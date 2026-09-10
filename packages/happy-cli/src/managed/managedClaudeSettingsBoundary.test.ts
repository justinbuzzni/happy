/**
 * What `claudeRemote` hands the SDK, captured where it is handed over.
 *
 * `settingSources` decides which settings files the Claude Agent SDK loads,
 * and a settings file's `env` block is applied to the agent — winning over the
 * environment this startup produced. The SDK's default (`undefined`) loads
 * every source Claude Code would, including `~/.claude/settings.json`, so a
 * managed run has to say "none" explicitly.
 *
 * This asserts on the options object the real call site builds, not on a
 * helper: a helper that returns the right value proves nothing if the call
 * site stops using it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedOptions: Array<Record<string, unknown>> = [];

vi.mock('@/claude/sdk', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/claude/sdk')>();
    return {
        ...original,
        query: (input: { options: Record<string, unknown> }) => {
            capturedOptions.push(input.options);
            // Ends the turn immediately: the options are the subject here.
            return Object.assign((async function* () { /* no messages */ })(), {
                setPermissionMode: async () => {},
                interrupt: async () => {},
            });
        },
    };
});

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(),
        infoDeveloper: vi.fn(), warn: vi.fn(), logFilePath: '/tmp/log',
    },
}));

import { claudeRemote } from '@/claude/claudeRemote';

async function runOnce(over: Record<string, unknown>) {
    let handedOut = false;
    await claudeRemote({
        sessionId: null,
        path: '/workspace/project',
        allowedTools: [],
        hookSettingsPath: '/tmp/hook-settings.json',
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }) as never,
        nextMessage: async () => {
            if (handedOut) return null;
            handedOut = true;
            return {
                message: 'do the thing',
                mode: { permissionMode: 'default', model: 'claude-opus-5' } as never,
            };
        },
        onReady: () => {},
        isAborted: () => false,
        onSessionFound: () => {},
        onMessage: () => {},
        ...over,
    } as never).catch(() => { /* the turn ends as soon as options are built */ });
}

describe('the settings sources claudeRemote gives the SDK', () => {
    beforeEach(() => {
        capturedOptions.length = 0;
        delete process.env.HAPPY_SETTING_SOURCES;
    });

    it('is an explicit empty list for a managed run', async () => {
        // Even with the operator's own configuration present, which an
        // ordinary run would honour.
        process.env.HAPPY_SETTING_SOURCES = 'user,project';
        await runOnce({ managedSettingsLockdown: true });

        expect(capturedOptions).toHaveLength(1);
        expect(capturedOptions[0].settingSources).toEqual([]);
        // Not the SDK default, which is what `undefined` means.
        expect(capturedOptions[0].settingSources).not.toBeUndefined();
        // The trusted settings this session generates are still handed over.
        expect(capturedOptions[0].settingsPath).toBe('/tmp/hook-settings.json');
    }, 30_000);

    it('leaves an ordinary run on the SDK default', async () => {
        await runOnce({});
        expect(capturedOptions).toHaveLength(1);
        expect(capturedOptions[0].settingSources).toBeUndefined();
    }, 30_000);

    it('still honours the operator configuration on an ordinary run', async () => {
        process.env.HAPPY_SETTING_SOURCES = 'project,local';
        await runOnce({});
        expect(capturedOptions[0].settingSources).toEqual(['project', 'local']);
    }, 30_000);
});
