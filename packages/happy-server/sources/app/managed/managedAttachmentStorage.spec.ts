import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    activateManagedStorage,
    assertPrivateRootIsolated,
    isMissingObject,
} from '@/app/managed/managedAttachmentStorage';

/**
 * The activation check for managed attachment storage. Pure: no bucket is
 * created, opened or written, and no policy is ever set.
 */

const PUBLIC_BUCKET = 'happy-files';
const MANAGED_BUCKET = 'happy-managed-files';

function client(over: {
    exists?: boolean | Error;
    policy?: string | Error;
} = {}) {
    return {
        bucketExists: async () => {
            if (over.exists instanceof Error) throw over.exists;
            return over.exists ?? true;
        },
        getBucketPolicy: async () => {
            if (over.policy instanceof Error) throw over.policy;
            if (over.policy === undefined) {
                throw Object.assign(new Error('no policy'), { code: 'NoSuchBucketPolicy' });
            }
            return over.policy;
        },
    } as never;
}

const env = {
    S3_BUCKET: PUBLIC_BUCKET,
    HAPPY_MANAGED_S3_BUCKET: MANAGED_BUCKET,
    HAPPY_MANAGED_S3_BACKEND: 'minio',
};

describe('activating managed object storage', () => {
    it('accepts a dedicated bucket that carries no policy at all', async () => {
        expect(await activateManagedStorage(env, client(), false))
            .toEqual({ ok: true, mode: 's3', bucket: MANAGED_BUCKET });
    });

    it('refuses to share the public bucket', async () => {
        // `s3:init` runs `mc anonymous set download` on that bucket, so every
        // object in it is readable by URL. Sharing it is not a choice.
        expect(await activateManagedStorage(
            { ...env, HAPPY_MANAGED_S3_BUCKET: PUBLIC_BUCKET }, client(), false,
        )).toEqual({ ok: false, reason: 'managed-bucket-same-as-public' });
    });

    it('refuses when no managed bucket is named', async () => {
        expect(await activateManagedStorage({ ...env, HAPPY_MANAGED_S3_BUCKET: undefined }, client(), false))
            .toEqual({ ok: false, reason: 'managed-bucket-not-configured' });
    });

    it('refuses a bucket that is not there', async () => {
        expect(await activateManagedStorage(env, client({ exists: false }), false))
            .toEqual({ ok: false, reason: 'managed-bucket-missing' });
    });

    it('refuses a policy read that answers anything but "there is none"', async () => {
        // The contract accepts exactly `NoSuchBucketPolicy`. A 200 carrying an
        // empty or unparseable body is not that answer, and reading it as one
        // would accept a bucket whose policy this server never saw.
        for (const policy of ['', '   ', '{}', 'null']) {
            expect(await activateManagedStorage(env, client({ policy }), false), JSON.stringify(policy))
                .toEqual({ ok: false, reason: 'managed-bucket-has-policy' });
        }
    });

    it('requires the backend to be named, and to be the one that was validated', async () => {
        // A comment saying AWS is unsupported does not stop an AWS-configured
        // client from passing the same check.
        expect(await activateManagedStorage(
            { ...env, HAPPY_MANAGED_S3_BACKEND: undefined }, client(), false,
        )).toEqual({ ok: false, reason: 'managed-backend-not-supported' });
        expect(await activateManagedStorage(
            { ...env, HAPPY_MANAGED_S3_BACKEND: 'aws' }, client(), false,
        )).toEqual({ ok: false, reason: 'managed-backend-not-supported' });
    });

    it('refuses any policy rather than deciding which ones are safe', async () => {
        for (const policy of [
            '{"Version":"2012-10-17","Statement":[]}',
            '{"Statement":[{"Effect":"Allow","Principal":"*","Action":["s3:GetObject"]}]}',
            'not json at all',
        ]) {
            expect(await activateManagedStorage(env, client({ policy }), false), policy)
                .toEqual({ ok: false, reason: 'managed-bucket-has-policy' });
        }
    });

    it('refuses when the policy cannot be read, which is not the same as absent', async () => {
        for (const error of [
            Object.assign(new Error('denied'), { code: 'AccessDenied', statusCode: 403 }),
            Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }),
            new Error('something else entirely'),
        ]) {
            expect(await activateManagedStorage(env, client({ policy: error }), false), String(error.message))
                .toEqual({ ok: false, reason: 'managed-bucket-unverifiable' });
        }
    });

    it('refuses when the bucket cannot be reached', async () => {
        expect(await activateManagedStorage(env, client({ exists: new Error('offline') }), false))
            .toEqual({ ok: false, reason: 'managed-bucket-unverifiable' });
    });
});

describe('the private local root', () => {
    it('refuses to be the public root, or to sit inside it', async () => {
        const base = await mkdtemp(join(tmpdir(), 'managed-root-'));
        const pub = join(base, 'files');
        await mkdir(pub, { recursive: true });
        expect(() => assertPrivateRootIsolated(pub, pub)).toThrow(/overlaps/);
        expect(() => assertPrivateRootIsolated(pub, join(pub, 'managed'))).toThrow(/overlaps/);
        expect(() => assertPrivateRootIsolated(join(pub, 'managed'), pub)).toThrow(/overlaps/);
        expect(() => assertPrivateRootIsolated(pub, join(base, 'managed-files'))).not.toThrow();
    });

    it('ascends only past a missing directory, never past one it cannot read', async () => {
        // A permission or loop error is not "this path does not exist yet"; the
        // lexical fallback would then compare two strings and call an overlap
        // safe.
        const base = await mkdtemp(join(tmpdir(), 'managed-perm-'));
        const loop = join(base, 'loop');
        await symlink(loop, loop);
        expect(() => assertPrivateRootIsolated(join(base, 'files'), join(loop, 'managed')))
            .toThrow(/unavailable|overlaps/);
    });

    it('sees through a symlink that points back into the public root', async () => {
        const base = await mkdtemp(join(tmpdir(), 'managed-link-'));
        const pub = join(base, 'files');
        await mkdir(pub, { recursive: true });
        const linked = join(base, 'managed-files');
        await symlink(pub, linked);
        // A string comparison would call these separate; they are the same
        // directory, and the bytes would land under the public route.
        expect(() => assertPrivateRootIsolated(pub, linked)).toThrow(/overlaps/);
    });
});

describe('what counts as an absent object', () => {
    it('is only a known not-found', () => {
        for (const error of [
            { code: 'ENOENT' }, { code: 'NoSuchKey' }, { name: 'NotFound' }, { statusCode: 404 },
        ]) {
            expect(isMissingObject(error), JSON.stringify(error)).toBe(true);
        }
    });

    it('is never an outage', () => {
        for (const error of [
            { code: 'EIO' }, { code: 'AccessDenied', statusCode: 403 },
            { code: 'ECONNREFUSED' }, new Error('unknown'),
        ]) {
            expect(isMissingObject(error), JSON.stringify(error)).toBe(false);
        }
    });
});
