/**
 * The skill catalogue reader and the card that joins it to the activity ledger.
 *
 * Two things matter: the route read is best-effort (a refusal, an empty list and a transport failure all
 * mean "counts only", never "this skill has no description"), and the card must render from counts alone
 * when the catalogue is absent.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogueOf, copySkillPath, readCatalogue, setSkillCopier } from '../../src/client/data/skills'
import { SkillsCard } from '../../src/client/ui/insights/skills'
import type { SkillLoadStat } from '../../src/client/data/aggregate'

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

/** The stats the ledger produces for two skills. */
const stats: SkillLoadStat[] = [
  { name: 'pdf', loads: 4, sessions: 2, last: Date.now() - 60_000 },
  { name: 'dsh-badge', loads: 1, sessions: 1, last: Date.now() - 3_600_000 },
]

afterEach(() => {
  vi.unstubAllGlobals()
  setSkillCopier(null)
})

describe('catalogueOf', () => {
  it('keeps valid entries and drops invalid ones', () => {
    const map = catalogueOf({
      skills: [
        { name: 'pdf', description: 'Read PDFs', path: '/skills/pdf', source: 'user' },
        { name: '' },
        { description: 'no name' },
        null,
      ],
    })
    expect([...(map?.keys() ?? [])]).toEqual(['pdf'])
    expect(map?.get('pdf')).toMatchObject({ description: 'Read PDFs', path: '/skills/pdf', source: 'user' })
  })

  it('treats an empty list as no catalogue', () => {
    expect(catalogueOf({ skills: [] })).toBeNull()
    expect(catalogueOf({})).toBeNull()
    expect(catalogueOf(null)).toBeNull()
  })
})

describe('readCatalogue', () => {
  it('omits unavailable body fields rather than sending nulls', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true,"value":{"skills":[{"name":"pdf","description":"d"}]}}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const map = await readCatalogue(undefined, 'session-1')
    expect(map?.get('pdf')).toBeDefined()
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    // A `cwd: null` would be an explicit empty scope; the key must be absent.
    expect(body).toEqual({ sessionId: 'session-1' })
  })

  it('resolves null on a refusal, a non-JSON body and a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":false,"error":{"code":"x","message":"y"}}', { status: 200 })))
    expect(await readCatalogue(undefined, 's')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    expect(await readCatalogue(undefined, 's')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await readCatalogue(undefined, 's')).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    expect(await readCatalogue(undefined, 's')).toBeNull()
  })
})

describe('copySkillPath', () => {
  it('reports the truth about the write', async () => {
    setSkillCopier(async () => {})
    expect(await copySkillPath('/a')).toBe(true)
    setSkillCopier(async () => { throw new Error('denied') })
    expect(await copySkillPath('/a')).toBe(false)
  })
})

describe('SkillsCard', () => {
  it('renders the counts with no catalogue at all', () => {
    const markup = renderToStaticMarkup(h(SkillsCard, {
      t, stats, catalog: null, selected: null, onSelect: () => {}, sort: 'loads', onSort: () => {}, now: Date.now(),
    }))
    expect(markup).toContain('pdf')
    expect(markup).toContain('ov.skills.loads')
    // Without a catalogue there is no copy control, and nothing claims a description.
    expect(markup).not.toContain('cb-ov-skill-copy')
  })

  it('enriches the rows from the catalogue', () => {
    const catalog = new Map([['pdf', { name: 'pdf', description: 'Read PDFs', path: '/skills/pdf', source: 'user' }]])
    const markup = renderToStaticMarkup(h(SkillsCard, {
      t, stats, catalog, selected: null, onSelect: () => {}, sort: 'loads', onSort: () => {}, now: Date.now(),
    }))
    expect(markup).toContain('ov.skills.src.user')
    expect(markup).toContain('cb-ov-skill-copy')
  })

  it('shows the empty state without loads', () => {
    const markup = renderToStaticMarkup(h(SkillsCard, {
      t, stats: [], catalog: null, selected: null, onSelect: () => {}, sort: 'loads', onSort: () => {}, now: Date.now(),
    }))
    expect(markup).toContain('ov.skills.empty')
  })

  it('keeps an out-of-scope pin visible and releasable', () => {
    const markup = renderToStaticMarkup(h(SkillsCard, {
      t, stats, catalog: null, selected: 'gone-skill', onSelect: () => {}, sort: 'loads', onSort: () => {}, now: Date.now(),
    }))
    expect(markup).toContain('gone-skill')
    expect(markup).toContain('cb-ov-skill-pinned')
  })
})
