/**
 * Host-half tests.
 *
 * These exercise the plugin entry through a context stub, which is where the
 * earlier defect lived: `sessionReport` returned a bare object, so the route
 * answered the fetch contract with a non-Response and the browser saw an empty
 * 400. A pure-function test suite cannot catch that, so the route table is
 * asserted here directly.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { apply, holidaysFrom, name } from '../lib/index.js';

/**
 * Model the query service's observation contract: `observeSession` resolves a
 * lease exposing `events` / `inheritedEventCount` / `source`, and the caller is
 * expected to release it through `Symbol.dispose`. `released` records whether the
 * host half actually did, which is a leak if it did not.
 */
function observationOf(events, { inherited = 0, source = 'log' } = {}) {
  const released = { count: 0 };
  const make = () => {
    let disposed = false;
    return {
      events,
      inheritedEventCount: inherited,
      source,
      [Symbol.dispose]() {
        if (disposed) throw new Error('observation disposed twice');
        disposed = true;
        released.count += 1;
      },
      released,
    };
  };
  return { make, released };
}

/** Route registrations captured from one apply(). */
function harness(options = {}) {
  const routes = new Map();
  const ctx = {
    get(name_) {
      if (name_ === 'deepseekAccount') return options.account;
      if (name_ === 'sessionQuery') {
        if (options.sessionQuery !== undefined) return options.sessionQuery;
        return {
          listSessions: async () => [
            { header: { id: 'session-root' } },
            { header: { id: 'session-child', parentSession: 'session-root' } },
            { header: { id: 'session-unrelated' } },
          ],
          observeSession: async (id) => {
            // An id the corpus does not know: DSH's reader rejects, which the
            // host half must contain into "no data" rather than an error.
            if (id !== 'session-root' && id !== 'session-child') throw new Error(`no session ${id}`);
            return observationOf([
              {
                type: 'assistant/message',
                seq: 1,
                time: Date.UTC(2026, 9, 12, 12, 0), // 20:00 Beijing, off-peak
                data: {
                  turn: 1,
                  step: 1,
                  usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
                  message: { source: { model: 'deepseek-v4.1-flash' } },
                },
              },
            ], { source: 'live' }).make();
          },
        };
      }
      if (name_ === 'connection') return { fetch: { register: (route) => { routes.set(route.path, route); return () => {}; } } };
      return undefined;
    },
    inject(services, callback) {
      callback(this);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  apply(ctx, options);
  return routes;
}

test('the host half exports the plugin contract', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(name, 'dsh-cost-breakdown');
  assert.equal(typeof apply, 'function');
  assert.ok(Array.isArray(mod.inject), 'inject must be an array');
});

test('every route registers as a POST buffered fetch route', () => {
  const routes = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    '/api/dsh-cost-breakdown/overview',
    '/api/dsh-cost-breakdown/session',
    '/api/dsh-cost-breakdown/status',
  ]);
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['POST']);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
});

test('the status route answers a real Response, not a bare object', async () => {
  const routes = harness();
  const response = await routes.get('/api/dsh-cost-breakdown/status').fetch(new Request('http://x/', { method: 'POST', body: '{}' }));
  assert.ok(response instanceof Response, 'a non-Response breaks the fetch contract');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.value.prices));
  assert.ok(body.value.prices.length >= 2);
  assert.equal(typeof body.value.period.peak, 'boolean');
});

test('the session route answers a real Response for a valid session', async () => {
  const routes = harness();
  const handler = routes.get('/api/dsh-cost-breakdown/session').fetch;
  const response = await handler(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'session-root' }) }),
  );
  // The regression: this used to be an empty 400 because the handler returned a
  // plain envelope object instead of a Response.
  assert.ok(response instanceof Response, 'the route must return a Response');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  const value = body.value;
  assert.equal(value.sessionId, 'session-root');
  assert.equal(value.sessionsWalked, 2, 'root plus its one child, not the unrelated session');
  assert.equal(value.combined.requests, 2, 'both sessions made one billed request');
  assert.equal(value.children.length, 1);
});

test('the session route rejects a body without a string sessionId', async () => {
  const routes = harness();
  const handler = routes.get('/api/dsh-cost-breakdown/session').fetch;
  for (const payload of ['{}', '{"sessionId":123}', '{"sessionId":""}', 'not json']) {
    const response = await handler(new Request('http://x/', { method: 'POST', body: payload }));
    assert.ok(response instanceof Response);
    assert.equal(response.status, 200, 'a bad request is an in-band envelope, not a transport failure');
    const body = await response.json();
    assert.equal(body.ok, false, `payload ${payload} must be refused`);
  }
});

test('a seeded child does not re-bill its inherited prefix', async () => {
  // A forked/summarized session copies its ancestor's events, marked by
  // `inheritedEventCount`. Those were already billed when the ancestor ran, so
  // counting them again would double-charge the same money.
  const billed = (tokens) => ({
    type: 'assistant/message',
    time: Date.UTC(2026, 9, 12, 12, 0),
    data: { turn: 1, step: 1, usage: { inputTokens: tokens }, message: { source: { model: 'deepseek-flash' } } },
  });
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { ...billed(1_000_000), seq: 1 }, // inherited from the parent
    { type: 'session/end-seed', seq: 2, time: 0, data: { inherited: true } },
    { ...billed(2_000_000), seq: 3 }, // this session's own request
  ];
  const routes = harness({
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'kid', isSeeded: true, parentSession: 'parent' } }],
      observeSession: async () => observationOf(events, { inherited: 3 }).make(),
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/session').fetch(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'kid' }) }),
  );
  const body = await response.json();
  const value = body.value;
  assert.equal(value.own.requests, 1, 'only the child-owned request is billed');
  // Flash off-peak cache-miss is 1 CNY per 1M, so 2M tokens is 2 CNY.
  assert.equal(value.own.cost, 2, 'the inherited 1M request must not be re-billed');
  assert.equal(value.combined.cost, 2);
  assert.equal(value.inheritedEventsSkipped, 3, 'the skipped prefix is reported');
});

test('an unmarked seeded child still stops at the seed marker', async () => {
  // Some logs omit `inheritedEventCount`; `session/end-seed { inherited: true }`
  // is the event that marks the same cut.
  const events = [
    { type: 'assistant/message', seq: 0, time: Date.UTC(2026, 9, 12, 12, 0),
      data: { usage: { inputTokens: 1_000_000 }, message: { source: { model: 'deepseek-flash' } } } },
    { type: 'session/end-seed', seq: 1, time: 0, data: { inherited: true } },
    { type: 'assistant/message', seq: 2, time: Date.UTC(2026, 9, 12, 12, 0),
      data: { usage: { inputTokens: 3_000_000 }, message: { source: { model: 'deepseek-flash' } } } },
  ];
  const routes = harness({
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'kid', isSeeded: true } }],
      // No `inheritedEventCount`: the seed marker must do the work.
      observeSession: async () => observationOf(events).make(),
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/session').fetch(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'kid' }) }),
  );
  const value = (await response.json()).value;
  assert.equal(value.own.requests, 1);
  assert.equal(value.own.cost, 3, 'only the post-marker request is billed');
});

test('a non-seeded session bills every request', async () => {
  // The dedup must not misfire on an ordinary session with no inheritance.
  const routes = harness();
  const response = await routes.get('/api/dsh-cost-breakdown/session').fetch(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'session-root' }) }),
  );
  const value = (await response.json()).value;
  assert.equal(value.own.requests, 1);
  assert.equal(value.inheritedEventsSkipped, 0);
});

test('a session with no reachable log reports an empty value, not an error', async () => {
  const routes = harness();
  const handler = routes.get('/api/dsh-cost-breakdown/session').fetch;
  const response = await handler(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'session-does-not-exist' }) }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.value, null, 'an unknown session is simply empty');
});

test('the account service splits topped-up and granted wallets', async () => {
  // The regression: the two wallets used to be summed into `total` with the
  // breakdown left at zero, so the panel could never show which part was bonus.
  const routes = harness({
    account: {
      getState: async () => ({ status: 'credential-stored' }),
      getBalance: async () => ({
        status: 'ready',
        value: [{ currency: 'CNY', balance: '30.50' }],
        bonusWallets: [{ currency: 'CNY', balance: '7.62' }],
      }),
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/status').fetch(
    new Request('http://x/', { method: 'POST', body: '{}' }),
  );
  const body = await response.json();
  const balance = body.value.balance;
  assert.equal(balance.source, 'account');
  assert.equal(balance.balances.length, 1);
  const [cny] = balance.balances;
  assert.equal(cny.toppedUp, 30.5, 'value[] is the recharge wallet');
  assert.equal(cny.granted, 7.62, 'bonusWallets[] is the granted wallet');
  assert.equal(cny.total, 38.12, 'the total is the two summed');
});

test('a signed-out account is reported as such, not as a zero balance', async () => {
  const routes = harness({
    account: {
      getState: async () => ({ status: 'signed-out' }),
      getBalance: async () => {
        throw new Error('must not be called while signed out');
      },
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/status').fetch(
    new Request('http://x/', { method: 'POST', body: '{}' }),
  );
  const body = await response.json();
  assert.equal(body.value.balance.source, 'none');
  assert.deepEqual(body.value.balance.balances, []);
});

test('a failing balance service never breaks the status route', async () => {
  const routes = harness({
    account: {
      getState: async () => {
        throw new Error('account service exploded');
      },
      getBalance: async () => {
        throw new Error('account service exploded');
      },
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/status').fetch(
    new Request('http://x/', { method: 'POST', body: '{}' }),
  );
  assert.equal(response.status, 200, 'the panel still gets pricing and period data');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.value.prices.length > 0, 'prices are served regardless of the account');
  assert.equal(body.value.balance.isAvailable, false);
});

test('account metadata uses the documented offset convention', async () => {
  // The official account UI sends `-(getTimezoneOffset()) * 60` — seconds EAST
  // of UTC. A fixed -8h literal would be wrong on any other machine and had the
  // sign inverted, so assert the value the host actually computes.
  let seen = null;
  const routes = harness({
    account: {
      getState: async () => ({ status: 'credential-stored' }),
      getBalance: async (client) => {
        seen = client;
        return { status: 'ready', value: [{ currency: 'CNY', balance: '1' }], bonusWallets: [] };
      },
    },
  });
  await routes.get('/api/dsh-cost-breakdown/status').fetch(
    new Request('http://x/', { method: 'POST', body: '{}' }),
  );
  assert.ok(seen !== null, 'the account service must be called with client metadata');
  assert.equal(typeof seen.version, 'string');
  assert.equal(typeof seen.locale, 'string');
  assert.equal(
    seen.timezoneOffsetSeconds,
    -new Date().getTimezoneOffset() * 60,
    'the offset must follow the official sign convention and be computed, not hardcoded',
  );
});

test('every observation lease is released, including on failure', async () => {
  // Holding a lease pins the query service's observation; releasing it is part
  // of the contract, so count disposals for both a success and a failure path.
  const releases = { ok: 0, bad: 0 };
  const routes = harness({
    sessionQuery: {
      // The walk goes DOWNWARD from the requested session, so request the
      // parent: it answers with a lease, and its child is unreadable.
      listSessions: async () => [
        { header: { id: 'parent' } },
        { header: { id: 'kid', parentSession: 'parent' } },
      ],
      observeSession: async (id) => {
        if (id === 'parent') {
          const { make, released } = observationOf([]);
          const lease = make();
          // Wrap the disposer so the counter survives the host's release call.
          return {
            ...lease,
            [Symbol.dispose]() {
              lease[Symbol.dispose]();
              releases.ok = released.count;
            },
          };
        }
        // Reject BEFORE a lease exists: nothing to release, and the walk must
        // still continue rather than aborting the whole report.
        releases.bad += 1;
        throw new Error(`no session ${id}`);
      },
    },
  });
  const response = await routes.get('/api/dsh-cost-breakdown/session').fetch(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ sessionId: 'parent' }) }),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(releases.ok, 1, 'the successful read released its lease exactly once');
  assert.equal(body.value.missing, 1, 'the unreadable descendant is counted as missing, not fatal');
});

test('an unusable holidays config keeps the built-in table in force', async () => {
  // The failure mode this guards is silent and expensive: an empty table prices
  // every public holiday at the PEAK rate, doubling those days. So the resolver
  // must answer `undefined` (= "use the built-in table") for any config that
  // yields no usable date, rather than answering `[]` (= "no holidays").
  for (const bad of [['not-a-date'], [123, null], [], 'nonsense', undefined, null, 42, {}]) {
    assert.equal(
      holidaysFrom({ holidays: bad }),
      undefined,
      `config ${JSON.stringify(bad) ?? 'undefined'} must fall back to the built-in table`,
    );
  }

  // A usable list is returned intact, with malformed entries dropped.
  assert.deepEqual(holidaysFrom({ holidays: ['2026-10-08', 'bad', '2026-10-09'] }), ['2026-10-08', '2026-10-09']);
  assert.deepEqual(holidaysFrom({ holidays: ['2026-01-01'] }), ['2026-01-01']);

  // And the difference is worth real money on a holiday, which is why this
  // cannot be left to "the route still answered 200".
  const { foldEvents } = await import('../lib/pricing.mjs');
  const at = Date.UTC(2026, 9, 1, 2, 0, 0); // 2026-10-01 (holiday), 10:00 Beijing
  const events = [{
    type: 'assistant/message', seq: 1, time: at,
    data: { usage: { inputTokens: 1_000_000 }, message: { source: { model: 'deepseek-flash' } } },
  }];
  assert.equal(foldEvents(events, { holidays: holidaysFrom({}) }).cost, 1, 'holiday = off-peak');
  assert.equal(foldEvents(events, { holidays: [] }).cost, 2, 'an empty table would double it');
});

test('a valid holidays config is accepted in full', async () => {
  const routes = harness({ holidays: ['2026-10-08', '2026-10-09'] });
  const response = await routes.get('/api/dsh-cost-breakdown/status').fetch(
    new Request('http://x/', { method: 'POST', body: '{}' }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

// ---------------------------------------------------------------------------
// Account overview
// ---------------------------------------------------------------------------

/** A query face serving canned per-session logs, with real parent links. */
function overviewHarness(sessions) {
  return harness({
    sessionQuery: {
      listSessions: async () => sessions.map((s) => ({ header: s.header, live: false, persisted: true })),
      observeSession: async (id) => {
        const hit = sessions.find((s) => s.header.id === id);
        if (hit === undefined) throw new Error(`no session ${id}`);
        return observationOf(hit.events, { source: 'log' }).make();
      },
    },
  });
}

/** One billed event at a given Beijing instant. */
function billed(seq, time, inputTokens = 1_000_000) {
  return {
    type: 'assistant/message', seq, time,
    data: { usage: { inputTokens }, message: { source: { model: 'deepseek-flash' } } },
  };
}

const overviewOf = async (routes, days = 30) => {
  const response = await routes.get('/api/dsh-cost-breakdown/overview').fetch(
    new Request('http://x/', { method: 'POST', body: JSON.stringify({ days }) }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true, 'the overview must answer the in-band envelope');
  return body.value;
};

/** Epoch ms for `daysAgo` at Beijing midnight. */
function agoBeijing(daysAgo) {
  const now = new Date(Date.now() + 8 * 3600_000);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600_000;
  return midnight - daysAgo * 86_400_000;
}

/** The `YYYY-MM-DD` Beijing label of an epoch instant. */
function beijingDay(time) {
  const d = new Date(time + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

test('the overview buckets spend by Beijing day across sessions', async () => {
  // Two sessions on different days, plus a third with two events on one day.
  // Off-peak instants are used so the expected cost is exact (rate 1/1M input).
  // Dates are relative to now on purpose: the window filter works from today, so
  // an absolute date would drift out of every window as time passes and the test
  // would fail for a reason unrelated to what it checks.
  const dayA = agoBeijing(2);
  const dayB = agoBeijing(1);
  const routes = overviewHarness([
    { header: { id: 's-a', createdAt: dayA }, events: [billed(1, dayA + 12 * 3600_000)] },
    { header: { id: 's-b', createdAt: dayB }, events: [billed(1, dayB + 12 * 3600_000), billed(2, dayB + 13 * 3600_000)] },
  ]);
  const value = await overviewOf(routes);
  const byDate = Object.fromEntries(value.days.map((d) => [d.date, d]));
  assert.equal(byDate[beijingDay(dayA)].cost, 1, 'one request at the off-peak rate');
  assert.equal(byDate[beijingDay(dayB)].cost, 2, 'two requests on the second day');
  assert.equal(byDate[beijingDay(dayB)].requests, 2);
  assert.deepEqual(value.days.map((d) => d.date), [beijingDay(dayA), beijingDay(dayB)], 'days ascend');

  // The headline figure and the chart must agree: they are two views of one
  // number, and a mismatch is the bug this guards.
  const daySum = value.days.reduce((sum, d) => sum + d.cost, 0);
  assert.ok(Math.abs(daySum - value.totals.cost) < 1e-9, `days (${daySum}) must sum to the total (${value.totals.cost})`);
});

test('the overview counts a descendant own spend, and marks it', async () => {
  // A parent and its child. The child's log here holds only its OWN event (the
  // host strips any inherited prefix before folding), so that spend is real and
  // must be counted — the same way the single-session view adds `own + children`.
  const when = agoBeijing(1);
  const routes = overviewHarness([
    { header: { id: 'root-1', createdAt: when }, events: [billed(1, when + 12 * 3600_000)] },
    { header: { id: 'child-1', parentSession: 'root-1', createdAt: when + 3600_000 }, events: [billed(2, when + 13 * 3600_000)] },
  ]);
  const value = await overviewOf(routes);
  const child = value.sessions.find((s) => s.sessionId === 'child-1');
  const root = value.sessions.find((s) => s.sessionId === 'root-1');
  assert.equal(child.isChild, true, 'a session whose parent is present is marked as a descendant');
  assert.equal(root.isChild, false, 'a parent must NOT be marked as a descendant');
  assert.equal(value.totals.cost, 2, 'both the parent and the descendant own spend count');
  assert.equal(value.totals.requests, 2);
});

test('the overview omits sessions with no billed activity', async () => {
  const when = agoBeijing(1);
  const routes = overviewHarness([
    { header: { id: 'busy', createdAt: when }, events: [billed(1, when + 12 * 3600_000)] },
    { header: { id: 'idle', createdAt: when }, events: [{ type: 'session/title', seq: 1, time: when + 3600_000, data: { title: 'nothing billed' } }] },
  ]);
  const value = await overviewOf(routes);
  assert.deepEqual(value.sessions.map((s) => s.sessionId), ['busy'], 'an unbilled session is not listed');
  assert.equal(value.totals.cost, 1);
});

test('the overview window excludes older sessions and clamps its input', async () => {
  const now = Date.now();
  const recent = { header: { id: 'recent', createdAt: now - 3600_000 }, events: [billed(1, now - 1800_000)] };
  // 100 days old: inside the 365-day cap but well outside a 7-day window, so the
  // two windows genuinely differ. (At 400 days it would fall outside both and
  // the "wide window includes it" assertion below could never hold.)
  const old = { header: { id: 'ancient', createdAt: now - 100 * 24 * 3600_000 }, events: [billed(1, now - 99 * 24 * 3600_000)] };
  const routes = overviewHarness([recent, old]);

  const narrow = await overviewOf(routes, 7);
  assert.deepEqual(narrow.sessions.map((s) => s.sessionId), ['recent'], 'a 7-day window drops the old session');
  assert.equal(narrow.windowDays, 7);

  const wide = await overviewOf(routes, 365);
  assert.equal(wide.sessions.length, 2, 'a wide window includes it again');

  // A nonsensical window must not reach the aggregator as-is.
  const clampHigh = await overviewOf(routes, 99_999);
  assert.equal(clampHigh.windowDays, 365, 'the window is capped');
  const clampLow = await overviewOf(routes, -5);
  assert.equal(clampLow.windowDays, 1, 'a non-positive window falls back to the minimum');
});

test('the overview tolerates an absent query service and unreadable logs', async () => {
  // No sessionQuery at all: the page must answer empty rather than throw.
  const bare = harness({ sessionQuery: null });
  const value = await overviewOf(bare);
  assert.deepEqual(value.days, []);
  assert.deepEqual(value.sessions, []);
  assert.equal(value.totals.cost, 0);

  // A corpus that lists a session whose log cannot be read counts it as missing.
  const routes = overviewHarness([{ header: { id: 'ghost', createdAt: Date.now() }, events: [billed(1, Date.now())] }]);
  const routesGhost = harness({
    sessionQuery: {
      listSessions: async () => [{ header: { id: 'ghost' } }, { header: { id: 'real', createdAt: Date.now() } }],
      observeSession: async (id) => {
        if (id === 'ghost') throw new Error('unreadable');
        return observationOf([billed(1, Date.now())], { source: 'log' }).make();
      },
    },
  });
  const valueGhost = await overviewOf(routesGhost);
  assert.equal(valueGhost.missing, 1, 'the unreadable session is reported, not fatal');
  assert.equal(valueGhost.sessions.length, 1, 'the readable one still contributes');
  assert.ok(routes.size > 0);
});

test('the window filters events, not just which sessions are read', async () => {
  // The bug this guards: the window selected sessions by recency and then summed
  // each one's WHOLE log, so a session active today but started months ago leaked
  // its out-of-window spend into a 7-day total, and the headline disagreed with
  // the day buckets the chart draws. A real 7-day request reported dates from two
  // months back.
  const old3 = agoBeijing(60);
  const old30 = agoBeijing(30);
  const recent = agoBeijing(1);
  const routes = overviewHarness([
    {
      header: { id: 'straddler', createdAt: old3 },
      events: [billed(1, old3 + 3600_000), billed(2, old30 + 3600_000), billed(3, recent + 3600_000)],
    },
  ]);

  const narrow = await overviewOf(routes, 7);
  // Only the recent event may count, and only its day may be listed.
  assert.equal(narrow.totals.requests, 1, 'only the in-window request is billed');
  assert.deepEqual(narrow.days.map((d) => d.date), [beijingDay(recent)], 'only in-window days appear');
  const daySum = narrow.days.reduce((sum, d) => sum + d.cost, 0);
  assert.ok(
    Math.abs(daySum - narrow.totals.cost) < 1e-9,
    `the chart must agree with the headline (days=${daySum}, total=${narrow.totals.cost})`,
  );

  // A window wide enough to cover every event must include them all.
  const wide = await overviewOf(routes, 90);
  assert.equal(wide.totals.requests, 3, 'a 90-day window includes all three events');
  assert.equal(wide.days.length, 3, 'and lists all three days');
});

test('the overview reports activity counters and a window-wide cache rate', async () => {
  // Turns and steps are read off the log's own markers rather than inferred, and
  // the hit rate is computed from the summed buckets (averaging per-session rates
  // would let a small high-rate session outweigh a large low-rate one).
  const when = agoBeijing(1);
  const withActivity = (id) => ({
    header: { id, createdAt: when },
    events: [
      { type: 'turn/start', seq: 1, time: when + 3600_000 },
      { type: 'step/start', seq: 2, time: when + 3600_000 },
      { type: 'tool/call', seq: 3, time: when + 3600_000 },
      {
        type: 'assistant/message', seq: 4, time: when + 3700_000,
        data: {
          turn: 1, step: 1,
          // 9M cached against 1M miss = 90% for this session.
          usage: { inputTokens: 1_000_000, cacheReadTokens: 9_000_000, outputTokens: 0 },
          message: { source: { model: 'deepseek-flash' } },
        },
      },
    ],
  });
  const routes = overviewHarness([withActivity('a'), withActivity('b')]);
  const value = await overviewOf(routes);

  assert.equal(value.totals.activity.turns, 2, 'one turn per session');
  assert.equal(value.totals.activity.steps, 2, 'one step per session');
  assert.equal(value.totals.activity.toolCalls, 2, 'one tool call per session');
  assert.equal(value.totals.sessions, 2, 'both sessions are counted');
  // 18M cached of 20M prompt = 90%.
  assert.ok(Math.abs(value.totals.cacheHitRate - 90) < 1e-6, `hit rate was ${value.totals.cacheHitRate}`);
  assert.equal(value.sessions.length, 2);
  assert.ok(Math.abs(value.sessions[0].cacheHitRate - 90) < 1e-6, 'per-session rate matches');
  assert.equal(value.days[0].activity.turns, 2, 'day buckets carry the activity too');
  assert.equal(value.days[0].sessions, 2, 'a day counts each active session once');
});
