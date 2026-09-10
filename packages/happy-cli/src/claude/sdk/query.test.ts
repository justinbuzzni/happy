import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    beforeEach(() => {
        sdkQuery.mockClear();
    });

    it('forwards the built-in tool allowance, including the empty list that disables them', () => {
        query({ prompt: 'continue', options: { tools: [] } });
        // 빈 배열은 "전부 끈다" 는 뜻이다. 여기서 흘리면 관리 실행의 도구 경계가
        // SDK 까지 도달하지 못한다.
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: [] }),
        }));

        sdkQuery.mockClear();
        query({ prompt: 'continue', options: { tools: ['Read'] } });
        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ tools: ['Read'] }),
        }));
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });

    it('enables partial assistant message streaming so the app can render tokens before a block completes', () => {
        query({ prompt: 'continue', options: {} });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ includePartialMessages: true }),
        }));
    });

    it('forwards additional directories to the Claude Agent SDK for new and resumed queries', () => {
        for (const resume of [undefined, 'claude-session-id']) {
            query({
                prompt: 'continue',
                options: {
                    additionalDirectories: ['/repo/frontend', '/repo/backend'],
                    resume,
                },
            });
        }

        expect(sdkQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: undefined,
            }),
        }));
        expect(sdkQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: 'claude-session-id',
            }),
        }));
    });

    it('forwards fail-closed sandbox settings to the Claude Agent SDK', () => {
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };

        query({ prompt: 'edit', options: { sandbox } });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox }),
        }));
    });

    it('inlines hook settings when sandbox settings must be merged by the SDK', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happy-query-settings-'));
        const settingsPath = join(directory, 'settings.json');
        const hooks = { hooks: { SessionStart: [{ matcher: '*' }] } };
        writeFileSync(settingsPath, JSON.stringify(hooks));
        const sandbox = { enabled: true, failIfUnavailable: true };
        try {
            query({ prompt: 'edit', options: { settingsPath, sandbox } });

            const settings = (sdkQuery.mock.calls as unknown as Array<Array<any>>)[0][0].options.settings;
            expect(typeof settings).toBe('string');
            expect(JSON.parse(settings as string)).toEqual(hooks);
            expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
                options: expect.objectContaining({ sandbox }),
            }));
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
