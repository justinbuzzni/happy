import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
    CheckpointObjectStoreError,
    getCheckpointObject,
    putCheckpointObject,
    putCheckpointPointer,
    readCheckpointPointer,
    verifyCheckpointObject,
} from './managedCheckpointObjectStore';

const created: string[] = [];

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-store-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

/** `BodyInit` is a DOM type; this package compiles with the node lib only. */
async function collect(body: RequestInit['body']): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    if (typeof body === 'string') return Buffer.from(body);
    const chunks: Buffer[] = [];
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

describe('putCheckpointObject', () => {
    it('shouldStreamTheFileAndReportWhatWasSent', async () => {
        const filePath = join(await scratch(), 'object.enc');
        const payload = Buffer.from('sealed bytes');
        await writeFile(filePath, payload);
        let received: Buffer = Buffer.alloc(0);

        const result = await putCheckpointObject({
            url: 'https://store.invalid/o',
            filePath,
            fetchImpl: async (_url, init) => {
                received = await collect((init as RequestInit).body);
                return new Response(null, {
                    status: 200,
                    headers: { etag: `"${createHash('md5').update(payload).digest('hex')}"` },
                });
            },
        });

        expect(received).toEqual(payload);
        expect(result.bytes).toBe(payload.length);
        expect(result.md5).toBe(createHash('md5').update(payload).digest('hex'));
    });

    it('shouldSurviveAStoreThatAnswersBeforeItReadsTheBody', async () => {
        // A signed URL that has expired is answered immediately, with the body
        // never consumed. Hashing the request body as it was consumed made the
        // digest finalise while the stream was still emitting, which threw
        // ERR_CRYPTO_HASH_FINALIZED out of a listener nobody awaited.
        const filePath = join(await scratch(), 'object.enc');
        const payload = randomBytes(4 * 1024 * 1024);
        await writeFile(filePath, payload);
        const unhandled: unknown[] = [];
        const record = (error: unknown): void => { unhandled.push(error); };
        process.on('uncaughtException', record);
        try {
            const result = await putCheckpointObject({
                url: 'https://store.invalid/o',
                filePath,
                fetchImpl: async () => new Response(null, { status: 200, headers: { etag: '"abc"' } }),
            });
            expect(result.md5).toBe(createHash('md5').update(payload).digest('hex'));
            expect(result.bytes).toBe(payload.length);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('uncaughtException', record);
        }
    });

    it('shouldReportTheDigestOfTheFileNotOfWhateverWasTransferred', async () => {
        const filePath = join(await scratch(), 'object.enc');
        const payload = Buffer.from('the whole file');
        await writeFile(filePath, payload);
        const result = await putCheckpointObject({
            url: 'https://store.invalid/o',
            filePath,
            fetchImpl: async (_url, init) => {
                // Reads only the first chunk and stops.
                const reader = ((init as RequestInit).body as ReadableStream).getReader();
                await reader.read();
                await reader.cancel();
                return new Response(null, { status: 200 });
            },
        });
        expect(result.md5).toBe(createHash('md5').update(payload).digest('hex'));
    });

    it('shouldSurfaceARejectedUploadWithoutTheStoresText', async () => {
        const filePath = join(await scratch(), 'object.enc');
        await writeFile(filePath, 'x');
        const failure = await putCheckpointObject({
            url: 'https://store.invalid/o',
            filePath,
            fetchImpl: async () => new Response('AccessDenied: signature expired for key abc', { status: 403 }),
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(CheckpointObjectStoreError);
        expect((failure as Error).message).toBe('managed checkpoint object store: upload-failed');
    });
});

    it('shouldRefuseToReplaceAnObjectWhenTheWriteIsConditional', async () => {
        const filePath = join(await scratch(), 'object.enc');
        await writeFile(filePath, 'bytes');
        let headers: Record<string, string> = {};
        await expect(putCheckpointObject({
            url: 'https://store.invalid/o',
            filePath,
            ifAbsent: true,
            fetchImpl: async (_url, init) => {
                headers = (init as RequestInit).headers as Record<string, string>;
                return new Response(null, { status: 412 });
            },
        })).rejects.toMatchObject({ code: 'object-exists' });
        expect(headers['if-none-match']).toBe('*');
    });

    it('shouldNotSendAPreconditionWhenTheWriteIsNotConditional', async () => {
        const filePath = join(await scratch(), 'object.enc');
        await writeFile(filePath, 'bytes');
        let headers: Record<string, string> = {};
        await putCheckpointObject({
            url: 'https://store.invalid/o',
            filePath,
            fetchImpl: async (_url, init) => {
                headers = (init as RequestInit).headers as Record<string, string>;
                return new Response(null, { status: 200 });
            },
        });
        expect(headers['if-none-match']).toBeUndefined();
    });

describe('verifyCheckpointObject', () => {
    it('shouldAcceptAStoredObjectThatMatchesSizeAndDigest', async () => {
        await expect(verifyCheckpointObject({
            url: 'https://store.invalid/o',
            expect: { bytes: 4, md5: 'a'.repeat(32) },
            fetchImpl: async () => new Response(null, {
                status: 200,
                headers: { 'content-length': '4', etag: `"${'a'.repeat(32)}"` },
            }),
        })).resolves.toBeUndefined();
    });

    it('shouldRefuseATruncatedOrAlteredObject', async () => {
        await expect(verifyCheckpointObject({
            url: 'https://store.invalid/o',
            expect: { bytes: 4, md5: 'a'.repeat(32) },
            fetchImpl: async () => new Response(null, {
                status: 200, headers: { 'content-length': '3', etag: `"${'a'.repeat(32)}"` },
            }),
        })).rejects.toMatchObject({ code: 'verify-failed' });

        await expect(verifyCheckpointObject({
            url: 'https://store.invalid/o',
            expect: { bytes: 4, md5: 'a'.repeat(32) },
            fetchImpl: async () => new Response(null, {
                status: 200, headers: { 'content-length': '4', etag: `"${'b'.repeat(32)}"` },
            }),
        })).rejects.toMatchObject({ code: 'verify-failed' });
    });

    it('shouldReportAMissingObjectDistinctlyFromAFailedCheck', async () => {
        await expect(verifyCheckpointObject({
            url: 'https://store.invalid/o',
            expect: { bytes: 1, md5: 'a'.repeat(32) },
            fetchImpl: async () => new Response(null, { status: 404 }),
        })).rejects.toMatchObject({ code: 'missing' });
    });

    it('shouldNotTreatANonMd5EtagAsAChecksumMismatch', async () => {
        await expect(verifyCheckpointObject({
            url: 'https://store.invalid/o',
            expect: { bytes: 4, md5: 'a'.repeat(32) },
            fetchImpl: async () => new Response(null, {
                status: 200, headers: { 'content-length': '4', etag: '"abc-3"' },
            }),
        })).resolves.toBeUndefined();
    });
});

describe('getCheckpointObject', () => {
    it('shouldStreamToAFileAndReportItsDigest', async () => {
        const destination = join(await scratch(), 'downloaded');
        const payload = Buffer.from('object body');
        const result = await getCheckpointObject({
            url: 'https://store.invalid/o',
            destination,
            fetchImpl: async () => new Response(payload),
        });
        expect(await readFile(destination)).toEqual(payload);
        expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
        expect(result.bytes).toBe(payload.length);
    });

    it('shouldLeaveNoPartialFileWhenTheDownloadFails', async () => {
        const destination = join(await scratch(), 'downloaded');
        await expect(getCheckpointObject({
            url: 'https://store.invalid/o',
            destination,
            fetchImpl: async () => new Response('nope', { status: 500 }),
        })).rejects.toMatchObject({ code: 'download-failed' });
        await expect(readFile(destination)).rejects.toThrow();
    });
});

    it('shouldNotDeleteADestinationItDidNotCreate', async () => {
        const destination = join(await scratch(), 'downloaded');
        await writeFile(destination, 'someone else wrote this');

        await expect(getCheckpointObject({
            url: 'https://store.invalid/o',
            destination,
            fetchImpl: async () => new Response('body'),
        })).rejects.toThrow();

        // The `wx` open failed because the file was already there — this call
        // never owned it, so cleaning up means deleting someone else's file.
        expect(await readFile(destination, 'utf8')).toBe('someone else wrote this');
    });

    it('shouldNotTouchTheDestinationWhenTheObjectIsNotThere', async () => {
        const destination = join(await scratch(), 'downloaded');
        await writeFile(destination, 'existing');
        await expect(getCheckpointObject({
            url: 'https://store.invalid/o',
            destination,
            fetchImpl: async () => new Response(null, { status: 404 }),
        })).rejects.toMatchObject({ code: 'missing' });
        expect(await readFile(destination, 'utf8')).toBe('existing');
    });

describe('putCheckpointPointer', () => {
    it('shouldCreateThePointerOnlyWhenThereIsNoneYet', async () => {
        let headers: Record<string, string> = {};
        const result = await putCheckpointPointer({
            url: 'https://store.invalid/latest.json',
            body: '{}',
            expectedEtag: null,
            fetchImpl: async (_url, init) => {
                headers = (init as RequestInit).headers as Record<string, string>;
                return new Response(null, { status: 200, headers: { etag: '"e1"' } });
            },
        });
        expect(headers['if-none-match']).toBe('*');
        expect(headers['if-match']).toBeUndefined();
        expect(result).toEqual({ ok: true, etag: 'e1' });
    });

    it('shouldReplaceOnlyTheVersionTheCallerReasonedAbout', async () => {
        let headers: Record<string, string> = {};
        await putCheckpointPointer({
            url: 'https://store.invalid/latest.json',
            body: '{}',
            expectedEtag: 'e1',
            fetchImpl: async (_url, init) => {
                headers = (init as RequestInit).headers as Record<string, string>;
                return new Response(null, { status: 200, headers: { etag: '"e2"' } });
            },
        });
        expect(headers['if-match']).toBe('"e1"');
        expect(headers['if-none-match']).toBeUndefined();
    });

    it('shouldReportAPreconditionFailureAsAConflictRatherThanAnError', async () => {
        for (const status of [412, 409]) {
            expect(await putCheckpointPointer({
                url: 'https://store.invalid/latest.json',
                body: '{}',
                expectedEtag: 'e1',
                fetchImpl: async () => new Response(null, { status }),
            })).toEqual({ ok: false, reason: 'conflict' });
        }
    });
});

describe('readCheckpointPointer', () => {
    it('shouldReturnNullWhenNoPointerExistsYet', async () => {
        expect(await readCheckpointPointer({
            url: 'https://store.invalid/latest.json',
            fetchImpl: async () => new Response(null, { status: 404 }),
        })).toBeNull();
    });

    it('shouldReturnTheBodyWithTheVersionItWasRead', async () => {
        expect(await readCheckpointPointer({
            url: 'https://store.invalid/latest.json',
            fetchImpl: async () => new Response('{"checkpointId":"a"}', { status: 200, headers: { etag: '"e7"' } }),
        })).toEqual({ body: '{"checkpointId":"a"}', etag: 'e7' });
    });
});
