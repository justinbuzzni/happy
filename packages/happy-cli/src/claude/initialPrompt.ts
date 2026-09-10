/**
 * HAPPY_INITIAL_PROMPT — daemon spawn(initialPrompt 옵션)이 전달한 첫 사용자
 * 프롬프트를 원격 세션에서 정확히 한 번 소비한다 (scheduled automations 등).
 *
 * 배달은 두 경로를 모두 만족해야 한다:
 * (a) 턴 시작 — messageQueue에 push해 에이전트가 이 프롬프트로 첫 턴을 연다.
 * (b) 서버 히스토리 — 앱발 프롬프트는 앱이 서버에 먼저 쓰지만 이 프롬프트는
 *     어디에도 없다. 데몬은 세션 콘텐츠 키가 없어 못 쓰므로, 키를 가진 세션
 *     프로세스가 직접 sendClaudeSessionMessage로 user 레코드를 보낸다 — 원격
 *     스캐너가 터미널발 프롬프트를 앱에 보이게 하는 것과 같은 메커니즘이다.
 *     스캐너의 자동 포워딩에 기대지 않는 이유: onSessionHook이
 *     treatExistingAsProcessed로 세션 시작 시점의 JSONL 내용을 전부 처리된
 *     것으로 마킹하므로, SDK가 먼저 쓴 첫 프롬프트는 포워딩되지 않을 수 있다.
 *     대신 recordAppPrompt로 스탬프해 스캐너가 SDK의 JSONL 기록을 이중
 *     포워딩하지 않게 한다(앱발 프롬프트와 동일한 dedupe 규약).
 */

import { appendTitleInstruction } from '@/utils/titlePrompt'
import type { RawJSONLines } from './types'
import {
    buildInitialPromptUserRecord,
    consumePendingInitialPrompt,
    consumeConfirmedInitialPromptDelivery,
    consumePendingInitialPromptLocalId,
    InitialPromptNotDurableError,
    type ConfirmInitialPromptDelivery,
} from '@/utils/initialPrompt'

export {
  buildInitialPromptUserRecord,
  consumePendingInitialPrompt,
  InitialPromptNotDurableError,
  type ConfirmInitialPromptDelivery,
} from '@/utils/initialPrompt'

export interface InitialPromptSink {
  sessionId: string | null
  hasTitle(): boolean
  sendClaudeSessionMessage(record: RawJSONLines, localId?: string): void
  recordAppPrompt(text: string): void
  pushPrompt(text: string): void
}

export type PreparedClaudeInitialPrompt = {
  prompt: string | null
  localId?: string
  /** The launcher asked for confirmed delivery; read once, at prepare time. */
  requireConfirmedDelivery?: boolean
  exitAfterFirstTurn: boolean
}

export function prepareClaudeInitialPrompt(input: {
  env: NodeJS.ProcessEnv
  reconnectSessionId?: string
  automationRunOnceRequested: boolean
  allowAutomationReconnectPrompt?: boolean
}): PreparedClaudeInitialPrompt {
  const consumedPrompt = consumePendingInitialPrompt(input.env)
  const localId = consumePendingInitialPromptLocalId(input.env)
  const requireConfirmedDelivery = consumeConfirmedInitialPromptDelivery(input.env)
  const prompt = consumedPrompt
    && (!input.reconnectSessionId || input.allowAutomationReconnectPrompt)
    ? consumedPrompt
    : null

  if ((input.automationRunOnceRequested || input.allowAutomationReconnectPrompt) && !prompt) {
    throw new Error('Claude automation cannot start without a fresh initial prompt')
  }

  return {
    prompt,
    ...(prompt && localId ? { localId } : {}),
    ...(requireConfirmedDelivery ? { requireConfirmedDelivery } : {}),
    exitAfterFirstTurn: input.automationRunOnceRequested && prompt !== null,
  }
}

/**
 * Refuses a start that cannot satisfy a required confirmed delivery.
 *
 * Called at the point the session decides to go offline, which returns long
 * before the prepared-start helper runs — the helper's own check cannot reach
 * that branch, so the condition is asserted where the branch is taken.
 */
export function assertClaudeConfirmedDeliveryPossible(input: {
  prepared: PreparedClaudeInitialPrompt
  serverAvailable: boolean
}): void {
  if (!input.prepared.requireConfirmedDelivery) return
  if (!input.serverAvailable) {
    throw new InitialPromptNotDurableError('no server session to confirm delivery against')
  }
}

export async function deliverPreparedClaudeSessionStart(input: {
  prepared: PreparedClaudeInitialPrompt
  sink: InitialPromptSink
  /**
   * Supplied only where the launcher asked for confirmed delivery. When
   * present the turn does not begin until the prompt is acknowledged, so a
   * message that never reached the server cannot be answered as if it had.
   */
  confirmDelivery?: ConfirmInitialPromptDelivery
  reportStarted?: () => Promise<void>
}): Promise<boolean> {
  const prompt = input.prepared.prompt
  const localId = input.prepared.localId
  const required = input.prepared.requireConfirmedDelivery === true
  input.prepared.prompt = null

  // The option states a condition about the *initial prompt* landing durably.
  // With no prompt, or nothing able to confirm one, that condition cannot be
  // met — so the launch is refused rather than quietly downgraded. A future
  // continuation path is a separate contract, not an implicit exemption.
  if (required && !prompt) {
    throw new InitialPromptNotDurableError('confirmed delivery required but no initial prompt')
  }
  if (required && !input.confirmDelivery) {
    throw new InitialPromptNotDurableError('confirmed delivery required but no confirmer is available')
  }

  if (prompt) {
    if (input.confirmDelivery) {
      // Nothing to correlate an acknowledgement with means no confirmed
      // delivery is possible, and a caller that asked for one must not get
      // the unconfirmed behaviour silently.
      if (!localId) throw new InitialPromptNotDurableError('missing localId')
      // Registered before the enqueue: a flush can begin the moment the record
      // is queued, and a waiter added afterwards would miss its own ack.
      const pending = input.confirmDelivery(localId)
      // The record goes through the ordinary outbox; only the push waits.
      input.sink.sendClaudeSessionMessage(buildInitialPromptUserRecord(prompt, input.sink.sessionId), localId)
      input.sink.recordAppPrompt(prompt)
      const ack = await pending
      if (!ack.ok) throw new InitialPromptNotDurableError(ack.reason ?? 'unknown')
      pushInitialPrompt(prompt, input.sink)
    } else {
      deliverInitialPrompt(prompt, input.sink, localId)
    }
  }
  await input.reportStarted?.()
  return prompt !== null
}

/** Starts the turn. Split out so the confirmed path can defer only this half. */
function pushInitialPrompt(prompt: string, sink: InitialPromptSink): void {
  let pushText = prompt
  if (!sink.hasTitle()) {
    const withTitle = appendTitleInstruction(pushText)
    if (withTitle !== pushText) {
      pushText = withTitle
      sink.recordAppPrompt(pushText)
    }
  }
  sink.pushPrompt(pushText)
}

export function deliverInitialPrompt(prompt: string, sink: InitialPromptSink, localId?: string): void {
  // (b) 서버 히스토리: 원문 그대로 — 앱은 이 레코드로 사용자 말풍선을 그린다.
  sink.sendClaudeSessionMessage(buildInitialPromptUserRecord(prompt, sink.sessionId), localId)
  // SDK가 곧 같은 텍스트를 JSONL에 쓴다 — 스캐너 이중 포워딩 방지 스탬프.
  sink.recordAppPrompt(prompt)

  // (a) 턴 시작. 새 세션엔 제목이 없으므로 onUserMessage와 동일하게 모델 사본에만
  // 제목 지시를 덧붙이고, 변형본도 dedupe 스탬프한다.
  pushInitialPrompt(prompt, sink)
}
