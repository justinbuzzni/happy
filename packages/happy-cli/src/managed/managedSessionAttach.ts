/**
 * Attaches a managed child to a session it did not create.
 *
 * ## What this refuses to do
 *
 * Everything that would make a session. A managed child holds a bearer scoped
 * to one session id and the raw key for that one session; it has no account
 * credential, no machine identity, and nothing it could authenticate a
 * `POST /v1/sessions` with. If the session it was pointed at is not there, the
 * answer is a failure — never a new session, which would be sealed with a key
 * the parent does not have and would strand the run silently.
 *
 * ## Why the lookup is not a formality
 *
 * The child is told an id and handed a key. Nothing in that pairing proves the
 * key belongs to the session, and using a raw key against the wrong record
 * would either fail obscurely or, worse, succeed against a session this run
 * has no business reading. So: exactly one record for that id — not "the first
 * that matches", which would let a second record ride along — and a wrapped
 * key equal byte for byte to the one the parent stored. Only then is the raw
 * key used, and the metadata it opens is the proof it was the right key.
 *
 * ## The project root
 *
 * The stored metadata carries a `cloud://…` display path, which is not a
 * directory. The runtime has exactly one, and it is fixed. The path is settled
 * here, before the session is handed to anything, because `ApiSessionClient`
 * registers the common handlers against `metadata.path` inside its own
 * constructor — after that, there is nothing left to correct.
 */
import axios from 'axios';

import type { AgentState, Metadata, Session } from '@/api/types';
import { decodeBase64, decrypt } from '@/api/encryption';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';
import type { ManagedSpawnBootstrap } from '@/managed/managedSpawnBootstrap';

export class ManagedAttachError extends Error {
    constructor(detail: string) {
        // Fixed text only: the caller holds a bearer and a key, and neither
        // belongs in a message that will be logged.
        super(`managed attach refused: ${detail}`);
        this.name = 'ManagedAttachError';
    }
}

export type ManagedAttachment = {
    session: Session;
    /** The credential mode every managed call must be made under. */
    managed: { serverOrigin: string };
    scopedToken: string;
};

type LookupRow = {
    id?: unknown;
    seq?: unknown;
    metadata?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
};

function nonNegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Constant-time-ish equality on two byte strings of the same purpose. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    let diff = 0;
    for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export async function attachManagedSession(
    bootstrap: ManagedSpawnBootstrap,
    now: number,
): Promise<ManagedAttachment> {
    if (bootstrap.tokenExpiresAt <= now) throw new ManagedAttachError('the scoped token has expired');
    const origin = new URL(bootstrap.serverOrigin).origin;

    let rows: unknown;
    try {
        const response = await axios.post(
            `${origin}/v2/sessions/lookup`,
            { ids: [bootstrap.sessionId] },
            {
                headers: {
                    Authorization: `Bearer ${bootstrap.scopedToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30_000,
                // A redirect is read after the request, and the request already
                // carried the bearer.
                maxRedirects: 0,
            },
        );
        rows = (response.data as { sessions?: unknown }).sessions;
    } catch {
        // The driver error names the origin and may carry the bearer it sent.
        throw new ManagedAttachError('the session could not be looked up');
    }

    if (!Array.isArray(rows) || rows.length !== 1) {
        throw new ManagedAttachError('the session lookup did not return exactly one record');
    }
    const row = rows[0] as LookupRow;
    if (row.id !== bootstrap.sessionId) {
        throw new ManagedAttachError('the session lookup returned a different session');
    }

    if (typeof row.dataEncryptionKey !== 'string') {
        throw new ManagedAttachError('the session carries no wrapped key');
    }
    if (!sameBytes(decodeBase64(row.dataEncryptionKey), decodeBase64(bootstrap.wrappedKeyBase64))) {
        throw new ManagedAttachError('the session wrapped key is not the one this run was given');
    }

    const encryptionKey = decodeBase64(bootstrap.rawKeyBase64);
    if (typeof row.metadata !== 'string') throw new ManagedAttachError('the session metadata is missing');
    const decoded = decrypt(encryptionKey, 'dataKey', decodeBase64(row.metadata));
    if (decoded === null || typeof decoded !== 'object') {
        throw new ManagedAttachError('the session metadata could not be opened with this key');
    }
    const stored = decoded as Metadata;

    let agentState: AgentState | null = null;
    if (typeof row.agentState === 'string') {
        const openedState = decrypt(encryptionKey, 'dataKey', decodeBase64(row.agentState));
        if (openedState === null) {
            throw new ManagedAttachError('the session agent state could not be opened with this key');
        }
        agentState = openedState as AgentState;
    }

    return {
        // Settled before anything can register handlers against it.
        session: {
            id: bootstrap.sessionId,
            seq: nonNegativeInteger(row.seq),
            encryptionKey,
            encryptionVariant: 'dataKey',
            metadata: { ...stored, path: MANAGED_PROJECT_ROOT },
            metadataVersion: nonNegativeInteger(row.metadataVersion),
            agentState,
            agentStateVersion: nonNegativeInteger(row.agentStateVersion),
        },
        managed: { serverOrigin: origin },
        scopedToken: bootstrap.scopedToken,
    };
}
