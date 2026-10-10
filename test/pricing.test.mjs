/**
 * Unit tests for the pricing core.
 *
 * The load-bearing cases are the ones that would silently produce a wrong
 * number: the token-bucket reconciliation (DSH reports cache-miss input in
 * `inputTokens`) and the peak/off-peak boundary.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_HOLIDAYS,
  MODELS,
  beijingParts,
  bucketsOf,
  combine,
  costOf,
  foldEvents,
  isPeak,
  matchModel,
  periodAt,
  priceTable,
} from '../lib/pricing.mjs';

/** Beijing wall-clock instant as epoch ms. */
function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0);
}

test('beijingParts converts an epoch instant to Beijing wall clock', () => {
  // 2026-10-10T00:48:58+08:00
  const parts = beijingParts(Date.UTC(2026, 9, 9, 16, 48, 58));
  assert.equal(parts.date, '2026-10-10');
  assert.equal(parts.hour, 0);
  assert.equal(parts.minute, 48);
  assert.equal(parts.weekday, 6, '2026-10-10 is a Saturday');
});

test('isPeak follows the two Beijing weekday windows', () => {
  // 2026-10-12 is a Monday.
  assert.equal(isPeak(beijing(2026, 10, 12, 9, 0)), true, '09:00 is the first peak minute');
  assert.equal(isPeak(beijing(2026, 10, 12, 11, 59)), true);
  assert.equal(isPeak(beijing(2026, 10, 12, 12, 0)), false, '12:00 is off-peak');
  assert.equal(isPeak(beijing(2026, 10, 12, 14, 0)), true, '14:00 opens the second window');
  assert.equal(isPeak(beijing(2026, 10, 12, 17, 59)), true);
  assert.equal(isPeak(beijing(2026, 10, 12, 18, 0)), false, '18:00 closes it');
  assert.equal(isPeak(beijing(2026, 10, 12, 8, 59)), false);
  assert.equal(isPeak(beijing(2026, 10, 12, 13, 0)), false, 'the lunch gap is off-peak');
});

test('weekends are off-peak all day', () => {
  // 2026-10-10 Saturday, 2026-10-11 Sunday.
  assert.equal(isPeak(beijing(2026, 10, 10, 10, 0)), false);
  assert.equal(isPeak(beijing(2026, 10, 11, 15, 0)), false);
});

test('holidays are off-peak even on a weekday', () => {
  // 2026-10-01 is a Thursday and a listed holiday.
  assert.ok(DEFAULT_HOLIDAYS.includes('2026-10-01'));
  assert.equal(isPeak(beijing(2026, 10, 1, 10, 0)), false);
  // The same hour is peak on an ordinary Thursday.
  assert.equal(isPeak(beijing(2026, 10, 8, 10, 0)), true);
});

test('periodAt reports the flip instant', () => {
  // One minute before 12:00 on a Monday.
  const before = periodAt(beijing(2026, 10, 12, 11, 59));
  assert.equal(before.peak, true);
  assert.notEqual(before.next, null);
  assert.equal(before.next.peak, false);
  assert.equal(beijingParts(before.next.at).hour, 12);
  assert.equal(beijingParts(before.next.at).minute, 0);

  // Inside the lunch gap, the next flip is 14:00 back to peak.
  const lunch = periodAt(beijing(2026, 10, 12, 13, 0));
  assert.equal(lunch.peak, false);
  assert.equal(lunch.next.peak, true);
  assert.equal(beijingParts(lunch.next.at).hour, 14);
});

test('matchModel accepts every historical and versioned id', () => {
  const flash = MODELS.find((row) => row.id === 'deepseek-flash');
  const pro = MODELS.find((row) => row.id === 'deepseek-v4-pro');
  assert.equal(matchModel('deepseek-flash')?.id, flash.id);
  assert.equal(matchModel('deepseek-v4.1-flash')?.id, flash.id, 'the id DSH actually records');
  assert.equal(matchModel('deepseek-v4-flash')?.id, flash.id, 'legacy name');
  assert.equal(matchModel('deepseek-v4-flash-vision-exp')?.id, flash.id, 'legacy vision name');
  assert.equal(matchModel('deepseek-v4-pro')?.id, pro.id);
  assert.equal(matchModel('some-unknown-model'), null);
  assert.equal(matchModel(''), null);
  assert.equal(matchModel(undefined), null);
});

test('bucketsOf reconciles the real recorded usage shape', () => {
  // A real DSH `assistant/message` usage record.
  const buckets = bucketsOf({ inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672 });
  assert.equal(buckets.input, 192, 'inputTokens is the cache-MISS input');
  assert.equal(buckets.cacheRead, 12672, 'cacheReadTokens is the cache-HIT input');
  assert.equal(buckets.output, 238);
  assert.equal(buckets.total, 13102);
  assert.equal(buckets.input + buckets.cacheRead + buckets.output, buckets.total, 'buckets must sum to the reported total');
});

test('costOf prices each bucket separately at the off-peak rate', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  const off = costOf('deepseek-flash', usage, false);
  // Flash off-peak: cache hit 0.02, miss 1, output 4.
  assert.equal(off.known, true);
  assert.equal(off.cost, 5.02);
  assert.equal(off.parts.cacheHit, 0.02);
  assert.equal(off.parts.cacheMiss, 1);
  assert.equal(off.parts.output, 4);
});

test('costOf charges exactly double during peak', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  const off = costOf('deepseek-flash', usage, false);
  const peak = costOf('deepseek-flash', usage, true);
  assert.equal(peak.cost, off.cost * 2);
  assert.equal(peak.cost, 10.04);
});

test('costOf prices the Pro row from its own table', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
  assert.equal(costOf('deepseek-v4-pro', usage, false).cost, 0.15 + 4.5 + 13.5);
  assert.equal(costOf('deepseek-v4-pro', usage, true).cost, 0.3 + 9 + 27);
});

test('an unknown model is reported unpriced, never counted as free', () => {
  const priced = costOf('mystery-model', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, false);
  assert.equal(priced.known, false);
  assert.equal(priced.cost, 0);
  assert.equal(priced.model, null);
});

test('reading inputTokens as the whole prompt would double the real cost', () => {
  // The regression this guards: a 13102-token request is mostly cache hits.
  const usage = { inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672 };
  const correct = costOf('deepseek-flash', usage, false).cost;
  // The mistaken reading: every prompt token billed at the cache-miss rate.
  const mistaken = ((192 + 12672) * 1 + 238 * 4) / 1_000_000;
  assert.ok(correct < mistaken, `correct=${correct} must be far below mistaken=${mistaken}`);
  assert.ok(correct < 0.002, 'a nearly-all-cache-hit request is very cheap');
});

test('foldEvents prices a session and splits it by period', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: beijing(2026, 10, 12, 10, 0), data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: beijing(2026, 10, 12, 10, 0),
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
        message: { source: { model: 'deepseek-v4.1-flash' } },
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: beijing(2026, 10, 12, 20, 0),
      data: {
        turn: 1,
        step: 2,
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
        message: { source: { model: 'deepseek-v4.1-flash' } },
      },
    },
  ];
  const totals = foldEvents(events);
  assert.equal(totals.requests, 2);
  assert.equal(totals.byPeriod.peak, 2, '10:00 peak: 1M miss tokens at 2 CNY');
  assert.equal(totals.byPeriod.offPeak, 1, '20:00 off-peak: the same tokens at 1 CNY');
  assert.equal(totals.cost, 3);
  assert.equal(totals.tokens.input, 2_000_000);
  assert.equal(totals.unpriced, 0);
});

test('foldEvents ignores events that carry no usage', () => {
  const totals = foldEvents([
    { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
    { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, step: 1, name: 'bash' } },
  ]);
  assert.equal(totals.requests, 0);
  assert.equal(totals.cost, 0);
});

test('foldEvents records unpriced models without dropping the request', () => {
  const totals = foldEvents([
    {
      type: 'assistant/message',
      seq: 1,
      time: beijing(2026, 10, 12, 20, 0),
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5 }, message: { source: { model: 'glm-5' } } },
    },
  ]);
  assert.equal(totals.requests, 1);
  assert.equal(totals.cost, 0);
  assert.equal(totals.unpriced, 1);
  assert.deepEqual(totals.unpricedModels, ['glm-5']);
});

test('foldEvents tolerates a malformed event log', () => {
  const totals = foldEvents([null, 42, {}, { type: 'assistant/message' }, { type: 'assistant/message', data: null }]);
  assert.equal(totals.requests, 0);
  assert.equal(totals.cost, 0);
  assert.deepEqual(foldEvents(undefined).requests, 0);
});

test('foldEvents groups by model, most expensive first', () => {
  const at = beijing(2026, 10, 12, 20, 0);
  const totals = foldEvents([
    {
      type: 'assistant/message',
      seq: 1,
      time: at,
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: { source: { model: 'deepseek-flash' } } },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: at,
      data: { usage: { inputTokens: 1_000_000, outputTokens: 0 }, message: { source: { model: 'deepseek-v4-pro' } } },
    },
  ]);
  assert.equal(totals.byModel.length, 2);
  assert.equal(totals.byModel[0].model, 'deepseek-v4-pro', 'the Pro row costs more');
  assert.equal(totals.byModel[0].cost, 4.5);
  assert.equal(totals.byModel[1].cost, 1);
});

test('foldEvents can keep only the most recent turns', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({
    type: 'assistant/message',
    seq: index + 1,
    time: beijing(2026, 10, 12, 20, 0),
    data: { turn: index + 1, step: 1, usage: { inputTokens: 1 }, message: { source: { model: 'deepseek-flash' } } },
  }));
  const totals = foldEvents(events, { turnLimit: 3 });
  assert.equal(totals.requests, 10, 'the totals still count every request');
  assert.equal(totals.turns.length, 3, 'only the tail of the turn list is kept');
  assert.equal(totals.turns[2].turn, 10);
});

test('combine adds a session and its descendants', () => {
  const at = beijing(2026, 10, 12, 20, 0);
  const root = foldEvents([
    {
      type: 'assistant/message',
      seq: 1,
      time: at,
      data: { usage: { inputTokens: 1_000_000 }, message: { source: { model: 'deepseek-flash' } } },
    },
  ]);
  const child = foldEvents([
    {
      type: 'assistant/message',
      seq: 1,
      time: at,
      data: { usage: { inputTokens: 2_000_000 }, message: { source: { model: 'deepseek-flash' } } },
    },
  ]);
  const total = combine([root, child]);
  assert.equal(total.cost, 3);
  assert.equal(total.requests, 2);
  assert.equal(total.tokens.input, 3_000_000);
  assert.equal(total.byModel.length, 1, 'same model merges into one row');
  assert.equal(total.byModel[0].requests, 2);
});

test('combine tolerates empty and malformed input', () => {
  assert.equal(combine([]).cost, 0);
  assert.equal(combine([null, undefined, 7]).cost, 0);
});

test('priceTable exposes the documented figures', () => {
  const table = priceTable();
  const flash = table.find((row) => row.id === 'deepseek-flash');
  assert.deepEqual(flash.peak, { cacheHit: 0.04, cacheMiss: 2, output: 8 });
  assert.deepEqual(flash.offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4 });
  const pro = table.find((row) => row.id === 'deepseek-v4-pro');
  assert.deepEqual(pro.peak, { cacheHit: 0.3, cacheMiss: 9, output: 27 });
  assert.deepEqual(pro.offPeak, { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 });
});

test('every off-peak rate is exactly half its peak rate', () => {
  for (const row of MODELS) {
    for (const bucket of ['cacheHit', 'cacheMiss', 'output']) {
      assert.equal(row.offPeak[bucket] * 2, row.peak[bucket], `${row.id}.${bucket}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Context composition (src/context.mts -> lib/context.mjs)
// ---------------------------------------------------------------------------

test('contextComposition anchors its split to the provider prompt count', async () => {
  // The card claims "of the N prompt tokens billed, this is the split", so the
  // categories must sum to the provider's own number rather than to an estimate.
  const { contextComposition } = await import('../lib/context.mjs');
  const at = Date.UTC(2026, 9, 12, 12, 0); // 20:00 Beijing, off-peak
  const events = [
    { type: 'request/context', seq: 1, time: at, data: { contextWindow: 1_000_000 } },
    { type: 'request/header', seq: 2, time: at, data: { header: { tools: [{ name: 'read', description: 'x'.repeat(400) }] } } },
    { type: 'system/message', seq: 3, time: at, surfaceOp: 'append', data: { message: { role: 'system', content: [{ type: 'text', text: 'y'.repeat(2000) }] } } },
    { type: 'user/message', seq: 4, time: at, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'z'.repeat(1000) }] } } },
    {
      type: 'assistant/message', seq: 5, time: at, surfaceOp: 'append',
      data: {
        usage: { inputTokens: 400, cacheReadTokens: 1600, outputTokens: 50 },
        message: { role: 'assistant', source: { model: 'deepseek-flash' }, content: [{ type: 'text', text: 'w'.repeat(500) }] },
      },
    },
  ];
  const composition = contextComposition(events, { promptCost: 10 });

  assert.equal(composition.anchor, 2000, 'the anchor is prompt = cache-miss + cache-read');
  assert.equal(composition.anchored, true);
  assert.equal(composition.total, 2000, 'the anchored total is the provider count');
  assert.equal(
    composition.categories.reduce((sum, c) => sum + c.tokens, 0),
    2000,
    'the categories sum to the anchored total',
  );
  assert.equal(composition.window, 1_000_000);
  assert.ok(Math.abs(composition.occupancy - 0.2) < 1e-9, `occupancy is 0.2% (was ${composition.occupancy})`);

  // Cost is attributed across the categories and must not exceed the prompt cost.
  const cost = composition.categories.reduce((sum, c) => sum + c.cost, 0);
  assert.ok(Math.abs(cost - 10) < 1e-6, `attributed cost sums to the prompt cost (was ${cost})`);
  const share = composition.categories.reduce((sum, c) => sum + c.share, 0);
  assert.ok(Math.abs(share - 100) < 1e-6, `shares sum to 100% (was ${share})`);
  // Largest first: the card answers "what is eating the window".
  for (let i = 1; i < composition.categories.length; i += 1) {
    assert.ok(composition.categories[i - 1].tokens >= composition.categories[i].tokens, 'sorted desc');
  }
});

test('contextComposition records a rewrite once, not once per half', async () => {
  // Real logs record ONE rewrite twice: a `compaction/prune` carrying
  // `data.shadowedRange`, then a `surfaceOp: {op:'replace'}` event on the next
  // seq naming the same range. Counting both reported twice the rewrites that
  // happened, and the replace half alone would still double it.
  const { contextComposition } = await import('../lib/context.mjs');
  const at = Date.UTC(2026, 9, 12, 12, 0);
  const base = [
    { type: 'system/message', seq: 1, time: at, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 's'.repeat(400) }] } } },
    { type: 'user/message', seq: 2, time: at, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'u'.repeat(400) }] } } },
    { type: 'assistant/message', seq: 3, time: at, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'a'.repeat(400) }] } } },
    // One rewrite, logged as the prune half then the replace half.
    { type: 'compaction/prune', seq: 4, time: at, data: { shadowedRange: { start: 2, end: 2 }, shadowedSeqs: [2], shadowedTokenCount: 100 } },
    { type: 'tool/result', seq: 5, time: at, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, data: { message: { content: [{ type: 'text', text: 'r'.repeat(400) }] } } },
    // A second, standalone replace (no prune twin) must still be counted.
    { type: 'tool/result', seq: 6, time: at, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: { message: { content: [{ type: 'text', text: 'r'.repeat(400) }] } } },
    { type: 'assistant/message', seq: 7, time: at, data: { usage: { inputTokens: 100, cacheReadTokens: 900 } } },
  ];
  const composition = contextComposition(base);
  assert.equal(composition.compactions, 2, 'one paired rewrite plus one standalone replace');
  assert.equal(composition.anchor, 1000);
  // The pruned and replaced nodes are gone; only the surviving ones are counted.
  assert.ok(composition.total > 0);
});

test('contextComposition reports an unanchored estimate rather than pretending', async () => {
  // Without a billed request there is no provider count to anchor to. The
  // estimate still renders, but `anchored` says so.
  const { contextComposition } = await import('../lib/context.mjs');
  const at = Date.UTC(2026, 9, 12, 12, 0);
  const composition = contextComposition([
    { type: 'system/message', seq: 1, time: at, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'x'.repeat(1980) }] } } },
  ]);
  assert.equal(composition.anchor, null);
  assert.equal(composition.anchored, false);
  assert.ok(composition.total > 0, 'an estimate is still produced');
  assert.equal(composition.occupancy, null, 'occupancy needs a recorded window');
});
