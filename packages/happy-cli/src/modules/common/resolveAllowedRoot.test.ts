import { describe, it, expect } from 'vitest';
import { resolveAllowedRoot } from './resolveAllowedRoot';

describe('resolveAllowedRoot', () => {
    const homeDir = '/Users/namsangboy';

    it('uses an absolute registryWorkspaceRoot verbatim', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '/opt/work',
            homeDir,
        })).toBe('/opt/work');
    });

    it('joins a relative registryWorkspaceRoot under homeDir', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: 'workspace/aplus-dev-studio-workspace',
            homeDir,
        })).toBe('/Users/namsangboy/workspace/aplus-dev-studio-workspace');
    });

    it('falls back to homeDir when registryWorkspaceRoot is null', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: null,
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('falls back to homeDir when registryWorkspaceRoot is undefined', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: undefined,
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('falls back to homeDir when registryWorkspaceRoot is empty string', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '',
            homeDir,
        })).toBe('/Users/namsangboy');
    });

    it('strips a trailing slash from registryWorkspaceRoot', () => {
        expect(resolveAllowedRoot({
            registryWorkspaceRoot: '/opt/work/',
            homeDir,
        })).toBe('/opt/work');
    });
});
