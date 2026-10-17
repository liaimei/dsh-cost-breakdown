/**
 * How every component on this surface obtains its translator.
 *
 * The registrations all carry `locale: NAMESPACE`, so the harness synthesises a `t` seat and passes it
 * down with the session seat props. This module is the one place that reads that seat defensively:
 * the payload is untrusted, and a missing/abusive seat must degrade to *readable* copy rather than to
 * a raw key.
 *
 * The fallback is the English dictionary — the harness's own locale chain ends `active → en → key`,
 * so falling back to `en` reproduces what DSH itself would render.
 */

import { DICT_EN } from '../../i18n/dict'
import type { Translate } from '../../i18n/dict'

/** Dictionary lookup with the harness's `{name}` substitution (unknown placeholders stay verbatim). */
const FALLBACK: Translate = (key, params) => {
  const text = (DICT_EN as Record<string, string>)[key] ?? key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Read the framework `t` seat off a slot's props, or fall back to the English dictionary. */
export function resolveT(props: unknown): Translate {
  if (props !== null && typeof props === 'object') {
    const seat = (props as { t?: unknown }).t
    if (typeof seat === 'function') return seat as Translate
  }
  return FALLBACK
}

/** Read one scalar off untrusted slot props. */
export function propOf<T>(props: unknown, key: string): T | undefined {
  if (props === null || typeof props !== 'object') return undefined
  const value = (props as Record<string, unknown>)[key]
  return value as T | undefined
}
