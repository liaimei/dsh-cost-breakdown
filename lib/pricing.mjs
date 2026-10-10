/**
 * Pure DeepSeek pricing core shared by the host half and the unit tests.
 *
 * Billing facts (verified against https://api-docs.deepseek.com/zh-cn/quick_start/pricing):
 *  - prices are CNY per 1M tokens and split into peak / off-peak, where the
 *    off-peak rate is exactly half the peak rate;
 *  - peak hours are Beijing time 09:00-12:00 and 14:00-18:00, Monday to Friday,
 *    excluding Chinese public holidays; every other hour — weekends and
 *    holidays in full — is off-peak;
 *  - one request bills three token buckets separately: cache hits, cache misses
 *    and output.
 *
 * Token reconciliation (verified against real DSH session logs): DSH reports
 * `inputTokens` as the CACHE-MISS input only, `cacheReadTokens` as the cache-hit
 * input, and `totalTokens` as the sum of all three buckets. A real record:
 *   {inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672}
 *   -> 192 + 12672 + 238 === 13102.
 * Reading `inputTokens` as the whole prompt would bill the cached prefix at the
 * miss rate and roughly double the real cost.
 */
/** Every price in this module is quoted in CNY per million tokens. */
export const CURRENCY = 'CNY';
export const TOKEN_UNIT = 1_000_000;
/**
 * The official price table. `aliases` lists every model id the API has served
 * for a row: the legacy `deepseek-v4-flash` names are retired but still billed
 * as Flash, and DSH reports the versioned `deepseek-v4.1-flash` form.
 */
export const MODELS = [
    {
        id: 'deepseek-flash',
        label: 'DeepSeek-V4.1-Flash',
        aliases: [
            'deepseek-flash',
            'deepseek-v4.1-flash',
            'deepseek-v4-flash',
            'deepseek-v4-flash-vision-exp',
            'deepseek-v4.1-flash-vision-exp',
        ],
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek-V4-Pro',
        aliases: ['deepseek-v4-pro', 'deepseek-v4.1-pro', 'deepseek-pro'],
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
];
/** Beijing peak windows as half-open [startHour, endHour) wall-clock ranges. */
export const PEAK_WINDOWS = [
    [9, 12],
    [14, 18],
];
/**
 * Chinese public holidays in Beijing dates, `YYYY-MM-DD`. Days listed here are
 * off-peak all day, exactly like a weekend. Override through the plugin config
 * (`holidays`) when the State Council publishes a new arrangement; an entry for
 * a date whose shift moves is intentionally absent rather than guessed, because
 * a wrong holiday misprices every request inside it.
 */
export const DEFAULT_HOLIDAYS = [
    // 2026 — State Council arrangement.
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The bucket keys each summing loop walks. Declared `as const` so the key type
 * is the literal union `tokens` declares: the annotation and the loop are both
 * erased at emit, so the built module keeps its original shape exactly.
 */
const WORKSPACE_TOKEN_KEYS = ['input', 'cacheRead', 'output', 'reasoning', 'total'];
const MODEL_TOKEN_KEYS = ['input', 'cacheRead', 'output', 'total'];
/** Narrow an unknown to a finite non-negative number, else 0. */
function amountOf(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * Beijing wall-clock parts of one epoch instant.
 * @param {number} time - epoch milliseconds.
 */
export function beijingParts(time) {
    const shifted = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS);
    const month = shifted.getUTCMonth() + 1;
    const day = shifted.getUTCDate();
    return {
        year: shifted.getUTCFullYear(),
        month,
        day,
        hour: shifted.getUTCHours(),
        minute: shifted.getUTCMinutes(),
        weekday: shifted.getUTCDay(),
        date: `${shifted.getUTCFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
}
/**
 * Whether one instant falls in a Beijing peak window.
 * @param {number} time - epoch milliseconds.
 * @param {readonly string[]} [holidays] - Beijing holiday dates.
 */
export function isPeak(time, holidays = DEFAULT_HOLIDAYS) {
    const parts = beijingParts(time);
    if (parts.weekday === 0 || parts.weekday === 6)
        return false;
    if (holidays.includes(parts.date))
        return false;
    return PEAK_WINDOWS.some(([from, to]) => parts.hour >= from && parts.hour < to);
}
/** The human label of one period. */
export function periodLabel(peak) {
    return peak ? '高峰时段' : '空闲时段';
}
/**
 * The current pricing period plus the instant it next flips. The scan steps one
 * minute at a time for at most eight days — a window is never longer than a
 * weekend plus a holiday run, and eight days always crosses a boundary.
 * @param {number} time - epoch milliseconds.
 * @param {readonly string[]} [holidays] - Beijing holiday dates.
 */
export function periodAt(time, holidays = DEFAULT_HOLIDAYS) {
    const peak = isPeak(time, holidays);
    const step = 60_000;
    const limit = time + 8 * DAY_MS;
    let next = null;
    for (let t = Math.floor(time / step) * step + step; t <= limit; t += step) {
        if (isPeak(t, holidays) !== peak) {
            next = { at: t, peak: !peak };
            break;
        }
    }
    return { peak, label: periodLabel(peak), next };
}
/**
 * Resolve the price row for one wire model id. Matching is tolerant on purpose:
 * a provider may report a versioned, dotted or suffixed id, and an unrecognized
 * id must never be priced as if it were cheap.
 * @param {string} model - the model id DSH recorded.
 */
export function matchModel(model) {
    const name = typeof model === 'string' ? model.trim().toLowerCase() : '';
    if (name === '')
        return null;
    for (const row of MODELS) {
        if (row.id === name || row.aliases.includes(name))
            return row;
    }
    // Provider-prefixed ids and unknown revisions of a known family.
    if (name.includes('pro'))
        return MODELS.find((row) => row.id === 'deepseek-v4-pro') ?? null;
    if (name.includes('flash'))
        return MODELS.find((row) => row.id === 'deepseek-flash') ?? null;
    return null;
}
/**
 * Normalize one DSH `TokenUsage` into the three billed buckets. `inputTokens`
 * carries the cache-miss input; `cacheWriteTokens` is only consulted when the
 * record omits a miss bucket entirely.
 * @param {object} usage - the recorded TokenUsage.
 */
export function bucketsOf(usage) {
    const source = usage !== null && typeof usage === 'object' ? usage : {};
    const cacheRead = amountOf(source.cacheReadTokens);
    const input = amountOf(source.inputTokens) || amountOf(source.cacheWriteTokens);
    const output = amountOf(source.outputTokens);
    const reasoning = amountOf(source.reasoningTokens);
    const reported = amountOf(source.totalTokens);
    return {
        cacheRead,
        input,
        output,
        reasoning,
        total: reported > 0 ? reported : input + cacheRead + output,
    };
}
/**
 * Price one recorded request.
 * @param {string} model - the wire model id from the assistant message source.
 * @param {object} usage - the recorded TokenUsage.
 * @param {boolean} peak - whether the request ran inside a peak window.
 * @returns {{known: boolean, cost: number, model: string|null, buckets: object, parts: object}}
 */
export function costOf(model, usage, peak) {
    const buckets = bucketsOf(usage);
    const row = matchModel(model);
    if (row === null) {
        return { known: false, cost: 0, model: null, buckets, parts: { cacheHit: 0, cacheMiss: 0, output: 0 } };
    }
    const rate = peak ? row.peak : row.offPeak;
    const parts = {
        cacheHit: (buckets.cacheRead * rate.cacheHit) / TOKEN_UNIT,
        cacheMiss: (buckets.input * rate.cacheMiss) / TOKEN_UNIT,
        output: (buckets.output * rate.output) / TOKEN_UNIT,
    };
    return { known: true, cost: parts.cacheHit + parts.cacheMiss + parts.output, model: row.id, buckets, parts };
}
/** A fresh accumulator workspace. */
function emptyTotals() {
    return {
        cost: 0,
        promptCost: 0,
        requests: 0,
        unpriced: 0,
        unpricedModels: [],
        tokens: { input: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
        byModel: {},
        byPeriod: { peak: 0, offPeak: 0 },
        turns: [],
    };
}
/** Convert a workspace's model map into the sorted array callers consume. */
function finalize(totals) {
    // The map becomes the sorted array every caller consumes; the cast is the one
    // place the two shapes meet, kept here so no caller has to know about it.
    const byModel = Object.values(totals.byModel).sort((a, b) => b.cost - a.cost);
    return { ...totals, byModel };
}
/**
 * Fold one session's event log into its cost picture.
 *
 * Only `assistant/message` events carrying `usage` are billed — that is the one
 * event DSH records provider token accounting on. The period is resolved per
 * event from the event's own timestamp, so a session that spans the 09:00 or
 * 18:00 boundary is priced correctly on both sides of it.
 *
 * @param {readonly object[]} events - the session's own events, ascending by seq.
 * @param {{holidays?: readonly string[], turnLimit?: number}} [options]
 */
export function foldEvents(events, options = {}) {
    const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
    const requested = options.turnLimit;
    const turnLimit = typeof requested === 'number' && Number.isInteger(requested) && requested > 0 ? requested : 0;
    const totals = emptyTotals();
    for (const event of Array.isArray(events) ? events : []) {
        if (event === null || typeof event !== 'object' || event.type !== 'assistant/message')
            continue;
        const data = event.data;
        if (data === null || typeof data !== 'object')
            continue;
        const usage = data.usage;
        if (usage === null || typeof usage !== 'object')
            continue;
        const time = Number.isFinite(event.time) ? event.time : 0;
        const model = data.message?.source?.model ?? data.message?.source?.provider ?? '';
        const peak = isPeak(time, holidays);
        const priced = costOf(model, usage, peak);
        const label = priced.model ?? (typeof model === 'string' && model !== '' ? model : 'unknown');
        const bucket = totals.byModel[label] ?? { model: label, label, known: priced.known, cost: 0, promptCost: 0, requests: 0, tokens: { input: 0, cacheRead: 0, output: 0, total: 0 } };
        if (totals.byModel[label] === undefined)
            totals.byModel[label] = bucket;
        totals.cost += priced.cost;
        totals.promptCost += priced.parts.cacheHit + priced.parts.cacheMiss;
        totals.requests += 1;
        totals.byPeriod[peak ? 'peak' : 'offPeak'] += priced.cost;
        totals.tokens.input += priced.buckets.input;
        totals.tokens.cacheRead += priced.buckets.cacheRead;
        totals.tokens.output += priced.buckets.output;
        totals.tokens.reasoning += priced.buckets.reasoning;
        totals.tokens.total += priced.buckets.total;
        bucket.cost += priced.cost;
        bucket.promptCost += priced.parts.cacheHit + priced.parts.cacheMiss;
        bucket.requests += 1;
        bucket.tokens.input += priced.buckets.input;
        bucket.tokens.cacheRead += priced.buckets.cacheRead;
        bucket.tokens.output += priced.buckets.output;
        bucket.tokens.total += priced.buckets.total;
        if (!priced.known) {
            totals.unpriced += 1;
            if (!totals.unpricedModels.includes(label))
                totals.unpricedModels.push(label);
        }
        totals.turns.push({
            seq: Number.isFinite(event.seq) ? event.seq : null,
            time,
            turn: Number.isInteger(data.turn) ? data.turn : null,
            step: Number.isInteger(data.step) ? data.step : null,
            model: label,
            known: priced.known,
            peak,
            cost: priced.cost,
            tokens: priced.buckets,
        });
    }
    if (turnLimit > 0 && totals.turns.length > turnLimit) {
        totals.turns = totals.turns.slice(-turnLimit);
    }
    return finalize(totals);
}
/** Sum several session folds into one total (used for a session's descendants). */
export function combine(totalsList) {
    const out = emptyTotals();
    for (const totals of Array.isArray(totalsList) ? totalsList : []) {
        if (totals === null || typeof totals !== 'object')
            continue;
        out.cost += amountOf(totals.cost);
        out.promptCost += amountOf(totals.promptCost);
        out.requests += amountOf(totals.requests);
        out.unpriced += amountOf(totals.unpriced);
        for (const name of totals.unpricedModels ?? [])
            if (!out.unpricedModels.includes(name))
                out.unpricedModels.push(name);
        for (const key of WORKSPACE_TOKEN_KEYS) {
            out.tokens[key] += amountOf(totals.tokens?.[key]);
        }
        out.byPeriod.peak += amountOf(totals.byPeriod?.peak);
        out.byPeriod.offPeak += amountOf(totals.byPeriod?.offPeak);
        // A fold finalizes `byModel` into an array; re-key it into the workspace map.
        for (const row of Array.isArray(totals.byModel) ? totals.byModel : Object.values(totals.byModel ?? {})) {
            if (row === null || typeof row !== 'object' || typeof row.model !== 'string')
                continue;
            const found = out.byModel[row.model];
            if (found === undefined) {
                out.byModel[row.model] = {
                    model: row.model,
                    label: typeof row.label === 'string' ? row.label : row.model,
                    known: row.known !== false,
                    cost: amountOf(row.cost),
                    promptCost: amountOf(row.promptCost),
                    requests: amountOf(row.requests),
                    tokens: {
                        input: amountOf(row.tokens?.input),
                        cacheRead: amountOf(row.tokens?.cacheRead),
                        output: amountOf(row.tokens?.output),
                        total: amountOf(row.tokens?.total),
                    },
                };
                continue;
            }
            found.cost += amountOf(row.cost);
            found.promptCost += amountOf(row.promptCost);
            found.requests += amountOf(row.requests);
            for (const key of MODEL_TOKEN_KEYS) {
                found.tokens[key] += amountOf(row.tokens?.[key]);
            }
        }
    }
    return finalize(out);
}
/** The client-facing price table: rounded like the docs, never a float artifact. */
export function priceTable() {
    return MODELS.map((row) => ({
        id: row.id,
        label: row.label,
        aliases: [...row.aliases],
        offPeak: { ...row.offPeak },
        peak: { ...row.peak },
    }));
}
/**
 * Fold one session's events into per-day totals, keyed by Beijing date.
 *
 * A separate pass from {@link foldEvents} on purpose: that function keeps only
 * the most recent `turnLimit` turns, so a long session's earlier days would be
 * dropped and the account view would silently under-report. This walks every
 * billed event and buckets by the event's own Beijing date, and it prices each
 * event's period the same way `foldEvents` does, so the two agree for any
 * session whose turns were not truncated.
 *
 * @param events - the session's OWN events (caller must exclude any inherited prefix).
 * @param options - holiday table override.
 */
export function foldEventsByDay(events, options = {}) {
    const holidays = options.holidays ?? DEFAULT_HOLIDAYS;
    const days = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        if (event === null || typeof event !== 'object' || event.type !== 'assistant/message')
            continue;
        const data = event.data;
        if (data === null || typeof data !== 'object')
            continue;
        const usage = data.usage;
        if (usage === null || typeof usage !== 'object')
            continue;
        const time = Number.isFinite(event.time) ? event.time : 0;
        const model = data.message?.source?.model ?? data.message?.source?.provider ?? '';
        const peak = isPeak(time, holidays);
        const priced = costOf(model, usage, peak);
        const date = beijingParts(time).date;
        let day = days.get(date);
        if (day === undefined) {
            day = {
                date,
                cost: 0,
                requests: 0,
                byPeriod: { peak: 0, offPeak: 0 },
                tokens: { input: 0, cacheRead: 0, output: 0, reasoning: 0, total: 0 },
            };
            days.set(date, day);
        }
        day.cost += priced.cost;
        day.requests += 1;
        day.byPeriod[peak ? 'peak' : 'offPeak'] += priced.cost;
        day.tokens.input += priced.buckets.input;
        day.tokens.cacheRead += priced.buckets.cacheRead;
        day.tokens.output += priced.buckets.output;
        day.tokens.reasoning += priced.buckets.reasoning;
        day.tokens.total += priced.buckets.total;
    }
    return days;
}
