/**
 * Centralized ignore patterns for file viewer + sync + deploy.
 *
 * ⚠️ Mirror of aplus-dev-studio/packages/web-ui/src/lib/ignorePresets.ts —
 * keep the two copies byte-identical except for indentation/style when
 * adding or removing presets. See aplus-dev-studio's
 * specs/file-ignore-presets/ for the motivation and the full roll-out.
 *
 * The daemon uses this matcher to filter its `getDirectoryTree` RPC
 * response so remote workspaces never ship .git / node_modules /
 * __pycache__ etc. across the wire in the first place. No React / DOM
 * deps — pure module.
 */

export type PresetName =
    | 'common'
    | 'node'
    | 'python'
    | 'rust'
    | 'jvm'
    | 'go'
    | 'mobile'
    | 'editor'
    | 'agent'

export const PRESET_NAMES: readonly PresetName[] = [
    'common',
    'node',
    'python',
    'rust',
    'jvm',
    'go',
    'mobile',
    'editor',
    'agent',
]

interface Preset {
    /** Exact segment matches (directory or file name). */
    segments: readonly string[]
    /** Basename globs — wildcard `*` only, matched against the final path segment. */
    globs: readonly string[]
}

const PRESETS: Record<PresetName, Preset> = {
    common: {
        segments: ['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db'],
        globs: [],
    },
    node: {
        segments: [
            'node_modules',
            '.next',
            '.nuxt',
            '.svelte-kit',
            'dist',
            'build',
            '.turbo',
            '.cache',
            '.parcel-cache',
        ],
        globs: [],
    },
    python: {
        segments: [
            '__pycache__',
            '.venv',
            'venv',
            '.pytest_cache',
            '.mypy_cache',
            '.ruff_cache',
            '.tox',
        ],
        globs: ['*.pyc'],
    },
    rust: {
        segments: ['target'],
        globs: [],
    },
    jvm: {
        segments: ['.gradle'],
        globs: ['*.iml'],
    },
    go: {
        // `vendor` is intentionally omitted — it's frequently a real source dir
        // in Go projects. Re-enable per-project once override UX exists.
        segments: ['bin'],
        globs: [],
    },
    mobile: {
        segments: ['Pods', 'DerivedData'],
        globs: ['*.xcuserstate'],
    },
    editor: {
        segments: ['.idea', '.vscode'],
        globs: ['*.swp', '*~'],
    },
    agent: {
        // AI coding tool state dirs that leak agent memory/sessions if deployed.
        segments: ['.claude', '.omc', '.happy', '.codex', '.cursor', '.aider'],
        globs: [],
    },
}

export interface IgnoreMatcherOptions {
    /** Active presets. Defaults to all. */
    presets?: readonly PresetName[]
}

export interface IgnoreMatcher {
    shouldIgnore(path: string): boolean
    /** Flat union of segment literals across active presets. For tar/CLI consumers. */
    getSegmentLiterals(): readonly string[]
    /** Flat union of basename globs. */
    getGlobBasenames(): readonly string[]
}

export function createIgnoreMatcher(options: IgnoreMatcherOptions = {}): IgnoreMatcher {
    const active = options.presets ?? PRESET_NAMES
    const segmentSet = new Set<string>()
    const globs: string[] = []
    for (const name of active) {
        const preset = PRESETS[name]
        if (!preset) continue
        for (const s of preset.segments) segmentSet.add(s)
        for (const g of preset.globs) {
            if (!globs.includes(g)) globs.push(g)
        }
    }
    const globRegexes = globs.map(compileGlob)
    const segmentLiterals = Array.from(segmentSet)

    function shouldIgnore(path: string): boolean {
        const segments = splitSegments(path)
        if (segments.length === 0) return false
        for (const seg of segments) {
            if (segmentSet.has(seg)) return true
        }
        const basename = segments[segments.length - 1]
        for (const re of globRegexes) {
            if (re.test(basename)) return true
        }
        return false
    }

    return {
        shouldIgnore,
        getSegmentLiterals: () => segmentLiterals,
        getGlobBasenames: () => globs,
    }
}

function splitSegments(path: string): string[] {
    return path.split('/').filter((s) => s.length > 0 && s !== '.')
}

function compileGlob(glob: string): RegExp {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`)
}
