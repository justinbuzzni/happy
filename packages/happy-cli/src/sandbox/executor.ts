/**
 * Unified tool execution interface following the Managed Agents execute(name, input) → string pattern.
 * Abstracts tool execution behind a uniform interface to support future execution backends
 * (Docker containers, remote sandboxes, Managed Agents API).
 */

import { exec } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxConfig } from '@/persistence';

const execAsync = promisify(exec);

export interface ToolExecutor {
    execute(name: string, input: Record<string, unknown>): Promise<string>;
    dispose(): Promise<void>;
}

export class LocalToolExecutor implements ToolExecutor {
    constructor(
        private readonly cwd: string,
        private readonly env: Record<string, string>,
        private readonly sandboxConfig?: SandboxConfig,
    ) {}

    async execute(name: string, input: Record<string, unknown>): Promise<string> {
        switch (name) {
            case 'bash':
                return this.executeBash(input);
            case 'read_file':
                return this.executeReadFile(input);
            case 'write_file':
                return this.executeWriteFile(input);
            case 'list_directory':
                return this.executeListDirectory(input);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }

    async dispose(): Promise<void> {}

    private validatePath(filePath: string): string {
        const resolved = resolve(this.cwd, filePath);
        if (resolved !== this.cwd && !resolved.startsWith(this.cwd + '/')) {
            throw new Error(`Path ${filePath} is outside workspace`);
        }
        return resolved;
    }

    private async executeBash(input: Record<string, unknown>): Promise<string> {
        const command = input.command as string;
        const timeout = (input.timeout as number) ?? 30000;
        const cwd = input.cwd ? this.validatePath(input.cwd as string) : this.cwd;

        const { stdout, stderr } = await execAsync(command, {
            cwd,
            env: this.env,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
        });

        return stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
    }

    private async executeReadFile(input: Record<string, unknown>): Promise<string> {
        const filePath = this.validatePath(input.path as string);
        return readFile(filePath, 'utf-8');
    }

    private async executeWriteFile(input: Record<string, unknown>): Promise<string> {
        const filePath = this.validatePath(input.path as string);
        const content = input.content as string;
        await writeFile(filePath, content, 'utf-8');
        return 'ok';
    }

    private async executeListDirectory(input: Record<string, unknown>): Promise<string> {
        const dirPath = this.validatePath(input.path as string);
        const entries = await readdir(dirPath, { withFileTypes: true });
        return entries
            .map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`)
            .join('\n');
    }
}
