import { describe, expect, it } from 'vitest';

import {
    classifyCheckpointEntry,
    sanitizeGitConfig,
    CHECKPOINT_MAX_FILE_BYTES,
} from './managedCheckpointScope';

describe('classifyCheckpointEntry', () => {
    it('shouldIncludeOrdinaryProjectFile', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'src/index.ts', type: 'file', bytes: 10 }))
            .toEqual({ include: true, reason: 'project-file' });
    });

    it('shouldIncludeGitMetadataAndLinkedWorktreePointer', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: '.git/HEAD', type: 'file', bytes: 23 }).include).toBe(true);
        expect(classifyCheckpointEntry({ area: 'project', path: '.git/worktrees/w1/gitdir', type: 'file', bytes: 30 }))
            .toEqual({ include: true, reason: 'git-metadata' });
    });

    it('shouldExcludeRegeneratableTreesButKeepLockfileAndToolchainVersion', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'node_modules/left-pad/index.js', type: 'file', bytes: 10 }))
            .toEqual({ include: false, reason: 'regeneratable' });
        expect(classifyCheckpointEntry({ area: 'project', path: 'pnpm-lock.yaml', type: 'file', bytes: 10 }).include).toBe(true);
        expect(classifyCheckpointEntry({ area: 'project', path: '.nvmrc', type: 'file', bytes: 6 }).include).toBe(true);
    });

    it('shouldExcludeProviderCredentialsFromProviderStateArea', () => {
        expect(classifyCheckpointEntry({ area: 'provider-state', path: 'auth.json', type: 'file', bytes: 10 }))
            .toEqual({ include: false, reason: 'credential' });
        expect(classifyCheckpointEntry({ area: 'provider-state', path: '.credentials.json', type: 'file', bytes: 10 }))
            .toEqual({ include: false, reason: 'credential' });
    });

    it('shouldCarryOnlyTheNamedSessionsOutOfProviderState', () => {
        const sessions = ['s-mine'];
        expect(classifyCheckpointEntry({
            area: 'provider-state', path: 'sessions/s-mine/rollout.jsonl', type: 'file', bytes: 10,
            providerStateSessions: sessions,
        })).toEqual({ include: true, reason: 'provider-state' });
        expect(classifyCheckpointEntry({
            area: 'provider-state', path: 'sessions/s-someone-else/rollout.jsonl', type: 'file', bytes: 10,
            providerStateSessions: sessions,
        })).toEqual({ include: false, reason: 'not-allowlisted' });
        // Anything a future provider release drops next to sessions is out by
        // default rather than in by default.
        expect(classifyCheckpointEntry({
            area: 'provider-state', path: 'config.toml', type: 'file', bytes: 10, providerStateSessions: sessions,
        })).toEqual({ include: false, reason: 'not-allowlisted' });
        expect(classifyCheckpointEntry({
            area: 'provider-state', path: 'brand-new-feature/state.db', type: 'file', bytes: 10,
            providerStateSessions: sessions,
        })).toEqual({ include: false, reason: 'not-allowlisted' });
    });

    it('shouldExcludeGitCredentialStoresLivingInsideTheRepository', () => {
        for (const path of ['.git/credentials', '.git/aplus-auth', '.git-credentials']) {
            expect(classifyCheckpointEntry({ area: 'project', path, type: 'file', bytes: 10 }))
                .toEqual({ include: false, reason: 'credential' });
        }
    });

    it('shouldMarkEveryGitConfigLayerForSanitizationNotJustTheMainOne', () => {
        // `extensions.worktreeConfig`, linked worktrees and submodules each get
        // their own config file, and any of them can hold an extraHeader.
        for (const path of [
            '.git/config',
            '.git/config.worktree',
            '.git/worktrees/feature/config.worktree',
            '.git/modules/vendor/config',
        ]) {
            expect(classifyCheckpointEntry({ area: 'project', path, type: 'file', bytes: 10 }))
                .toEqual({ include: true, reason: 'git-config', sanitize: 'git-config' });
        }
    });

    it('shouldNotMistakeAnOrdinaryProjectFileNamedConfigForAGitConfig', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'src/config', type: 'file', bytes: 10 }))
            .toEqual({ include: true, reason: 'project-file' });
        expect(classifyCheckpointEntry({ area: 'project', path: '.git/HEAD', type: 'file', bytes: 10 }))
            .toEqual({ include: true, reason: 'git-metadata' });
    });

    it('shouldExcludePersonalGlobalHistoryFromProviderStateArea', () => {
        expect(classifyCheckpointEntry({ area: 'provider-state', path: 'history.jsonl', type: 'file', bytes: 10 }))
            .toEqual({ include: false, reason: 'personal-history' });
    });

    it('shouldExcludeCredentialFilesEvenInsideProject', () => {
        for (const path of ['.ssh/id_rsa', '.aws/credentials', '.netrc', '.codex/auth.json', '.claude/.credentials.json']) {
            expect(classifyCheckpointEntry({ area: 'project', path, type: 'file', bytes: 10 }))
                .toEqual({ include: false, reason: 'credential' });
        }
    });

    it('shouldExcludeFileOverSizeLimitWithItsOwnReason', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'big.bin', type: 'file', bytes: CHECKPOINT_MAX_FILE_BYTES + 1 }))
            .toEqual({ include: false, reason: 'too-large' });
        expect(classifyCheckpointEntry({ area: 'project', path: 'big.bin', type: 'file', bytes: CHECKPOINT_MAX_FILE_BYTES }).include).toBe(true);
    });

    it('shouldIncludeSymlinkOnlyWhenTargetStaysInsideArea', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'a/link', type: 'symlink', bytes: 0, linkTarget: '../b/file' }))
            .toEqual({ include: true, reason: 'project-file' });
        expect(classifyCheckpointEntry({ area: 'project', path: 'a/link', type: 'symlink', bytes: 0, linkTarget: '../../etc/passwd' }))
            .toEqual({ include: false, reason: 'link-escape' });
        expect(classifyCheckpointEntry({ area: 'project', path: 'link', type: 'symlink', bytes: 0, linkTarget: '/etc/passwd' }))
            .toEqual({ include: false, reason: 'link-escape' });
    });

    it('shouldRefuseUnsafePathsInsteadOfSilentlyExcludingThem', () => {
        for (const path of ['/abs', '../up', 'a/../../up', '', 'a/\0b', './a', 'a//b']) {
            expect(() => classifyCheckpointEntry({ area: 'project', path, type: 'file', bytes: 1 }))
                .toThrow('unsafe checkpoint path');
        }
    });

    it('shouldExcludeDeviceAndSocketEntries', () => {
        expect(classifyCheckpointEntry({ area: 'project', path: 'weird', type: 'other', bytes: 0 }))
            .toEqual({ include: false, reason: 'unsupported-type' });
    });

    it('shouldRemoveCredentialsFromGitConfigWithoutLosingTheRest', () => {
        const sanitized = sanitizeGitConfig([
            '[core]',
            '\trepositoryformatversion = 0',
            '[remote "origin"]',
            '\turl = https://oauth2:ghp_secret@github.com/acme/repo.git',
            '\tfetch = +refs/heads/*:refs/remotes/origin/*',
            '[http "https://github.com/"]',
            '\textraHeader = Authorization: Bearer ghp_secret',
            '[credential]',
            '\thelper = store --file=/root/.git-credentials',
            '[branch "main"]',
            '\tremote = origin',
        ].join('\n'));

        expect(sanitized).not.toContain('ghp_secret');
        expect(sanitized).not.toContain('extraHeader');
        expect(sanitized).not.toContain('helper');
        expect(sanitized).not.toContain('[credential]');
        expect(sanitized).toContain('url = https://github.com/acme/repo.git');
        expect(sanitized).toContain('fetch = +refs/heads/*:refs/remotes/origin/*');
        expect(sanitized).toContain('[branch "main"]');
        expect(sanitized).toContain('repositoryformatversion = 0');
    });

    it('shouldLeaveAConfigWithoutCredentialsByteIdentical', () => {
        const clean = '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/repo.git\n';
        expect(sanitizeGitConfig(clean)).toBe(clean);
    });
});
