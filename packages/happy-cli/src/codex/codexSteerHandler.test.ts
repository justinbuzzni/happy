import { describe, expect, it, vi } from 'vitest';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { registerCodexSteerHandler } from './codexSteerHandler';

function createHarness(
    steerTurn = vi.fn(async (_text: string) => undefined),
    managedRun = false,
) {
    let handler: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
    const sendSessionProtocolMessage = vi.fn((_envelope: SessionEnvelope) => undefined);
    const onFailure = vi.fn();

    registerCodexSteerHandler({
        client: { steerTurn },
        session: {
            rpcHandlerManager: {
                registerHandler: (_method, registeredHandler) => {
                    handler = registeredHandler;
                },
            },
            sendSessionProtocolMessage,
        },
        onFailure,
        managedRun,
    });

    if (!handler) throw new Error('steer handler was not registered');
    return { handler, steerTurn, sendSessionProtocolMessage, onFailure };
}

describe('registerCodexSteerHandler', () => {
    it('records an accepted steer as one user protocol message', async () => {
        const harness = createHarness();

        await expect(harness.handler({ text: 'apply this now' })).resolves.toEqual({ success: true });
        expect(harness.steerTurn).toHaveBeenCalledWith('apply this now');
        expect(harness.sendSessionProtocolMessage).toHaveBeenCalledOnce();
        expect(harness.sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({
            role: 'user',
            ev: { t: 'text', text: 'apply this now' },
        }));
    });

    it('does not record a user message when Codex rejects the steer', async () => {
        const harness = createHarness(vi.fn(async () => {
            throw new Error('no active turn');
        }));

        await expect(harness.handler({ text: 'too late' })).resolves.toEqual({
            success: false,
            error: 'no active turn',
        });
        expect(harness.sendSessionProtocolMessage).not.toHaveBeenCalled();
        expect(harness.onFailure).toHaveBeenCalledWith('no active turn');
    });

    it('rejects empty text without steering or recording it', async () => {
        const harness = createHarness();

        await expect(harness.handler({ text: '   ' })).resolves.toEqual({
            success: false,
            error: 'Steer text is required',
        });
        expect(harness.steerTurn).not.toHaveBeenCalled();
        expect(harness.sendSessionProtocolMessage).not.toHaveBeenCalled();
    });

    /**
     * Steering injects free text into the turn that is already running. For a
     * managed Cloud run that is an instruction its admission never covered, so
     * it is refused before the turn is touched at all — not after, and not by
     * the provider.
     */
    it('refuses to steer a managed run, without reaching the turn', async () => {
        const steerTurn = vi.fn(async (_text: string) => undefined);
        const { handler, sendSessionProtocolMessage, onFailure } = createHarness(steerTurn, true);

        await expect(handler({ text: 'do something else' }))
            .resolves.toEqual({ success: false, error: 'A managed run cannot be steered' });

        expect(steerTurn).not.toHaveBeenCalled();
        // Nothing was recorded either: a refused instruction is not a message
        // the session took.
        expect(sendSessionProtocolMessage).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('still steers an ordinary run', async () => {
        const steerTurn = vi.fn(async (_text: string) => undefined);
        const { handler } = createHarness(steerTurn, false);
        await expect(handler({ text: 'do something else' })).resolves.toEqual({ success: true });
        expect(steerTurn).toHaveBeenCalledWith('do something else');
    });
});
