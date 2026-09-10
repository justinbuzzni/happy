import { describe, expect, it, vi } from 'vitest'

import {
  assertCodexAutomationServerAvailable,
  deliverCodexInitialPrompt,
  prepareCodexInitialPrompt,
  prepareCodexSessionStart,
} from './initialPrompt'

function makeInput(env: NodeJS.ProcessEnv, reconnectSessionId: string | undefined = undefined) {
  const prepared = prepareCodexInitialPrompt({
    env,
    reconnectSessionId,
    automationRunOnceRequested: false,
  })
  return {
    prepared,
    sendSessionMessage: vi.fn(),
    pushPrompt: vi.fn(),
  }
}

describe('deliverCodexInitialPrompt', () => {
  it('shouldRecordAndQueueDaemonPromptExactlyOnceForFreshSession', () => {
    const input = makeInput({ HAPPY_INITIAL_PROMPT: '  오늘 오류를 확인해줘  ' })

    expect(deliverCodexInitialPrompt(input)).toBe(true)
    expect(input.sendSessionMessage).toHaveBeenCalledTimes(1)
    expect(input.sendSessionMessage.mock.calls[0]?.[0]).toMatchObject({
      role: 'user',
      ev: { t: 'text', text: '오늘 오류를 확인해줘' },
    })
    expect(input.pushPrompt).toHaveBeenCalledWith('오늘 오류를 확인해줘')

    expect(deliverCodexInitialPrompt(input)).toBe(false)
    expect(input.sendSessionMessage).toHaveBeenCalledTimes(1)
    expect(input.pushPrompt).toHaveBeenCalledTimes(1)
  })

  it('shouldConsumeWithoutReplayingPromptWhenReconnecting', () => {
    const input = makeInput({ HAPPY_INITIAL_PROMPT: 'stale prompt' }, 'existing-session')

    expect(deliverCodexInitialPrompt(input)).toBe(false)
    expect(input.sendSessionMessage).not.toHaveBeenCalled()
    expect(input.pushPrompt).not.toHaveBeenCalled()
  })

  it('shouldIgnoreMissingOrBlankPrompt', () => {
    for (const env of [{}, { HAPPY_INITIAL_PROMPT: '   ' }]) {
      const input = makeInput(env)
      expect(deliverCodexInitialPrompt(input)).toBe(false)
      expect(input.sendSessionMessage).not.toHaveBeenCalled()
      expect(input.pushPrompt).not.toHaveBeenCalled()
    }
  })
})

describe('prepareCodexSessionStart', () => {
  it('shouldReportDaemonStartOnlyAfterTheAutomationPromptIsQueued', async () => {
    const events: string[] = []
    const prepared = prepareCodexInitialPrompt({
      env: { HAPPY_INITIAL_PROMPT: '오늘 오류를 확인해줘' },
      automationRunOnceRequested: true,
    })

    const delivered = await prepareCodexSessionStart({
      prepared,
      sendSessionMessage: () => events.push('record-prompt'),
      pushPrompt: () => events.push('queue-prompt'),
      reportStarted: async () => {
        events.push('report-started')
      },
    })

    expect(delivered).toBe(true)
    expect(events).toEqual(['record-prompt', 'queue-prompt', 'report-started'])
  })

  it('shouldStillReportDaemonStartWhenThereIsNoAutomationPrompt', async () => {
    const reportStarted = vi.fn()

    const delivered = await prepareCodexSessionStart({
      prepared: { prompt: null, exitAfterFirstTurn: false },
      sendSessionMessage: vi.fn(),
      pushPrompt: vi.fn(),
      reportStarted,
    })

    expect(delivered).toBe(false)
    expect(reportStarted).toHaveBeenCalledOnce()
  })

  it('shouldNotReportDaemonStartWhenTheAutomationPromptCannotBeQueued', async () => {
    const reportStarted = vi.fn()

    await expect(prepareCodexSessionStart({
      prepared: { prompt: '오늘 오류를 확인해줘', exitAfterFirstTurn: true },
      sendSessionMessage: vi.fn(),
      pushPrompt: () => {
        throw new Error('queue failed')
      },
      reportStarted,
    })).rejects.toThrow('queue failed')

    expect(reportStarted).not.toHaveBeenCalled()
  })
})

describe('prepareCodexInitialPrompt', () => {
  it('forwards the web optimistic local id to the persisted user envelope', () => {
    const sendSessionMessage = vi.fn()
    const env = {
      HAPPY_INITIAL_PROMPT: '복구 후 이어서 작업해줘',
      HAPPY_INITIAL_PROMPT_LOCAL_ID: 'web-local-1',
    }
    const prepared = prepareCodexInitialPrompt({
      env,
      automationRunOnceRequested: false,
    })

    deliverCodexInitialPrompt({
      prepared,
      sendSessionMessage,
      pushPrompt: vi.fn(),
    })

    expect(sendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user' }),
      'web-local-1',
    )
    expect(env.HAPPY_INITIAL_PROMPT_LOCAL_ID).toBeUndefined()
  })

  it('requiresAndActivatesRunOnceOnlyForAFreshAutomationPrompt', () => {
    const env = { HAPPY_INITIAL_PROMPT: '  업무 브리핑  ' }

    expect(prepareCodexInitialPrompt({
      env,
      automationRunOnceRequested: true,
    })).toEqual({ prompt: '업무 브리핑', exitAfterFirstTurn: true })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsRunOnceAutomationWhenItsInitialPromptIsMissing', () => {
    expect(() => prepareCodexInitialPrompt({
      env: {},
      automationRunOnceRequested: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')
  })

  it('rejectsRunOnceAutomationInsteadOfReplayingItsPromptOnReconnect', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'stale prompt' }

    expect(() => prepareCodexInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')

    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('allowsAFreshRunOncePromptForAnExplicitAutomationResume', () => {
    const env = { HAPPY_INITIAL_PROMPT: 'apply reviewed findings' }

    expect(prepareCodexInitialPrompt({
      env,
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: true,
      allowAutomationReconnectPrompt: true,
    })).toEqual({ prompt: 'apply reviewed findings', exitAfterFirstTurn: true })
    expect(env.HAPPY_INITIAL_PROMPT).toBeUndefined()
  })

  it('rejectsAnExplicitAutomationResumeWithoutItsPrompt', () => {
    expect(() => prepareCodexInitialPrompt({
      env: {},
      reconnectSessionId: 'existing-session',
      automationRunOnceRequested: false,
      allowAutomationReconnectPrompt: true,
    })).toThrow('Codex automation cannot start without a fresh initial prompt')
  })
})

describe('assertCodexAutomationServerAvailable', () => {
  it('failsClosedForOfflineRunOnceAutomation', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: true,
      serverAvailable: false,
    })).toThrow('Codex automation cannot start while the Happy server is unavailable')
  })

  it('allowsInteractiveOfflineMode', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: false,
      serverAvailable: false,
    })).not.toThrow()
  })
})

describe('confirmed delivery on the Codex prepared start path', () => {
  function harness(outcome: { ok: boolean; reason?: string }) {
    const order: string[] = []
    const confirmCalls: string[] = []
    return {
      order,
      confirmCalls,
      sendSessionMessage: () => { order.push('sent') },
      pushPrompt: () => { order.push('pushed') },
      confirmDelivery: async (localId: string) => {
        confirmCalls.push(localId)
        return outcome
      },
    }
  }

  it('pushes the prompt only after the message is acknowledged', async () => {
    const h = harness({ ok: true })
    const reported: string[] = []
    const delivered = await prepareCodexSessionStart({
      prepared: { prompt: '배포 확인', localId: 'local-1', exitAfterFirstTurn: false },
      sendSessionMessage: h.sendSessionMessage,
      pushPrompt: h.pushPrompt,
      confirmDelivery: h.confirmDelivery,
      reportStarted: async () => { reported.push('reported') },
    })
    expect(delivered).toBe(true)
    expect(h.order).toEqual(['sent', 'pushed'])
    expect(h.confirmCalls).toEqual(['local-1'])
    expect(reported).toEqual(['reported'])
  })

  it('throws without pushing or reporting when the acknowledgement never came', async () => {
    const h = harness({ ok: false, reason: 'deadline' })
    const reported: string[] = []
    await expect(prepareCodexSessionStart({
      prepared: { prompt: '배포 확인', localId: 'local-1', exitAfterFirstTurn: false },
      sendSessionMessage: h.sendSessionMessage,
      pushPrompt: h.pushPrompt,
      confirmDelivery: h.confirmDelivery,
      reportStarted: async () => { reported.push('reported') },
    })).rejects.toThrowError(/durability/)
    expect(h.order).toEqual(['sent'])
    expect(reported).toEqual([])
  })

  it('fails closed when a confirmed delivery was asked for without a localId', async () => {
    const h = harness({ ok: true })
    await expect(prepareCodexSessionStart({
      prepared: { prompt: '배포 확인', exitAfterFirstTurn: false },
      sendSessionMessage: h.sendSessionMessage,
      pushPrompt: h.pushPrompt,
      confirmDelivery: h.confirmDelivery,
    })).rejects.toThrowError(/localId/)
    expect(h.order).toEqual([])
  })

  it('registers the waiter before the message is enqueued', async () => {
    let resolveAck: ((v: { ok: boolean }) => void) | null = null
    let registeredBeforeSend = false
    const order: string[] = []
    await prepareCodexSessionStart({
      prepared: { prompt: 'x', localId: 'local-1', exitAfterFirstTurn: false },
      sendSessionMessage: () => {
        registeredBeforeSend = resolveAck !== null
        resolveAck?.({ ok: true })
      },
      pushPrompt: () => { order.push('pushed') },
      confirmDelivery: (_localId) => new Promise((resolve) => { resolveAck = resolve }),
    })
    expect(registeredBeforeSend).toBe(true)
    expect(order).toEqual(['pushed'])
  })

  it('leaves the unconfirmed path exactly as it was', async () => {
    const h = harness({ ok: true })
    const delivered = await prepareCodexSessionStart({
      prepared: { prompt: '배포 확인', localId: 'local-1', exitAfterFirstTurn: false },
      sendSessionMessage: h.sendSessionMessage,
      pushPrompt: h.pushPrompt,
    })
    expect(delivered).toBe(true)
    expect(h.order).toEqual(['sent', 'pushed'])
    expect(h.confirmCalls).toEqual([])
  })
})

describe('Codex required confirmation is a launch precondition', () => {
  it('refuses when the session has no server response to confirm against', async () => {
    const order: string[] = []
    const reported: string[] = []
    await expect(prepareCodexSessionStart({
      prepared: { prompt: 'x', localId: 'local-1', requireConfirmedDelivery: true, exitAfterFirstTurn: false },
      sendSessionMessage: () => { order.push('sent') },
      pushPrompt: () => { order.push('pushed') },
      reportStarted: async () => { reported.push('reported') },
    })).rejects.toThrowError(/confirm/)
    // Offline start: no confirmer exists, so the turn must not begin.
    expect(order).toEqual([])
    expect(reported).toEqual([])
  })

  it('refuses when confirmation is required but there is no prompt', async () => {
    const order: string[] = []
    const reported: string[] = []
    await expect(prepareCodexSessionStart({
      prepared: { prompt: null, requireConfirmedDelivery: true, exitAfterFirstTurn: false },
      sendSessionMessage: () => { order.push('sent') },
      pushPrompt: () => { order.push('pushed') },
      confirmDelivery: async () => ({ ok: true }),
      reportStarted: async () => { reported.push('reported') },
    })).rejects.toThrowError(/prompt/)
    expect(order).toEqual([])
    expect(reported).toEqual([])
  })
})

describe('assertCodexAutomationServerAvailable with required confirmation', () => {
  it('refuses an offline start that requires confirmed delivery', () => {
    // This is the real seam `runCodex` calls right after it learns whether a
    // server session exists, before anything offline begins.
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: false,
      serverAvailable: false,
      prepared: { prompt: 'x', localId: 'local-1', requireConfirmedDelivery: true, exitAfterFirstTurn: false },
    })).toThrowError(/confirm/)
  })

  it('allows an offline start that did not require confirmation', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: false,
      serverAvailable: false,
      prepared: { prompt: 'x', localId: 'local-1', exitAfterFirstTurn: false },
    })).not.toThrow()
  })

  it('allows a confirmed launch when a server session exists', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: false,
      serverAvailable: true,
      prepared: { prompt: 'x', localId: 'local-1', requireConfirmedDelivery: true, exitAfterFirstTurn: false },
    })).not.toThrow()
  })

  it('keeps the existing automation rule unchanged', () => {
    expect(() => assertCodexAutomationServerAvailable({
      automationRunOnceRequested: true,
      serverAvailable: false,
    })).toThrowError(/unavailable/)
  })
})
