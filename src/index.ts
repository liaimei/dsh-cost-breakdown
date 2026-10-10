/**
 * DSH Usage Meter — host half.
 *
 * Serves three reads to the browser half over the authenticated `/api` fence:
 *   - the DeepSeek account balance (account sign-in first, API key as fallback);
 *   - the current pricing period and the official price table;
 *   - one session's cost, folded from its own log plus every descendant session.
 *
 * Cost is computed from DSH's own recorded token accounting — DSH ships no
 * pricing model, so this plugin owns it (see ./pricing.mts).
 */

import { combine, foldEvents, foldEventsByDay, periodAt, priceTable } from './pricing.mjs';
import { contextComposition } from './context.mjs';

/** Every route this plugin owns, under the connection service's `/api` fence. */
const ROUTE_STATUS = '/api/dsh-cost-breakdown/status';
const ROUTE_SESSION = '/api/dsh-cost-breakdown/session';
const ROUTE_OVERVIEW = '/api/dsh-cost-breakdown/overview';
const ROUTE_CONTEXT = '/api/dsh-cost-breakdown/context';

/** How many sessions one descendant walk may touch before it gives up. */
const MAX_WALK_SESSIONS = 400;
/** Turns kept per session for the panel's recent-request list. */
const TURN_LIMIT = 30;

/**
 * How many sessions the account-wide overview will read per request.
 *
 * Each session costs one observation of its full event log, so this is the one
 * knob that bounds the overview's latency. The request's `days` window narrows
 * which sessions are read at all (a session whose newest event predates the
 * window cannot contribute), which is what keeps the common case cheap.
 */
const MAX_OVERVIEW_SESSIONS = 500;
/** Default overview window, in days. */
const DEFAULT_OVERVIEW_DAYS = 30;
/** Largest window the overview will accept, so one request cannot scan forever. */
const MAX_OVERVIEW_DAYS = 365;

/** The settings namespace the DeepSeek API-key provider serves its section under. */
const DEEPSEEK_SETTINGS_NS = 'llm-deepseek';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const PUBLIC_BASE_URL = 'https://api.deepseek.com';
const FETCH_TIMEOUT_MS = 10_000;
/** This host build's identity for account requests it makes on the panel's behalf. */
const CLIENT_VERSION = '1';
/** Locale for server-authored account copy; the panel renders its own labels. */
const CLIENT_LOCALE = 'zh-CN';

/**
 * A string-keyed record, as `asRecord` returns it. Provider payloads, service
 * results and config all arrive here untyped, so every read is narrowed rather
 * than asserted.
 */
type Record_ = Record<string, unknown>;

/** One wallet as the panel receives it. */
interface Wallet {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

/** The resolved balance answer, including which face produced it. */
interface BalanceAnswer {
  source: 'account' | 'api-key' | 'none';
  isAvailable: boolean;
  balances: Wallet[];
}

/**
 * The subset of the Cordis context this half uses. Every service is fetched by
 * name and may be absent — a harness without `deepseekAccount` or
 * `sessionQuery` still has to serve its routes — so reads stay `unknown`-based.
 */
interface HostContext {
  get(name: string): unknown;
  inject(services: readonly string[], callback: (scope: HostScope) => void): unknown;
}

/** The injected fiber `ctx.inject` hands back: services plus effect scoping. */
interface HostScope extends HostContext {
  effect(callback: () => unknown, label?: string): unknown;
}

/** Plugin config as it arrives from the profile patch. */
interface PluginConfig {
  holidays?: unknown;
  logRoutes?: unknown;
  [key: string]: unknown;
}

/** One session's events as the observation API reported them. */
interface SessionRead {
  events: unknown[];
  inherited: number;
  source: 'live' | 'log';
}

/** The plugin's resolved config: only validated values reach the route table. */
interface ResolvedConfig {
  holidays?: string[];
  logRoutes: boolean;
}

/** A route registration, as `connection.fetch.register` consumes it. */
interface RouteRegistration {
  path: string;
  methods: readonly string[];
  requestBody: string;
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Account client metadata. The offset uses the same convention the official
 * account UI does — `-(Date.prototype.getTimezoneOffset()) * 60`, i.e. seconds
 * EAST of UTC — and is computed from the host's real zone rather than assumed,
 * because a fixed value would be wrong on any machine outside it.
 */
function clientMetadata(): { version: string; locale: string; timezoneOffsetSeconds: number } {
  return {
    version: CLIENT_VERSION,
    locale: CLIENT_LOCALE,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

const Logger = {
  warn: (...args: unknown[]): void => console.warn('[dsh-cost-breakdown]', ...args),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a string-keyed record, or null. */
function asRecord(value: unknown): Record_ | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record_) : null;
}

/** A JSON response that is never cached by the browser. */
function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/** One failure envelope the browser half understands. */
function failure(code: string, message: string): Response {
  return reply({ ok: false, code, message });
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * The DeepSeek API-key provider's settings section, read through whichever face
 * the running DSH line serves: the registered namespace directly, else the
 * `describe()` projection row that declares an `apiKeyEnv` credential ref.
 */
function deepseekSectionOf(ctx: HostContext): Record_ | null {
  const settings = asRecord(ctx.get('settings'));
  const direct = typeof settings?.get === 'function'
    ? asRecord((settings.get as (ns: string) => unknown).call(settings, DEEPSEEK_SETTINGS_NS))
    : null;
  if (direct !== null) return direct;
  if (typeof settings?.describe !== 'function') return null;
  try {
    const rows = (settings.describe as () => unknown).call(settings);
    if (!Array.isArray(rows)) return null;
    let shaped: Record_ | null = null;
    for (const row of rows) {
      try {
        const record = asRecord(row);
        if (record === null) continue;
        const value = asRecord(record.value);
        if (value === null || typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv === '') continue;
        if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === 'llm-deepseek-api-key') return value;
        shaped ??= value;
      } catch {
        continue;
      }
    }
    return shaped;
  } catch {
    return null;
  }
}

/** Resolve `{baseUrl, apiKey}` for a direct platform read, or null. */
async function apiKeyFacts(ctx: HostContext): Promise<{ baseUrl: string; apiKey: string } | null> {
  const section = deepseekSectionOf(ctx);
  if (section === null) return null;
  const apiKeyEnv =
    typeof section.apiKeyEnv === 'string' && section.apiKeyEnv !== '' ? section.apiKeyEnv : DEFAULT_API_KEY_ENV;
  const baseUrl = typeof section.baseURL === 'string' && section.baseURL !== '' ? section.baseURL : PUBLIC_BASE_URL;
  const credentials = asRecord(ctx.get('credentials'));
  if (typeof credentials?.resolve !== 'function') return null;
  try {
    const hit = asRecord(await (credentials.resolve as (env: string) => Promise<unknown>).call(credentials, apiKeyEnv));
    const apiKey = typeof hit?.value === 'string' ? hit.value : '';
    return apiKey === '' ? null : { baseUrl, apiKey };
  } catch {
    return null;
  }
}

/** One amount, accepting the platform's string or numeric form. */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Narrow the platform's `/user/balance` payload. The total is the two parts
 * summed: the platform's own `total_balance` rounds independently of them.
 */
function balanceOfPayload(value: unknown): { isAvailable: boolean; balances: Wallet[] } | null {
  const data = asRecord(value);
  if (data === null) return null;
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  const balances: Wallet[] = [];
  for (const info of infos) {
    try {
      const entry = asRecord(info);
      if (entry === null) continue;
      const currency = entry.currency;
      const granted = amountOf(entry.granted_balance);
      const toppedUp = amountOf(entry.topped_up_balance);
      if (typeof currency !== 'string' || currency === '' || granted === null || toppedUp === null) continue;
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp });
    } catch {
      continue;
    }
  }
  return balances.length > 0 ? { isAvailable: data.is_available === true, balances } : null;
}

/** Read the balance through the API key. Never rejects. */
async function readWithApiKey(ctx: HostContext): Promise<{ isAvailable: boolean; balances: Wallet[] } | null> {
  const facts = await apiKeyFacts(ctx);
  if (facts === null) return null;
  try {
    const response = await fetch(`${facts.baseUrl.replace(/\/+$/, '')}/user/balance`, {
      headers: { accept: 'application/json', authorization: `Bearer ${facts.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return balanceOfPayload(await response.json());
  } catch {
    return null;
  }
}

/**
 * Read the balance from the DSH account sign-in (no API key involved).
 * Returns `{signedIn:false}` when the account is signed out so the caller can
 * distinguish "no credentials" from "credentials that returned no wallet".
 */
async function readWithAccount(
  ctx: HostContext,
): Promise<{ signedIn: boolean; balance: { isAvailable: boolean; balances: Wallet[] } | null }> {
  const account = asRecord(ctx.get('deepseekAccount'));
  if (account === null || typeof account.getBalance !== 'function') return { signedIn: false, balance: null };
  try {
    const state = typeof account.getState === 'function'
      ? asRecord(await (account.getState as () => Promise<unknown>).call(account))
      : null;
    if (state !== null && state.status === 'signed-out') return { signedIn: false, balance: null };
  } catch {
    /* fall through to the balance read, which reports its own failure */
  }
  try {
    const outcome = asRecord(
      await (account.getBalance as (meta: unknown) => Promise<unknown>).call(account, clientMetadata()),
    );
    if (outcome === null || outcome.status !== 'ready') return { signedIn: true, balance: null };
    // The account service splits the two wallets structurally: `value` holds the
    // recharge (topped-up) wallets and `bonusWallets` the granted ones. Keeping
    // them apart is what lets the panel show the same breakdown the console does.
    const byCurrency = new Map<string, Wallet>();
    const add = (wallets: unknown, field: 'granted' | 'toppedUp'): void => {
      for (const wallet of Array.isArray(wallets) ? wallets : []) {
        const entry = asRecord(wallet);
        if (entry === null) continue;
        const amount = amountOf(entry.balance);
        if (typeof entry.currency !== 'string' || amount === null) continue;
        const current = byCurrency.get(entry.currency) ?? { currency: entry.currency, total: 0, granted: 0, toppedUp: 0 };
        current[field] += amount;
        current.total += amount;
        byCurrency.set(entry.currency, current);
      }
    };
    add(outcome.value, 'toppedUp');
    add(outcome.bonusWallets, 'granted');
    const balances = [...byCurrency.values()];
    return { signedIn: true, balance: balances.length > 0 ? { isAvailable: true, balances } : null };
  } catch {
    return { signedIn: true, balance: null };
  }
}

/**
 * Read the balance, preferring the account sign-in and falling back to the API
 * key. The response always states which source answered, so the panel never
 * presents an API-key figure as if it were the signed-in account's.
 */
async function readBalance(ctx: HostContext): Promise<BalanceAnswer> {
  const account = await readWithAccount(ctx);
  if (account.balance !== null) return { source: 'account', ...account.balance };
  const keyed = await readWithApiKey(ctx);
  if (keyed !== null) return { source: 'api-key', ...keyed };
  return { source: account.signedIn ? 'account' : 'none', isAvailable: false, balances: [] };
}

// ---------------------------------------------------------------------------
// Session walk
// ---------------------------------------------------------------------------

/** The header of one listed session record, or null. */
function headerOf(record: unknown): { id: string; parentSession?: string } | null {
  const row = asRecord(record);
  const header = asRecord(row?.header);
  return header !== null && typeof header.id === 'string'
    ? { id: header.id, ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}) }
    : null;
}

/** The session-query face this half calls, as far as it is used. */
interface QueryFace {
  observeSession(id: string, options: { projectionMode: string }): Promise<unknown>;
  listSessions(): Promise<unknown>;
}

/**
 * Collect `rootId` plus every descendant session, breadth-first over the
 * parent links the header carries. Bounded so a pathological lineage cannot
 * pin the event loop.
 */
function collectLineage(
  rootId: string,
  headers: ReadonlyArray<{ id: string; parentSession?: string }>,
): { ids: string[]; truncated: boolean } {
  const children = new Map<string, string[]>();
  for (const header of headers) {
    const parent = typeof header.parentSession === 'string' ? header.parentSession : null;
    if (parent === null) continue;
    const bucket = children.get(parent) ?? [];
    bucket.push(header.id);
    children.set(parent, bucket);
  }
  const seen = new Set([rootId]);
  const queue = [rootId];
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      if (seen.has(child)) continue;
      if (seen.size >= MAX_WALK_SESSIONS) {
        truncated = true;
        break;
      }
      seen.add(child);
      queue.push(child);
    }
  }
  return { ids: [...seen], truncated };
}

/**
 * Read one session's events through the cheapest available face: the live
/**
 * Read one session's events through the sanctioned observation API.
 *
 * `sessionQuery.observeSession` hands back a caller-owned lease whose events are
 * complete, and the lease is released before returning. The synchronous
 * `Session.snapshotEvents()` accessor is deliberately NOT used: it is marked
 * deprecated with "new calls are prohibited", and it would bypass the query
 * service's live-preferred resolution and its memoization floors.
 *
 * `inherited` is the fork-inherited prefix length: a seeded (forked or
 * summarized) session carries a copy of its ancestor's events, and those were
 * already billed when the ancestor ran. Billing them again under the child
 * would count the same money twice, so the fold skips the prefix.
 */
async function eventsOf(sessionId: string, query: QueryFace | null): Promise<SessionRead | null> {
  if (query === null) return null;
  let observation: unknown = null;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'none' });
    const record = asRecord(observation);
    const events = record?.events;
    if (!Array.isArray(events)) return null;
    // The observation reports the inherited prefix as a branded count; accept a
    // plain integer and otherwise fall back to the seed marker in the log.
    const raw = record?.inheritedEventCount;
    const inherited = Number.isInteger(raw) ? (raw as number) : 0;
    return { events: [...events], inherited, source: record?.source === 'live' ? 'live' : 'log' };
  } catch {
    return null;
  } finally {
    // The lease must be released even when the read failed part-way, or the
    // query service keeps the observation pinned.
    try {
      // `Symbol.dispose` is not a string key, so it is read off the record
      // reflectively rather than through the string-keyed index signature.
      const dispose = observation === null || observation === undefined
        ? undefined
        : Reflect.get(observation as object, Symbol.dispose);
      if (typeof dispose === 'function') dispose.call(observation);
    } catch {
      /* releasing is best-effort; the read already produced its value */
    }
  }
}

/**
 * The events one session actually owns: everything past its inherited prefix.
 * Falls back to a `session/end-seed` marker when the count was not reported,
 * because that event is exactly where a seeded log marks its inherited cut.
 */
function ownedEventsOf(read: SessionRead): unknown[] {
  const events = read.events;
  let from = Number.isInteger(read.inherited) && read.inherited > 0 ? read.inherited : 0;
  if (from === 0) {
    const marker = events.findIndex(
      (event) => asRecord(event)?.type === 'session/end-seed' && asRecord(asRecord(event)?.data)?.inherited === true,
    );
    if (marker >= 0) from = marker + 1;
  }
  return from > 0 ? events.slice(from) : events;
}

/** A session's title, when the log carries one. */
function titleOf(events: readonly unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = asRecord(events[i]);
    if (event?.type !== 'session/title') continue;
    const title = asRecord(event.data)?.title;
    if (typeof title === 'string' && title !== '') return title;
  }
  return null;
}

/** Real message count, used as a cheap "is this session interesting" signal. */
function messageCountOf(events: readonly unknown[]): number {
  let count = 0;
  for (const event of events) if (asRecord(event)?.type === 'user/message') count += 1;
  return count;
}

/**
 * Activity counters a session's log already records, so they are READ rather
 * than inferred: `turn/start` and `step/start` are the authoritative markers
 * DSH writes, and counting them cannot drift from what the agent really did.
 * (Deriving turns from distinct `data.turn` values happens to agree on today's
 * logs, but it would silently disagree on any log that replays a turn.)
 */
interface ActivityCounts {
  turns: number;
  steps: number;
  toolCalls: number;
  userMessages: number;
  compactions: number;
}

/** Read one session's activity counters off its own events. */
function activityOf(events: readonly unknown[]): ActivityCounts {
  const counts: ActivityCounts = { turns: 0, steps: 0, toolCalls: 0, userMessages: 0, compactions: 0 };
  for (const event of events) {
    switch (asRecord(event)?.type) {
      case 'turn/start': counts.turns += 1; break;
      case 'step/start': counts.steps += 1; break;
      case 'tool/call': counts.toolCalls += 1; break;
      case 'user/message': counts.userMessages += 1; break;
      case 'compaction/start': counts.compactions += 1; break;
      default: break;
    }
  }
  return counts;
}

/**
 * Bucket a session's activity by Beijing day, using each event's OWN timestamp.
 *
 * Kept here rather than in `pricing.mts`: that module prices tokens, and turns
 * and steps are not money. A turn that starts at 23:59 and a step that runs past
 * midnight land on their own days, which is the same rule the billing fold uses.
 */
function activityByDay(events: readonly unknown[]): Map<string, ActivityCounts> {
  const days = new Map<string, ActivityCounts>();
  for (const event of events) {
    const record = asRecord(event);
    const type = record?.type;
    let field: keyof ActivityCounts | null = null;
    if (type === 'turn/start') field = 'turns';
    else if (type === 'step/start') field = 'steps';
    else if (type === 'tool/call') field = 'toolCalls';
    else if (type === 'user/message') field = 'userMessages';
    else if (type === 'compaction/start') field = 'compactions';
    if (field === null) continue;

    const time = record?.time;
    const date = beijingDateOf(Number.isFinite(time) ? (time as number) : 0);
    let bucket = days.get(date);
    if (bucket === undefined) {
      bucket = { turns: 0, steps: 0, toolCalls: 0, userMessages: 0, compactions: 0 };
      days.set(date, bucket);
    }
    bucket[field] += 1;
  }
  return days;
}

/** The `YYYY-MM-DD` Beijing date of one epoch instant. */
function beijingDateOf(time: number): string {
  const shifted = new Date((Number.isFinite(time) ? time : 0) + 8 * 60 * 60 * 1000);
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return `${shifted.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The share of prompt tokens served from cache, as a percentage.
 *
 * Cache reads and misses together are the whole prompt, so the rate is
 * `cacheRead / (cacheRead + input)`. It answers "how much did caching save",
 * which is why the account view leads with it.
 */
function cacheHitRate(tokens: { input: number; cacheRead: number }): number {
  const prompt = tokens.cacheRead + tokens.input;
  return prompt > 0 ? (tokens.cacheRead / prompt) * 100 : 0;
}

/** One session's contribution to the walk, before it is reshaped for the wire. */
interface SessionEntry {
  sessionId: string;
  title: string | null;
  messages: number;
  source: string;
  inheritedEvents: number;
  totals: ReturnType<typeof foldEvents>;
}

/**
 * Build the cost picture for one session and its descendants.
 *
 * Returns the bare payload (or null when no log was reachable); the route is
 * what wraps it in a Response. Never throws for an absent or unreadable session.
 */
async function sessionReport(
  ctx: HostContext,
  sessionId: string,
  options: ResolvedConfig,
): Promise<Record<string, unknown> | null> {
  const holidays = options.holidays;
  const query = asRecord(ctx.get('sessionQuery'));
  // Observation is the read; `listSessions` is only needed to discover the
  // lineage, so a corpus that can observe but not list still works.
  const queryFace =
    query !== null && typeof query.observeSession === 'function' ? (query as unknown as QueryFace) : null;
  const canList = queryFace !== null && typeof queryFace.listSessions === 'function';

  // Which sessions to walk: one session's lineage. An unreachable corpus still
  // allows the root itself, so the panel works before persistence answers.
  let ids = [sessionId];
  let lineageTruncated = false;
  if (canList) {
    try {
      const listed = await queryFace.listSessions();
      const headers = (Array.isArray(listed) ? listed : [])
        .map(headerOf)
        .filter((header): header is { id: string; parentSession?: string } => header !== null);
      const lineage = collectLineage(sessionId, headers);
      ids = lineage.ids;
      lineageTruncated = lineage.truncated;
    } catch {
      ids = [sessionId];
    }
  }

  const children: SessionEntry[] = [];
  let root: SessionEntry | null = null;
  let missing = 0;
  for (const id of ids) {
    const read = await eventsOf(id, queryFace);
    if (read === null) {
      missing += 1;
      continue;
    }
    // Bill only the events this session owns: a seeded child's inherited
    // prefix is its ancestor's history, already counted there.
    const owned = ownedEventsOf(read);
    const folded = foldEvents(owned, { holidays, turnLimit: TURN_LIMIT });
    const entry: SessionEntry = {
      sessionId: id,
      title: titleOf(owned),
      messages: messageCountOf(owned),
      source: read.source,
      inheritedEvents: read.events.length - owned.length,
      totals: folded,
    };
    if (id === sessionId) root = entry;
    else children.push(entry);
  }

  if (root === null) return null;

  const rootEntry = root as SessionEntry;
  children.sort((a, b) => b.totals.cost - a.totals.cost);
  const combined = combine([rootEntry.totals, ...children.map((child) => child.totals)]);
  return {
    sessionId,
    title: rootEntry.title,
    messages: rootEntry.messages,
    source: rootEntry.source,
    own: rootEntry.totals,
    children: children.map((child) => ({
      sessionId: child.sessionId,
      title: child.title,
      cost: child.totals.cost,
      requests: child.totals.requests,
      tokens: child.totals.tokens,
    })),
    combined,
    sessionsWalked: ids.length,
    lineageTruncated,
    missing,
    // Events skipped across the lineage because a seeded child had inherited
    // them from an ancestor: reported so the panel can explain a child whose
    // cost is lower than its raw event count would suggest.
    inheritedEventsSkipped: rootEntry.inheritedEvents + children.reduce((sum, child) => sum + child.inheritedEvents, 0),
  };
}

// ---------------------------------------------------------------------------
// Account-wide overview
// ---------------------------------------------------------------------------

/** One session's contribution to the account overview. */
interface OverviewSession {
  sessionId: string;
  title: string | null;
  createdAt: number;
  lastActivity: number;
  cost: number;
  requests: number;
  unpriced: number;
  tokens: { input: number; cacheRead: number; output: number; reasoning: number; total: number };
  byPeriod: { peak: number; offPeak: number };
  /** Turn / step / tool-call counters read off the session's own events. */
  activity: ActivityCounts;
  /** Percentage of prompt tokens served from cache. */
  cacheHitRate: number;
  /**
   * What fills this session's context window, and the prompt-side cost attributed
   * to each part. Anchored to the provider's own prompt count (see context.mts).
   */
  context: ReturnType<typeof contextComposition>;
  /** Set when this session is one of another's descendants (already counted under its ancestor). */
  isChild: boolean;
}

/** The account-wide view: per-day totals plus per-session breakdown. */
interface OverviewReport {
  days: Array<{
    date: string;
    cost: number;
    requests: number;
    byPeriod: { peak: number; offPeak: number };
    tokens: { input: number; cacheRead: number; output: number; reasoning: number; total: number };
    /** Turns and steps that STARTED on this day, plus the tool calls they made. */
    activity: ActivityCounts;
    /** Sessions with at least one billed request on this day. */
    sessions: number;
  }>;
  sessions: OverviewSession[];
  totals: {
    cost: number;
    requests: number;
    unpriced: number;
    byPeriod: { peak: number; offPeak: number };
    tokens: { input: number; cacheRead: number; output: number; reasoning: number; total: number };
    activity: ActivityCounts;
    /** Percentage of prompt tokens served from cache across the whole window. */
    cacheHitRate: number;
    /** Distinct sessions with any billed activity in the window. */
    sessions: number;
  };
  windowDays: number;
  since: number;
  sessionsRead: number;
  sessionsSkipped: number;
  truncated: boolean;
  missing: number;
  /** Milliseconds the aggregation took, so the UI can explain a slow open. */
  elapsedMs: number;
}

/**
 * Aggregate every session in the corpus into per-day and per-session totals.
 *
 * Why this is not just `sessionReport` in a loop: the overview has to answer
 * "what did each day cost", and a session can span days. It therefore folds each
 * session's OWN events with `foldEventsByDay` (which, unlike `foldEvents`, keeps
 * every turn) and then unions the days across sessions.
 *
 * Descendant de-duplication applies here too, and is the reason a session's
 * own events are used rather than its raw log: a seeded child's prefix is its
 * ancestor's history, already counted. Every session is still listed in the
 * breakdown, because the reader wants to see where the money went — but a child
 * is marked `isChild` and its cost is NOT added to the account total again.
 *
 * @param ctx - the Cordis context, for `sessionQuery`.
 * @param options - resolved plugin config (the holiday table).
 * @param requestedDays - window in days; clamped to [1, MAX_OVERVIEW_DAYS].
 */
async function overviewReport(
  ctx: HostContext,
  options: ResolvedConfig,
  requestedDays: number,
): Promise<OverviewReport> {
  const started = Date.now();
  const holidays = options.holidays;
  const windowDays = Math.min(MAX_OVERVIEW_DAYS, Math.max(1, Math.trunc(requestedDays) || DEFAULT_OVERVIEW_DAYS));
  const since = started - windowDays * 24 * 60 * 60 * 1000;

  const query = asRecord(ctx.get('sessionQuery'));
  const queryFace =
    query !== null && typeof query.observeSession === 'function' ? (query as unknown as QueryFace) : null;
  const canList = queryFace !== null && typeof queryFace.listSessions === 'function';

  const days = new Map<string, OverviewReport['days'][number]>();
  const sessions: OverviewSession[] = [];
  let missing = 0;
  let sessionsSkipped = 0;
  let truncated = false;

  if (!canList) {
    return {
      days: [], sessions: [], totals: emptyOverviewTotals(), windowDays, since,
      sessionsRead: 0, sessionsSkipped: 0, truncated: false, missing: 0, elapsedMs: Date.now() - started,
    };
  }

  // Newest first, so when the cap bites it is the OLDEST sessions that are skipped.
  let headers: Array<{ id: string; parentSession?: string; createdAt: number }> = [];
  try {
    const listed = await queryFace.listSessions();
    headers = (Array.isArray(listed) ? listed : [])
      .map((record) => {
        const header = headerOf(record);
        if (header === null) return null;
        const created = asRecord(asRecord(record)?.header)?.createdAt;
        return { ...header, createdAt: Number.isFinite(created) ? (created as number) : 0 };
      })
      .filter((header): header is { id: string; parentSession?: string; createdAt: number } => header !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    headers = [];
  }

  // Which sessions are somebody's descendant, so the breakdown can say so.
  //
  // This set holds the IDs that APPEAR AS a parentSession value, i.e. the
  // sessions that HAVE a parent — so `has(id)` answers "is this a child".
  // Building it from `id` instead (the obvious-looking mistake) inverts the
  // meaning and would flag every parent as a child.
  const childIds = new Set(
    headers
      .map((h) => (typeof h.parentSession === 'string' ? h.id : null))
      .filter((id): id is string => id !== null),
  );

  for (const header of headers) {
    if (sessions.length >= MAX_OVERVIEW_SESSIONS) {
      truncated = true;
      sessionsSkipped = headers.length - sessions.length;
      break;
    }
    const read = await eventsOf(header.id, queryFace);
    if (read === null) {
      missing += 1;
      continue;
    }
    const owned = ownedEventsOf(read);

    const lastEvent = owned.length > 0 ? ownLastTime(owned) : header.createdAt;
    const activity = activityOf(owned);

    // The window filters EVENTS, not just which sessions are read.
    //
    // Selecting sessions by recency and then summing each one's whole log leaks
    // out-of-window spend into the window: a session active today but started
    // months ago would contribute those months to a 7-day total, and the
    // headline would disagree with the day buckets the chart draws (a real
    // 7-day request reported dates from two months back). Both figures are
    // therefore computed from the same in-window slice.
    const windowDates = new Set<string>();
    for (let offset = 0; offset < windowDays; offset += 1) {
      windowDates.add(beijingDateOf(started - offset * 24 * 60 * 60 * 1000));
    }
    const inWindow = owned.filter((event) => {
      const time = asRecord(event)?.time;
      return windowDates.has(beijingDateOf(Number.isFinite(time) ? (time as number) : 0));
    });

    const folded = foldEvents(inWindow, { holidays });
    // Skip a session with no billed activity in the window: listing thousands of
    // zero-cost rows would drown the ones the reader is looking for.
    if (folded.requests === 0) continue;

    // A day can carry activity without any billing (a turn that only ran local
    // tools), so the activity counters seed the day buckets too — otherwise a
    // quiet-but-busy day would be missing from the chart entirely.
    const perDayActivity = activityByDay(inWindow);
    const ensureDay = (date: string): OverviewReport['days'][number] => {
      const at = days.get(date);
      if (at !== undefined) return at;
      const fresh: OverviewReport['days'][number] = {
        date,
        cost: 0,
        requests: 0,
        byPeriod: { peak: 0, offPeak: 0 },
        tokens: { input: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
        activity: { turns: 0, steps: 0, toolCalls: 0, userMessages: 0, compactions: 0 },
        sessions: 0,
      };
      days.set(date, fresh);
      return fresh;
    };

    // Descendants are counted, not skipped.
    //
    // `owned` is already past any inherited prefix, so what remains in a child
    // session is its OWN calls — real spend the provider really charged. The
    // single-session view does the same thing: it sums `own + children` into
    // `combined` (asserted by the lineage e2e). De-duplication happens once, in
    // `ownedEventsOf`; excluding descendants here as well would drop genuine
    // cost and disagree with the per-session numbers.
    for (const [date, day] of foldEventsByDay(inWindow, { holidays })) {
      const at = ensureDay(date);
      at.cost += day.cost;
      at.requests += day.requests;
      at.byPeriod.peak += day.byPeriod.peak;
      at.byPeriod.offPeak += day.byPeriod.offPeak;
      at.tokens.input += day.tokens.input;
      at.tokens.cacheRead += day.tokens.cacheRead;
      at.tokens.output += day.tokens.output;
      at.tokens.reasoning += day.tokens.reasoning;
      at.tokens.total += day.tokens.total;
    }
    for (const [date, counts] of perDayActivity) {
      addActivity(ensureDay(date).activity, counts);
    }
    // A session counts once per day it was active, not once per event.
    for (const date of perDayActivity.keys()) ensureDay(date).sessions += 1;

    sessions.push({
      sessionId: header.id,
      title: titleOf(owned),
      createdAt: header.createdAt,
      lastActivity: lastEvent,
      cost: folded.cost,
      requests: folded.requests,
      unpriced: folded.unpriced,
      tokens: folded.tokens,
      byPeriod: folded.byPeriod,
      activity,
      cacheHitRate: cacheHitRate(folded.tokens),
      // Composed from the whole owned log, not the window slice: the context
      // window is a property of the session's tail, and slicing it to a date
      // range would describe a window that never existed.
      context: contextComposition(owned, {
        // Prompt-side spend only: output tokens are not context.
        promptCost: folded.promptCost,
      }),
      isChild: childIds.has(header.id),
    });
  }

  // Every listed session contributes, descendants included: their totals are
  // already net of any inherited prefix, so they are their own real spend. The
  // sum therefore equals the day buckets above, which is what keeps the chart
  // and the headline figure from disagreeing.
  const totals = emptyOverviewTotals();
  for (const session of sessions) {
    totals.cost += session.cost;
    totals.requests += session.requests;
    totals.unpriced += session.unpriced;
    totals.byPeriod.peak += session.byPeriod.peak;
    totals.byPeriod.offPeak += session.byPeriod.offPeak;
    addActivity(totals.activity, session.activity);
    for (const key of ['input', 'cacheRead', 'output', 'reasoning', 'total'] as const) {
      totals.tokens[key] += session.tokens[key];
    }
  }
  totals.sessions = sessions.length;
  // The window-wide hit rate is computed from the summed buckets, not averaged
  // from the per-session rates: an average of percentages would let one small
  // session with a high rate outweigh a large one with a low rate.
  totals.cacheHitRate = cacheHitRate(totals.tokens);

  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return {
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    sessions,
    totals,
    windowDays,
    since,
    sessionsRead: sessions.length,
    sessionsSkipped,
    truncated,
    missing,
    elapsedMs: Date.now() - started,
  };
}

/** A fresh zeroed overview total. */
function emptyOverviewTotals(): OverviewReport['totals'] {
  return {
    cost: 0,
    requests: 0,
    unpriced: 0,
    byPeriod: { peak: 0, offPeak: 0 },
    tokens: { input: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
    activity: { turns: 0, steps: 0, toolCalls: 0, userMessages: 0, compactions: 0 },
    cacheHitRate: 0,
    sessions: 0,
  };
}

/** Add one session's activity counters into an accumulator. */
function addActivity(into: ActivityCounts, from: ActivityCounts): void {
  into.turns += from.turns;
  into.steps += from.steps;
  into.toolCalls += from.toolCalls;
  into.userMessages += from.userMessages;
  into.compactions += from.compactions;
}

/** The newest event timestamp in one session's own events. */
function ownLastTime(events: readonly unknown[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const time = asRecord(events[i])?.time;
    if (Number.isFinite(time)) return time as number;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * Serve the plugin's routes. Registration rides the injected fiber, so
 * unloading the connection service withdraws every route with it.
 */
function installRoutes(ctx: HostContext, config: ResolvedConfig): void {
  ctx.inject(['connection'], (scope) => {
    const connection = asRecord(scope.get('connection'));
    const register =
      typeof asRecord(connection?.fetch)?.register === 'function'
        ? (asRecord(connection?.fetch)!.register as (route: RouteRegistration) => unknown).bind(connection!.fetch)
        : null;
    if (register === null) {
      Logger.warn('connection.fetch.register is unavailable — routes not served');
      return;
    }

    const status = async (): Promise<Response> => {
      const now = Date.now();
      let balance: BalanceAnswer;
      try {
        balance = await readBalance(ctx);
      } catch (error) {
        Logger.warn('balance read failed', error);
        balance = { source: 'none', isAvailable: false, balances: [] };
      }
      return reply({
        ok: true,
        value: {
          balance,
          period: periodAt(now, config.holidays),
          prices: priceTable(),
          currency: 'CNY',
          now,
        },
      });
    };

    const session = async (request: Request): Promise<Response> => {
      let id: unknown;
      try {
        const body = await request.json();
        id = asRecord(body)?.sessionId;
      } catch {
        return failure('dsh-cost-breakdown/bad-request', 'body is not JSON');
      }
      if (typeof id !== 'string' || id === '') return failure('dsh-cost-breakdown/bad-request', 'missing sessionId');
      try {
        // The route owns Response construction: sessionReport returns the bare
        // payload, and a plain object would never satisfy the fetch contract.
        return reply({ ok: true, value: await sessionReport(ctx, id, config) });
      } catch (error) {
        Logger.warn('session report failed', error);
        return failure('dsh-cost-breakdown/session-failed', error instanceof Error ? error.message : String(error));
      }
    };

    const overview = async (request: Request): Promise<Response> => {
      // The window is a convenience, not a contract: an unreadable or absent
      // body simply means "use the default".
      let days = DEFAULT_OVERVIEW_DAYS;
      try {
        const body = asRecord(await request.json());
        if (Number.isFinite(body?.days)) days = body!.days as number;
      } catch {
        /* default window */
      }
      try {
        return reply({ ok: true, value: await overviewReport(ctx, config, days) });
      } catch (error) {
        Logger.warn('overview report failed', error);
        return failure('dsh-cost-breakdown/overview-failed', error instanceof Error ? error.message : String(error));
      }
    };

    const routes: ReadonlyArray<readonly [string, (request: Request) => Promise<Response>]> = [
      [ROUTE_STATUS, status],
      [ROUTE_SESSION, session],
      [ROUTE_OVERVIEW, overview],
    ];
    for (const [path, handler] of routes) {
      try {
        scope.effect(
          () => register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler }),
          `dsh-cost-breakdown: ${path}`,
        );
      } catch (error) {
        Logger.warn(`route ${path} not registered`, error);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const name = 'dsh-cost-breakdown';
export const inject: string[] = [];

/**
 * Resolve the holiday table from plugin config.
 *
 * An empty table is NOT the same as an absent one: it makes every holiday bill
 * at the peak rate, which silently doubles those days' cost. So a value that
 * yields no usable date — a non-array, or an array whose entries are all
 * malformed — falls back to the built-in table rather than disabling holidays.
 * Configuring a deliberately empty table is therefore not possible; that is the
 * safe direction to fail, because over-charging a holiday is invisible.
 * @returns validated dates, or undefined for the default.
 */
function holidaysFrom(config: PluginConfig): string[] | undefined {
  if (!Array.isArray(config.holidays)) return undefined;
  const dates = config.holidays.filter((day): day is string => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day));
  if (dates.length === 0) {
    Logger.warn('the configured `holidays` list holds no valid YYYY-MM-DD date; using the built-in table');
    return undefined;
  }
  const dropped = config.holidays.length - dates.length;
  if (dropped > 0) Logger.warn(`ignored ${dropped} malformed entr${dropped === 1 ? 'y' : 'ies'} in the configured \`holidays\` list`);
  return dates;
}

/** Plugin entry point. */
export function apply(ctx: HostContext, config: PluginConfig = {}): void {
  const resolved: ResolvedConfig = { holidays: holidaysFrom(config), logRoutes: config.logRoutes === true };
  // `undefined` lets pricing.mts apply its own built-in default.
  if (resolved.holidays === undefined) delete resolved.holidays;
  if (resolved.logRoutes) {
    Logger.warn(`routes: ${ROUTE_STATUS}, ${ROUTE_SESSION}, ${ROUTE_OVERVIEW}`);
  }
  installRoutes(ctx, resolved);
}

export { foldEvents, foldEventsByDay, holidaysFrom, periodAt, priceTable };
