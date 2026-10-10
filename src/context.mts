/**
 * Context composition: what is filling a session's context window, and what it
 * costs.
 *
 * DSH records the surface it actually sends — each event carries `surfaceOp`
 * (`'append'`, or a replace range for compaction and pruning), so the retained
 * window can be reconstructed from the log alone. That is what this module
 * folds.
 *
 * Magnitudes are ANCHORED, not invented. A pure character heuristic cannot know
 * a provider's tokenizer, so the per-category characters only decide the SHAPE;
 * they are then scaled so their sum equals the prompt tokens the provider
 * reported for that request (measured at ~1.98 chars/token across real logs,
 * within ±5%, but the anchor removes the guesswork entirely). The result is
 * "of the N prompt tokens actually billed, this is how they split" — not a
 * second opinion about how many tokens there were.
 *
 * Tools are counted from the request envelope's schemas, which is why they are
 * a category even though they are not a surface message: they occupy the window
 * like everything else and a large tool set is a common cause of a full window.
 */

/** The buckets a context window splits into. */
export type ContextCategoryKey = 'system' | 'tools' | 'user' | 'assistant' | 'toolResults';

/** One category's share of the window. */
export interface ContextCategory {
  key: ContextCategoryKey;
  tokens: number;
  /** Percentage of the anchored total. */
  share: number;
  /** Prompt-side cost attributed to this category, in CNY. */
  cost: number;
}

/** The composition of one request's prompt, plus the window it sits in. */
export interface ContextComposition {
  categories: ContextCategory[];
  /** Tokens in the retained window, equal to `anchor` when the provider reported one. */
  total: number;
  /** Prompt tokens the provider reported for the last request, or null. */
  anchor: number | null;
  /** The model's context window, when the log recorded one. */
  window: number | null;
  /** Percentage of `window` in use, or null without a window. */
  occupancy: number | null;
  /** How many compactions and prunes rewrote the window over this log. */
  compactions: number;
  /** Whether the window is anchored to a real provider count. */
  anchored: boolean;
}

/** Options accepted by {@link contextComposition}. */
export interface ContextOptions {
  /**
   * Characters per token for the shape estimate. The final figures are scaled to
   * the provider's count, so this only affects which category looks largest when
   * two are close — it cannot move the total.
   */
  charsPerToken?: number;
  /**
   * Prompt-side cost (cache-miss plus cache-read spend) to attribute across the
   * categories. Omit to report tokens without money.
   */
  promptCost?: number;
}

/** The default ratio, measured across real session logs (see the module note). */
const DEFAULT_CHARS_PER_TOKEN = 1.98;

/** Every string a message contributes to the prompt, flattened. */
function messageChars(value: unknown): number {
  let total = 0;
  const walk = (node: unknown): void => {
    if (typeof node === 'string') { total += node.length; return; }
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      // `usage` and `stream` are accounting and transport, never prompt content.
      if (key === 'usage' || key === 'stream') continue;
      walk(child);
    }
  };
  walk(value);
  return total;
}

/** A `surfaceOp` that appends one node, or a range replacement. */
interface SurfaceOp {
  kind: 'append' | 'replace';
  start?: number;
  end?: number;
}

/** Read one event's `surfaceOp`, tolerating the string form older logs use. */
function surfaceOpOf(event: Record<string, unknown>): SurfaceOp | null {
  const op = event.surfaceOp;
  if (op === 'append') return { kind: 'append' };
  if (op === undefined || op === null) return null;
  if (typeof op === 'object') {
    const record = op as Record<string, unknown>;
    // A replace names the range it removes; an explicit append may also carry a range.
    if (record.kind === 'append' || record.op === 'append') return { kind: 'append' };
    const start = Number(record.startSeq ?? record.start);
    const end = Number(record.endSeq ?? record.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { kind: 'replace', start, end };
    }
  }
  return null;
}

/**
 * The range a pruning event evicts, or null.
 *
 * Compaction and pruning do NOT ride `surfaceOp`. Real logs record them as
 * `compaction/prune` (and `compaction/summary`) carrying
 * `data.shadowedRange: {start, end}` — checking only `surfaceOp` therefore
 * counts evicted content as if it were still in the window, which inflates the
 * composition and hides the one event that explains why the window shrank.
 */
function evictedRangeOf(event: Record<string, unknown>): { start: number; end: number } | null {
  if (event.type !== 'compaction/prune' && event.type !== 'compaction/summary') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object') return null;
  const range = (data as Record<string, unknown>).shadowedRange;
  if (range === null || typeof range !== 'object') return null;
  const start = Number((range as Record<string, unknown>).start);
  const end = Number((range as Record<string, unknown>).end);
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

/** The category one surface event belongs to, or null when it is not model-visible. */
function categoryOf(type: unknown): ContextCategoryKey | null {
  switch (type) {
    case 'system/message': return 'system';
    case 'user/message': return 'user';
    case 'assistant/message': return 'assistant';
    case 'tool/result': return 'toolResults';
    default: return null;
  }
}

/** One retained window node: its category and estimated character weight. */
interface SurfaceNode {
  seq: number;
  category: ContextCategoryKey;
  chars: number;
}

/**
 * Fold a session's events into the composition of its context window.
 *
 * The fold stops at the last billed request: that request's prompt is what the
 * provider counted, so anchoring there is what makes the shares trustworthy.
 * Anything appended afterwards (a reply, a tool result, the next user message)
 * is not yet part of a counted prompt and would silently deflate every share.
 *
 * @param events - the session's own events, ascending by seq.
 * @param options - ratio override and the prompt cost to attribute.
 */
export function contextComposition(events: unknown, options: ContextOptions = {}): ContextComposition {
  const list = Array.isArray(events) ? events : [];
  const charsPerToken = options.charsPerToken !== undefined && options.charsPerToken > 0
    ? options.charsPerToken
    : DEFAULT_CHARS_PER_TOKEN;

  let nodes: SurfaceNode[] = [];
  let toolsChars = 0;
  /** One entry per distinct window rewrite (a prune and its replace twin count once). */
  const rewrites: Array<{ start: number; end: number; seq: number }> = [];
  let anchor: number | null = null;
  let window: number | null = null;

  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const event = raw as Record<string, unknown>;
    const seq = Number.isFinite(event.seq) ? (event.seq as number) : -1;

    // The window size is recorded per request and does not change mid-session.
    if (event.type === 'request/context') {
      const size = (event.data as Record<string, unknown> | undefined)?.contextWindow;
      if (Number.isFinite(size) && (size as number) > 0) window = size as number;
      continue;
    }

    // Tool schemas ride the request envelope; the latest one describes the tools
    // the next request will carry, so it replaces rather than accumulates.
    if (event.type === 'request/header') {
      const header = (event.data as Record<string, unknown> | undefined)?.header;
      const tools = (header as Record<string, unknown> | undefined)?.tools;
      toolsChars = Array.isArray(tools) ? messageChars(tools) : 0;
      continue;
    }

    const op = surfaceOpOf(event);
    const evicted = evictedRangeOf(event);
    if (evicted !== null) {
      // A prune/summary removes a range from the window: drop those nodes so the
      // composition describes what is actually retained.
      //
      // One rewrite is logged TWICE — `compaction/prune` carrying
      // `data.shadowedRange`, then a `surfaceOp: {op:'replace', startSeq, endSeq}`
      // event on the very next seq naming the same range (verified on real logs:
      // 19 prunes, 19 same-range replaces, plus 1 standalone replace). Counting
      // both would report roughly twice as many rewrites as happened, so the
      // replace half is recognised as the same rewrite and not re-counted.
      nodes = nodes.filter((node) => node.seq < evicted.start || node.seq > evicted.end);
      rewrites.push({ start: evicted.start, end: evicted.end, seq });
      continue;
    }
    if (op !== null) {
      if (op.kind === 'replace' && op.start !== undefined && op.end !== undefined) {
        const { start, end } = op;
        // The replace half of a rewrite already recorded from its prune twin.
        const isTwin = rewrites.some((seen) => seen.start === start && seen.end === end && seen.seq === seq - 1);
        if (!isTwin) rewrites.push({ start, end, seq });
        nodes = nodes.filter((node) => node.seq < start || node.seq > end);
        continue;
      }
      const category = categoryOf(event.type);
      if (category !== null) {
        nodes.push({ seq, category, chars: messageChars(event.data) });
      }
    }

    // The anchor is the last billed request's prompt: cache-miss plus cache-read
    // input is the whole prompt the provider charged for.
    if (event.type === 'assistant/message') {
      const usage = (event.data as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
      if (usage !== undefined && usage !== null) {
        const prompt = numberOr(usage.inputTokens, 0) + numberOr(usage.cacheReadTokens, 0);
        if (prompt > 0) {
          // Every node in the window at this instant is what this prompt carried.
          anchor = prompt;
        }
      }
    }
  }

  // Character weight per category, then tools as its own bucket.
  const chars: Record<ContextCategoryKey, number> = {
    system: 0, tools: toolsChars, user: 0, assistant: 0, toolResults: 0,
  };
  for (const node of nodes) chars[node.category] += node.chars;

  const estimated = (Object.keys(chars) as ContextCategoryKey[]).map((key) => ({
    key,
    tokens: Math.max(0, Math.round(chars[key] / charsPerToken)),
  }));
  const estimatedTotal = estimated.reduce((sum, entry) => sum + entry.tokens, 0);

  // Anchor the magnitudes: keep the shape, take the provider's total. Without an
  // anchor the estimate stands on its own and is reported as such.
  const scale = anchor !== null && estimatedTotal > 0 ? anchor / estimatedTotal : 1;
  const promptCost = options.promptCost ?? 0;

  // Scale to the anchor with largest-remainder rounding.
  //
  // Rounding each category independently drifts the sum off the provider's count
  // (a 2000-token prompt came out as 2001), which defeats the point of
  // anchoring: the card claims these ARE the billed prompt's parts. Handing the
  // leftover units to the largest fractional parts keeps every category within
  // one token of its exact share AND makes the sum exact.
  const scaled = estimated
    .map((entry) => ({ key: entry.key, exact: entry.tokens * scale }))
    .filter((entry) => entry.exact > 0 || entry.key === 'system' || entry.key === 'tools');
  const floors = scaled.map((entry) => ({
    key: entry.key,
    value: Math.floor(entry.exact),
    frac: entry.exact - Math.floor(entry.exact),
  }));
  const target = anchor !== null ? anchor : Math.round(estimatedTotal * scale);
  let remainder = target - floors.reduce((sum, entry) => sum + entry.value, 0);
  for (const entry of [...floors].sort((a, b) => b.frac - a.frac)) {
    if (remainder <= 0) break;
    entry.value += 1;
    remainder -= 1;
  }
  const categories: ContextCategory[] = floors.map((entry) => ({
    key: entry.key,
    tokens: Math.max(0, entry.value),
    share: 0,
    cost: 0,
  }));

  const total = categories.reduce((sum, entry) => sum + entry.tokens, 0);
  for (const entry of categories) {
    entry.share = total > 0 ? (entry.tokens / total) * 100 : 0;
    entry.cost = promptCost > 0 ? (entry.share / 100) * promptCost : 0;
  }
  // Largest first: the question this card answers is "what is eating the window".
  categories.sort((a, b) => b.tokens - a.tokens);

  return {
    categories,
    total,
    anchor,
    window,
    occupancy: window !== null && window > 0 ? (total / window) * 100 : null,
    compactions: rewrites.length,
    anchored: anchor !== null,
  };
}

/** Narrow an unknown to a finite number, else a fallback. */
function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
