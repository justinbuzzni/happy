/**
 * specs/managed-cloud-byos §5.36 — 세대 launch/종료의 durable 원장.
 *
 * `fencingBackend.proveGenerationStopped({belowEpoch})` 는 run/attempt 를 받지
 * 않는다. teardown 은 `Number.MAX_SAFE_INTEGER` 로 부른다 — "내가 띄운 것 중
 * 그 epoch 미만이 전부 끝났는가" 라는 질문이다. 그래서 이 원장은 **띄운 것**과
 * **끝난 것**을 둘 다 기록한다.
 *
 * 띄운 적 없는 세대는 증명할 대상이 아니다. 띄웠는데 종료 기록이 없으면
 * **모른다**(재시작 뒤에도 launch 기록이 디스크에 남으므로 그 구분이 유지된다).
 * 원장을 못 읽으면 그것도 모른다 — 비어 있다고 읽으면 아무것도 안 띄운 것처럼
 * 보여 fencing 이 통과한다.
 *
 * 파일명은 scope 의 canonical digest 다. 구분자를 쓰면 id 안의 구분자로 두 scope
 * 가 같은 이름이 된다(`a__b` + `c` 와 `a` + `b__c`).
 *
 * 쓰기는 tmp(O_EXCL, 임의 이름) → fsync → rename → 디렉터리 fsync 다. 파일만
 * fsync 하면 이름이 디스크에 없을 수 있고, rename 만 하면 내용이 없을 수 있다.
 */
import {
    closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync,
    readSync, readdirSync, renameSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';

export type GenerationKey = {
    runId: string;
    attemptId: string;
    epoch: number;
};

export type GenerationRecord = {
    version: 1;
    runId: string;
    attemptId: string;
    epoch: number;
    launchedAt: number;
    /**
     * 정지를 **요청한** 시각. 요청과 관측 사이에서 죽으면 이 값만 남고, 그때
     * cgroup 이 없다는 사실은 "치웠다" 가 아니라 "재조정이 필요하다" 는 뜻이다.
     */
    terminationRequestedAt: number | null;
    /** cgroup 이 비었고 제거까지 성공한 시각. 없으면 아직 관측하지 못했다. */
    observedEmptyAt: number | null;
};

export type GenerationProof =
    | { proven: true; record: GenerationRecord }
    | {
        proven: false;
        detail:
            /** 이 supervisor 가 띄운 적이 없다. 증명할 대상이 아니다. */
            | 'never-launched'
            /** 띄웠는데 종료를 관측하지 못했다. */
            | 'termination-unknown'
            /** 정지를 요청했지만 관측 전에 끊겼다. 재조정 대상이다. */
            | 'termination-pending'
            /** 기록이 있는데 읽을 수 없다. 부재로 접지 않는다. */
            | 'record-unreadable';
    };

export type LaunchRefusal = 'already-launched' | 'already-terminated' | 'record-unreadable';

export type GenerationManifest = {
    /**
     * 세대를 띄우기 **전에** 기록한다. 같은 세대의 재기동은 거부다 — 종료된
     * 기록을 남긴 채 다시 띄우면 살아 있는 workload 가 `proven stopped` 로 보인다.
     */
    recordLaunch: (input: { key: GenerationKey; launchedAt: number }) =>
        { ok: true } | { ok: false; reason: LaunchRefusal };
    /** 정지 요청을 kill 보다 **먼저** 남긴다. */
    recordTerminationRequested: (input: { key: GenerationKey; requestedAt: number }) => void;
    recordTermination: (input: { key: GenerationKey; observedEmptyAt: number }) => void;
    proveStopped: (key: GenerationKey) => GenerationProof;
    /** 띄운 것 중 `belowEpoch` 미만이 전부 종료로 관측됐는가. */
    proveAllBelow: (belowEpoch: number) => { proven: boolean; detail: string };
    /** 아직 종료를 관측하지 못한 세대들. 재시작 재조정이 이것으로 시작한다. */
    listOpen: () => { records: GenerationRecord[]; unreadable: number };
};

const MAX_RECORD_BYTES = 4096;
const FILE_SUFFIX = '.json';

function isSafeSegment(value: string): boolean {
    return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function assertKey(key: GenerationKey): void {
    if (!isSafeSegment(key.runId) || !isSafeSegment(key.attemptId)) {
        throw new Error('generation manifest requires safe id segments');
    }
    if (!Number.isSafeInteger(key.epoch) || key.epoch < 0) {
        throw new Error('generation manifest requires a non-negative safe epoch');
    }
}

/** scope 전체의 digest. 구분자 충돌이 원리적으로 없다. */
export function generationScopeDigest(key: GenerationKey): string {
    assertKey(key);
    return createHash('sha256')
        .update(JSON.stringify([key.runId, key.attemptId, key.epoch]))
        .digest('hex');
}

/**
 * 원장 디렉터리가 신뢰할 수 있는지 본다.
 *
 * symlink 나 타 사용자 쓰기 가능 디렉터리를 그대로 쓰면, agent 가 원장을
 * 갈아 끼워 "전부 종료됨" 을 만들어 낼 수 있다.
 */
/**
 * 조상 전체를 검사한다. leaf 만 보면 agent 소유 조상이 leaf 를 rename 해
 * 원장을 통째로 갈아끼울 수 있다(§5.6 의 같은 계약).
 *
 * 먼저 심볼릭 링크를 **해소한 뒤** 그 실제 경로의 조상을 훑는다. 시스템 경로에
 * 링크가 있는 것 자체는 위협이 아니다(예: macOS 의 `/var`) — 위협은 남이 쓸 수
 * 있는 조상이다. 다만 leaf 가 링크인 것은 거부한다: 원장이 가리키는 곳이 통째로
 * 바뀔 수 있다.
 */
function assertTrustedRoot(root: string, ownerUid: number): void {
    if (lstatSync(root).isSymbolicLink()) {
        throw new Error('generation manifest root must not be a symlink');
    }
    const resolved = realpathSync(root);
    const segments = resolved.split(sep).filter(Boolean);
    let current: string = sep;
    for (const segment of [...segments, null]) {
        if (segment !== null) current = join(current, segment);
        const stat = lstatSync(current);
        // root 소유이거나 이 프로세스 소유여야 한다. 그 밖의 사용자가 소유한
        // 조상은 그 사용자가 아래를 통째로 갈아끼울 수 있다는 뜻이다.
        if (stat.uid !== 0 && stat.uid !== ownerUid) {
            throw new Error(`generation manifest ancestor ${current} has an unexpected owner`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new Error(`generation manifest ancestor ${current} is writable by others`);
        }
    }
    if (!lstatSync(resolved).isDirectory()) {
        throw new Error('generation manifest root must be a directory');
    }
}

function parseRecord(raw: string, key: GenerationKey): GenerationRecord | 'unreadable' {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 'unreadable';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return 'unreadable';
    if (typeof record.runId !== 'string' || typeof record.attemptId !== 'string') return 'unreadable';
    if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) < 0) return 'unreadable';
    if (!Number.isSafeInteger(record.launchedAt) || (record.launchedAt as number) <= 0) return 'unreadable';
    const requested = record.terminationRequestedAt;
    if (requested !== null && requested !== undefined
        && (!Number.isSafeInteger(requested) || (requested as number) <= 0)) return 'unreadable';
    const empty = record.observedEmptyAt;
    if (empty !== null && (!Number.isSafeInteger(empty) || (empty as number) <= 0)) return 'unreadable';
    // digest 가 맞아도 내용이 다른 scope 를 가리키면 그 파일은 이 질문의 답이 아니다.
    if (record.runId !== key.runId || record.attemptId !== key.attemptId
        || record.epoch !== key.epoch) {
        return 'unreadable';
    }
    return {
        version: 1,
        runId: record.runId,
        attemptId: record.attemptId,
        epoch: record.epoch as number,
        launchedAt: record.launchedAt as number,
        terminationRequestedAt: requested === null || requested === undefined
            ? null
            : (requested as number),
        observedEmptyAt: empty === null ? null : (empty as number),
    };
}

function parseAny(raw: string): GenerationRecord | 'unreadable' {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 'unreadable';
    }
    if (!parsed || typeof parsed !== 'object') return 'unreadable';
    const record = parsed as Record<string, unknown>;
    if (typeof record.runId !== 'string' || typeof record.attemptId !== 'string') return 'unreadable';
    if (!Number.isSafeInteger(record.epoch)) return 'unreadable';
    return parseRecord(raw, {
        runId: record.runId, attemptId: record.attemptId, epoch: record.epoch as number,
    });
}

export function createGenerationManifest(
    root: string,
    options: { ownerUid?: number } = {},
): GenerationManifest {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const ownerUid = options.ownerUid ?? (process.getuid?.() ?? 0);
    assertTrustedRoot(root, ownerUid);

    function pathFor(key: GenerationKey): string {
        return join(root, `${generationScopeDigest(key)}${FILE_SUFFIX}`);
    }

    function readRaw(path: string): string | null {
        let fd: number;
        try {
            fd = openSync(path, 'r');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
            throw error;
        }
        try {
            // 열어 둔 fd 로 확인한다. 경로를 다시 보면 그 사이에 바뀔 수 있다.
            const stat = fstatSync(fd);
            if (!stat.isFile()) throw new Error('manifest entry is not a regular file');
            if (stat.uid !== ownerUid) throw new Error('manifest entry has an unexpected owner');
            // 상한을 두고 읽는다. 원장 파일 하나가 임의 크기 입력이 되지 않게.
            const buffer = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
            // read(2) 는 요청보다 적게 줄 수 있다. 한 번 호출로 끝내지 않는다.
            let total = 0;
            for (;;) {
                const read = readSync(fd, buffer, total, buffer.length - total, total);
                if (read <= 0) break;
                total += read;
                if (total > MAX_RECORD_BYTES) return 'oversize';
            }
            return buffer.subarray(0, total).toString('utf8');
        } finally {
            closeSync(fd);
        }
    }

    function load(key: GenerationKey): GenerationRecord | null | 'unreadable' {
        let raw: string | null;
        try {
            raw = readRaw(pathFor(key));
        } catch {
            return 'unreadable';
        }
        if (raw === null) return null;
        if (raw === 'oversize') return 'unreadable';
        return parseRecord(raw, key);
    }

    /** tmp(O_EXCL, 임의 이름) → fsync → rename → 디렉터리 fsync. */
    function writeDurably(path: string, data: string): void {
        // 짧은 쓰기가 있을 수 있다. 다 나갈 때까지 반복한다.
        const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        const fd = openSync(tmp, 'wx', 0o600);
        try {
            const bytes = Buffer.from(data, 'utf8');
            let written = 0;
            while (written < bytes.length) {
                written += writeSync(fd, bytes, written, bytes.length - written);
            }
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        try {
            renameSync(tmp, path);
        } catch (error) {
            try { unlinkSync(tmp); } catch { /* 정리 실패는 기록 실패가 아니다 */ }
            throw error;
        }
        const dir = openSync(root, 'r');
        try {
            fsyncSync(dir);
        } finally {
            closeSync(dir);
        }
    }

    function upsert(key: GenerationKey, mutate: (existing: GenerationRecord | null) => GenerationRecord): void {
        const existing = load(key);
        // 읽지 못한 기록을 조용히 덮으면 무슨 일이 있었는지 영영 모른다.
        if (existing === 'unreadable') {
            throw new Error('generation manifest record is unreadable; refusing to overwrite it');
        }
        writeDurably(pathFor(key), JSON.stringify(mutate(existing)));
    }

    return {
        recordLaunch({ key, launchedAt }) {
            assertKey(key);
            const existing = load(key);
            if (existing === 'unreadable') return { ok: false, reason: 'record-unreadable' };
            // 세대는 한 번만 쓴다. 종료된 세대를 다시 띄우면 살아 있는 workload 가
            // 이전 종료 기록 덕분에 `proven stopped` 로 보인다.
            if (existing !== null) {
                return {
                    ok: false,
                    reason: existing.observedEmptyAt !== null ? 'already-terminated' : 'already-launched',
                };
            }
            writeDurably(pathFor(key), JSON.stringify({
                version: 1,
                runId: key.runId,
                attemptId: key.attemptId,
                epoch: key.epoch,
                launchedAt,
                terminationRequestedAt: null,
                observedEmptyAt: null,
            } satisfies GenerationRecord));
            return { ok: true };
        },

        recordTerminationRequested({ key, requestedAt }) {
            assertKey(key);
            upsert(key, (existing) => ({
                version: 1,
                runId: key.runId,
                attemptId: key.attemptId,
                epoch: key.epoch,
                launchedAt: existing?.launchedAt ?? requestedAt,
                terminationRequestedAt: existing?.terminationRequestedAt ?? requestedAt,
                observedEmptyAt: existing?.observedEmptyAt ?? null,
            }));
        },

        recordTermination({ key, observedEmptyAt }) {
            assertKey(key);
            upsert(key, (existing) => {
                // 첫 관측이 권위다. 나중 기록이 덮으면 재증명이 멱등이 아니다.
                if (existing && existing.observedEmptyAt !== null) return existing;
                return {
                    version: 1,
                    runId: key.runId,
                    attemptId: key.attemptId,
                    epoch: key.epoch,
                    launchedAt: existing?.launchedAt ?? observedEmptyAt,
                    terminationRequestedAt: existing?.terminationRequestedAt ?? null,
                    observedEmptyAt,
                };
            });
        },

        proveStopped(key) {
            assertKey(key);
            const record = load(key);
            if (record === null) return { proven: false, detail: 'never-launched' };
            if (record === 'unreadable') return { proven: false, detail: 'record-unreadable' };
            if (record.observedEmptyAt === null) {
                return {
                    proven: false,
                    detail: record.terminationRequestedAt !== null
                        ? 'termination-pending'
                        : 'termination-unknown',
                };
            }
            return { proven: true, record };
        },

        proveAllBelow(belowEpoch) {
            if (!Number.isSafeInteger(belowEpoch) || belowEpoch < 0) {
                return { proven: false, detail: 'invalid-epoch' };
            }
            let entries: string[];
            try {
                entries = readdirSync(root);
            } catch {
                // 원장을 못 읽는 것을 "아무것도 안 띄웠다" 로 읽으면 fencing 이 뚫린다.
                return { proven: false, detail: 'manifest-unreadable' };
            }
            for (const entry of entries) {
                if (!entry.endsWith(FILE_SUFFIX)) continue;
                // 파일명은 내용의 digest 여야 한다. 아니면 누가 갖다 놓은 것이다.
                if (!/^[0-9a-f]{64}\.json$/.test(entry)) {
                    return { proven: false, detail: 'record-unreadable' };
                }
                let raw: string | null;
                try {
                    raw = readRaw(join(root, entry));
                } catch {
                    return { proven: false, detail: 'record-unreadable' };
                }
                if (raw === null) continue;
                if (raw === 'oversize') return { proven: false, detail: 'record-unreadable' };
                const record = parseAny(raw);
                if (record === 'unreadable') return { proven: false, detail: 'record-unreadable' };
                if (`${generationScopeDigest(record)}${FILE_SUFFIX}` !== entry) {
                    return { proven: false, detail: 'record-unreadable' };
                }
                if (record.epoch >= belowEpoch) continue;
                if (record.observedEmptyAt === null) {
                    return {
                        proven: false,
                        detail: record.terminationRequestedAt !== null
                            ? 'termination-pending'
                            : 'termination-unknown',
                    };
                }
            }
            return { proven: true, detail: 'all-launched-generations-observed-empty' };
        },

        listOpen() {
            let entries: string[];
            try {
                entries = readdirSync(root);
            } catch {
                return { records: [], unreadable: 1 };
            }
            const records: GenerationRecord[] = [];
            let unreadable = 0;
            for (const entry of entries) {
                if (!entry.endsWith(FILE_SUFFIX)) continue;
                if (!/^[0-9a-f]{64}\.json$/.test(entry)) { unreadable += 1; continue; }
                let raw: string | null;
                try {
                    raw = readRaw(join(root, entry));
                } catch {
                    unreadable += 1;
                    continue;
                }
                if (raw === null) continue;
                if (raw === 'oversize') { unreadable += 1; continue; }
                const record = parseAny(raw);
                if (record === 'unreadable'
                    || `${generationScopeDigest(record)}${FILE_SUFFIX}` !== entry) {
                    unreadable += 1;
                    continue;
                }
                if (record.observedEmptyAt === null) records.push(record);
            }
            return { records, unreadable };
        },
    };
}
