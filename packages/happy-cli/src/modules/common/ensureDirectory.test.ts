import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureDirectory } from './ensureDirectory';

describe('ensureDirectory', () => {
    let workingDir: string;

    beforeEach(async () => {
        workingDir = await mkdtemp(join(tmpdir(), 'ensure-dir-'));
    });

    afterEach(async () => {
        await rm(workingDir, { recursive: true, force: true });
    });

    it('creates a missing nested directory', async () => {
        const target = join(workingDir, 'a', 'b', 'c');
        const result = await ensureDirectory(target, workingDir);
        expect(result.success).toBe(true);
        const s = await stat(target);
        expect(s.isDirectory()).toBe(true);
    });

    it('is idempotent — succeeds when directory already exists', async () => {
        const target = join(workingDir, 'existing');
        await mkdir(target);
        const result = await ensureDirectory(target, workingDir);
        expect(result.success).toBe(true);
    });

    it('rejects paths outside the working directory', async () => {
        const result = await ensureDirectory('/etc/should-not-create', workingDir);
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('rejects path traversal attempts', async () => {
        const result = await ensureDirectory('../../etc/breakout', workingDir);
        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('returns the resolved absolute path on success', async () => {
        const result = await ensureDirectory('relative/sub', workingDir);
        expect(result.success).toBe(true);
        expect(result.resolvedPath).toBe(join(workingDir, 'relative', 'sub'));
    });

    it('treats the working directory itself as a valid (idempotent) target', async () => {
        const result = await ensureDirectory(workingDir, workingDir);
        expect(result.success).toBe(true);
    });
});
