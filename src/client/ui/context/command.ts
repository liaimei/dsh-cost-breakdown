/**
 * The `/context` command.
 *
 * It runs as the plugin's own `'/'` input trigger rather than a host command: it dispatches nothing,
 * writes no session-log record and produces no model-visible content. Both pick paths answer
 * `'handled'` and open the modal; the guard is stashed **before** the modal store flips, because the
 * overlay's first frame reads it.
 */

import type { ClientContext, InputTriggersFace, TriggerCandidate, TriggerPick } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import { modalStoreOf } from './modalStore'
import { setPendingConsume } from './modalStore'

const COMMAND = 'context'
const LINE = `/${COMMAND}`

/** Register the source on the input-trigger service; a host without that service never fires it. */
export function registerContextCommand(ctx: ClientContext, t: Translate): void {
  ctx.inject(['inputTriggers'], (injected) => {
    const raw = injected as ClientContext & { inputTriggers?: InputTriggersFace }
    const triggers = raw.inputTriggers
    if (triggers === undefined || typeof triggers.registerSource !== 'function') return
    raw.effect(() => triggers.registerSource({
      trigger: '/',
      name: COMMAND,
      order: 1,
      candidates: (_session, request) => {
        // Only a token at the very start of the input is a command; mid-sentence `/context` is prose.
        if (request.position !== 'leading') return Promise.resolve([])
        const query = request.query.trim().toLowerCase()
        if (query !== '' && !COMMAND.startsWith(query)) return Promise.resolve([])
        return Promise.resolve([candidate(t)] as readonly TriggerCandidate[])
      },
      onPick: (pick: TriggerPick) => {
        // The guard is stashed before the store flips: the overlay's first frame reads it, and a write
        // that lands after the notification would be consumed too late.
        setPendingConsume(pick.session.sessionId, { kind: 'span', span: pick.span })
        modalStoreOf(pick.session.sessionId).set(true)
        return 'handled'
      },
      matchEnter: (session, line) => {
        // Exact match only: `/contextual` is not this command, and returning undefined lets the shell
        // dispatch the line as an ordinary prompt.
        if (line !== LINE) return Promise.resolve(undefined)
        setPendingConsume(session.sessionId, { kind: 'bare-token', token: LINE })
        modalStoreOf(session.sessionId).set(true)
        return Promise.resolve<'handled'>('handled')
      },
    }), 'dsh-cost-breakdown: /context command')
  })
}

/** The single menu candidate. `section` replaces the menu's source-title row, which would otherwise
 * print the raw source name. */
function candidate(t: Translate): TriggerCandidate {
  return {
    name: COMMAND,
    label: t('cmd.label'),
    section: t('cmd.section'),
    description: t('cmd.desc'),
  }
}
