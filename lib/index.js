/**
 * dsh-cost-breakdown v0.1.0
 * Token 用量与费用：按平台分别计价，各用自己的账单单位（人民币 / 美元 / 积分），卡内含逐模型消费与调用次数；官方人民币价目表含峰谷与法定节假日。同时保留上下文仪表盘、浏览器与 /context 命令。
 * @author liaimei
 * @license Apache-2.0
 * @homepage https://github.com/liaimei/dsh-cost-breakdown
 * @built 2026-10-18T01:38:56+08:00
 * @commit 2c81301b21ef (dirty working tree) on rewrite
 * @commit-date 2026-10-18T01:37:29+08:00
 */

import { createRequire } from "node:module";
import { getHeapStatistics } from "node:v8";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import z$1 from "@deepseek-ai/schemastery";
//#region src/core/version.ts
const BASELINE_RELEASE = "0.1.7-rc.2";
const RELEASE_RANK = 4;
const CHANNEL_RANK = {
	rc: 3,
	beta: 2,
	alpha: 1
};
function parseRelease(version) {
	if (typeof version !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim());
	if (match === null) return null;
	const channel = match[4] === void 0 ? void 0 : match[4].toLowerCase();
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		rank: channel === void 0 ? RELEASE_RANK : CHANNEL_RANK[channel] ?? 0,
		serial: match[5] === void 0 ? 0 : Number(match[5])
	};
}
function compareReleases(left, right) {
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.rank !== right.rank) return left.rank - right.rank;
	return left.serial - right.serial;
}
function meetsBaseline(version, baseline = BASELINE_RELEASE) {
	const parsed = parseRelease(version);
	const floor = parseRelease(baseline);
	if (parsed === null || floor === null) return true;
	return compareReleases(parsed, floor) >= 0;
}
//#endregion
//#region src/host/http/router.ts
const ROUTE_PREFIX = "/api/dsh-cost-breakdown";
const BAD_REQUEST_CODE = "dsh-cost-breakdown/bad-request";
const INTERNAL_ERROR_CODE = "gateway/internal";
function routePath(name) {
	return `${ROUTE_PREFIX}/${name}`;
}
function routeRegistrar(connection) {
	const fetch = connection?.fetch;
	return typeof fetch?.register === "function" ? fetch.register.bind(fetch) : void 0;
}
function registerPostRoute(scope, connection, path, handler, label) {
	const register = routeRegistrar(connection);
	if (register === void 0) return false;
	try {
		scope.effect(() => {
			const dispose = register({
				path,
				methods: ["POST"],
				requestBody: "buffered",
				fetch: handler
			});
			return typeof dispose === "function" ? dispose : () => {};
		}, label);
	} catch {
		return false;
	}
	return true;
}
function replyJson(body) {
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}
function replyValue(value) {
	return replyJson({
		ok: true,
		value
	});
}
function replyFailure(code, message) {
	return replyJson({
		ok: false,
		error: {
			code,
			message
		}
	});
}
async function readJsonBody(request) {
	try {
		return {
			ok: true,
			value: await request.json()
		};
	} catch {
		return { ok: false };
	}
}
function messageOf$1(error) {
	try {
		return error instanceof Error ? error.message : String(error);
	} catch {
		return "unprintable error";
	}
}
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
async function disposeResource(resource) {
	if (resource === null || typeof resource !== "object" && typeof resource !== "function") return;
	try {
		const asyncDispose = resource[Symbol.asyncDispose];
		if (typeof asyncDispose === "function") {
			await asyncDispose.call(resource);
			return;
		}
		const syncDispose = resource[Symbol.dispose];
		if (typeof syncDispose === "function") syncDispose.call(resource);
	} catch {}
}
//#endregion
//#region src/host/http/backfill.ts
const BACKFILL_ROUTE = routePath("backfill");
const LOG_PREFIX = "dsh-cost-breakdown:";
const YIELD_MS = 100;
const UNSUPPORTED_FORMAT = "SessionFormatUnsupported";
const PROBE_KEYS = ["contextActivity", "contextTimeline"];
function headerOf(record) {
	const header = asRecord(asRecord(record)?.header);
	if (header === null) return null;
	if (typeof header.id !== "string" || header.id === "") return null;
	return header;
}
function servesRows(cache, header) {
	try {
		const values = asRecord(asRecord(cache.cachedSnapshot?.(header, PROBE_KEYS))?.values);
		return values !== null && values.contextActivity !== void 0 && values.contextTimeline !== void 0;
	} catch {
		return false;
	}
}
function isLive(sessions, id) {
	const get = sessions?.get;
	if (typeof get !== "function") return false;
	try {
		return get.call(sessions, id) !== void 0;
	} catch {
		return true;
	}
}
function isUnsupportedFormat(error) {
	try {
		return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT);
	} catch {
		return false;
	}
}
const CLOSER_TEXT = {
	started: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
	notStarted: "The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed."
};
const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";
const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN";
function tailClosers(events) {
	let openTurn = null;
	let openStep = null;
	const pending = new Map();
	for (const event of events) {
		const data = asRecord(event.data);
		switch (event.type) {
			case "turn/start":
				openTurn = typeof data?.turn === "number" ? data.turn : null;
				openStep = null;
				pending.clear();
				break;
			case "turn/end":
				openTurn = null;
				openStep = null;
				pending.clear();
				break;
			case "step/start":
				openStep = typeof data?.step === "number" ? data.step : null;
				break;
			case "step/end":
				pending.clear();
				openStep = null;
				break;
			case "assistant/message": {
				const content = asRecord(data?.message)?.content;
				const step = typeof data?.step === "number" ? data.step : null;
				if (!Array.isArray(content) || step === null) break;
				for (const block of content) {
					const record = asRecord(block);
					if (record?.type !== "tool-call" || typeof record.id !== "string") continue;
					pending.set(record.id, { step });
				}
				break;
			}
			case "tool/call": {
				const callId = data?.callId;
				if (typeof callId !== "string") break;
				const entry = pending.get(callId);
				if (entry !== void 0 && typeof event.seq === "number") entry.callSeq = event.seq;
				break;
			}
			case "tool/result": {
				const callId = asRecord(asRecord(data?.message)?.source)?.callId;
				if (typeof callId === "string") pending.delete(callId);
				break;
			}
		}
	}
	const last = events.at(-1);
	if (openTurn === null || last === void 0) return [];
	let seq = typeof last.seq === "number" ? last.seq + 1 : 0;
	const time = typeof last.time === "number" ? last.time : 0;
	const closers = [];
	for (const [callId, { step, callSeq }] of pending) {
		const started = callSeq !== void 0;
		const eventSeq = seq++;
		closers.push({
			type: "tool/result",
			seq: eventSeq,
			time,
			data: {
				turn: openTurn,
				step,
				message: {
					id: `interrupted-tool-result-${callId}-${eventSeq}`,
					role: "tool",
					toolCallId: callId,
					isError: true,
					source: {
						kind: "tool",
						callId
					},
					content: [{
						type: "text",
						text: started ? CLOSER_TEXT.started : CLOSER_TEXT.notStarted
					}]
				},
				error: started ? {
					name: "ToolOutcomeUnknownError",
					code: TOOL_OUTCOME_UNKNOWN
				} : {
					name: "ToolNotStartedError",
					code: TOOL_NOT_STARTED
				}
			},
			surfaceOp: "append",
			...started ? { sourceEventSeqs: [callSeq] } : {}
		});
	}
	if (openStep !== null) closers.push({
		type: "step/end",
		seq: seq++,
		time,
		data: {
			turn: openTurn,
			step: openStep
		}
	});
	closers.push({
		type: "turn/end",
		seq: seq++,
		time,
		data: {
			turn: openTurn,
			reason: { kind: "interrupted" }
		}
	});
	return closers;
}
async function readColdLog(persistence, id, signal) {
	const open = persistence.open;
	if (typeof open !== "function") throw new Error("sessionPersistence.open is not callable");
	const handle = await open.call(persistence, id, "read", { signal });
	let events;
	try {
		const result = asRecord(await handle.read(0, void 0, { signal }))?.events;
		events = Array.isArray(result) ? result : [];
	} catch (error) {
		try {
			await handle.close();
		} catch {}
		throw error;
	}
	await handle.close();
	return {
		header: handle.header,
		inheritedEventCount: handle.inheritedEventCount,
		events: [...events, ...tailClosers(events)]
	};
}
function yieldToHost() {
	return new Promise((resolve) => setTimeout(resolve, YIELD_MS));
}
function watchActivityBackfill(ctx, coldReads) {
	let requested = false;
	let started = false;
	let launch = null;
	const tryLaunch = () => {
		if (!requested || started || launch === null) return;
		started = true;
		launch();
	};
	const routeFiber = ctx.inject(["connection"], (c) => {
		const handler = () => {
			requested = true;
			tryLaunch();
			return replyJson({ ok: true });
		};
		registerPostRoute(c, c.get("connection"), BACKFILL_ROUTE, handler, "dsh-cost-breakdown: backfill route");
	});
	const runnerFiber = ctx.inject([
		"sessionQuery",
		"sessionProjectionCache",
		"sessionPersistence",
		"sessions"
	], (raw) => {
		const injected = raw;
		const query = asRecord(injected.sessionQuery);
		const cache = asRecord(injected.sessionProjectionCache);
		const persistence = asRecord(injected.sessionPersistence);
		if (typeof query?.listSessions !== "function") return;
		if (typeof cache?.cachedSnapshot !== "function" || typeof cache.coldSnapshot !== "function") return;
		if (typeof persistence?.open !== "function") return;
		const sessions = asRecord(injected.sessions);
		const abort = new AbortController();
		const run = async () => {
			const listed = await query.listSessions?.(abort.signal);
			if (!Array.isArray(listed)) return;
			let folded = 0;
			let refused = 0;
			let paused = false;
			for (const record of listed) {
				if (abort.signal.aborted) return;
				const header = headerOf(record);
				if (header === null || typeof header.cwd !== "string") continue;
				if (isLive(sessions, header.id)) continue;
				if (servesRows(cache, header)) continue;
				try {
					if (await coldReads.admit(async () => {
						const log = await readColdLog(persistence, header.id, abort.signal);
						cache.coldSnapshot.call(cache, log.header, log.inheritedEventCount, log.events);
						return true;
					}) === void 0) {
						paused = true;
						break;
					}
					folded++;
				} catch (error) {
					if (isUnsupportedFormat(error)) {
						refused++;
						ctx.logger.debug(`${LOG_PREFIX} projection backfill skipped "${header.id}" (${messageOf$1(error)})`);
					} else ctx.logger.warn(`${LOG_PREFIX} projection backfill skipped "${header.id}" (${messageOf$1(error)})`);
				}
				await yieldToHost();
			}
			if (folded > 0) ctx.logger.info(`${LOG_PREFIX} projection rows backfilled for ${folded} session(s)`);
			if (paused) ctx.logger.info(`${LOG_PREFIX} projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)`);
			if (refused > 0) ctx.logger.info(`${LOG_PREFIX} projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`);
		};
		launch = () => {
			run().catch((error) => {
				if (!abort.signal.aborted) ctx.logger.warn(`${LOG_PREFIX} projection backfill stopped early (${messageOf$1(error)})`);
			});
		};
		tryLaunch();
		return () => {
			abort.abort();
		};
	});
	return () => {
		for (const fiber of [routeFiber, runnerFiber]) fiber?.dispose?.();
	};
}
//#endregion
//#region src/host/platform/account.ts
const DEEPSEEK_SETTINGS_NS = "llm-deepseek";
const DEEPSEEK_API_KEY_NS = "llm-deepseek-api-key";
const PUBLIC_BASE_URL = "https://api.deepseek.com";
const FETCH_TIMEOUT_MS$1 = 1e4;
function amountOf(value) {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}
function recordOf(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function clientMetadata() {
	return {
		version: "1",
		locale: "zh-CN",
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
	};
}
function isSignedOut(state) {
	return recordOf(state)?.status === "signed-out";
}
function addWallets(into, wallets, field) {
	for (const wallet of Array.isArray(wallets) ? wallets : []) try {
		const entry = recordOf(wallet);
		if (entry === null) continue;
		const amount = amountOf(entry.balance);
		if (typeof entry.currency !== "string" || entry.currency === "" || amount === null) continue;
		const current = into.get(entry.currency) ?? {
			currency: entry.currency,
			total: 0,
			granted: 0,
			toppedUp: 0
		};
		current[field] += amount;
		current.total += amount;
		into.set(entry.currency, current);
	} catch {
		continue;
	}
}
async function readAccountBalance(ctx) {
	const account = ctx.get("deepseekAccount");
	const getBalance = typeof account?.getBalance === "function" ? account.getBalance.bind(account) : void 0;
	if (getBalance === void 0) return null;
	try {
		if (typeof account?.getState === "function") {
			if (isSignedOut(await account.getState())) return null;
		}
	} catch {}
	try {
		const outcome = recordOf(await getBalance(clientMetadata()));
		if (outcome === null || outcome.status !== "ready") return null;
		const byCurrency = new Map();
		addWallets(byCurrency, outcome.value, "toppedUp");
		addWallets(byCurrency, outcome.bonusWallets, "granted");
		const balances = [...byCurrency.values()];
		return balances.length > 0 ? {
			isAvailable: true,
			balances
		} : null;
	} catch {
		return null;
	}
}
function deepSeekSectionOf(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return null;
	try {
		const rows = settings.describe();
		if (!Array.isArray(rows)) return null;
		let shaped = null;
		for (const row of rows) try {
			const record = recordOf(row);
			if (record === null) continue;
			const value = recordOf(record.value);
			if (value === null || typeof value.apiKeyEnv !== "string" || value.apiKeyEnv === "") continue;
			if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === DEEPSEEK_API_KEY_NS) return value;
			shaped ??= value;
		} catch {
			continue;
		}
		return shaped;
	} catch {
		return null;
	}
}
async function resolveDeepSeekFacts(ctx) {
	const section = deepSeekSectionOf(ctx);
	if (section === null) return null;
	const apiKeyEnv = section.apiKeyEnv;
	const baseUrl = typeof section.baseURL === "string" && section.baseURL !== "" ? section.baseURL : PUBLIC_BASE_URL;
	const credentials = ctx.get("credentials");
	const resolve = typeof credentials?.resolve === "function" ? credentials.resolve.bind(credentials) : void 0;
	if (resolve === void 0) return null;
	let hit;
	try {
		hit = await resolve(apiKeyEnv);
	} catch {
		return null;
	}
	const apiKey = typeof hit?.value === "string" ? hit.value : "";
	return apiKey === "" ? null : {
		baseUrl,
		apiKey
	};
}
function balanceOfPayload(value) {
	const data = recordOf(value);
	if (data === null) return null;
	const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
	const balances = [];
	for (const info of infos) try {
		const entry = recordOf(info);
		if (entry === null) continue;
		const currency = entry.currency;
		const granted = amountOf(entry.granted_balance);
		const toppedUp = amountOf(entry.topped_up_balance);
		if (typeof currency !== "string" || currency === "" || granted === null || toppedUp === null) continue;
		balances.push({
			currency,
			total: granted + toppedUp,
			granted,
			toppedUp
		});
	} catch {
		continue;
	}
	return balances.length > 0 ? {
		isAvailable: data.is_available === true,
		balances
	} : null;
}
const defaultFetcher$1 = (url, init) => fetch(url, init);
let fetcher$1 = defaultFetcher$1;
let inFlight = null;
async function readApiKeyBalance(facts) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		try {
			const response = await fetcher$1(facts.baseUrl.replace(/\/+$/, "") + "/user/balance", {
				headers: {
					accept: "application/json",
					authorization: "Bearer " + facts.apiKey
				},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS$1)
			});
			return response.ok ? balanceOfPayload(await response.json()) : null;
		} catch {
			return null;
		}
	})();
	const settled = inFlight;
	try {
		return await settled;
	} finally {
		inFlight = null;
	}
}
//#endregion
//#region src/host/http/balance.ts
const BALANCE_ROUTE = routePath("balance");
async function readPlatformBalance(ctx) {
	const account = await readAccountBalance(ctx);
	if (account !== null) return account;
	const facts = await resolveDeepSeekFacts(ctx);
	return facts !== null ? readApiKeyBalance(facts) : null;
}
function watchBalanceChannel(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async () => replyValue(await readPlatformBalance(ctx));
		registerPostRoute(c, c.get("connection"), BALANCE_ROUTE, handler, "dsh-cost-breakdown: balance route");
	});
}
//#endregion
//#region src/host/http/cold.ts
const HIGH_WATER = 2 / 3;
function v8Reading() {
	const stats = getHeapStatistics();
	return {
		used: stats.used_heap_size,
		limit: stats.heap_size_limit
	};
}
const noop = () => {};
function makeColdReadGate(reading = v8Reading) {
	const clear = () => {
		try {
			const { used, limit } = reading();
			if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true;
			return used < limit * HIGH_WATER;
		} catch {
			return true;
		}
	};
	let tail = Promise.resolve();
	return { admit(read) {
		const run = tail.then(() => clear() ? read() : void 0);
		tail = run.then(noop, noop);
		return run;
	} };
}
//#endregion
//#region src/host/http/credits.ts
const CREDITS_ROUTE = routePath("credits");
const CREDITS_ROUTES = [{
	provider: "workbuddy",
	url: "http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status"
}, {
	provider: "workbuddy-ai",
	url: "http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status"
}];
const CACHE_MS$1 = 6e4;
const FETCH_TIMEOUT_MS = 8e3;
function creditsOfPayload(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const root = value;
	if (root.status !== "signed-in") return null;
	const credits = root.credits;
	if (credits === null || typeof credits !== "object" || Array.isArray(credits)) return null;
	const raw = credits;
	const total = typeof raw.total === "number" && Number.isFinite(raw.total) && raw.total >= 0 ? raw.total : null;
	if (total === null) return null;
	return {
		total,
		unlimited: raw.unlimited === true,
		...typeof raw.cycleResetTime === "string" && raw.cycleResetTime !== "" ? { cycleResetTime: raw.cycleResetTime } : {}
	};
}
const defaultFetcher = (url, init) => fetch(url, init);
let fetcher = defaultFetcher;
let cached$1 = null;
async function platformCredits(now = Date.now()) {
	if (cached$1 !== null && now - cached$1.at < CACHE_MS$1) return cached$1.value;
	const table = {};
	await Promise.all(CREDITS_ROUTES.map(async ({ provider, url }) => {
		try {
			const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (!response.ok) return;
			const value = creditsOfPayload(await response.json());
			if (value !== null) table[provider] = value;
		} catch {}
	}));
	const value = Object.keys(table).length > 0 ? table : null;
	cached$1 = {
		at: now,
		value
	};
	return value;
}
function watchCreditsChannel(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async () => replyValue(await platformCredits());
		registerPostRoute(c, c.get("connection"), CREDITS_ROUTE, handler, "dsh-cost-breakdown: platform credits route");
	});
}
function emptyTimeline() {
	return {
		surface: [],
		sums: {
			user: 0,
			inject: 0,
			skill: 0,
			assistant: 0,
			tool: 0
		},
		systemTokens: 0,
		toolsTokens: 0,
		requests: [],
		turnRuns: 0,
		events: [],
		archived: [],
		callNames: {},
		fileOps: [],
		spans: []
	};
}
function draftOf(previous) {
	const next = { ...previous };
	const cloned = new Set();
	const touch = (...keys) => {
		for (const key of keys) {
			if (cloned.has(key)) continue;
			cloned.add(key);
			switch (key) {
				case "surface":
					next.surface = [...previous.surface];
					break;
				case "sums":
					next.sums = { ...previous.sums };
					break;
				case "requests":
					next.requests = [...previous.requests];
					break;
				case "events":
					next.events = [...previous.events];
					break;
				case "archived":
					next.archived = [...previous.archived];
					break;
				case "callNames":
					next.callNames = { ...previous.callNames };
					break;
				case "fileOps":
					next.fileOps = [...previous.fileOps];
					break;
				case "timing": if (previous.timing !== void 0) next.timing = {
					...previous.timing,
					tools: { ...previous.timing.tools }
				};
			}
		}
		return next;
	};
	return {
		previous,
		next,
		touch
	};
}
function countTurnRuns(requests) {
	let runs = 0;
	let previousTurn;
	for (const record of requests) if (record.turn !== previousTurn) {
		runs++;
		previousTurn = record.turn;
	}
	return runs;
}
function trimToLastTurns(requests, maxTurns) {
	let runs = 0;
	let start = requests.length;
	let previousTurn;
	for (let index = requests.length - 1; index >= 0; index--) {
		const turn = requests[index].turn;
		if (turn !== previousTurn) {
			if (runs >= maxTurns) break;
			runs++;
			previousTurn = turn;
		}
		start = index;
	}
	return requests.slice(start);
}
function pruneTimeline(state, bounds) {
	state.turnRuns = state.turnRuns ?? countTurnRuns(state.requests);
	if (state.turnRuns > bounds.maxKeptTurns) {
		state.requests = trimToLastTurns(state.requests, bounds.maxKeptTurns);
		state.turnRuns = countTurnRuns(state.requests);
	}
	if (state.requests.length > bounds.maxRequestSteps) {
		state.requests = state.requests.slice(-bounds.maxRequestSteps);
		state.turnRuns = countTurnRuns(state.requests);
	}
	if (state.events.length > bounds.maxEvents) state.events = state.events.slice(-bounds.maxEvents);
	if (state.spans.length > 2e3) state.spans = state.spans.slice(-2e3);
	if (state.fileOps.length > bounds.maxFileOps) {
		const drop = state.fileOps.length - bounds.maxFileOps;
		state.fileOpsFloor = Math.max(state.fileOpsFloor ?? 0, state.fileOps[drop - 1].seq);
		state.fileOps = state.fileOps.slice(drop);
	}
	pruneArchive(state, bounds);
}
function pruneArchive(state, bounds) {
	if (state.archived.length === 0) return;
	let drop = 0;
	const oldestRetained = state.requests.length > 0 ? state.requests[0].seq : void 0;
	if (oldestRetained !== void 0) while (drop < state.archived.length && (state.archived[drop].gone ?? Infinity) <= oldestRetained) drop++;
	if (state.archived.length - drop > bounds.maxArchiveNodes) drop = state.archived.length - bounds.maxArchiveNodes;
	if (drop === 0) return;
	const floor = state.archived[drop - 1].gone;
	if (floor !== void 0) state.archiveFloor = Math.max(state.archiveFloor ?? 0, floor);
	state.archived = state.archived.slice(drop);
}
//#endregion
//#region src/core/imageTokens.ts
const PATCH = 14;
const DOWNSAMPLE = 3;
const MAX_RATIO = 8;
const MIN_PIXELS = 147456;
const floorDiv = (a, b) => Math.floor(a / b);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
function gridTokens(rows, cols) {
	let total = rows * (cols + 1) + 2;
	if (rows % 2 === 1) total += cols + 1;
	total += ceilDiv(rows, 2) * (cols + 1) % 2 * 2;
	return total;
}
function fitToBudget(height, width, budget) {
	const ratio = height / width;
	const gridWidth = Math.sqrt((budget - 2) / ratio + .25) - .5;
	const gridHeight = gridWidth * ratio;
	const unit = 42;
	let bestHeight;
	let bestWidth;
	if (gridWidth < 1) {
		let rows = floorDiv(budget - 2, 2);
		if (rows % 2 === 1) rows -= 1;
		bestWidth = unit;
		bestHeight = rows * unit;
	} else if (gridHeight < 2) {
		const cols = floorDiv(budget - 2, 2) - 1;
		if (cols <= 1) throw new Error("image token estimate: budget too small to solve");
		bestHeight = 84;
		bestWidth = cols * unit;
	} else {
		const cols = Math.trunc(gridWidth);
		let rows = Math.trunc(gridHeight);
		if (rows % 2 === 1) rows -= 1;
		const scale = Math.min(cols * unit / width, rows * unit / height);
		bestWidth = Math.trunc(width * scale / PATCH) * PATCH;
		bestHeight = Math.trunc(height * scale / PATCH) * PATCH;
	}
	const rows = ceilDiv(floorDiv(bestHeight, PATCH), DOWNSAMPLE);
	const cols = ceilDiv(floorDiv(bestWidth, PATCH), DOWNSAMPLE);
	return {
		rows,
		cols,
		height: bestHeight,
		width: bestWidth,
		tokens: gridTokens(rows, cols)
	};
}
function fitPadded(height, width, paddedHeight, paddedWidth) {
	const rows = ceilDiv(floorDiv(paddedHeight, PATCH), DOWNSAMPLE);
	const cols = ceilDiv(floorDiv(paddedWidth, PATCH), DOWNSAMPLE);
	const budget = 381;
	let fit = {
		rows,
		cols,
		height: paddedHeight,
		width: paddedWidth,
		tokens: gridTokens(rows, cols)
	};
	if (fit.tokens > budget) {
		let nextBudget = budget;
		fit = fitToBudget(height, width, nextBudget);
		while (fit.tokens > budget) {
			nextBudget -= 1;
			fit = fitToBudget(height, width, nextBudget);
		}
	}
	fit.tokens += 3;
	return fit;
}
function fitImage(width, height) {
	let w = width;
	let h = height;
	if (w > h * MAX_RATIO) w = h * MAX_RATIO;
	const pixels = w * h;
	if (pixels < MIN_PIXELS && pixels > 0) {
		const scale = Math.sqrt(MIN_PIXELS / pixels);
		w = Math.trunc(w * scale);
		h = Math.trunc(h * scale);
	}
	return fitPadded(h, w, ceilDiv(h, PATCH) * PATCH, ceilDiv(w, PATCH) * PATCH);
}
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	try {
		let fit = fitImage(width, height);
		for (let attempt = 1; attempt < 10; attempt++) {
			const next = fitImage(fit.width, fit.height);
			if (next.rows === fit.rows && next.cols === fit.cols && next.height === fit.height && next.width === fit.width && next.tokens === fit.tokens) return fit.tokens;
			fit = next;
		}
		return null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/core/tokens.ts
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
const PREVIEW_MAX = 80;
function estimateSystemText(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}
function estimateSystemBlocks(blocks) {
	if (!Array.isArray(blocks) || blocks.length === 0) return 0;
	let characters = 0;
	for (const block of blocks) {
		const text = block !== null && typeof block === "object" && block.type === "text" ? block.text : void 0;
		if (typeof text === "string") {
			characters += text.length;
			continue;
		}
		try {
			const json = JSON.stringify(block);
			if (typeof json === "string") characters += json.length;
		} catch {}
	}
	return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
}
function jsonLengthOf(value) {
	try {
		const json = JSON.stringify(value);
		return typeof json === "string" ? json.length : 0;
	} catch {
		return 0;
	}
}
function estimateTools(tools) {
	if (tools.length === 0) return 0;
	return Math.ceil(jsonLengthOf(tools) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
function estimateToolSchema(tool) {
	return Math.ceil(jsonLengthOf(tool) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
function estimateBlocks(blocks) {
	if (!Array.isArray(blocks)) return 0;
	let tokens = 0;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") {
			tokens += BLOCK_OVERHEAD;
			continue;
		}
		const block = item;
		switch (block.type) {
			case "text":
			case "reasoning":
				tokens += Math.ceil((block.text || "").length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
				break;
			case "tool-call":
				tokens += Math.ceil((block.name || "").length / CHARS_PER_TOKEN) + Math.ceil((block.arguments || "").length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
				break;
			case "image": {
				const ref = block.attachment;
				const priced = ref !== null && typeof ref === "object" && typeof ref.width === "number" && typeof ref.height === "number" ? estimateImageTokens(ref.width, ref.height) : null;
				tokens += (priced ?? Math.ceil(jsonLengthOf(block) / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD;
				break;
			}
			default: tokens += BLOCK_OVERHEAD + Math.ceil(jsonLengthOf(block) / CHARS_PER_TOKEN);
		}
	}
	return tokens;
}
function estimateMessage(message, emptyIsZero = false) {
	if (emptyIsZero) {
		if (message === null || message === void 0 || !Array.isArray(message.content) || message.content.length === 0) return 0;
	}
	return estimateBlocks(message?.content) + ROLE_OVERHEAD;
}
function countImages(blocks) {
	if (!Array.isArray(blocks)) return 0;
	let count = 0;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "image") count++;
		else if (Array.isArray(block.content)) count += countImages(block.content);
	}
	return count;
}
function firstText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") return block.text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX);
	}
	return "";
}
function firstRawText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "text" && typeof block.text === "string" && block.text !== "") return block.text;
	}
	return "";
}
function toolCallNames(blocks) {
	const names = [];
	if (!Array.isArray(blocks)) return names;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "tool-call" && typeof block.name === "string") names.push(block.name);
	}
	return names;
}
function injectionLabel(source) {
	if (source?.kind === "agent-instructions" && Array.isArray(source.changes)) {
		const paths = [];
		for (const change of source.changes) {
			const path = change?.path;
			if (typeof path === "string" && path !== "" && !paths.includes(path)) paths.push(path);
		}
		if (paths.length > 0) return paths.join(", ");
	}
	if (typeof source?.plugin === "string" && source.plugin !== "") return source.plugin;
	return typeof source?.kind === "string" ? source.kind : "";
}
function isInjection(source) {
	if (source === null || source === void 0) return false;
	const kind = source.kind;
	if (typeof kind === "string" && kind !== "" && kind !== "user") return true;
	return typeof source.form === "string";
}
const SKILL_NAME_RE = /<skill_content\s+name="([^"]+)"/;
function skillNameOf(text) {
	const match = SKILL_NAME_RE.exec(text);
	return match === null ? "" : match[1];
}
//#endregion
//#region src/core/ops.ts
function parseCallArgs(raw) {
	if (typeof raw !== "string" || raw === "") return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
const KIND_BY_TOOL = {
	read: "read",
	read_image: "read",
	write: "write",
	edit: "write",
	grep: "search",
	glob: "search"
};
function kindOfTool(tool) {
	if (tool === void 0) return null;
	return KIND_BY_TOOL[tool] ?? null;
}
function kindOfCall(tool, args) {
	if (tool === "str_replace_editor") return args !== null && args.command === "view" ? "read" : "write";
	return kindOfTool(tool);
}
function mayTouchFiles(tool) {
	return tool === "str_replace_editor" || kindOfTool(tool) !== null;
}
function needsRawArgs(tool) {
	return mayTouchFiles(tool) || tool === "run_code";
}
function pathOfArgs(tool, args) {
	if (args === null) return null;
	if (tool === "grep" || tool === "glob") {
		const path = args.path;
		if (typeof path === "string" && path !== "") return path;
		const pattern = args.pattern;
		return typeof pattern === "string" && pattern !== "" ? pattern : null;
	}
	for (const key of [
		"file_path",
		"filePath",
		"path"
	]) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return value;
	}
	return null;
}
function lineCount(text) {
	if (text === "") return 0;
	let breaks = 0;
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") breaks++;
	return text.endsWith("\n") ? breaks : breaks + 1;
}
function pairOf(added, removed) {
	return {
		added: typeof added === "string" ? lineCount(added) : 0,
		removed: typeof removed === "string" ? lineCount(removed) : 0
	};
}
function deltaOf(tool, args) {
	if (tool === "edit") return pairOf(args.new_string, args.old_string);
	if (tool === "write") return pairOf(args.content, void 0);
	if (tool === "str_replace_editor") {
		if (args.command === "str_replace") return pairOf(args.new_str, args.old_str);
		if (args.command === "insert") return pairOf(args.new_str, void 0);
		if (args.command === "create") return pairOf(args.file_text, void 0);
	}
	return {
		added: 0,
		removed: 0
	};
}
function readWindowOf(meta) {
	if (meta === null || typeof meta !== "object") return null;
	const record = meta;
	if (typeof record.path !== "string" || record.path === "") return null;
	if (typeof record.offset !== "number" || !Number.isFinite(record.offset) || record.offset < 1) return null;
	if (!Array.isArray(record.lines) || record.lines.length === 0) return null;
	return {
		start: record.offset,
		count: record.lines.length
	};
}
function readEstimateOf(args) {
	const limit = args.limit;
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? {
		count: Math.floor(limit),
		est: true
	} : void 0;
}
function readOf(meta, args) {
	const window = readWindowOf(meta);
	if (window !== null) return window;
	return readEstimateOf(args);
}
function searchDetailOf(args) {
	const pattern = args?.pattern;
	if (typeof pattern !== "string" || pattern === "") return void 0;
	const include = args?.include;
	return typeof include === "string" && include !== "" ? `${pattern} (${include})` : pattern;
}
function searchFilesOf(meta) {
	if (meta === null || typeof meta !== "object") return null;
	const record = meta;
	if (record.truncated !== false) return null;
	const files = [];
	if (record.shape === "matches" && Array.isArray(record.files)) for (const file of record.files) {
		if (file === null || typeof file !== "object") continue;
		const group = file;
		if (typeof group.path === "string" && group.path !== "" && Array.isArray(group.matches)) files.push({
			path: group.path,
			hits: group.matches.length
		});
	}
	else if (record.shape === "paths" && Array.isArray(record.paths)) {
		for (const path of record.paths) if (typeof path === "string" && path !== "") files.push({
			path,
			hits: 0
		});
	}
	return files.length > 0 ? files : null;
}
function opsOfCall(facts) {
	const args = mayTouchFiles(facts.tool) ? parseCallArgs(facts.argsRaw) : null;
	const kind = kindOfCall(facts.tool, args);
	if (kind === null) return [];
	const stamp = {
		seq: facts.seq,
		kind,
		tool: facts.tool,
		err: facts.err === true,
		added: 0,
		removed: 0,
		path: "",
		...facts.time !== void 0 ? { time: facts.time } : {},
		...facts.parent !== void 0 ? { parent: facts.parent } : {},
		...facts.program !== void 0 ? { program: facts.program } : {}
	};
	if (kind === "search") {
		const files = searchFilesOf(facts.meta);
		if (files !== null) {
			const detail = searchDetailOf(args);
			const target = args !== null ? pathOfArgs(facts.tool, args) : null;
			const narrowed = args !== null && typeof args.path === "string" && args.path !== "";
			return [...target !== null && !files.some((file) => file.path === target) ? [{
				...stamp,
				path: target,
				...narrowed && detail !== void 0 ? { detail } : {},
				...narrowed ? {} : { pattern: true }
			}] : [], ...files.map((file) => ({
				...stamp,
				path: file.path,
				...detail !== void 0 ? { detail } : {},
				...file.hits > 0 ? { hits: file.hits } : {}
			}))];
		}
	}
	if (args === null) return [];
	const path = pathOfArgs(facts.tool, args);
	if (path === null) return [];
	const { added, removed } = deltaOf(facts.tool, args);
	const narrowed = typeof args.path === "string" && args.path !== "";
	const detail = kind === "search" && narrowed ? searchDetailOf(args) : void 0;
	const read = kind === "read" ? readOf(facts.meta, args) : void 0;
	return [{
		...stamp,
		path,
		added,
		removed,
		...detail !== void 0 ? { detail } : {},
		...read !== void 0 ? { read } : {},
		...kind === "search" && !narrowed ? { pattern: true } : {}
	}];
}
//#endregion
//#region src/core/clock.ts
const OFFICIAL_TABLE = [{
	id: "deepseek-flash",
	label: "DeepSeek-V4.1-Flash",
	aliases: [
		"deepseek-flash",
		"deepseek-v4.1-flash",
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp",
		"deepseek-v4.1-flash-vision-exp"
	],
	offPeak: {
		hit: .02,
		miss: 1,
		out: 4
	},
	peak: {
		hit: .04,
		miss: 2,
		out: 8
	}
}, {
	id: "deepseek-v4-pro",
	label: "DeepSeek-V4-Pro",
	aliases: [
		"deepseek-v4-pro",
		"deepseek-v4.1-pro",
		"deepseek-pro"
	],
	offPeak: {
		hit: .15,
		miss: 4.5,
		out: 13.5
	},
	peak: {
		hit: .3,
		miss: 9,
		out: 27
	}
}];
const PEAK_WINDOWS = [[9, 12], [14, 18]];
const DEFAULT_HOLIDAYS = [
	"2026-01-01",
	"2026-01-02",
	"2026-01-03",
	"2026-02-15",
	"2026-02-16",
	"2026-02-17",
	"2026-02-18",
	"2026-02-19",
	"2026-02-20",
	"2026-02-21",
	"2026-04-04",
	"2026-04-05",
	"2026-04-06",
	"2026-05-01",
	"2026-05-02",
	"2026-05-03",
	"2026-05-04",
	"2026-05-05",
	"2026-06-19",
	"2026-06-20",
	"2026-06-21",
	"2026-09-25",
	"2026-09-26",
	"2026-09-27",
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
	"2026-10-05",
	"2026-10-06",
	"2026-10-07"
];
const BEIJING_OFFSET_MS = 288e5;
function beijingClock(time) {
	const shifted = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS);
	const year = shifted.getUTCFullYear();
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	return {
		year,
		month,
		day,
		hour: shifted.getUTCHours(),
		weekday: shifted.getUTCDay(),
		date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
	};
}
function isPeakAt(time, holidays = DEFAULT_HOLIDAYS) {
	const clock = beijingClock(time);
	if (clock.weekday === 0 || clock.weekday === 6) return false;
	if (holidays.includes(clock.date)) return false;
	return PEAK_WINDOWS.some(([from, to]) => clock.hour >= from && clock.hour < to);
}
function normaliseHolidays(value) {
	if (!Array.isArray(value)) return void 0;
	const kept = [];
	for (const entry of value) if (typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry)) kept.push(entry);
	return kept.length === 0 ? void 0 : kept;
}
function findOfficialModel(model) {
	if (typeof model !== "string" || model === "") return null;
	const needle = model.trim().toLowerCase();
	for (const row of OFFICIAL_TABLE) {
		if (row.id === needle) return row;
		if (row.aliases.some((alias) => alias === needle)) return row;
	}
	return null;
}
//#endregion
//#region src/core/ledger.ts
function billedTokensOf(usage) {
	return usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output;
}
function addBuckets(into, delta) {
	return {
		uncached: into.uncached + delta.uncached,
		cacheRead: into.cacheRead + delta.cacheRead,
		cacheWrite: into.cacheWrite + delta.cacheWrite,
		output: into.output + delta.output
	};
}
function copyModelLedger(ledger) {
	const copy = {};
	if (ledger.peak !== void 0) copy.peak = { ...ledger.peak };
	if (ledger.off !== void 0) copy.off = { ...ledger.off };
	return copy;
}
function copyCostLedger(ledger) {
	const copy = {};
	for (const [provider, models] of Object.entries(ledger)) {
		const row = {};
		for (const [model, entry] of Object.entries(models)) row[model] = copyModelLedger(entry);
		copy[provider] = row;
	}
	return copy;
}
function copyCallLedger(ledger) {
	const copy = {};
	for (const [provider, models] of Object.entries(ledger)) copy[provider] = { ...models };
	return copy;
}
function bookUsage(ledger, provider, model, period, buckets) {
	const next = copyCostLedger(ledger);
	const providerRow = next[provider] ?? {};
	const modelRow = providerRow[model] ?? {};
	const current = period === "peak" ? modelRow.peak : modelRow.off;
	const merged = current === void 0 ? { ...buckets } : addBuckets(current, buckets);
	if (period === "peak") modelRow.peak = merged;
	else modelRow.off = merged;
	providerRow[model] = modelRow;
	next[provider] = providerRow;
	return next;
}
//#endregion
//#region src/core/providers.ts
const VENDOR_BY_ROUTE = {
	"deepseek-official": "deepseek",
	"deepseek-account": "deepseek",
	"kimi-coding": "moonshotai",
	"minimax-cn": "minimax",
	"zai-coding-cn": "zhipuai"
};
function vendorOf(route) {
	return VENDOR_BY_ROUTE[route] ?? route;
}
function isDeepSeekRoute(route) {
	return vendorOf(route) === "deepseek";
}
function pricedByPeriod(route, model) {
	return isDeepSeekRoute(route) || findOfficialModel(model) !== null;
}
//#endregion
//#region src/host/fold/metering.ts
function tokenCountOf(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
	}
	return null;
}
function settlementOf(usage) {
	if (usage === null || typeof usage !== "object") return null;
	const raw = usage;
	const input = tokenCountOf(raw.inputTokens);
	const cacheRead = tokenCountOf(raw.cacheReadTokens);
	const cacheWrite = tokenCountOf(raw.cacheWriteTokens);
	const output = tokenCountOf(raw.outputTokens);
	if (input === null && cacheRead === null && cacheWrite === null && output === null) return null;
	return {
		buckets: {
			uncached: input ?? 0,
			cacheRead: cacheRead ?? 0,
			cacheWrite: cacheWrite ?? 0,
			output: output ?? 0
		},
		prompt: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
		output,
		cacheRead
	};
}
function periodAt(time, provider, model, holidays) {
	if (!pricedByPeriod(provider, model)) return "peak";
	return isPeakAt(time, holidays) ? "peak" : "off";
}
function bookSettlement(state, context, buckets) {
	const { model } = context;
	if (model === void 0 || model === "") return;
	const provider = context.provider;
	const period = periodAt(context.time, provider, model, context.holidays);
	state.cost = bookInto(state.cost, provider, model, period, buckets);
	bumpCalls(state, provider, model);
	if (context.turn !== void 0 && Number.isFinite(context.turn)) appendTurnUsage(state, String(context.turn), provider, model, period, buckets);
}
function bookInto(ledger, provider, model, period, buckets) {
	const next = { ...ledger };
	const providerRow = { ...next[provider] };
	const modelRow = { ...providerRow[model] };
	const current = period === "peak" ? modelRow.peak : modelRow.off;
	const merged = current === void 0 ? { ...buckets } : addBuckets(current, buckets);
	if (period === "peak") modelRow.peak = merged;
	else modelRow.off = merged;
	providerRow[model] = modelRow;
	next[provider] = providerRow;
	return next;
}
function appendTurnUsage(state, turnKey, provider, model, period, buckets) {
	const previous = state.turnCost?.[turnKey];
	const usage = bookInto(previous?.usage, provider, model, period, buckets);
	const requests = { ...previous?.requests };
	const models = { ...requests[provider] };
	models[model] = (models[model] ?? 0) + 1;
	requests[provider] = models;
	state.turnCost = {
		...state.turnCost,
		[turnKey]: {
			usage,
			requests
		}
	};
}
function bumpCalls(state, provider, model) {
	const calls = { ...state.calls };
	const row = { ...calls[provider] };
	row[model] = (row[model] ?? 0) + 1;
	calls[provider] = row;
	state.calls = calls;
}
function settlementTokens(buckets) {
	return billedTokensOf(buckets);
}
function durationBetween(from, to) {
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
	return Math.max(0, to - from);
}
function ensureTiming(state) {
	if (state.timing === void 0) state.timing = {
		wallMs: 0,
		ttftMs: 0,
		genMs: 0,
		calls: 0,
		toolsMs: 0,
		toolCalls: 0,
		tools: {}
	};
	return state.timing;
}
const DECODE_KINDS = [
	"reasoning",
	"text",
	"toolarg"
];
const DECODE_FIELDS = {
	reasoning: {
		ms: "reasoningMs",
		blocks: "reasoningBlocks"
	},
	text: {
		ms: "textMs",
		blocks: "textBlocks"
	},
	toolarg: {
		ms: "toolArgMs",
		blocks: "toolArgBlocks"
	}
};
function addDecode(timing, kind, ms, blocks) {
	const fields = DECODE_FIELDS[kind];
	if (ms > 0) timing[fields.ms] = (timing[fields.ms] ?? 0) + ms;
	if (blocks > 0) timing[fields.blocks] = (timing[fields.blocks] ?? 0) + blocks;
}
function addToolTiming(timing, name, ms) {
	if (name === "__proto__") return;
	if (!Object.hasOwn(timing.tools, name)) {
		if (Object.keys(timing.tools).length >= 16) {
			let cheapest = "";
			let cheapestMs = Infinity;
			for (const key of Object.keys(timing.tools)) if (timing.tools[key].ms < cheapestMs) {
				cheapestMs = timing.tools[key].ms;
				cheapest = key;
			}
			const kept = {};
			for (const key of Object.keys(timing.tools)) if (key !== cheapest) kept[key] = timing.tools[key];
			timing.tools = kept;
		}
		timing.tools[name] = {
			calls: 1,
			ms
		};
		return;
	}
	const current = timing.tools[name];
	timing.tools[name] = {
		calls: current.calls + 1,
		ms: current.ms + ms
	};
}
//#endregion
//#region src/host/fold/records.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function messageOf(event) {
	const data = event.data;
	if (data === void 0) return null;
	switch (event.type) {
		case "user/message": return isRecord(data) ? data : null;
		case "system/message":
		case "developer/message":
		case "assistant/message":
		case "tool/result": {
			const message = data.message;
			return isRecord(message) ? message : null;
		}
		default: return null;
	}
}
function surfaceMessageOf(event) {
	const message = messageOf(event);
	if (message === null) return null;
	if (!Array.isArray(message.content)) return null;
	return message;
}
function answeredCallIdOf(message) {
	const callId = (message?.source)?.callId;
	return typeof callId === "string" && callId !== "" ? callId : void 0;
}
function requestRecordOf(event, state) {
	const sums = state.sums;
	const record = {
		time: event.time,
		seq: event.seq,
		system: state.systemTokens,
		tools: state.toolsTokens,
		user: sums.user,
		inject: sums.inject,
		skill: sums.skill,
		assistant: sums.assistant,
		tool: sums.tool,
		total: state.systemTokens + state.toolsTokens + sums.user + sums.inject + sums.skill + sums.assistant + sums.tool
	};
	const turn = event.data?.turn;
	if (typeof turn === "number") record.turn = turn;
	const step = event.data?.step;
	if (typeof step === "number") record.step = step;
	return record;
}
function injectionEventOf(event, tokens, source) {
	const form = typeof source?.form === "string" && source.form !== "" ? source.form : "context";
	const record = {
		seq: event.seq,
		time: event.time,
		kind: "inject",
		form,
		tokens
	};
	if (source?.kind === "skill-invocation") {
		record.sub = "skill";
		record.name = typeof source.name === "string" ? source.name : "?";
		return record;
	}
	const label = injectionLabel(source);
	if (label !== "") record.name = label;
	const summary = source?.summary;
	if (source?.form === "notice" && typeof summary === "string" && summary !== "") record.detail = summary;
	return record;
}
function modelSwitchEventOf(event, from, to) {
	return {
		seq: event.seq,
		time: event.time,
		kind: "model",
		from,
		to
	};
}
function modeEventOf(event, active) {
	return {
		seq: event.seq,
		time: event.time,
		kind: "mode",
		name: active ? "plan.on" : "plan.off"
	};
}
function compactionEventOf(event, kind) {
	const data = event.data;
	const record = {
		seq: event.seq,
		time: event.time,
		kind,
		tokens: typeof data?.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0
	};
	if (kind === "compaction" && Array.isArray(data?.shadowedSeqs)) record.count = data.shadowedSeqs.length;
	return record;
}
function skillLoadEventOf(event, name, tokens) {
	return {
		seq: event.seq,
		time: event.time,
		kind: "inject",
		form: "instructions",
		sub: "skill",
		name,
		tokens
	};
}
//#endregion
//#region src/host/fold/streams.ts
function isTokenChunk(chunk) {
	if (chunk === null || typeof chunk !== "object") return false;
	const candidate = chunk;
	switch (candidate.type) {
		case "text-delta":
		case "reasoning-delta": return typeof candidate.text === "string" && candidate.text !== "";
		case "tool-call-delta": return typeof candidate.argumentsDelta === "string" && candidate.argumentsDelta !== "" || candidate.name !== void 0;
		default: return false;
	}
}
function decodeKindOfBlock(blockType) {
	if (blockType === "reasoning") return "reasoning";
	if (blockType === "text") return "text";
	if (blockType === "tool-call") return "toolarg";
}
function blockMarkersOf(stream) {
	const markers = [];
	if (!Array.isArray(stream)) return markers;
	for (const record of stream) {
		if (record === null || typeof record !== "object") continue;
		const row = record;
		if (row.type !== "chunk" || row.chunk === null || typeof row.chunk !== "object") continue;
		const chunk = row.chunk;
		if (chunk.type !== "block-start") continue;
		const time = row.time;
		if (typeof time !== "number" || !Number.isFinite(time)) continue;
		markers.push({
			time,
			kind: decodeKindOfBlock(chunk.blockType)
		});
	}
	return markers;
}
function decodeTallyOfStream(stream, endTime) {
	const tally = {
		spans: {
			reasoning: 0,
			text: 0,
			toolarg: 0
		},
		blocks: {
			reasoning: 0,
			text: 0,
			toolarg: 0
		}
	};
	if (!Number.isFinite(endTime)) return tally;
	let kind;
	let since = 0;
	for (const marker of blockMarkersOf(stream)) {
		if (kind !== void 0) tally.spans[kind] += Math.max(0, marker.time - since);
		kind = marker.kind;
		if (kind !== void 0) tally.blocks[kind] += 1;
		since = marker.time;
	}
	if (kind !== void 0) tally.spans[kind] += Math.max(0, endTime - since);
	return tally;
}
function decodeSlicesOfStream(stream, endTime) {
	const slices = [];
	if (!Number.isFinite(endTime)) return slices;
	let kind;
	let since = 0;
	const close = (to) => {
		if (kind !== void 0 && to > since) slices.push({
			kind,
			start: since,
			end: to
		});
	};
	for (const marker of blockMarkersOf(stream)) {
		close(marker.time);
		kind = marker.kind;
		since = marker.time;
	}
	close(endTime);
	return slices;
}
function packedRunFirstToken(row) {
	const base = row.time0;
	if (typeof base !== "number" || !Number.isFinite(base)) return void 0;
	const toolCall = row.type === "tool-call-chunks";
	if (toolCall && row.name !== void 0) return base;
	const fragments = toolCall ? row.args : row.texts;
	if (!Array.isArray(fragments)) return void 0;
	const gaps = Array.isArray(row.dt) ? row.dt : [];
	let time = base;
	for (const [index, fragment] of fragments.entries()) {
		if (index > 0) {
			const gap = gaps[index - 1];
			if (typeof gap !== "number" || !Number.isFinite(gap)) return void 0;
			time += gap;
		}
		if (typeof fragment === "string" && fragment !== "") return time;
	}
}
function firstTokenTimeOfStream(stream) {
	if (!Array.isArray(stream)) return void 0;
	for (const record of stream) {
		if (record === null || typeof record !== "object") continue;
		const row = record;
		if (row.type === "chunk") {
			const time = row.time;
			if (typeof time === "number" && Number.isFinite(time) && isTokenChunk(row.chunk)) return time;
			continue;
		}
		const stamped = packedRunFirstToken(row);
		if (stamped !== void 0) return stamped;
	}
}
function replacedRangeOf(surfaceOp) {
	if (surfaceOp === null || typeof surfaceOp !== "object") return null;
	const op = surfaceOp;
	if (op.op !== "replace") return null;
	const start = op.startSeq;
	const end = op.endSeq;
	if (typeof start !== "number" || !Number.isFinite(start)) return null;
	if (typeof end !== "number" || !Number.isFinite(end)) return null;
	return {
		start,
		end
	};
}
//#endregion
//#region src/host/fold/surface.ts
function stageOf(type, source) {
	if (type === "assistant/message") return "assistant";
	if (type === "tool/result") return "tool";
	if (type === "developer/message") return "inject";
	if (source?.kind === "skill-invocation" || source?.kind === "skill-catalog") return "skill";
	if (isInjection(source)) return "inject";
	return "user";
}
function buildSurfaceNode(event, type, message, facts = {}) {
	const source = message?.source;
	const emptyIsZero = type === "assistant/message" || type === "developer/message";
	const node = {
		seq: event.seq,
		time: event.time,
		cat: stageOf(type, source),
		tokens: estimateMessage(message, emptyIsZero)
	};
	const images = countImages(message?.content);
	if (images > 0) node.imgs = images;
	if (typeof source?.form === "string") node.form = source.form;
	if (type === "assistant/message") describeAssistant(node, message);
	else if (type === "tool/result") describeToolResult(node, message, facts);
	else if (source?.kind === "skill-invocation") node.skill = typeof source.name === "string" ? source.name : "?";
	else if (source?.kind === "plugin") describePluginNode(node, message, source);
	else {
		const text = firstText(message?.content);
		if (text !== "") node.text = text;
	}
	return node;
}
function describeAssistant(node, message) {
	const text = firstText(message?.content);
	if (text !== "") {
		node.text = text;
		return;
	}
	const names = toolCallNames(message?.content);
	if (names.length > 0) node.calls = names.slice(0, 3);
}
function describeToolResult(node, message, facts) {
	if (facts.tool !== void 0) node.tool = facts.tool;
	if (message?.isError === true) node.err = true;
}
function describePluginNode(node, message, source) {
	if (source.form === "notice" && typeof source.summary === "string") {
		node.text = source.summary;
		return;
	}
	if (source.form === "snapshot" && Array.isArray(source.sections)) {
		node.text = source.sections.map((section) => section?.name).filter((name) => typeof name === "string" && name !== "").join(", ").slice(0, 80);
		return;
	}
	const text = firstText(message?.content);
	if (text !== "") node.text = text;
}
function producerLabelOf(source) {
	return injectionLabel(source);
}
function takeShadowClaim(draft) {
	const seqs = draft.previous.pendingShadowedSeqs;
	const eventSeq = draft.previous.pendingShadowEventSeq;
	delete draft.next.pendingShadowedSeqs;
	delete draft.next.pendingShadowEventSeq;
	return {
		seqs: seqs ?? [],
		eventSeq
	};
}
function archiveNodes(draft, removed, goneSeq) {
	for (const node of removed) draft.next.archived.push({
		...node,
		gone: goneSeq
	});
}
function removeClaimed(draft, claimed, goneSeq) {
	if (claimed.size === 0) return [];
	const kept = [];
	const removed = [];
	for (const node of draft.next.surface) if (claimed.has(node.seq)) {
		draft.next.sums[node.cat] -= node.tokens;
		removed.push(node);
	} else kept.push(node);
	archiveNodes(draft, removed, goneSeq);
	draft.next.surface = kept;
	return removed;
}
function placeNode(draft, event, node) {
	const claim = takeShadowClaim(draft);
	const range = replacedRangeOf(event.surfaceOp);
	if (range !== null) {
		if (claim.seqs.length > 0) {
			const removed = removeClaimed(draft, new Set(claim.seqs), event.seq);
			draft.next.sums[node.cat] += node.tokens;
			draft.next.surface.push(node);
			if (claim.eventSeq !== void 0) rewriteShadowPrice(draft, claim.eventSeq, removed, node.tokens);
			return;
		}
		let startIndex = -1;
		let endIndex = -1;
		for (let index = 0; index < draft.next.surface.length; index++) {
			if (startIndex < 0 && draft.next.surface[index].seq === range.start) startIndex = index;
			if (draft.next.surface[index].seq === range.end) {
				endIndex = index;
				break;
			}
		}
		if (startIndex >= 0 && endIndex >= startIndex) {
			const removed = draft.next.surface.splice(startIndex, endIndex - startIndex + 1, node);
			archiveNodes(draft, removed, event.seq);
			for (const stale of removed) draft.next.sums[stale.cat] -= stale.tokens;
			draft.next.sums[node.cat] += node.tokens;
			return;
		}
	}
	draft.next.surface.push(node);
	draft.next.sums[node.cat] += node.tokens;
}
function rewriteShadowPrice(draft, eventSeq, removed, readded) {
	let removedSum = 0;
	for (const node of removed) removedSum += node.tokens;
	const index = draft.next.events.findIndex((row) => row.seq === eventSeq);
	if (index < 0) return;
	draft.next.events[index] = {
		...draft.next.events[index],
		tokens: Math.max(0, removedSum - readded)
	};
}
function removeSurfaceInRange(draft, event) {
	const range = replacedRangeOf(event.surfaceOp);
	if (range === null) return 0;
	const claimed = new Set();
	for (const node of draft.next.surface) if (node.seq >= range.start && node.seq <= range.end) claimed.add(node.seq);
	return removeClaimed(draft, claimed, event.seq).length;
}
function pushSystemNode(draft, node) {
	const systems = [...draft.next.systems ?? [], node];
	draft.next.systems = systems.length > 8 ? systems.slice(-8) : systems;
	draft.next.systemTokens = effectiveSystemTokens(draft.next.systems);
}
function effectiveSystemTokens(systems) {
	for (let index = systems.length - 1; index >= 0; index--) if (systems[index].tokens > 0) return systems[index].tokens;
	return 0;
}
function removeSystemInRange(draft, event) {
	const range = replacedRangeOf(event.surfaceOp);
	if (range === null) return;
	const systems = draft.next.systems ?? [];
	draft.next.systems = systems.filter((node) => node.seq < range.start || node.seq > range.end);
}
function openStep(draft, event) {
	draft.next.stepStart = { time: event.time };
	delete draft.next.stepSpans;
	delete draft.next.stepWaits;
	delete draft.next.stepApprovals;
	delete draft.next.stepRequestSeq;
}
function stampAttempt(draft, stream) {
	const slot = draft.previous.stepStart;
	if (slot === void 0 || slot.firstToken !== void 0) return false;
	const first = firstTokenTimeOfStream(stream);
	if (first === void 0) return false;
	draft.next.stepStart = {
		time: slot.time,
		firstToken: first
	};
	return true;
}
function armApproval(draft, id, time) {
	if (draft.previous.stepStart === void 0 || typeof id !== "string") return false;
	draft.next.stepApprovals = {
		...draft.previous.stepApprovals,
		[id]: time
	};
	return true;
}
function settleApproval(draft, id, time) {
	const pending = draft.previous.stepApprovals;
	const askedAt = typeof id === "string" ? pending?.[id] : void 0;
	if (pending === void 0 || askedAt === void 0) return false;
	draft.next.stepWaits = [...draft.previous.stepWaits ?? [], {
		start: askedAt,
		end: time
	}];
	const kept = {};
	for (const key of Object.keys(pending)) if (key !== id) kept[key] = pending[key];
	if (Object.keys(kept).length > 0) draft.next.stepApprovals = kept;
	else delete draft.next.stepApprovals;
	return true;
}
function recordAnswerWait(draft, start, end) {
	if (draft.previous.stepStart === void 0) return;
	draft.next.stepWaits = [...draft.previous.stepWaits ?? [], {
		start,
		end
	}];
}
function closeStep(draft, event) {
	const slot = draft.previous.stepStart;
	if (slot === void 0) return false;
	const end = event.time;
	const timing = ensureTiming(draft.next);
	const wall = durationBetween(slot.time, end);
	timing.wallMs += wall;
	stampActiveTime(draft, wall - clampedWaitMs(draft.previous, slot.time, end));
	flushSpans(draft, slot.time, end);
	delete draft.next.stepStart;
	delete draft.next.stepSpans;
	delete draft.next.stepWaits;
	delete draft.next.stepApprovals;
	delete draft.next.stepRequestSeq;
	return true;
}
function clampedWaitMs(state, start, end) {
	const waits = [...state.stepWaits ?? []];
	const pending = state.stepApprovals;
	if (pending !== void 0) for (const id of Object.keys(pending)) waits.push({
		start: pending[id],
		end
	});
	waits.sort((left, right) => left.start - right.start || left.end - right.end);
	let total = 0;
	let cursor = start;
	for (const wait of waits) {
		const from = Math.max(cursor, wait.start);
		const to = Math.min(wait.end, end);
		if (to > from) {
			total += to - from;
			cursor = to;
		}
	}
	return total;
}
function stampActiveTime(draft, activeMs) {
	const targetSeq = draft.previous.stepRequestSeq;
	if (targetSeq === void 0) return;
	const requests = draft.next.requests;
	const last = requests.at(-1);
	if (last === void 0 || last.seq !== targetSeq) return;
	requests[requests.length - 1] = {
		...last,
		activeMs
	};
}
function flushSpans(draft, start, end) {
	const painted = [];
	for (const span of draft.previous.stepSpans ?? []) {
		const from = Math.max(start, span.start);
		const to = Math.min(end, span.end);
		if (to > from) painted.push({
			kind: span.kind,
			start: from,
			end: to
		});
	}
	painted.sort((left, right) => left.start - right.start || left.end - right.end);
	const flushed = [...draft.previous.spans];
	let cursor = start;
	for (const span of painted) {
		const from = Math.max(cursor, span.start);
		if (span.end <= from) continue;
		if (from > cursor) flushed.push({
			kind: "other",
			start: cursor,
			end: from
		});
		flushed.push({
			kind: span.kind,
			start: from,
			end: span.end
		});
		cursor = span.end;
	}
	if (end > cursor) flushed.push({
		kind: "other",
		start: cursor,
		end
	});
	draft.next.spans = flushed;
}
function decodeWindowOf(stream, endTime, firstToken) {
	if (firstToken === void 0) return null;
	const slices = decodeSlicesOfStream(stream, endTime);
	let start = firstToken;
	for (const slice of slices) start = Math.min(start, slice.start);
	return {
		start,
		slices,
		tally: decodeTallyOfStream(stream, endTime)
	};
}
function applyMessageTiming(draft, event, stream, outputTokens) {
	const timing = ensureTiming(draft.next);
	timing.calls += 1;
	const slot = draft.previous.stepStart;
	if (slot === void 0) return;
	const firstToken = slot.firstToken ?? firstTokenTimeOfStream(stream);
	const window = decodeWindowOf(stream, event.time, firstToken);
	if (window === null || firstToken === void 0) return;
	timing.ttftMs += durationBetween(slot.time, window.start);
	timing.genMs += durationBetween(window.start, event.time);
	const modelSpans = [{
		kind: "ttft",
		start: slot.time,
		end: window.start
	}];
	for (const slice of window.slices) {
		const to = Math.min(event.time, slice.end);
		if (to <= slice.start) continue;
		const from = modelSpans.length === 1 ? window.start : slice.start;
		modelSpans.push({
			kind: slice.kind,
			start: from,
			end: to
		});
	}
	draft.next.stepSpans = [...draft.previous.stepSpans ?? [], ...modelSpans];
	if (outputTokens !== null) {
		timing.speedMs = (timing.speedMs ?? 0) + durationBetween(firstToken, event.time);
		timing.speedTokens = (timing.speedTokens ?? 0) + outputTokens;
	}
	for (const kind of DECODE_KINDS) addDecode(timing, kind, window.tally.spans[kind], window.tally.blocks[kind]);
}
function recordToolRun(draft, timing, name, start, end) {
	const duration = durationBetween(start, end);
	timing.toolsMs += duration;
	timing.toolCalls += 1;
	addToolTiming(timing, name, duration);
	if (draft.previous.stepStart !== void 0) draft.next.stepSpans = [...draft.previous.stepSpans ?? [], {
		kind: "tools",
		start,
		end
	}];
}
//#endregion
//#region src/host/fold/reducer.ts
function bumpDetailRev(draft) {
	draft.next.detailRev = (draft.previous.detailRev ?? 0) + 1;
}
function rawArgumentsOf(value) {
	if (typeof value === "string") return value;
	if (value === void 0 || value === null) return void 0;
	try {
		return JSON.stringify(value);
	} catch {
		return;
	}
}
function appendFileOps(draft, ops) {
	for (const op of ops) draft.next.fileOps.push(op);
}
function bufferCodeOps(draft, rootCallId, ops) {
	const pending = draft.previous.pendingCodeOps ?? {};
	let total = 0;
	for (const key of Object.keys(pending)) total += pending[key].length;
	if (total + ops.length > 200) return;
	draft.next.pendingCodeOps = {
		...pending,
		[rootCallId]: [...pending[rootCallId] ?? [], ...ops]
	};
}
const reduceHeader = (draft, event) => {
	const data = event.data;
	const header = isRecord(data?.header) ? data.header : {};
	const tools = Array.isArray(header.tools) ? header.tools : [];
	draft.touch("events");
	draft.next.toolsTokens = estimateTools(tools);
	const config = isRecord(header.config) ? header.config : void 0;
	if (typeof config?.model === "string") draft.next.model = config.model;
	if (typeof config?.provider === "string") draft.next.provider = config.provider;
	const reason = data?.reason;
	const previousModel = draft.previous.lastModel;
	const model = draft.next.model;
	if ((reason === "change" || reason === "resume") && model !== void 0 && previousModel !== void 0 && model !== previousModel) {
		draft.next.events.push(modelSwitchEventOf(event, previousModel, model));
		bumpDetailRev(draft);
	}
	if (model !== void 0) draft.next.lastModel = model;
	return "changed";
};
const reduceContext = (draft, event) => {
	const data = event.data;
	draft.touch();
	if (typeof data?.contextWindow === "number") draft.next.contextWindow = data.contextWindow;
	if (typeof data?.model === "string") draft.next.model = data.model;
	if (typeof data?.provider === "string") draft.next.provider = data.provider;
	return "changed";
};
const reduceSystem = (draft, event) => {
	draft.touch("surface", "sums", "archived");
	delete draft.next.pendingShadowedSeqs;
	delete draft.next.pendingShadowEventSeq;
	removeSystemInRange(draft, event);
	if (removeSurfaceInRange(draft, event) > 0) bumpDetailRev(draft);
	const message = messageOf(event);
	pushSystemNode(draft, {
		seq: event.seq,
		time: event.time,
		tokens: estimateSystemBlocks(message?.content)
	});
	return "changed";
};
const reduceToolCall = (draft, event) => {
	const data = event.data;
	const callId = data?.callId;
	const name = data?.name;
	if (typeof callId !== "string" || typeof name !== "string") return "ignored";
	draft.touch("callNames");
	const argsRaw = needsRawArgs(name) ? rawArgumentsOf(data?.arguments) : void 0;
	const entry = {
		name,
		start: event.time
	};
	if (argsRaw !== void 0) entry.argsRaw = argsRaw;
	draft.next.callNames[callId] = entry;
	return "changed";
};
const reduceCodeDispatch = (draft, event) => {
	const data = event.data;
	const rootCallId = data?.rootCallId;
	const name = data?.name;
	if (typeof rootCallId !== "string" || typeof name !== "string") return "ignored";
	const argsRaw = needsRawArgs(name) ? rawArgumentsOf(data?.arguments) : void 0;
	const ops = opsOfCall({
		seq: event.seq,
		time: event.time,
		tool: name,
		argsRaw,
		err: data?.isError === true
	});
	if (ops.length === 0) return "ignored";
	draft.touch();
	bufferCodeOps(draft, rootCallId, ops);
	return "changed";
};
const reduceStepStart = (draft, event) => {
	draft.touch();
	openStep(draft, event);
	return "changed";
};
const reduceStepEnd = (draft, event) => {
	if (draft.previous.stepStart === void 0) return "ignored";
	const clones = draft.previous.stepRequestSeq === void 0 ? ["timing"] : ["timing", "requests"];
	draft.touch(...clones);
	closeStep(draft, event);
	bumpDetailRev(draft);
	return "changed";
};
const reduceApprovalAsked = (draft, event) => {
	if (!armApproval(draft, event.data?.id, event.time)) return "ignored";
	draft.touch();
	return "changed";
};
const reduceApprovalDecided = (draft, event) => {
	if (!settleApproval(draft, event.data?.id, event.time)) return "ignored";
	draft.touch();
	return "changed";
};
const reduceAttempt = (draft, event) => {
	if (!stampAttempt(draft, event.data?.stream)) return "ignored";
	draft.touch();
	return "changed";
};
const reduceUserMessage = (draft, event) => {
	const message = surfaceMessageOf(event);
	if (message === null) return "ignored";
	draft.touch("surface", "sums", "archived", "events");
	bumpDetailRev(draft);
	const node = buildSurfaceNode(event, event.type, message);
	placeNode(draft, event, node);
	if (isInjection(message.source)) {
		draft.next.events.push(injectionEventOf(event, node.tokens, message.source));
		stampProducer(node, message.source);
	} else {
		draft.next.humanInputs = (draft.next.humanInputs ?? 0) + 1;
		if (node.text !== void 0 && node.text !== "") draft.next.lastUser = node.text;
	}
	return "changed";
};
const reduceDeveloperMessage = (draft, event) => {
	const message = messageOf(event);
	if (message === null || !Array.isArray(message.content)) return "ignored";
	draft.touch("surface", "sums", "archived", "events");
	bumpDetailRev(draft);
	const node = buildSurfaceNode(event, event.type, message);
	placeNode(draft, event, node);
	draft.next.events.push(injectionEventOf(event, node.tokens, message.source));
	stampProducer(node, message.source);
	return "changed";
};
function stampProducer(node, source) {
	if (source?.kind === "skill-invocation") return;
	const label = producerLabelOf(source);
	if (label !== "") node.name = label;
}
const reduceToolResult = (draft, event) => {
	const message = surfaceMessageOf(event);
	if (message === null) return "ignored";
	const callId = answeredCallIdOf(message);
	const pending = callId !== void 0 ? draft.previous.callNames[callId] : void 0;
	const buffered = callId !== void 0 ? draft.previous.pendingCodeOps?.[callId] : void 0;
	const data = event.data;
	draft.touch("surface", "sums", "archived", "events", "fileOps", "timing");
	bumpDetailRev(draft);
	const node = buildSurfaceNode(event, event.type, message, { tool: pending?.name });
	consumeCall(draft, callId);
	placeNode(draft, event, node);
	stampProducer(node, message.source);
	if (node.tool === "ask_user_question") draft.next.humanInputs = (draft.next.humanInputs ?? 0) + 1;
	if (pending?.name === "ask_user_question") recordAnswerWait(draft, pending.start, event.time);
	if (pending !== void 0) {
		recordToolRun(draft, ensureTiming(draft.next), pending.name, pending.start, event.time);
		appendFileOps(draft, opsOfCall({
			seq: event.seq,
			time: event.time,
			tool: pending.name,
			argsRaw: pending.argsRaw,
			meta: data?.meta,
			err: message.isError === true
		}));
	}
	flushCodeOps(draft, callId, buffered, pending, event.seq);
	retagSkillLoad(draft, event, node, message);
	return "changed";
};
function consumeCall(draft, callId) {
	if (callId === void 0) return;
	const kept = {};
	for (const key of Object.keys(draft.next.callNames)) if (key !== callId) kept[key] = draft.next.callNames[key];
	draft.next.callNames = kept;
}
function flushCodeOps(draft, callId, buffered, pending, parentSeq) {
	if (callId === void 0 || buffered === void 0 || buffered.length === 0) return;
	const description = parseCallArgs(pending?.argsRaw)?.description;
	const program = typeof description === "string" && description !== "" ? description : void 0;
	appendFileOps(draft, buffered.map((op) => ({
		...op,
		parent: parentSeq,
		...program !== void 0 ? { program } : {}
	})));
	const kept = {};
	for (const key of Object.keys(draft.next.pendingCodeOps ?? {})) if (key !== callId) kept[key] = (draft.next.pendingCodeOps ?? {})[key];
	if (Object.keys(kept).length > 0) draft.next.pendingCodeOps = kept;
	else delete draft.next.pendingCodeOps;
}
function retagSkillLoad(draft, event, node, message) {
	if (node.tool !== "skill" && node.tool !== void 0) return;
	const name = skillNameOfIn$1(message);
	if (name === "") return;
	node.skill = name;
	if (node.tool === void 0) node.tool = "skill";
	draft.next.sums.tool -= node.tokens;
	node.cat = "skill";
	draft.next.sums.skill += node.tokens;
	draft.next.events.push(skillLoadEventOf(event, name, node.tokens));
}
function skillNameOfIn$1(message) {
	return skillNameOf(firstRawText(message.content));
}
const reduceAssistantMessage = (draft, event, bounds) => {
	const message = surfaceMessageOf(event);
	if (message === null) return "ignored";
	const data = event.data;
	draft.touch("surface", "sums", "archived", "events", "requests", "timing");
	bumpDetailRev(draft);
	const record = requestRecordOf(event, draft.next);
	if (draft.previous.stepStart !== void 0) draft.next.stepRequestSeq = record.seq;
	const settlement = settlementOf(data?.usage);
	if (settlement !== null) {
		record.prompt = settlement.prompt;
		if (settlement.cacheRead !== null) record.cacheRead = settlement.cacheRead;
		if (settlement.output !== null) record.output = settlement.output;
		bookSettlement(draft.next, {
			time: event.time,
			provider: draft.next.provider ?? "",
			model: draft.next.model,
			holidays: bounds.holidays,
			turn: record.turn
		}, settlement.buckets);
	}
	draft.next.requests.push(record);
	updateTurnRuns(draft, record);
	applyMessageTiming(draft, event, data?.stream, settlement?.output ?? null);
	const node = buildSurfaceNode(event, event.type, message);
	placeNode(draft, event, node);
	if (node.text !== void 0) draft.next.answers = (draft.next.answers ?? 0) + 1;
	return "changed";
};
function updateTurnRuns(draft, record) {
	const base = draft.previous.turnRuns ?? countTurnRuns(draft.previous.requests);
	const last = draft.previous.requests.at(-1);
	const opened = last === void 0 ? record.turn !== void 0 ? 1 : 0 : record.turn === last.turn ? 0 : 1;
	draft.next.turnRuns = base + opened;
}
const reduceSeedBoundary = (draft, event) => {
	if (event.data?.inherited !== true) return "ignored";
	draft.touch();
	draft.next.cost = {};
	draft.next.turnCost = {};
	return "changed";
};
const reducePlanMode = (draft, event) => {
	const active = event.data?.active;
	if (typeof active !== "boolean") return "ignored";
	draft.touch("events");
	draft.next.events.push(modeEventOf(event, active));
	bumpDetailRev(draft);
	return "changed";
};
const reduceCompaction = (draft, event) => {
	draft.touch("events");
	bumpDetailRev(draft);
	const data = event.data;
	if (Array.isArray(data?.shadowedSeqs)) {
		draft.next.pendingShadowedSeqs = data.shadowedSeqs.filter((value) => typeof value === "number");
		draft.next.pendingShadowEventSeq = event.seq;
	}
	draft.next.events.push(compactionEventOf(event, event.type === "compaction/summary" ? "compaction" : "prune"));
	return "changed";
};
const HANDLERS = {
	"request/header": reduceHeader,
	"request/context": reduceContext,
	"system/message": reduceSystem,
	"tool/call": reduceToolCall,
	"tool/ptc-dispatch": reduceCodeDispatch,
	"assistant/attempt": reduceAttempt,
	"step/start": reduceStepStart,
	"step/end": reduceStepEnd,
	"approval/asked": reduceApprovalAsked,
	"approval/decided": reduceApprovalDecided,
	"user/message": reduceUserMessage,
	"developer/message": reduceDeveloperMessage,
	"tool/result": reduceToolResult,
	"assistant/message": reduceAssistantMessage,
	"session/end-seed": reduceSeedBoundary,
	"plan/mode": reducePlanMode,
	"compaction/summary": reduceCompaction,
	"compaction/prune": reduceCompaction
};
function reduceTimeline(state, event, bounds) {
	const handler = HANDLERS[event.type];
	if (handler === void 0) return state;
	const draft = draftOf(state);
	try {
		if (handler(draft, event, bounds) === "ignored") return state;
	} catch {
		return state;
	}
	pruneTimeline(draft.next, bounds);
	return draft.next;
}
//#endregion
//#region src/core/credits.ts
const CREDIT_AMOUNT = /^\s*x?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?\s*$/i;
function creditAmountOf(value) {
	if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
	if (typeof value !== "string") return null;
	const match = CREDIT_AMOUNT.exec(value);
	if (match === null) return null;
	const amount = Number(match[1]);
	return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
function creditRatesOf(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const out = {};
	const put = (provider, model, amount) => {
		if (provider === "" || model === "") return;
		const models = out[provider] ?? {};
		models[model] = amount;
		out[provider] = models;
	};
	const amountOf = (raw) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
	for (const [key, raw] of Object.entries(value)) {
		const colon = key.indexOf(":");
		if (colon > 0) {
			const amount = amountOf(raw);
			if (amount !== null) put(key.slice(0, colon).trim().toLowerCase(), key.slice(colon + 1).trim().toLowerCase(), amount);
			continue;
		}
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const provider = key.trim().toLowerCase();
		for (const [model, inner] of Object.entries(raw)) {
			const amount = amountOf(inner);
			if (amount !== null) put(provider, model.trim().toLowerCase(), amount);
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}
//#endregion
//#region src/host/platform/catalog.ts
const CATALOG_FORMAT_VERSION = 1;
const CATALOGUES = [{
	file: ".workbuddy-catalog.json",
	provider: "workbuddy"
}, {
	file: ".workbuddy-ai-catalog.json",
	provider: "workbuddy-ai"
}];
const CACHE_MS = 3e4;
function dshHome() {
	const env = process.env.DSH_HOME;
	return env !== void 0 && env !== "" ? env : join(homedir(), ".dsh");
}
function creditRatesFromCatalogue(value, provider = "workbuddy") {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const root = value;
	if (root.version !== CATALOG_FORMAT_VERSION) return null;
	if (root.entries === null || typeof root.entries !== "object" || Array.isArray(root.entries)) return null;
	let best = null;
	for (const raw of Object.values(root.entries)) {
		if (raw === null || typeof raw !== "object") continue;
		const entry = raw;
		const at = typeof entry.fetchedAtMs === "number" && Number.isFinite(entry.fetchedAtMs) ? entry.fetchedAtMs : -1;
		if (!Array.isArray(entry.models)) continue;
		if (best === null || at > best.fetchedAtMs) best = {
			fetchedAtMs: at,
			models: entry.models
		};
	}
	if (best === null) return null;
	const models = {};
	for (const raw of best.models) {
		if (raw === null || typeof raw !== "object") continue;
		const model = raw;
		if (typeof model.id !== "string" || model.id === "") continue;
		const billing = model.billing;
		if (billing === null || typeof billing !== "object") continue;
		const amount = creditAmountOf(billing.credits);
		if (amount === null) continue;
		models[model.id.toLowerCase()] = amount;
	}
	return Object.keys(models).length > 0 ? { [provider]: models } : null;
}
let cached = null;
function platformCreditRates(now = Date.now()) {
	if (cached !== null && now - cached.at < CACHE_MS) return cached.value;
	const out = {};
	for (const { file, provider } of CATALOGUES) try {
		const text = readFileSync(join(dshHome(), file), "utf8");
		const one = creditRatesFromCatalogue(JSON.parse(text), provider);
		if (one !== null) out[provider] = one[provider];
	} catch {}
	const value = Object.keys(out).length > 0 ? out : null;
	cached = {
		at: now,
		value
	};
	return value;
}
function creditRatesForWire() {
	return creditRatesOf(platformCreditRates()) ?? void 0;
}
//#endregion
//#region src/host/fold/wire.ts
function headOf(state) {
	const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool;
	const snapshot = {
		ok: true,
		...state.model !== void 0 ? { model: state.model } : {},
		...state.provider !== void 0 ? { provider: state.provider } : {},
		...state.contextWindow !== void 0 ? { contextWindow: state.contextWindow } : {},
		current: {
			system: state.systemTokens,
			tools: state.toolsTokens,
			user: state.sums.user,
			inject: state.sums.inject,
			skill: state.sums.skill,
			assistant: state.sums.assistant,
			tool: state.sums.tool,
			total: surfaceTotal + state.systemTokens + state.toolsTokens
		},
		images: state.surface.reduce((total, node) => total + (node.imgs ?? 0), 0),
		toolCalls: state.surface.reduce((total, node) => node.cat === "tool" || node.cat === "skill" && node.tool !== void 0 ? total + 1 : total, 0),
		humanInputs: state.humanInputs ?? 0,
		answers: state.answers ?? 0,
		...state.lastUser !== void 0 ? { lastUser: state.lastUser } : {},
		requests: [],
		events: [],
		nodes: [],
		droppedNodes: 0,
		archive: []
	};
	if (state.cost !== void 0) snapshot.cost = copyCostLedger(state.cost);
	if (state.calls !== void 0) snapshot.calls = copyCallLedger(state.calls);
	if (state.turnCost !== void 0) snapshot.turnCost = copyTurnLedger(state.turnCost);
	const creditRates = creditRatesForWire();
	if (creditRates !== void 0) snapshot.creditRates = creditRates;
	if (state.timing !== void 0) snapshot.timing = copyTiming(state.timing);
	if (state.systems !== void 0 && state.systems.length > 0) snapshot.systems = state.systems.map(copySystemNode);
	return snapshot;
}
function copyTurnLedger(ledger) {
	const copy = {};
	for (const turn of Object.keys(ledger)) copy[turn] = {
		usage: copyCostLedger(ledger[turn].usage),
		requests: copyCallLedger(ledger[turn].requests)
	};
	return copy;
}
function copyTiming(timing) {
	const tools = {};
	for (const name of Object.keys(timing.tools)) tools[name] = { ...timing.tools[name] };
	return {
		...timing,
		tools
	};
}
function copySystemNode(node) {
	return {
		seq: node.seq,
		time: node.time,
		tokens: node.tokens
	};
}
function detailOf(state, bounds) {
	const requests = state.requests.map(copyRequest);
	const events = state.events.map(copyEventRow);
	attachRequestContext(requests, events);
	const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes);
	const overflow = state.surface.slice(0, overflowCount);
	const tail = state.surface.slice(overflowCount);
	const pinned = overflow.filter((node) => node.cat === "inject" || node.cat === "skill");
	const collections = {
		requests,
		events,
		nodes: (pinned.length > 0 ? [...pinned, ...tail] : tail).map(copySurfaceNode),
		droppedNodes: overflowCount - pinned.length,
		archive: state.archived.map(copySurfaceNode),
		fileOps: state.fileOps.map(copyFileOp),
		...state.fileOpsFloor !== void 0 ? { fileOpsFloor: state.fileOpsFloor } : {},
		spans: state.spans.map(copySpan)
	};
	if (collections.droppedNodes > 0) {
		let floor = 0;
		for (const node of overflow) if (node.cat !== "inject" && node.cat !== "skill") floor = Math.max(floor, node.seq);
		collections.surfaceFloor = floor;
	}
	if (state.archiveFloor !== void 0) collections.archiveFloor = state.archiveFloor;
	return collections;
}
function inlineOf(state, bounds) {
	return {
		...headOf(state),
		...detailOf(state, bounds)
	};
}
function attachRequestContext(requests, events) {
	let index = 0;
	for (const event of events) {
		while (index < requests.length && requests[index].seq <= event.seq) index++;
		const next = requests.at(index);
		const previous = index > 0 ? requests.at(index - 1) : void 0;
		if (next !== void 0 && typeof next.turn === "number" && typeof next.step === "number") {
			event.turn = next.turn;
			event.step = next.step;
		}
		if (previous !== void 0 && typeof previous.turn === "number" && typeof previous.step === "number") {
			event.fromTurn = previous.turn;
			event.fromStep = previous.step;
		}
	}
}
function countsOf(state) {
	const turns = new Set();
	for (const record of state.requests) turns.add(record.turn ?? 0);
	let injects = 0;
	let compactions = 0;
	let prunes = 0;
	const skills = new Set();
	for (const event of state.events) {
		if (event.kind === "inject") injects++;
		else if (event.kind === "compaction") compactions++;
		else if (event.kind === "prune") prunes++;
		if (event.sub === "skill" && typeof event.name === "string" && event.name !== "") skills.add(event.name);
	}
	return {
		turns: turns.size,
		steps: state.requests.length,
		injects,
		compactions,
		prunes,
		skills: skills.size
	};
}
function splitHeadOf(state) {
	const snapshot = headOf(state);
	snapshot.counts = countsOf(state);
	const last = state.requests.at(-1);
	if (last !== void 0) {
		const anchor = {
			seq: last.seq,
			total: last.total
		};
		if (typeof last.prompt === "number") anchor.prompt = last.prompt;
		snapshot.last = anchor;
	}
	snapshot.detailRev = state.detailRev ?? 0;
	return snapshot;
}
function detailPayloadOf(state, bounds) {
	return {
		rev: state.detailRev ?? 0,
		head: splitHeadOf(state),
		...detailOf(state, bounds)
	};
}
function copyRequest(record) {
	return { ...record };
}
function copyEventRow(row) {
	return { ...row };
}
function copySurfaceNode(node) {
	const copy = { ...node };
	if (node.calls !== void 0) copy.calls = [...node.calls];
	return copy;
}
function copyFileOp(op) {
	const copy = { ...op };
	if (op.read !== void 0) copy.read = { ...op.read };
	return copy;
}
function copySpan(span) {
	return {
		kind: span.kind,
		start: span.start,
		end: span.end
	};
}
//#endregion
//#region src/host/http/detail.ts
const DETAIL_ROUTE = routePath("detail");
const TIMELINE_KEY$1 = "contextTimeline";
async function coldDetail(observe, sessionId, bounds) {
	const observation = await observe(sessionId, { projectionMode: "none" });
	try {
		const events = asRecord(observation)?.events;
		if (!Array.isArray(events)) return null;
		let state = emptyTimeline();
		for (const event of events) state = reduceTimeline(state, event, bounds);
		return detailPayloadOf(state, bounds);
	} finally {
		await disposeResource(observation);
	}
}
function watchDetailChannel(ctx, bounds, coldReads) {
	const gate = { live: false };
	ctx.inject(["connection", "sessions"], (c) => {
		const sessions = c.get("sessions");
		const getSession = typeof sessions?.get === "function" ? sessions.get.bind(sessions) : void 0;
		if (getSession === void 0) return;
		const handler = async (request) => {
			const body = await readJsonBody(request);
			if (!body.ok) return replyFailure(BAD_REQUEST_CODE, "body is not JSON");
			const sessionId = asRecord(body.value)?.sessionId;
			if (typeof sessionId !== "string" || sessionId === "") return replyFailure(BAD_REQUEST_CODE, "missing sessionId");
			try {
				const session = getSession(sessionId);
				if (session !== void 0 && session !== null) {
					const projections = ctx.sessionProjections;
					const state = typeof projections.stateOf === "function" ? projections.stateOf(session, TIMELINE_KEY$1) : void 0;
					if (state === void 0 || state === null) return replyValue(null);
					return replyValue(detailPayloadOf(state, bounds));
				}
				const query = ctx.get("sessionQuery");
				const observe = typeof query?.observeSession === "function" ? query.observeSession.bind(query) : void 0;
				if (observe === void 0) return replyValue(null);
				return replyValue(await coldReads.admit(async () => coldDetail((id, options) => observe(id, options), sessionId, bounds)) ?? null);
			} catch (error) {
				return replyFailure(INTERNAL_ERROR_CODE, messageOf$1(error));
			}
		};
		if (!registerPostRoute(c, c.get("connection"), DETAIL_ROUTE, handler, "dsh-cost-breakdown: detail route")) return;
		gate.live = true;
		return () => {
			gate.live = false;
		};
	});
	return gate;
}
//#endregion
//#region src/host/http/skills.ts
const SKILLS_ROUTE = routePath("skills");
const MAX_SKILLS = 500;
function stringOf(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function skillEntryOf(value) {
	const record = asRecord(value);
	if (record === null || typeof record.name !== "string" || record.name === "") return null;
	return {
		name: record.name,
		description: typeof record.description === "string" ? record.description : "",
		...typeof record.path === "string" && record.path !== "" ? { path: record.path } : {},
		...typeof record.source === "string" && record.source !== "" ? { source: record.source } : {}
	};
}
async function sessionViewOf(ctx, sessionId) {
	if (sessionId === void 0) return {};
	const query = asRecord(ctx.get("sessionQuery"));
	if (typeof query?.observeSession !== "function") return {};
	let observation;
	try {
		observation = await query.observeSession.call(query, sessionId);
	} catch {
		return {};
	}
	try {
		const obs = asRecord(observation);
		const cwd = stringOf(asRecord(obs?.header)?.cwd);
		const agentPreset = stringOf(asRecord(asRecord(obs?.projections)?.values)?.agentPreset);
		return {
			...cwd === void 0 ? {} : { cwd },
			...agentPreset === void 0 ? {} : { agentPreset }
		};
	} finally {
		await disposeResource(observation);
	}
}
async function resolveRegistry(ctx, sessionId, agentPreset) {
	const presets = asRecord(ctx.get("agentPresets"));
	let live;
	if (sessionId !== void 0) {
		const agents = asRecord(ctx.get("agents"));
		if (typeof agents?.get === "function") try {
			live = agents.get.call(agents, sessionId);
		} catch {
			live = void 0;
		}
	}
	if (live !== void 0 && live !== null && typeof presets?.serviceFor === "function") {
		const scoped = asRecord(presets.serviceFor.call(presets, live, "skills"));
		if (scoped !== null && typeof scoped.list === "function") return {
			registry: scoped,
			scope: live,
			lease: void 0
		};
	}
	const registry = asRecord(ctx.get("skills"));
	if (registry === null || typeof registry.list !== "function") return null;
	let scope;
	let lease;
	if (typeof presets?.acquireScope === "function") try {
		lease = await presets.acquireScope.call(presets, agentPreset);
		scope = asRecord(lease)?.key;
	} catch {
		lease = void 0;
	}
	return {
		registry,
		scope,
		lease
	};
}
async function readSkillCatalogue(ctx, body) {
	const record = asRecord(body);
	const sessionId = stringOf(record?.sessionId);
	let lease;
	try {
		const view = await sessionViewOf(ctx, sessionId);
		const cwd = view.cwd ?? stringOf(record?.cwd);
		const choice = await resolveRegistry(ctx, sessionId, view.agentPreset);
		if (choice === null) return null;
		lease = choice.lease;
		const listed = await choice.registry.list({
			...cwd === void 0 ? {} : { cwd },
			...choice.scope === void 0 ? {} : { scope: choice.scope }
		});
		const rows = Array.isArray(listed) ? listed : [];
		const skills = [];
		for (const row of rows) {
			const entry = skillEntryOf(row);
			if (entry !== null) skills.push(entry);
			if (skills.length >= MAX_SKILLS) break;
		}
		return { skills };
	} catch {
		return null;
	} finally {
		await disposeResource(lease);
	}
}
function watchSkillsChannel(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async (request) => {
			const body = await readJsonBody(request);
			if (!body.ok) return replyValue(null);
			return replyValue(await readSkillCatalogue(ctx, body.value));
		};
		registerPostRoute(c, c.get("connection"), SKILLS_ROUTE, handler, "dsh-cost-breakdown: skills route");
	});
}
function mcpServerOf(name) {
	if (!name.startsWith("mcp__")) return void 0;
	const cut = name.lastIndexOf("__");
	if (cut < 5) return void 0;
	const server = name.slice(5, cut);
	return server.length > 0 ? server : void 0;
}
function mcpSourceOf(name) {
	const server = mcpServerOf(name);
	return server !== void 0 ? `mcp:${server}` : void 0;
}
const FIRST_PARTY_SOURCES = Object.freeze({
	read: "@deepseek-ai/dsh-tool-fs",
	write: "@deepseek-ai/dsh-tool-fs",
	edit: "@deepseek-ai/dsh-tool-fs",
	read_image: "@deepseek-ai/dsh-tool-fs",
	glob: "@deepseek-ai/dsh-tool-fs-search",
	grep: "@deepseek-ai/dsh-tool-fs-search",
	str_replace_editor: "@deepseek-ai/dsh-tool-str-replace-editor",
	bash: "@deepseek-ai/dsh-tool-bash",
	pwsh: "@deepseek-ai/dsh-tool-pwsh",
	web_search: "@deepseek-ai/dsh-tool-web",
	web_fetch: "@deepseek-ai/dsh-tool-web",
	job_output: "@deepseek-ai/dsh-tool-jobs",
	job_list: "@deepseek-ai/dsh-tool-jobs",
	job_kill: "@deepseek-ai/dsh-tool-jobs",
	ask_user_question: "@deepseek-ai/dsh-tool-ask-user",
	plan: "@deepseek-ai/dsh-plan-mode",
	exit_plan_mode: "@deepseek-ai/dsh-plan-mode",
	skill: "@deepseek-ai/dsh-tool-skill",
	todo_write: "@deepseek-ai/dsh-tool-todo",
	subagent: "@deepseek-ai/dsh-tool-subagent",
	subagent_fork: "@deepseek-ai/dsh-tool-subagent",
	send_message: "@deepseek-ai/dsh-tool-subagent-control",
	interrupt_agent: "@deepseek-ai/dsh-tool-subagent-control",
	list_agents: "@deepseek-ai/dsh-tool-subagent-control",
	ralph: "@deepseek-ai/dsh-tool-ralph",
	workflow: "@deepseek-ai/dsh-tool-workflow",
	run_code: "@deepseek-ai/dsh-tools",
	schedule_create: "@deepseek-ai/dsh-schedule",
	schedule_list: "@deepseek-ai/dsh-schedule",
	schedule_delete: "@deepseek-ai/dsh-schedule",
	create_goal: "@deepseek-ai/dsh-tool-goal",
	get_goal: "@deepseek-ai/dsh-tool-goal",
	update_goal: "@deepseek-ai/dsh-tool-goal",
	lsp: "@deepseek-ai/dsh-tool-lsp"
});
function pinnedSourceOf(name) {
	return FIRST_PARTY_SOURCES[name];
}
//#endregion
//#region src/host/platform/attribution.ts
const SELF_URL = normalize(fileURLToPath(import.meta.url));
const packageNameCache = new Map();
const PACKAGE_WALK_DEPTH = 12;
function packageNameFrom(file) {
	let dir = dirname(file);
	for (let depth = 0; depth < PACKAGE_WALK_DEPTH; depth++) {
		const cached = packageNameCache.get(dir);
		if (cached !== void 0) return cached;
		const packageFile = join(dir, "package.json");
		if (existsSync(packageFile)) try {
			const name = JSON.parse(readFileSync(packageFile, "utf8")).name;
			if (typeof name === "string" && name !== "") {
				packageNameCache.set(dir, name);
				return name;
			}
		} catch {}
		const parent = dirname(dir);
		packageNameCache.set(dir, void 0);
		if (parent === dir) return void 0;
		dir = parent;
	}
}
const FRAME_POSITION = /:\d+:\d+$/;
const CORDIS_ORIGINAL = Symbol.for("cordis.original");
function rawInstanceOf(service) {
	return service?.[CORDIS_ORIGINAL] ?? service;
}
const SELF_PACKAGE = packageNameFrom(SELF_URL);
function callerPackageFrom(stack) {
	if (stack === void 0 || stack === "") return void 0;
	for (const raw of stack.split("\n").slice(1)) {
		let line = raw.trim();
		if (!line.startsWith("at ")) continue;
		line = line.slice(3);
		if (line.startsWith("async ")) line = line.slice(6);
		line = line.replace(/\)\s*$/, "");
		const position = FRAME_POSITION.exec(line);
		if (position === null) continue;
		let target = line.slice(0, -position[0].length);
		if (target.includes("(")) target = target.slice(target.lastIndexOf("(") + 1);
		if (target.startsWith("file://")) try {
			target = normalize(fileURLToPath(target));
		} catch {
			continue;
		}
		else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith("/") && !target.startsWith("\\\\")) continue;
		else target = normalize(target);
		if (target === SELF_URL) continue;
		const name = packageNameFrom(target);
		if (name !== void 0 && name !== SELF_PACKAGE) return name;
	}
}
function createToolAttribution(ctx) {
	const live = new Map();
	const wrapped = new WeakSet();
	const self = ctx.fiber.name;
	let lastReader;
	const restores = [];
	const wrapInstance = (tools) => {
		if (tools === null || typeof tools !== "object" || wrapped.has(tools)) return;
		const instance = tools;
		const register = instance.register;
		if (typeof register !== "function") return;
		wrapped.add(tools);
		const original = register.attributedOriginal ?? register;
		if (typeof original !== "function") return;
		const wrappedRegister = function(definition) {
			const toolName = definition?.name;
			let owner = lastReader;
			if (owner === void 0 || owner === "" || owner === "root" || owner === self) owner = callerPackageFrom(new Error().stack);
			const dispose = original.call(this, definition);
			if (typeof toolName === "string" && owner !== void 0 && owner !== "root" && owner !== self && owner !== SELF_PACKAGE) {
				live.set(toolName, owner);
				if (typeof dispose === "function") return () => {
					try {
						return dispose();
					} finally {
						live.delete(toolName);
					}
				};
			}
			return dispose;
		};
		wrappedRegister.attributedOriginal = original;
		instance.register = wrappedRegister;
		restores.push(() => {
			if (instance.register === wrappedRegister) instance.register = original;
		});
	};
	ctx.on("internal/get", (reader, name, _error, next) => {
		if (name !== "tools") return next();
		const tools = next();
		lastReader = reader.fiber.name;
		wrapInstance(rawInstanceOf(tools));
		return tools;
	});
	ctx.effect(() => () => {
		for (const restore of restores.splice(0)) restore();
	}, "tools.register attribution");
	const bootTools = rawInstanceOf(ctx.get("tools", false));
	wrapInstance(bootTools);
	const boot = new Set();
	try {
		const entries = bootTools?.layers?.global?.tools;
		if (entries !== void 0 && typeof entries.entries === "function") for (const [name] of entries.entries()) boot.add(name);
	} catch {}
	return { ownerOf: (name) => mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name) ?? (boot.has(name) ? "<unknown-plugin>" : void 0) };
}
//#endregion
//#region src/host/platform/harness.ts
const LIBRARY_PROBE_PACKAGES = ["@deepseek-ai/dsh-session-projection", "@deepseek-ai/dsh-session"];
const RUNNING_PROBE_PACKAGES = ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-projection"];
const HOME_PROBE_PACKAGES = ["@deepseek-ai/dsh", ...LIBRARY_PROBE_PACKAGES];
function ownPackageRoot() {
	try {
		return dirname(fileURLToPath(import.meta.resolve("dsh-cost-breakdown/package.json")));
	} catch {
		return dirname(fileURLToPath(import.meta.url));
	}
}
const PLUGIN_ROOT = ownPackageRoot();
function versionOfManifest(manifestPath, expectedName) {
	try {
		const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (parsed === null || typeof parsed !== "object") return void 0;
		const record = parsed;
		if (expectedName !== void 0 && record.name !== expectedName) return void 0;
		return typeof record.version === "string" && record.version !== "" ? record.version : void 0;
	} catch {
		return;
	}
}
function versionViaManifest(resolve, packageName) {
	try {
		return versionOfManifest(resolve(packageName + "/package.json"));
	} catch {
		return;
	}
}
function versionViaEntry(resolve, packageName) {
	let dir;
	try {
		dir = dirname(resolve(packageName));
	} catch {
		return;
	}
	for (;;) {
		const version = versionOfManifest(join(dir, "package.json"), packageName);
		if (version !== void 0) return version;
		const parent = dirname(dir);
		if (parent === dir) return void 0;
		dir = parent;
	}
}
function probeAnchor(resolve, packageNames) {
	for (const packageName of packageNames) {
		const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName);
		if (version !== void 0) return version;
	}
}
function isInside(root, candidate) {
	const rel = relative(root, candidate);
	return !rel.startsWith("..") && !isAbsolute(rel);
}
function probeRunningTree(resolve, pluginRoot) {
	for (const packageName of RUNNING_PROBE_PACKAGES) {
		let witness;
		try {
			witness = resolve(packageName);
		} catch {
			continue;
		}
		if (isInside(pluginRoot, witness)) continue;
		const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName);
		if (version !== void 0) return version;
	}
}
function resolveRunningModule(specifier) {
	return import.meta.resolve(specifier);
}
function probeHarnessRelease(ctx, resolveUrl = resolveRunningModule, pluginRoot = PLUGIN_ROOT) {
	const running = probeRunningTree((specifier) => {
		const url = resolveUrl(specifier);
		if (!url.startsWith("file:")) throw new Error(`dsh-cost-breakdown: non-file module URL for ${specifier}`);
		return fileURLToPath(url);
	}, pluginRoot);
	if (running !== void 0) return running;
	try {
		const homePath = ctx.get("dshHomePath");
		if (typeof homePath === "function") {
			const requireFromHome = createRequire(homePath("profiles", "dsh-cost-breakdown-version-probe.cjs"));
			const home = probeAnchor((specifier) => requireFromHome.resolve(specifier), HOME_PROBE_PACKAGES);
			if (home !== void 0) return home;
		}
	} catch {}
}
//#endregion
//#region src/host/platform/step-ids.ts
const MINTED_ID_PREFIX = "dshctx-";
function lacksId(message) {
	if (typeof message !== "object" || message === null) return false;
	const id = message.id;
	return typeof id !== "string" || id === "";
}
function identifiedMessages(messages) {
	let copy;
	for (const [index, message] of messages.entries()) {
		if (!lacksId(message)) {
			copy?.push(message);
			continue;
		}
		copy ??= messages.slice(0, index);
		copy.push({
			...message,
			id: MINTED_ID_PREFIX + randomUUID()
		});
	}
	return copy;
}
function watchInboxIdentity(ctx) {
	ctx.on("agent/pre-step", async (_input, next) => {
		const decision = await next();
		try {
			if (decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
			const identified = identifiedMessages(decision.messages);
			return identified === void 0 ? decision : {
				...decision,
				messages: identified
			};
		} catch {
			return decision;
		}
	}, { prepend: true });
}
//#endregion
//#region src/core/day.ts
function dayKeyOf(time) {
	if (!Number.isFinite(time)) return null;
	const date = new Date(time);
	const year = date.getFullYear();
	if (!Number.isFinite(year) || year < 1970 || year > 9999) return null;
	return `${String(year).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
//#endregion
//#region src/wire/schema.ts
const counter = z.number().int().nonnegative();
const systemNode = z.object({
	seq: counter,
	time: z.number(),
	tokens: counter
}).strict();
const surfaceEntry = z.object({
	seq: counter,
	time: z.number().optional(),
	cat: z.enum([
		"user",
		"inject",
		"skill",
		"assistant",
		"tool"
	]),
	tokens: counter,
	imgs: counter.optional(),
	gone: counter.optional(),
	form: z.string().optional(),
	name: z.string().optional(),
	text: z.string().optional(),
	tool: z.string().optional(),
	err: z.boolean().optional(),
	skill: z.string().optional(),
	calls: z.array(z.string()).optional()
}).strict();
const requestRow = z.object({
	turn: z.number().optional(),
	step: z.number().optional(),
	time: z.number(),
	seq: z.number(),
	system: counter,
	tools: counter,
	user: counter,
	inject: counter,
	assistant: counter,
	tool: counter,
	total: counter,
	prompt: counter.optional(),
	skill: counter.optional(),
	cacheRead: counter.optional(),
	output: counter.optional(),
	activeMs: z.number().nonnegative().optional(),
	stepCount: z.number().int().positive().optional(),
	net: z.number().optional()
}).strict();
const ledgerEvent = z.object({
	seq: z.number(),
	time: z.number(),
	kind: z.enum([
		"compaction",
		"prune",
		"inject",
		"model",
		"mode"
	]),
	form: z.string().optional(),
	tokens: z.number().optional(),
	count: z.number().optional(),
	sub: z.string().optional(),
	name: z.string().optional(),
	detail: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	fromTurn: z.number().optional(),
	fromStep: z.number().optional(),
	turn: z.number().optional(),
	step: z.number().optional()
}).strict();
const fileOp = z.object({
	seq: z.number(),
	path: z.string(),
	kind: z.enum([
		"read",
		"write",
		"search"
	]),
	tool: z.string(),
	time: z.number().optional(),
	err: z.boolean(),
	added: counter,
	removed: counter,
	detail: z.string().optional(),
	hits: z.number().optional(),
	read: z.union([z.object({
		start: z.number(),
		count: z.number()
	}).strict(), z.object({
		count: z.number(),
		est: z.literal(true)
	}).strict()]).optional(),
	parent: z.number().optional(),
	program: z.string().optional(),
	pattern: z.literal(true).optional()
}).strict();
const timingSegment = z.object({
	kind: z.enum([
		"ttft",
		"reasoning",
		"text",
		"toolarg",
		"tools",
		"other"
	]),
	start: z.number(),
	end: z.number()
}).strict();
const toolTiming = z.object({
	calls: z.number(),
	ms: z.number()
}).strict();
const timingTotals = z.object({
	wallMs: z.number(),
	ttftMs: z.number(),
	genMs: z.number(),
	reasoningMs: z.number().optional(),
	reasoningBlocks: z.number().optional(),
	textMs: z.number().optional(),
	textBlocks: z.number().optional(),
	toolArgMs: z.number().optional(),
	toolArgBlocks: z.number().optional(),
	speedTokens: z.number().optional(),
	speedMs: z.number().optional(),
	calls: z.number(),
	toolsMs: z.number(),
	toolCalls: z.number(),
	tools: z.record(z.string(), toolTiming)
}).strict();
const bucketTotals = z.object({
	uncached: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
	output: z.number()
}).strict();
const modelLedger = z.object({
	peak: bucketTotals.optional(),
	off: bucketTotals.optional()
}).strict();
const costLedger = z.record(z.string(), z.record(z.string(), modelLedger));
const callLedger = z.record(z.string(), z.record(z.string(), z.number()));
const turnEntry = z.object({
	usage: costLedger,
	requests: callLedger
}).strict();
const turnLedger = z.record(z.string(), turnEntry);
const creditRates = z.record(z.string(), z.record(z.string(), z.number()));
const retainedCounts = z.object({
	turns: counter,
	steps: counter,
	injects: counter,
	compactions: counter,
	prunes: counter,
	skills: counter.optional()
}).strict();
const newestRequest = z.object({
	seq: z.number(),
	total: counter,
	prompt: counter.optional()
}).strict();
const timelineViewSchema = z.object({
	ok: z.boolean(),
	unsupported: z.object({
		current: z.string(),
		minimum: z.string()
	}).strict().optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	contextWindow: z.number().optional(),
	current: z.object({
		system: counter,
		tools: counter,
		user: counter,
		inject: counter,
		skill: counter,
		assistant: counter,
		tool: counter,
		total: counter
	}).strict(),
	images: counter.optional(),
	toolCalls: counter.optional(),
	humanInputs: counter.optional(),
	answers: counter.optional(),
	lastUser: z.string().optional(),
	counts: retainedCounts.optional(),
	last: newestRequest.optional(),
	detailRev: counter.optional(),
	requests: z.array(requestRow),
	events: z.array(ledgerEvent),
	cost: costLedger.optional(),
	calls: callLedger.optional(),
	turnCost: turnLedger.optional(),
	creditRates: creditRates.optional(),
	timing: timingTotals.optional(),
	systems: z.array(systemNode).optional(),
	nodes: z.array(surfaceEntry),
	droppedNodes: counter,
	archive: z.array(surfaceEntry),
	surfaceFloor: z.number().optional(),
	archiveFloor: z.number().optional(),
	fileOps: z.array(fileOp).optional(),
	fileOpsFloor: counter.optional(),
	spans: z.array(timingSegment).optional()
}).strict();
z.object({
	rev: counter,
	head: timelineViewSchema.optional(),
	requests: z.array(requestRow),
	events: z.array(ledgerEvent),
	nodes: z.array(surfaceEntry),
	droppedNodes: counter,
	archive: z.array(surfaceEntry),
	surfaceFloor: z.number().optional(),
	archiveFloor: z.number().optional(),
	fileOps: z.array(fileOp).optional(),
	fileOpsFloor: counter.optional(),
	spans: z.array(timingSegment).optional()
}).strict();
const timelineStateSchema = z.object({
	surface: z.array(surfaceEntry),
	sums: z.object({
		user: z.number(),
		inject: z.number(),
		skill: z.number(),
		assistant: z.number(),
		tool: z.number()
	}).strict(),
	systemTokens: z.number(),
	systems: z.array(systemNode).optional(),
	toolsTokens: z.number(),
	model: z.string().optional(),
	provider: z.string().optional(),
	lastModel: z.string().optional(),
	contextWindow: z.number().optional(),
	requests: z.array(requestRow),
	turnRuns: z.number().optional(),
	events: z.array(ledgerEvent),
	archived: z.array(surfaceEntry),
	cost: costLedger.optional(),
	turnCost: turnLedger.optional(),
	calls: callLedger.optional(),
	humanInputs: z.number().optional(),
	answers: z.number().optional(),
	lastUser: z.string().optional(),
	archiveFloor: z.number().optional(),
	detailRev: z.number().optional(),
	timing: timingTotals.optional(),
	stepStart: z.object({
		time: z.number(),
		firstToken: z.number().optional()
	}).strict().optional(),
	stepWaits: z.array(z.object({
		start: z.number(),
		end: z.number()
	}).strict()).optional(),
	stepApprovals: z.record(z.string(), z.number()).optional(),
	stepRequestSeq: z.number().optional(),
	spans: z.array(timingSegment),
	stepSpans: z.array(timingSegment).optional(),
	callNames: z.record(z.string(), z.object({
		name: z.string(),
		start: z.number(),
		argsRaw: z.string().optional()
	}).strict()),
	pendingShadowedSeqs: z.array(z.number()).optional(),
	pendingShadowEventSeq: z.number().optional(),
	fileOps: z.array(fileOp),
	fileOpsFloor: counter.optional(),
	pendingCodeOps: z.record(z.string(), z.array(fileOp)).optional()
}).strict();
const headeredTool = z.object({
	name: z.string(),
	tokens: z.number(),
	plugin: z.string().optional()
}).strict();
const headerEpoch = z.object({
	seq: z.number(),
	time: z.number(),
	systemTokens: z.number().optional(),
	tools: z.array(headeredTool)
}).strict();
const headerViewSchema = z.object({ headers: z.array(headerEpoch) }).strict();
const headerStateSchema = z.object({ headers: z.array(z.object({
	seq: z.number(),
	time: z.number(),
	system: z.string().optional(),
	systemTokens: z.number().optional(),
	tools: z.array(z.object({
		name: z.string(),
		tokens: z.number(),
		description: z.string().optional(),
		plugin: z.string().optional(),
		schema: z.unknown().optional()
	}).strict())
}).strict()) }).strict();
const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ledgerDay = z.object({
	tokens: z.number(),
	requests: z.number(),
	cost: costLedger.optional(),
	skills: z.record(z.string(), z.object({
		n: z.number(),
		last: z.number()
	}).strict()).optional()
}).strict();
const activityViewSchema = z.object({ days: z.record(dayKey, ledgerDay) }).strict();
const activityStateSchema = z.object({
	days: z.record(dayKey, ledgerDay),
	model: z.string().optional(),
	provider: z.string().optional(),
	stepStart: z.number().optional(),
	skillCalls: z.array(z.string()).optional()
}).strict();
z.object({
	isAvailable: z.boolean(),
	balances: z.array(z.object({
		currency: z.string(),
		total: z.number(),
		granted: z.number(),
		toppedUp: z.number()
	}).strict())
}).strict();
const skillEntrySchema = z.object({
	name: z.string(),
	description: z.string(),
	path: z.string().optional(),
	source: z.string().optional()
}).strict();
z.object({ skills: z.array(skillEntrySchema) }).strict();
z.object({
	total: z.number(),
	unlimited: z.boolean(),
	cycleResetTime: z.string().optional()
}).strict();
z.object({
	ok: z.literal(false),
	error: z.object({
		code: z.string(),
		message: z.string()
	}).strict()
}).strict();
//#endregion
//#region src/host/projections/activity.ts
const ACTIVITY_KEY = "contextActivity";
function withDay(state, key, day) {
	let days = {
		...state.days,
		[key]: day
	};
	const keys = Object.keys(days);
	if (keys.length > 400) {
		keys.sort();
		const dropped = new Set(keys.slice(0, keys.length - 400));
		days = Object.fromEntries(Object.entries(days).filter(([entryKey]) => !dropped.has(entryKey)));
	}
	return {
		...state,
		days
	};
}
function bookSkillLoad(state, name, time) {
	const key = dayKeyOf(time);
	if (key === null) return state;
	const previous = state.days[key];
	const existing = previous?.skills?.[name];
	if (existing === void 0 && previous?.skills !== void 0 && Object.keys(previous.skills).length >= 100) return state;
	const skills = {
		...previous?.skills,
		[name]: {
			n: (existing?.n ?? 0) + 1,
			last: existing === void 0 ? time : Math.max(existing.last, time)
		}
	};
	return withDay(state, key, {
		tokens: previous?.tokens ?? 0,
		requests: previous?.requests ?? 0,
		...previous?.cost !== void 0 ? { cost: previous.cost } : {},
		skills
	});
}
function invokedSkillOf(event) {
	const data = event.data;
	const carrier = event.type === "developer/message" ? data?.message : data;
	if (!isRecord(carrier)) return "";
	const source = carrier.source;
	if (!isRecord(source)) return "";
	return source.kind === "skill-invocation" && typeof source.name === "string" ? source.name : "";
}
function resultCallIdOf(message) {
	if (!isRecord(message)) return null;
	if (typeof message.toolCallId === "string" && message.toolCallId !== "") return message.toolCallId;
	const source = message.source;
	if (!isRecord(source)) return null;
	const callId = source.callId;
	return typeof callId === "string" && callId !== "" ? callId : null;
}
function pricedDay(day, key, state, initiated, buckets, holidays) {
	let cost = day?.cost;
	if (state.model !== void 0) {
		const provider = state.provider ?? "";
		cost = bookUsage(cost ?? {}, provider, state.model, periodAt(initiated, provider, state.model, holidays), buckets);
	}
	return withDay(state, key, {
		tokens: (day?.tokens ?? 0) + settlementTokens(buckets),
		requests: (day?.requests ?? 0) + 1,
		...cost !== void 0 ? { cost } : {},
		...day?.skills !== void 0 ? { skills: day.skills } : {}
	});
}
function reduceActivity(state, event, holidays) {
	switch (event.type) {
		case "request/header": {
			const config = event.data?.header?.config;
			if (!isRecord(config)) return state;
			const model = typeof config.model === "string" ? config.model : void 0;
			const provider = typeof config.provider === "string" ? config.provider : void 0;
			const nextModel = model ?? state.model;
			const nextProvider = provider ?? state.provider;
			if (nextModel === state.model && nextProvider === state.provider) return state;
			return {
				...state,
				...nextModel !== void 0 ? { model: nextModel } : {},
				...nextProvider !== void 0 ? { provider: nextProvider } : {}
			};
		}
		case "step/start":
			if (!Number.isFinite(event.time)) return state;
			return state.stepStart === event.time ? state : {
				...state,
				stepStart: event.time
			};
		case "step/end": {
			if (state.stepStart === void 0) return state;
			const next = { ...state };
			delete next.stepStart;
			return next;
		}
		case "session/end-seed":
			if (event.data?.inherited !== true) return state;
			return { days: {} };
		case "user/message":
		case "developer/message": {
			const name = invokedSkillOf(event);
			return name === "" ? state : bookSkillLoad(state, name, event.time);
		}
		case "tool/call": {
			const data = event.data;
			const callId = data?.callId;
			if (data?.name !== "skill" || typeof callId !== "string" || callId === "") return state;
			const pending = state.skillCalls ?? [];
			if (pending.includes(callId)) return state;
			return {
				...state,
				skillCalls: [...pending, callId].slice(-100)
			};
		}
		case "tool/result": {
			const message = event.data?.message;
			const callId = resultCallIdOf(message);
			const pending = state.skillCalls;
			if (callId === null || pending === void 0 || !pending.includes(callId)) return state;
			const remaining = pending.filter((id) => id !== callId);
			const next = { ...state };
			if (remaining.length > 0) next.skillCalls = remaining;
			else delete next.skillCalls;
			const name = skillNameOfIn(message);
			return name === "" ? next : bookSkillLoad(next, name, event.time);
		}
		case "assistant/message": {
			const initiated = state.stepStart ?? event.time;
			const key = dayKeyOf(initiated);
			if (key === null) return state;
			const settlement = settlementOf(event.data?.usage);
			const day = state.days[key];
			if (settlement === null) return withDay(state, key, {
				tokens: day?.tokens ?? 0,
				requests: (day?.requests ?? 0) + 1,
				...day?.cost !== void 0 ? { cost: day.cost } : {},
				...day?.skills !== void 0 ? { skills: day.skills } : {}
			});
			return pricedDay(day, key, state, initiated, settlement.buckets, holidays);
		}
		default: return state;
	}
}
function skillNameOfIn(message) {
	if (!isRecord(message) || !Array.isArray(message.content)) return "";
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string" || block.text === "") continue;
		return skillNameOf(block.text);
	}
	return "";
}
function createActivityUnit(holidays) {
	return {
		key: ACTIVITY_KEY,
		stateSchema: activityStateSchema,
		init: () => ({ days: {} }),
		apply: (state, event) => reduceActivity(state, event, holidays),
		wire: {
			viewSchema: activityViewSchema,
			view: (state) => ({ days: Object.fromEntries(Object.entries(state.days).map(([key, day]) => [key, {
				...day,
				...day.cost !== void 0 ? { cost: copyCostLedger(day.cost) } : {},
				...day.skills !== void 0 ? { skills: Object.fromEntries(Object.entries(day.skills).map(([name, tally]) => [name, { ...tally }])) } : {}
			}])) })
		},
		stateVersion: 6
	};
}
const degradedStateSchema = z.object({});
function degradedUnit(key, viewSchema, value) {
	const view = () => value;
	return {
		key,
		stateSchema: degradedStateSchema,
		init: () => ({}),
		apply: (state, _event) => state,
		wire: {
			viewSchema,
			view
		},
		schema: viewSchema,
		view,
		stateVersion: 1
	};
}
function createDegradedTimeline(current) {
	return degradedUnit("contextTimeline", timelineViewSchema, {
		ok: true,
		unsupported: {
			current,
			minimum: BASELINE_RELEASE
		},
		current: {
			system: 0,
			tools: 0,
			user: 0,
			inject: 0,
			skill: 0,
			assistant: 0,
			tool: 0,
			total: 0
		},
		requests: [],
		events: [],
		nodes: [],
		droppedNodes: 0,
		archive: []
	});
}
function createDegradedHeaders() {
	return degradedUnit("contextHeaders", headerViewSchema, { headers: [] });
}
function createDegradedActivity() {
	return degradedUnit("contextActivity", activityViewSchema, { days: {} });
}
//#endregion
//#region src/host/projections/headers.ts
const HEADERS_KEY = "contextHeaders";
function epochOf(event) {
	if (event.type !== "request/header") return null;
	const rawHeader = event.data?.header;
	if (!isRecord(rawHeader)) return null;
	const tools = Array.isArray(rawHeader.tools) ? rawHeader.tools : [];
	return {
		seq: event.seq,
		time: event.time,
		tools: tools.map((tool) => {
			const record = isRecord(tool) ? tool : {};
			const entry = {
				name: typeof record.name === "string" ? record.name : "?",
				tokens: estimateToolSchema(tool)
			};
			if (typeof record.plugin === "string" && record.plugin !== "") entry.plugin = record.plugin;
			return entry;
		})
	};
}
function wireEpochOf(epoch, resolve) {
	const record = {
		seq: epoch.seq,
		time: epoch.time,
		tools: epoch.tools.map((tool) => {
			const entry = {
				name: tool.name,
				tokens: tool.tokens
			};
			const plugin = tool.plugin ?? (resolve !== void 0 ? resolve(tool.name) : void 0);
			if (plugin !== void 0) entry.plugin = plugin;
			return entry;
		})
	};
	const systemTokens = epoch.systemTokens ?? (typeof epoch.system === "string" && epoch.system !== "" ? estimateSystemText(epoch.system) : void 0);
	if (systemTokens !== void 0) record.systemTokens = systemTokens;
	return record;
}
function createHeadersUnit(resolve) {
	return {
		key: HEADERS_KEY,
		stateSchema: headerStateSchema,
		init: () => ({ headers: [] }),
		apply: (state, event) => {
			const epoch = epochOf(event);
			if (epoch === null) return state;
			const last = state.headers.at(-1);
			if (last !== void 0 && last.seq === epoch.seq) return state;
			const headers = [...state.headers, epoch];
			return { headers: headers.length > 50 ? headers.slice(-50) : headers };
		},
		wire: {
			viewSchema: headerViewSchema,
			view: (state) => ({ headers: state.headers.map((epoch) => wireEpochOf(epoch, resolve)) })
		},
		stateVersion: 1
	};
}
//#endregion
//#region src/host/settings.ts
const DEFAULT_BOUNDS = {
	maxRequestSteps: 1500,
	maxKeptTurns: 300,
	maxEvents: 400,
	maxNodes: 2e3,
	maxArchiveNodes: 400,
	maxFileOps: 400,
	holidays: [...DEFAULT_HOLIDAYS]
};
function volatileField(field) {
	const volatile = field.volatile;
	return typeof volatile === "function" ? volatile.call(field) : field;
}
function count(defaultValue) {
	return z$1.number().min(1).step(1).default(defaultValue);
}
const Config = z$1.object({
	maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
	maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
	maxEvents: count(DEFAULT_BOUNDS.maxEvents),
	maxNodes: count(DEFAULT_BOUNDS.maxNodes),
	maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
	maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
	holidays: z$1.array(z$1.string()).default([...DEFAULT_HOLIDAYS]).loose(),
	defaultPlacement: volatileField(z$1.union([
		"all",
		"tab",
		"sidebar"
	]).default("all").loose()),
	defaultGranularity: volatileField(z$1.union(["step", "turn"]).default("step").loose()),
	defaultTrendMode: volatileField(z$1.union(["total", "delta"]).default("total").loose()),
	defaultDeltaBase: volatileField(z$1.union(["step", "turn"]).default("step").loose()),
	defaultToolSort: volatileField(z$1.union([
		"size",
		"count",
		"name"
	]).default("count").loose()),
	defaultFileSort: volatileField(z$1.union([
		"count",
		"latest",
		"path"
	]).default("count").loose()),
	insightsEntry: volatileField(z$1.union(["show", "hide"]).default("show").loose()),
	defaultDurationCurve: volatileField(z$1.union(["show", "hide"]).default("show").loose())
});
function resolveBounds(config) {
	const resolved = Config(config ?? {});
	return {
		maxRequestSteps: resolved.maxRequestSteps,
		maxKeptTurns: resolved.maxKeptTurns,
		maxEvents: resolved.maxEvents,
		maxNodes: resolved.maxNodes,
		maxArchiveNodes: resolved.maxArchiveNodes,
		maxFileOps: resolved.maxFileOps,
		holidays: normaliseHolidays(resolved.holidays) ?? [...DEFAULT_HOLIDAYS]
	};
}
//#endregion
//#region src/host/projections/timeline.ts
const TIMELINE_KEY = "contextTimeline";
function createTimelineUnit(config, slim) {
	const bounds = resolveBounds(config);
	return {
		key: TIMELINE_KEY,
		stateSchema: timelineStateSchema,
		init: () => emptyTimeline(),
		apply: (state, event) => reduceTimeline(state, event, bounds),
		wire: {
			viewSchema: timelineViewSchema,
			view: (state) => slim() ? splitHeadOf(state) : inlineOf(state, bounds)
		},
		stateVersion: 29
	};
}
//#endregion
//#region src/host/plugin.ts
const name = "dsh-cost-breakdown";
const inject = ["sessionProjections"];
function registerUnit(ctx, definition) {
	ctx.sessionProjections?.register(definition);
}
function apply(ctx, config) {
	watchBalanceChannel(ctx);
	watchCreditsChannel(ctx);
	watchSkillsChannel(ctx);
	const release = probeHarnessRelease(ctx);
	if (release !== void 0 && !meetsBaseline(release)) {
		registerUnit(ctx, createDegradedTimeline(release));
		registerUnit(ctx, createDegradedHeaders());
		registerUnit(ctx, createDegradedActivity());
		return;
	}
	const attribution = createToolAttribution(ctx);
	watchInboxIdentity(ctx);
	const coldReads = makeColdReadGate();
	const bounds = resolveBounds(config);
	const channel = watchDetailChannel(ctx, bounds, coldReads);
	registerUnit(ctx, createTimelineUnit(config, () => channel.live));
	registerUnit(ctx, createHeadersUnit((toolName) => attribution.ownerOf(toolName)));
	registerUnit(ctx, createActivityUnit(bounds.holidays));
	watchActivityBackfill(ctx, coldReads);
}
//#endregion
export { Config, apply, inject, name };
