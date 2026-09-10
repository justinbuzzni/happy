/**
 * Query wrapper around official @anthropic-ai/claude-agent-sdk
 * Maps internal QueryOptions to official SDK Options
 */

import { query as sdkQuery, type Options, type Query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync } from 'node:fs'
import type { QueryOptions, QueryPrompt, SDKMessage } from './types'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ensureLocalProxyBypass } from '../utils/proxyBypass'
import { resolveHappyEntrypoint } from './happyEntrypoint'

/**
 * Wraps the official SDK query() with our QueryOptions adapter
 */
export function query(params: { prompt: QueryPrompt; options?: QueryOptions }): Query {
    const opts = params.options
    const settings = resolveSettings(opts)

    // Build system prompt
    let systemPrompt: Options['systemPrompt'] = undefined
    if (opts?.customSystemPrompt) {
        systemPrompt = opts.customSystemPrompt
    } else if (opts?.appendSystemPrompt) {
        systemPrompt = {
            type: 'preset',
            preset: 'claude_code',
            append: opts.appendSystemPrompt
        }
    }

    // Map QueryOptions -> official Options
    const sdkOptions: Options = {
        cwd: opts?.cwd,
        additionalDirectories: opts?.additionalDirectories,
        resume: opts?.resume,
        continue: opts?.continue,
        model: opts?.model,
        fallbackModel: opts?.fallbackModel,
        maxTurns: opts?.maxTurns,
        promptSuggestions: opts?.promptSuggestions,
        permissionMode: opts?.permissionMode,
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        tools: opts?.tools,
        mcpServers: opts?.mcpServers as Options['mcpServers'],
        systemPrompt,
        settings,
        strictMcpConfig: opts?.strictMcpConfig,
        sessionId: undefined,
        effort: opts?.effort,
        agents: opts?.agents,
        settingSources: opts?.settingSources,
        skills: opts?.skills,
        sandbox: opts?.sandbox,
        spawnClaudeCodeProcess: opts?.spawnClaudeCodeProcess,
        // Token-level partials (`stream_event`) let the app render text as it
        // is produced instead of after a whole content block completes.
        includePartialMessages: true,
    }

    // Map abort signal -> AbortController
    if (opts?.abort) {
        const controller = new AbortController()
        opts.abort.addEventListener('abort', () => controller.abort(), { once: true })
        sdkOptions.abortController = controller
    }

    // Build env: tag the spawned Claude with an entrypoint that is NOT in
    // Claude Code's `--resume` picker filter set ({sdk-cli, sdk-ts, sdk-py}),
    // so sessions Happy starts/continues remain visible to a plain
    // `claude --resume` picker. The agent SDK would otherwise default to
    // CLAUDE_CODE_ENTRYPOINT="sdk-ts" and the picker would hide every Happy
    // session. See slopus/happy#1202.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === 'string') env[key] = value
    }
    env.CLAUDE_CODE_ENTRYPOINT = resolveHappyEntrypoint(process.env.CLAUDE_CODE_ENTRYPOINT)
    if (opts?.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        ensureLocalProxyBypass(env)
    }
    sdkOptions.env = env

    // Map canCallTool -> canUseTool
    if (opts?.canCallTool) {
        const callback = opts.canCallTool
        sdkOptions.canUseTool = async (toolName, input, options) => {
            return callback(toolName, input, options)
        }
    }

    return sdkQuery({
        prompt: params.prompt as string | AsyncIterable<SDKUserMessage>,
        options: sdkOptions,
    })
}

function resolveSettings(opts: QueryOptions | undefined): string | undefined {
    if (!opts?.settingsPath || !opts.sandbox) return opts?.settingsPath
    const rawSettings = readFileSync(opts.settingsPath, 'utf8')
    let parsedSettings: unknown
    try {
        parsedSettings = JSON.parse(rawSettings)
    } catch (error) {
        throw new Error('Claude hook settings must contain valid JSON before sandbox merge', { cause: error })
    }
    if (!parsedSettings || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
        throw new Error('Claude hook settings must be a JSON object before sandbox merge')
    }
    return JSON.stringify(parsedSettings)
}
