import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
    openCheckpointFile,
    sealCheckpointBuffer,
    sealCheckpointStream,
    type CheckpointCryptoBinding,
} from './managedCheckpointCrypto';

const created: string[] = [];
const key = randomBytes(32);
const binding: CheckpointCryptoBinding = {
    companyId: 'co_1',
    projectId: 'pr_1',
    checkpointId: 'a'.repeat(64),
    area: 'project',
};

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-crypto-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function seal(plaintext: Buffer, overrides: Partial<CheckpointCryptoBinding> = {}): Promise<string> {
    const destination = join(await scratch(), 'object.enc');
    await sealCheckpointBuffer({ plaintext, destination, key, binding: { ...binding, ...overrides } });
    return destination;
}

async function open(source: string, overrides: Partial<CheckpointCryptoBinding> = {}, openKey = key) {
    const destination = join(await scratch(), 'plain');
    const result = await openCheckpointFile({
        source, destination, key: openKey, binding: { ...binding, ...overrides },
    });
    return { ...result, destination };
}

describe('managed checkpoint envelope', () => {
    it('shouldRoundTripUnderTheSameBindingAndReportThePlaintextDigest', async () => {
        const plaintext = Buffer.from('hello checkpoint');
        const opened = await open(await seal(plaintext));
        expect(await readFile(opened.destination)).toEqual(plaintext);
        expect(opened.bytes).toBe(plaintext.length);
        expect(opened.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    });

    it('shouldNotProduceTheSameCiphertextTwice', async () => {
        const a = await readFile(await seal(Buffer.from('x')));
        const b = await readFile(await seal(Buffer.from('x')));
        expect(a.equals(b)).toBe(false);
    });

    it('shouldRefuseDecryptionUnderADifferentTenantProjectCheckpointOrArea', async () => {
        const sealed = await seal(Buffer.from('secret'));
        for (const other of [
            { companyId: 'co_2' },
            { projectId: 'pr_2' },
            { checkpointId: 'b'.repeat(64) },
            { area: 'provider-state' as const },
        ]) {
            await expect(open(sealed, other)).rejects.toThrow('managed checkpoint object is not readable');
        }
    });

    it('shouldRefuseADifferentKey', async () => {
        await expect(open(await seal(Buffer.from('secret')), {}, randomBytes(32)))
            .rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldLeaveNoPlaintextBehindWhenTheTagDoesNotHold', async () => {
        const sealed = await seal(Buffer.from('secret'));
        const destination = join(await scratch(), 'plain');
        await expect(openCheckpointFile({ source: sealed, destination, key: randomBytes(32), binding }))
            .rejects.toThrow('managed checkpoint object is not readable');
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldRefuseTamperedCiphertextAndTruncatedInput', async () => {
        const sealed = await seal(Buffer.from('secret'));
        const bytes = await readFile(sealed);
        const flipped = Buffer.from(bytes);
        flipped[flipped.length - 1] ^= 0xff;
        const flippedPath = join(await scratch(), 'flipped.enc');
        await writeFile(flippedPath, flipped);
        await expect(open(flippedPath)).rejects.toThrow('managed checkpoint object is not readable');

        const truncatedPath = join(await scratch(), 'short.enc');
        await writeFile(truncatedPath, bytes.subarray(0, 10));
        await expect(open(truncatedPath)).rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldRefuseAnObjectWithAForeignMagic', async () => {
        const bytes = await readFile(await seal(Buffer.from('secret')));
        bytes.write('XXXXX', 0, 'ascii');
        const path = join(await scratch(), 'foreign.enc');
        await writeFile(path, bytes);
        await expect(open(path)).rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldRequireA32ByteKeyOnBothSides', async () => {
        await expect(sealCheckpointBuffer({
            plaintext: Buffer.from('x'), destination: join(await scratch(), 'o.enc'), key: randomBytes(16), binding,
        })).rejects.toThrow('32-byte');
        await expect(open(await seal(Buffer.from('x')), {}, randomBytes(16))).rejects.toThrow('32-byte');
    });

    it('shouldRefuseAnEmptyTenantOrProjectBinding', async () => {
        for (const override of [{ companyId: '' }, { projectId: '' }]) {
            await expect(sealCheckpointBuffer({
                plaintext: Buffer.from('x'),
                destination: join(await scratch(), 'o.enc'),
                key,
                binding: { ...binding, ...override },
            })).rejects.toThrow('binding');
        }
    });

    it('shouldWriteCiphertextWhileTheSourceIsStillProducing', async () => {
        // The property is "this streams", and the observable form of that is
        // that sealed bytes are on disk before the source has finished. An
        // implementation that collected the plaintext first would have written
        // nothing at this point, however much memory it happened to be using.
        //
        // Measuring heap instead was the earlier version of this test, and it
        // was not a measurement of anything: `heapUsed + external` moves with
        // whatever else the process is doing, so it failed at 19.7MB against a
        // 16MB threshold with the implementation unchanged.
        const chunk = randomBytes(256 * 1024);
        const chunks = 64;
        const destination = join(await scratch(), 'big.enc');
        let sealedBytesAtHalfway = 0;

        await sealCheckpointStream({
            source: Readable.from((async function* () {
                for (let index = 0; index < chunks; index += 1) {
                    if (index === chunks / 2) {
                        sealedBytesAtHalfway = await stat(destination).then(
                            (entry) => entry.size,
                            () => 0,
                        );
                    }
                    yield chunk;
                }
            })()),
            destination,
            key,
            binding,
        });

        // Not `> 0`: the header is yielded before the cipher produces
        // anything, so a body that was collected and written at the end would
        // still have left those few bytes on disk. The assertion has to be
        // about the *body* having made progress.
        expect(sealedBytesAtHalfway).toBeGreaterThan(4 * chunk.length);
        const opened = await open(destination);
        expect(opened.bytes).toBe(chunk.length * chunks);
    });

    it('shouldNotStartTheProducerBeforeItHasClaimedTheDestination', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'already here');
        let producerStarted = false;

        // The barrier: the source must not run at all if the destination
        // cannot be claimed. A producer that has already begun is a producer
        // whose failures have nowhere to go — nothing is listening yet.
        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                producerStarted = true;
                yield Buffer.from('x');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();

        expect(producerStarted).toBe(false);
        expect(await readFile(destination, 'utf8')).toBe('already here');
    });

    it('shouldNotDeleteAnExistingDestinationWhenTheSourceIsRefusedBeforeAnyWrite', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'someone else wrote this');

        // The write is refused because the destination is already there; the
        // cleanup that follows must not then remove it.
        await expect(sealCheckpointStream({
            source: Readable.from([Buffer.from('x')]),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('someone else wrote this');
    });

    it('shouldNotDeleteAnExistingDestinationWhenTheSourceItselfFails', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'someone else wrote this');

        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                yield Buffer.from('x');
                throw new Error('the source broke');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('someone else wrote this');
    });

    it('shouldRemoveOnlyItsOwnPartialOutputWhenTheSourceFails', async () => {
        const destination = join(await scratch(), 'object.enc');
        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                yield randomBytes(64 * 1024);
                throw new Error('the source broke');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        // It created this one, so it is the one to clean up.
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldNotDeleteAnExistingPlaintextWhenTheSealedObjectIsMalformed', async () => {
        const source = join(await scratch(), 'short.enc');
        await writeFile(source, Buffer.from('too short'));
        const destination = join(await scratch(), 'plain');
        await writeFile(destination, 'existing plaintext');

        // The refusal happens before a destination would ever be created.
        await expect(openCheckpointFile({ source, destination, key, binding }))
            .rejects.toThrow('managed checkpoint object is not readable');
        expect(await readFile(destination, 'utf8')).toBe('existing plaintext');
    });

    it('shouldNotDeleteAnExistingPlaintextWhenTheSealedObjectIsMissing', async () => {
        const destination = join(await scratch(), 'plain');
        await writeFile(destination, 'existing plaintext');
        await expect(openCheckpointFile({
            source: join(await scratch(), 'nope.enc'), destination, key, binding,
        })).rejects.toThrow('managed checkpoint object is not readable');
        expect(await readFile(destination, 'utf8')).toBe('existing plaintext');
    });

    it('shouldRefuseToOverwriteAnExistingObject', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'existing');
        await expect(sealCheckpointBuffer({ plaintext: Buffer.from('x'), destination, key, binding }))
            .rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('existing');
    });
});
