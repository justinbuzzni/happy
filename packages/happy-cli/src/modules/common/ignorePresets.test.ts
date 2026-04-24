/**
 * Tests for the ignore-preset matcher.
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/ignorePresets.spec.ts —
 * if you tweak a preset or matching rule, update both files.
 */

import { describe, it, expect } from 'vitest'
import { createIgnoreMatcher, PRESET_NAMES } from './ignorePresets'

describe('createIgnoreMatcher — default (all presets on)', () => {
    const matcher = createIgnoreMatcher()

    it('ignores common VCS/OS paths', () => {
        expect(matcher.shouldIgnore('.git')).toBe(true)
        expect(matcher.shouldIgnore('.svn')).toBe(true)
        expect(matcher.shouldIgnore('.DS_Store')).toBe(true)
        expect(matcher.shouldIgnore('Thumbs.db')).toBe(true)
    })

    it('ignores Node.js build/deps directories', () => {
        expect(matcher.shouldIgnore('node_modules')).toBe(true)
        expect(matcher.shouldIgnore('.next')).toBe(true)
        expect(matcher.shouldIgnore('.nuxt')).toBe(true)
        expect(matcher.shouldIgnore('dist')).toBe(true)
        expect(matcher.shouldIgnore('build')).toBe(true)
        expect(matcher.shouldIgnore('.turbo')).toBe(true)
        expect(matcher.shouldIgnore('.cache')).toBe(true)
        expect(matcher.shouldIgnore('.parcel-cache')).toBe(true)
    })

    it('ignores Python artifacts including *.pyc glob', () => {
        expect(matcher.shouldIgnore('__pycache__')).toBe(true)
        expect(matcher.shouldIgnore('.venv')).toBe(true)
        expect(matcher.shouldIgnore('venv')).toBe(true)
        expect(matcher.shouldIgnore('.pytest_cache')).toBe(true)
        expect(matcher.shouldIgnore('foo.pyc')).toBe(true)
        expect(matcher.shouldIgnore('src/utils/bar.pyc')).toBe(true)
    })

    it('ignores Rust target', () => {
        expect(matcher.shouldIgnore('target')).toBe(true)
    })

    it('ignores JVM build artifacts', () => {
        expect(matcher.shouldIgnore('.gradle')).toBe(true)
        expect(matcher.shouldIgnore('module.iml')).toBe(true)
    })

    it('ignores iOS/Android mobile build output', () => {
        expect(matcher.shouldIgnore('Pods')).toBe(true)
        expect(matcher.shouldIgnore('DerivedData')).toBe(true)
        expect(matcher.shouldIgnore('Something.xcuserstate')).toBe(true)
    })

    it('ignores editor artifacts', () => {
        expect(matcher.shouldIgnore('.idea')).toBe(true)
        expect(matcher.shouldIgnore('file.swp')).toBe(true)
        expect(matcher.shouldIgnore('backup~')).toBe(true)
    })

    it('ignores AI coding agent state directories', () => {
        expect(matcher.shouldIgnore('.claude')).toBe(true)
        expect(matcher.shouldIgnore('.omc')).toBe(true)
        expect(matcher.shouldIgnore('.happy')).toBe(true)
        expect(matcher.shouldIgnore('.codex')).toBe(true)
        expect(matcher.shouldIgnore('.cursor')).toBe(true)
        expect(matcher.shouldIgnore('.aider')).toBe(true)
    })

    it('ignores agent paths when nested', () => {
        expect(matcher.shouldIgnore('.claude/projects/x/memory/MEMORY.md')).toBe(true)
        expect(matcher.shouldIgnore('.omc/sessions/y.json')).toBe(true)
        expect(matcher.shouldIgnore('packages/foo/.cursor/rules.md')).toBe(true)
    })

    it('does NOT match partial segment for agent names', () => {
        expect(matcher.shouldIgnore('my-.claude-backup')).toBe(false)
        expect(matcher.shouldIgnore('cursor-app/file')).toBe(false)
        expect(matcher.shouldIgnore('src/claude/helper.ts')).toBe(false)
    })

    it('matches the pattern on any nested segment (not just the root)', () => {
        expect(matcher.shouldIgnore('src/node_modules/foo')).toBe(true)
        expect(matcher.shouldIgnore('a/b/.git/HEAD')).toBe(true)
        expect(matcher.shouldIgnore('packages/app/dist/bundle.js')).toBe(true)
    })

    it('does NOT match partial segment prefix/suffix', () => {
        expect(matcher.shouldIgnore('my-node_modules-backup')).toBe(false)
        expect(matcher.shouldIgnore('gitignore')).toBe(false)
        expect(matcher.shouldIgnore('src/nodes/modules.js')).toBe(false)
        expect(matcher.shouldIgnore('distribution')).toBe(false)
    })

    it('does NOT ignore normal source files', () => {
        expect(matcher.shouldIgnore('src/index.ts')).toBe(false)
        expect(matcher.shouldIgnore('README.md')).toBe(false)
        expect(matcher.shouldIgnore('package.json')).toBe(false)
        expect(matcher.shouldIgnore('a/b/c.py')).toBe(false)
    })

    it('handles leading ./ and trailing /', () => {
        expect(matcher.shouldIgnore('./node_modules')).toBe(true)
        expect(matcher.shouldIgnore('node_modules/')).toBe(true)
        expect(matcher.shouldIgnore('./src/.git/')).toBe(true)
    })

    it('is case-sensitive', () => {
        expect(matcher.shouldIgnore('Node_Modules')).toBe(false)
        expect(matcher.shouldIgnore('.GIT')).toBe(false)
        expect(matcher.shouldIgnore('DIST')).toBe(false)
    })

    it('returns false for empty or root paths', () => {
        expect(matcher.shouldIgnore('')).toBe(false)
        expect(matcher.shouldIgnore('/')).toBe(false)
        expect(matcher.shouldIgnore('.')).toBe(false)
    })
})

describe('createIgnoreMatcher — selective presets', () => {
    it('only applies enabled presets', () => {
        const matcher = createIgnoreMatcher({ presets: ['common'] })
        expect(matcher.shouldIgnore('.git')).toBe(true)
        expect(matcher.shouldIgnore('node_modules')).toBe(false)
        expect(matcher.shouldIgnore('__pycache__')).toBe(false)
        expect(matcher.shouldIgnore('target')).toBe(false)
    })

    it('empty presets array ignores nothing', () => {
        const matcher = createIgnoreMatcher({ presets: [] })
        expect(matcher.shouldIgnore('.git')).toBe(false)
        expect(matcher.shouldIgnore('node_modules')).toBe(false)
    })

    it('combining presets unions their patterns', () => {
        const matcher = createIgnoreMatcher({ presets: ['common', 'python'] })
        expect(matcher.shouldIgnore('.git')).toBe(true)
        expect(matcher.shouldIgnore('__pycache__')).toBe(true)
        expect(matcher.shouldIgnore('node_modules')).toBe(false)
    })

    it('does not apply agent patterns when agent preset disabled', () => {
        const matcher = createIgnoreMatcher({ presets: ['common'] })
        expect(matcher.shouldIgnore('.claude')).toBe(false)
        expect(matcher.shouldIgnore('.omc')).toBe(false)
        expect(matcher.shouldIgnore('.cursor')).toBe(false)
    })

    it('agent preset alone only matches its own patterns', () => {
        const matcher = createIgnoreMatcher({ presets: ['agent'] })
        expect(matcher.shouldIgnore('.claude')).toBe(true)
        expect(matcher.shouldIgnore('.omc')).toBe(true)
        expect(matcher.shouldIgnore('node_modules')).toBe(false)
        expect(matcher.shouldIgnore('.git')).toBe(false)
    })

    it('PRESET_NAMES exposes all known presets', () => {
        expect(PRESET_NAMES).toEqual(
            expect.arrayContaining(['common', 'node', 'python', 'rust', 'jvm', 'go', 'mobile', 'editor', 'agent']),
        )
    })
})
