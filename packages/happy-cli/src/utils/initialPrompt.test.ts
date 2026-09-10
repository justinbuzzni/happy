import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  consumeConfirmedInitialPromptDelivery,
  INITIAL_PROMPT_INLINE_LIMIT_BYTES,
  consumePendingInitialAppendSystemPrompt,
  consumePendingInitialEffort,
  consumePendingInitialModel,
  consumePendingInitialPrompt,
  consumePendingInitialSaycodePromptBlocks,
  consumePendingInitialSaycodeSystemPromptEnabled,
  normalizeClaudeModelForRuntime,
  stageInitialPromptEnvironment,
} from './initialPrompt'

// 2026-08-27 프로덕션 — AgentTask 리뷰가 diff 를 프롬프트에 인라인하는데, 그
// 프롬프트가 HAPPY_INITIAL_PROMPT 환경변수로 전달된다. Linux 의 단일 env 한도는
// MAX_ARG_STRLEN(32 * 4096 = 131072 바이트)이라, justin-work PR #17 의 143,500
// 바이트 diff 에서 spawn 이 E2BIG 으로 죽었다. 큰 프롬프트는 파일로 넘긴다.
describe('initial prompt staging (E2BIG)', () => {
  it('keeps a small prompt inline so the common spawn path is unchanged', async () => {
    const staged = await stageInitialPromptEnvironment('review this', {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env).toEqual({ HAPPY_INITIAL_PROMPT: 'review this' })
    expect(staged.cleanup).toBeUndefined()
  })

  it('stages a prompt over the inline limit as a file instead of an env value', async () => {
    const big = 'x'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES + 1)
    const staged = await stageInitialPromptEnvironment(big, {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    const file = staged.env.HAPPY_INITIAL_PROMPT_FILE!
    expect(file).toBeTruthy()
    expect(await readFile(file, 'utf8')).toBe(big)
    await staged.cleanup?.()
  })

  // 문자 길이가 아니라 바이트 길이로 재야 한다 — 한국어는 UTF-8 로 3바이트다.
  it('measures the limit in utf-8 bytes, not string length', async () => {
    const multibyte = '가'.repeat(INITIAL_PROMPT_INLINE_LIMIT_BYTES - 10)
    expect(multibyte.length).toBeLessThan(INITIAL_PROMPT_INLINE_LIMIT_BYTES)
    expect(Buffer.byteLength(multibyte, 'utf8')).toBeGreaterThan(INITIAL_PROMPT_INLINE_LIMIT_BYTES)

    const staged = await stageInitialPromptEnvironment(multibyte, {
      makeTempDir: () => mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-')),
    })

    expect(staged.env.HAPPY_INITIAL_PROMPT).toBeUndefined()
    expect(staged.env.HAPPY_INITIAL_PROMPT_FILE).toBeTruthy()
    await staged.cleanup?.()
  })

  it('stays under the kernel per-variable limit for an inline prompt', () => {
    // 한도 자체가 커널 상수(32 * 4096)보다 작아야 의미가 있다.
    expect(INITIAL_PROMPT_INLINE_LIMIT_BYTES).toBeLessThan(32 * 4096)
  })
})

describe('consumePendingInitialPrompt', () => {
  it('reads an inline prompt exactly once', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_PROMPT: 'review this' }

    expect(consumePendingInitialPrompt(env)).toBe('review this')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT')
    expect(consumePendingInitialPrompt(env)).toBeNull()
  })

  it('reads a staged file, then removes both the variable and the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-initial-prompt-test-'))
    const file = join(dir, 'prompt.txt')
    await writeFile(file, 'a very large review prompt', 'utf8')
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_PROMPT_FILE: file }

    expect(consumePendingInitialPrompt(env)).toBe('a very large review prompt')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT_FILE')
    expect(existsSync(file)).toBe(false)
  })

  // 파일이 사라졌다고 세션 시작 자체가 죽으면 안 된다 — 프롬프트 없이 뜨는 게
  // 낫다. 던지면 spawn 이 통째로 실패한다.
  it('returns null instead of throwing when the staged file is gone', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_PROMPT_FILE: join(tmpdir(), 'happy-initial-prompt-missing-file'),
    }

    expect(consumePendingInitialPrompt(env)).toBeNull()
    expect(env).not.toHaveProperty('HAPPY_INITIAL_PROMPT_FILE')
  })
})

describe('consumePendingInitialAppendSystemPrompt', () => {
  it('reads a recovered user/project prompt exactly once without trimming its contents', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_APPEND_SYSTEM_PROMPT: ' USER CONTEXT ' }

    expect(consumePendingInitialAppendSystemPrompt(env)).toBe(' USER CONTEXT ')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_APPEND_SYSTEM_PROMPT')
    expect(consumePendingInitialAppendSystemPrompt(env)).toBeUndefined()
  })

  it('treats an empty value as absent', () => {
    expect(consumePendingInitialAppendSystemPrompt({ HAPPY_INITIAL_APPEND_SYSTEM_PROMPT: '' }))
      .toBeUndefined()
  })
})

describe('consumePendingInitialModel', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_MODEL: ' opus ' }

    expect(consumePendingInitialModel(env)).toBe('opus')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_MODEL')
    expect(consumePendingInitialModel(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialModel({ HAPPY_INITIAL_MODEL: '   ' })).toBeNull()
    expect(consumePendingInitialModel({})).toBeNull()
  })
})

describe('normalizeClaudeModelForRuntime', () => {
  it('maps Claude model families to Z.AI aliases and removes Fable', () => {
    expect(normalizeClaudeModelForRuntime('claude-fable-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBeUndefined()
    expect(normalizeClaudeModelForRuntime('fable', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBeUndefined()
    expect(normalizeClaudeModelForRuntime('claude-opus-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('opus')
    expect(normalizeClaudeModelForRuntime('claude-sonnet-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('sonnet')
    expect(normalizeClaudeModelForRuntime('claude-haiku-4-5', {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    })).toBe('haiku')
    expect(normalizeClaudeModelForRuntime('claude-fable-5', {})).toBe('claude-fable-5')
  })
})

describe('consumePendingInitialEffort', () => {
  it('reads the seed exactly once and scrubs it from the environment', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_INITIAL_EFFORT: 'high' }

    expect(consumePendingInitialEffort(env)).toBe('high')
    expect(env).not.toHaveProperty('HAPPY_INITIAL_EFFORT')
    expect(consumePendingInitialEffort(env)).toBeNull()
  })

  it('treats a blank value as absent', () => {
    expect(consumePendingInitialEffort({ HAPPY_INITIAL_EFFORT: '' })).toBeNull()
    expect(consumePendingInitialEffort({})).toBeNull()
  })
})

describe('consumePendingInitialSaycodeSystemPromptEnabled', () => {
  it('reads an explicit recovery policy exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'false',
    }

    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBe(false)
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED')
    expect(consumePendingInitialSaycodeSystemPromptEnabled(env)).toBeUndefined()
  })

  it('preserves legacy enabled behavior for absent or invalid values', () => {
    expect(consumePendingInitialSaycodeSystemPromptEnabled({})).toBeUndefined()
    expect(consumePendingInitialSaycodeSystemPromptEnabled({
      HAPPY_INITIAL_SAYCODE_SYSTEM_PROMPT_ENABLED: 'invalid',
    })).toBeUndefined()
  })
})

describe('consumePendingInitialSaycodePromptBlocks', () => {
  it('reads a JSON block override map exactly once', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '{"workerDelegation":false,"axBase":true}',
    }

    expect(consumePendingInitialSaycodePromptBlocks(env)).toEqual({
      workerDelegation: false,
      axBase: true,
    })
    expect(env).not.toHaveProperty('HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS')
    expect(consumePendingInitialSaycodePromptBlocks(env)).toBeUndefined()
  })

  it('degrades malformed values to no-override instead of poisoning the session', () => {
    // A recovery seed is machine-produced but still crosses a process boundary —
    // a broken value must fall back to the legacy master inheritance, mirroring
    // MessageMetaSchema's catch(undefined) on the wire.
    expect(consumePendingInitialSaycodePromptBlocks({})).toBeUndefined()
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: 'not json',
    })).toBeUndefined()
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '["array"]',
    })).toBeUndefined()
    // Non-boolean entries are dropped, boolean ones survive.
    expect(consumePendingInitialSaycodePromptBlocks({
      HAPPY_INITIAL_SAYCODE_PROMPT_BLOCKS: '{"workerDelegation":"no","axBase":false}',
    })).toEqual({ axBase: false })
  })
})

describe('consumeConfirmedInitialPromptDelivery', () => {
  it('is on only for the exact daemon-set value', () => {
    expect(consumeConfirmedInitialPromptDelivery({ HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' })).toBe(true)
  })

  it('is off when absent or set to anything else', () => {
    for (const value of [undefined, '', '0', 'false', 'true', 'yes']) {
      const env = value === undefined ? {} : { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: value }
      expect(consumeConfirmedInitialPromptDelivery(env)).toBe(false)
    }
  })

  it('removes the key so a child this session spawns does not inherit it', () => {
    const env: NodeJS.ProcessEnv = { HAPPY_MANAGED_REQUIRE_PROMPT_ACK: '1' }
    expect(consumeConfirmedInitialPromptDelivery(env)).toBe(true)
    expect('HAPPY_MANAGED_REQUIRE_PROMPT_ACK' in env).toBe(false)
    // A second read finds nothing — the decision belonged to this launch only.
    expect(consumeConfirmedInitialPromptDelivery(env)).toBe(false)
  })
})
