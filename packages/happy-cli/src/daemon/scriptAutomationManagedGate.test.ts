import { describe, expect, it } from 'vitest';

import { shouldRunScriptAutomations } from './run';

/**
 * The one decision that keeps the script automation worker out of a managed
 * runtime. It is asserted here rather than through `startDaemon`, which pulls
 * in the whole daemon bootstrap; what this pins is the predicate the
 * initialisation branch actually calls.
 */

describe('script automations in a managed runtime', () => {
    it('does not start when the runtime is managed, whatever the flag says', () => {
        // The worker drives Docker directly. Nothing it does passes through
        // `spawnSession`, so a managed run's lease, epoch and budget checks
        // would never see it.
        expect(shouldRunScriptAutomations({ managedRuntimeActive: true, enabled: '1' })).toBe(false);
        expect(shouldRunScriptAutomations({ managedRuntimeActive: true, enabled: undefined })).toBe(false);
        expect(shouldRunScriptAutomations({ managedRuntimeActive: true, enabled: '0' })).toBe(false);
    });

    it('keeps the BYOS behaviour exactly as it was', () => {
        expect(shouldRunScriptAutomations({ managedRuntimeActive: false, enabled: '1' })).toBe(true);
        expect(shouldRunScriptAutomations({ managedRuntimeActive: false, enabled: undefined })).toBe(false);
        expect(shouldRunScriptAutomations({ managedRuntimeActive: false, enabled: '0' })).toBe(false);
        expect(shouldRunScriptAutomations({ managedRuntimeActive: false, enabled: 'true' })).toBe(false);
    });
});
