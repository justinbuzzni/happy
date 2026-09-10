import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire'

import {
  consumeConfirmedInitialPromptDelivery,
  consumePendingInitialPrompt,
  consumePendingInitialPromptLocalId,
  InitialPromptNotDurableError,
  type ConfirmInitialPromptDelivery,
} from '@/utils/initialPrompt'

export { InitialPromptNotDurableError, type ConfirmInitialPromptDelivery } from '@/utils/initialPrompt'

export type PreparedCodexInitialPrompt = {
  prompt: string | null
  localId?: string
  /** The launcher asked for confirmed delivery; read once, at prepare time. */
  requireConfirmedDelivery?: boolean
  exitAfterFirstTurn: boolean
}

export function prepareCodexInitialPrompt(input: {
  env: NodeJS.ProcessEnv
  reconnectSessionId?: string
  automationRunOnceRequested: boolean
  allowAutomationReconnectPrompt?: boolean
}): PreparedCodexInitialPrompt {
  const consumedPrompt = consumePendingInitialPrompt(input.env)
  const localId = consumePendingInitialPromptLocalId(input.env)
  const requireConfirmedDelivery = consumeConfirmedInitialPromptDelivery(input.env)
  const prompt = consumedPrompt
    && (!input.reconnectSessionId || input.allowAutomationReconnectPrompt)
    ? consumedPrompt
    : null

  if ((input.automationRunOnceRequested || input.allowAutomationReconnectPrompt) && !prompt) {
    throw new Error('Codex automation cannot start without a fresh initial prompt')
  }

  return {
    prompt,
    ...(prompt && localId ? { localId } : {}),
    ...(requireConfirmedDelivery ? { requireConfirmedDelivery } : {}),
    exitAfterFirstTurn: input.automationRunOnceRequested && prompt !== null,
  }
}

export function assertCodexAutomationServerAvailable(input: {
  automationRunOnceRequested: boolean
  serverAvailable: boolean
  /** Prepared prompt, when the launch asked for confirmed delivery. */
  prepared?: PreparedCodexInitialPrompt
}): void {
  if (input.automationRunOnceRequested && !input.serverAvailable) {
    throw new Error('Codex automation cannot start while the Happy server is unavailable')
  }
  // Same condition as Claude's: without a server session there is nothing to
  // acknowledge, and the offline path must not start the turn anyway.
  if (input.prepared?.requireConfirmedDelivery && !input.serverAvailable) {
    throw new InitialPromptNotDurableError('no server session to confirm delivery against')
  }
}

export function deliverCodexInitialPrompt(input: {
  prepared: PreparedCodexInitialPrompt
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void
  pushPrompt: (prompt: string) => void
}): boolean {
  const prompt = input.prepared.prompt
  input.prepared.prompt = null
  if (!prompt) return false

  input.sendSessionMessage(
    createEnvelope('user', { t: 'text', text: prompt }),
    input.prepared.localId,
  )
  input.pushPrompt(prompt)
  return true
}

export async function prepareCodexSessionStart(input: {
  prepared: PreparedCodexInitialPrompt
  sendSessionMessage: (envelope: SessionEnvelope, localId?: string) => void
  pushPrompt: (prompt: string) => void
  /**
   * Supplied only where the launcher asked for confirmed delivery. The turn
   * does not begin until the prompt is acknowledged.
   */
  confirmDelivery?: ConfirmInitialPromptDelivery
  reportStarted?: () => Promise<void>
}): Promise<boolean> {
  const required = input.prepared.requireConfirmedDelivery === true
  // See the Claude counterpart: an offline start has no confirmer, and a
  // required confirmation cannot be met without one.
  if (required && !input.prepared.prompt) {
    input.prepared.prompt = null
    throw new InitialPromptNotDurableError('confirmed delivery required but no initial prompt')
  }
  if (required && !input.confirmDelivery) {
    input.prepared.prompt = null
    throw new InitialPromptNotDurableError('confirmed delivery required but no confirmer is available')
  }

  if (input.confirmDelivery) {
    const prompt = input.prepared.prompt
    const localId = input.prepared.localId
    input.prepared.prompt = null
    if (prompt) {
      if (!localId) throw new InitialPromptNotDurableError('missing localId')
      // Registered before the enqueue — see the type's contract.
      const pending = input.confirmDelivery(localId)
      input.sendSessionMessage(createEnvelope('user', { t: 'text', text: prompt }), localId)
      const ack = await pending
      if (!ack.ok) throw new InitialPromptNotDurableError(ack.reason ?? 'unknown')
      input.pushPrompt(prompt)
    }
    await input.reportStarted?.()
    return prompt !== null
  }
  const delivered = deliverCodexInitialPrompt(input)
  await input.reportStarted?.()
  return delivered
}
