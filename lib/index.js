/**
 * dsh-cost-breakdown v0.0.1
 * DSH 费用与上下文洞察：整账号 token/费用统计 + 上下文组成，官方人民币峰谷计价（含法定节假日），输入框下方常驻费用读数。
 * @author liaimei
 * @license Apache-2.0
 * @homepage https://github.com/liaimei/dsh-cost-breakdown
 * @built 2026-10-12T13:55:27+08:00
 * @commit 931e30b824b1 (dirty working tree) on main
 * @commit-date 2026-10-12T13:47:12+08:00
 */

import { createRequire } from "node:module";
import { z } from "zod";
import { deriveEventMessage, interruptedTurnClosers } from "@deepseek-ai/dsh-session";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import z$1 from "@deepseek-ai/schemastery";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { randomUUID } from "node:crypto";
//#region src/shared/estimate.ts
const CHARS_PER_TOKEN$1 = 4;
const ROLE_OVERHEAD$1 = 4;
function estimateSystemTokens(text) {
	if (typeof text !== "string" || text.length === 0) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN$1) + ROLE_OVERHEAD$1;
}
function estimateSystemContent(blocks) {
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
	return Math.ceil(characters / CHARS_PER_TOKEN$1) + ROLE_OVERHEAD$1;
}
//#endregion
//#region src/shared/imageTokens.ts
const PATCH_SIZE = 14;
const DOWNSAMPLE_RATIO = 3;
const MAX_WH_RATIO = 8;
const MIN_PIXELS = 147456;
const floorDiv = (a, b) => Math.floor(a / b);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
function gridTokens(rows, cols) {
	let n = rows * (cols + 1) + 2;
	if (rows % 2 === 1) n += cols + 1;
	n += ceilDiv(rows, 2) * (cols + 1) % 2 * 2;
	return n;
}
function solveResizeRatio(height, width, budget) {
	const ratio = height / width;
	const gridW = Math.sqrt((budget - 2) / ratio + .25) - .5;
	const gridH = gridW * ratio;
	const unit = 42;
	let bestHeight;
	let bestWidth;
	if (gridW < 1) {
		let rows = floorDiv(budget - 2, 2);
		if (rows % 2 === 1) rows -= 1;
		bestWidth = unit;
		bestHeight = rows * unit;
	} else if (gridH < 2) {
		const cols = floorDiv(budget - 2, 2) - 1;
		if (cols <= 1) throw new Error("image tokens: budget too small to solve");
		bestHeight = 84;
		bestWidth = cols * unit;
	} else {
		const cols = Math.trunc(gridW);
		let rows = Math.trunc(gridH);
		if (rows % 2 === 1) rows -= 1;
		const scale = Math.min(cols * unit / width, rows * unit / height);
		bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE;
		bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE;
	}
	const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	return {
		nLlmH,
		nLlmW,
		bestHeight,
		bestWidth,
		numTokens: gridTokens(nLlmH, nLlmW)
	};
}
function safeResize(height, width, paddedHeight, paddedWidth) {
	const nLlmH = ceilDiv(floorDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const nLlmW = ceilDiv(floorDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO);
	const pad = 3;
	const budget = 381;
	let result = {
		nLlmH,
		nLlmW,
		bestHeight: paddedHeight,
		bestWidth: paddedWidth,
		numTokens: gridTokens(nLlmH, nLlmW)
	};
	if (result.numTokens > budget) {
		result = solveResizeRatio(height, width, budget);
		let nextBudget = budget;
		while (result.numTokens > budget) {
			nextBudget -= 1;
			result = solveResizeRatio(height, width, nextBudget);
		}
	}
	result.numTokens += pad;
	return result;
}
function calcResizeInner(width, height) {
	let w = width;
	let h = height;
	if (w > h * MAX_WH_RATIO) w = h * MAX_WH_RATIO;
	const pixels = w * h;
	if (pixels < MIN_PIXELS && pixels > 0) {
		const scale = Math.sqrt(MIN_PIXELS / pixels);
		w = Math.trunc(w * scale);
		h = Math.trunc(h * scale);
	}
	const paddedWidth = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE;
	const paddedHeight = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE;
	return safeResize(h, w, paddedHeight, paddedWidth);
}
function estimateImageTokens(width, height) {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	try {
		let result = calcResizeInner(width, height);
		for (let i = 1; i < 10; i++) {
			const next = calcResizeInner(result.bestWidth, result.bestHeight);
			if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth && next.numTokens === result.numTokens) return result.numTokens;
			result = next;
		}
		return null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/host/pricing.ts
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
function estimateToolsTotal(tools) {
	return tools.length > 0 ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0;
}
function estimateBlocks(blocks) {
	let tokens = 0;
	if (!Array.isArray(blocks)) return 0;
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
				tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD;
				break;
			}
			default: tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
		}
	}
	return tokens;
}
function estimateMessage(message, emptyIsZero = false) {
	if (emptyIsZero && (message === null || message === void 0 || !Array.isArray(message.content) || message.content.length === 0)) return 0;
	return estimateBlocks(message?.content) + ROLE_OVERHEAD;
}
function estimateToolSchema(tool) {
	return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
function imageCountOf(blocks) {
	let count = 0;
	if (!Array.isArray(blocks)) return 0;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "image") count++;
		else if (Array.isArray(block.content)) count += imageCountOf(block.content);
	}
	return count;
}
function firstText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const b = item;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") return b.text.replace(/\s+/g, " ").trim().slice(0, 80);
	}
	return "";
}
function toolCallNames(blocks) {
	const names = [];
	if (!Array.isArray(blocks)) return names;
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const b = item;
		if (b.type === "tool-call" && typeof b.name === "string") names.push(b.name);
	}
	return names;
}
function injectionSourceName(source) {
	if (source?.kind === "agent-instructions" && Array.isArray(source.changes)) {
		const paths = [];
		for (const change of source.changes) {
			const path = change?.path;
			if (typeof path === "string" && path !== "" && !paths.includes(path)) paths.push(path);
		}
		if (paths.length > 0) return paths.join(", ");
	}
	const plugin = source?.plugin;
	if (typeof plugin === "string" && plugin !== "") return plugin;
	const kind = source?.kind;
	return typeof kind === "string" && kind !== "" ? kind : "";
}
function isInjection(source) {
	return source !== null && source !== void 0 && (typeof source.kind === "string" && source.kind !== "" && source.kind !== "user" || typeof source.form === "string");
}
//#endregion
//#region src/host/logShapes.ts
function isTokenChunk(chunk) {
	if (chunk === null || typeof chunk !== "object") return false;
	const c = chunk;
	switch (c.type) {
		case "text-delta":
		case "reasoning-delta": return typeof c.text === "string" && c.text !== "";
		case "tool-call-delta": return typeof c.argumentsDelta === "string" && c.argumentsDelta !== "" || c.name !== void 0;
		default: return false;
	}
}
function decodeKindOfBlock(blockType) {
	if (blockType === "reasoning") return "reasoning";
	if (blockType === "text") return "text";
	if (blockType === "tool-call") return "toolarg";
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
	if (!Array.isArray(stream) || !Number.isFinite(endTime)) return tally;
	let kind;
	let since = 0;
	for (const record of stream) {
		if (record === null || typeof record !== "object") continue;
		const r = record;
		if (r.type !== "chunk" || r.chunk === null || typeof r.chunk !== "object") continue;
		const chunk = r.chunk;
		if (chunk.type !== "block-start") continue;
		const time = r.time;
		if (typeof time !== "number" || !Number.isFinite(time)) continue;
		if (kind !== void 0) tally.spans[kind] += Math.max(0, time - since);
		kind = decodeKindOfBlock(chunk.blockType);
		if (kind !== void 0) tally.blocks[kind] += 1;
		since = time;
	}
	if (kind !== void 0) tally.spans[kind] += Math.max(0, endTime - since);
	return tally;
}
function decodeSpansOfStream(stream, endTime) {
	const spans = [];
	if (!Array.isArray(stream) || !Number.isFinite(endTime)) return spans;
	let kind;
	let since = 0;
	const close = (to) => {
		if (kind !== void 0 && to > since) spans.push({
			kind,
			start: since,
			end: to
		});
	};
	for (const record of stream) {
		if (record === null || typeof record !== "object") continue;
		const r = record;
		if (r.type !== "chunk" || r.chunk === null || typeof r.chunk !== "object") continue;
		const chunk = r.chunk;
		if (chunk.type !== "block-start") continue;
		const time = r.time;
		if (typeof time !== "number" || !Number.isFinite(time)) continue;
		close(time);
		kind = decodeKindOfBlock(chunk.blockType);
		since = time;
	}
	close(endTime);
	return spans;
}
function runFirstTokenTime(record) {
	const time0 = record.time0;
	if (typeof time0 !== "number" || !Number.isFinite(time0)) return void 0;
	if (record.type === "tool-call-chunks" && record.name !== void 0) return time0;
	const fragments = record.type === "tool-call-chunks" ? record.args : record.texts;
	if (!Array.isArray(fragments)) return void 0;
	const dt = Array.isArray(record.dt) ? record.dt : [];
	let time = time0;
	for (const [index, fragment] of fragments.entries()) {
		if (index > 0) {
			const step = dt[index - 1];
			if (typeof step !== "number" || !Number.isFinite(step)) return void 0;
			time += step;
		}
		if (typeof fragment === "string" && fragment !== "") return time;
	}
}
function firstTokenTimeOfStream(stream) {
	if (!Array.isArray(stream)) return void 0;
	for (const record of stream) {
		if (record === null || typeof record !== "object") continue;
		const r = record;
		if (r.type === "chunk") {
			const time = r.time;
			if (typeof time === "number" && Number.isFinite(time) && isTokenChunk(r.chunk)) return time;
			continue;
		}
		const time = runFirstTokenTime(r);
		if (time !== void 0) return time;
	}
}
function replaceRangeOf(surfaceOp) {
	if (surfaceOp === null || typeof surfaceOp !== "object") return null;
	const op = surfaceOp;
	if (op.op !== "replace") return null;
	const { startSeq: start, endSeq: end } = op;
	if (typeof start !== "number" || !Number.isFinite(start)) return null;
	if (typeof end !== "number" || !Number.isFinite(end)) return null;
	return {
		start,
		end
	};
}
//#endregion
//#region src/shared/fileOps.ts
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
function opBearingTool(tool) {
	return tool === "str_replace_editor" || kindOfTool(tool) !== null;
}
function rawArgsNeeded(tool) {
	return opBearingTool(tool) || tool === "run_code";
}
function pathOfArgs(tool, args) {
	if (args === null) return null;
	if (tool === "grep" || tool === "glob") {
		const p = args.path;
		if (typeof p === "string" && p !== "") return p;
		const pattern = args.pattern;
		return typeof pattern === "string" && pattern !== "" ? pattern : null;
	}
	for (const k of [
		"file_path",
		"filePath",
		"path"
	]) {
		const v = args[k];
		if (typeof v === "string" && v !== "") return v;
	}
	return null;
}
function linesOf(s) {
	if (s === "") return 0;
	let n = 0;
	for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
	return s.endsWith("\n") ? n : n + 1;
}
function pairOf(added, removed) {
	return {
		added: typeof added === "string" ? linesOf(added) : 0,
		removed: typeof removed === "string" ? linesOf(removed) : 0
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
	const m = meta;
	if (typeof m.path !== "string" || m.path === "") return null;
	if (typeof m.offset !== "number" || !Number.isFinite(m.offset) || m.offset < 1) return null;
	if (!Array.isArray(m.lines) || m.lines.length === 0) return null;
	return {
		start: m.offset,
		count: m.lines.length
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
	const win = readWindowOf(meta);
	if (win !== null) return {
		start: win.start,
		count: win.count
	};
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
	const m = meta;
	if (m.truncated !== false) return null;
	const files = [];
	if (m.shape === "matches" && Array.isArray(m.files)) for (const f of m.files) {
		if (f === null || typeof f !== "object") continue;
		const group = f;
		if (typeof group.path === "string" && group.path !== "" && Array.isArray(group.matches)) files.push({
			path: group.path,
			hits: group.matches.length
		});
	}
	else if (m.shape === "paths" && Array.isArray(m.paths)) {
		for (const p of m.paths) if (typeof p === "string" && p !== "") files.push({
			path: p,
			hits: 0
		});
	}
	return files.length > 0 ? files : null;
}
function opsOfCall(input) {
	const args = opBearingTool(input.tool) ? parseCallArgs(input.argsRaw) : null;
	const kind = kindOfCall(input.tool, args);
	if (kind === null) return [];
	const stamp = {
		seq: input.seq,
		kind,
		tool: input.tool,
		err: input.err === true,
		added: 0,
		removed: 0,
		path: "",
		...input.time !== void 0 ? { time: input.time } : {},
		...input.gone !== void 0 ? { gone: input.gone } : {},
		...input.parent !== void 0 ? { parent: input.parent } : {},
		...input.program !== void 0 ? { program: input.program } : {}
	};
	if (kind === "search") {
		const files = searchFilesOf(input.meta);
		if (files !== null) {
			const detail = searchDetailOf(args);
			const target = args !== null ? pathOfArgs(input.tool, args) : null;
			const narrowed = args !== null && typeof args.path === "string" && args.path !== "";
			return [...target !== null && !files.some((f) => f.path === target) ? [{
				...stamp,
				path: target,
				...narrowed && detail !== void 0 ? { detail } : {},
				...narrowed ? {} : { pattern: true }
			}] : [], ...files.map((f) => ({
				...stamp,
				path: f.path,
				...detail !== void 0 ? { detail } : {},
				...f.hits > 0 ? { hits: f.hits } : {}
			}))];
		}
	}
	if (args === null) return [];
	const path = pathOfArgs(input.tool, args);
	if (path === null) return [];
	const { added, removed } = deltaOf(input.tool, args);
	const narrowed = typeof args.path === "string" && args.path !== "";
	const detail = kind === "search" && narrowed ? searchDetailOf(args) : void 0;
	const read = kind === "read" ? readOf(input.meta, args) : void 0;
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
//#region src/host/foldState.ts
function trimToLastTurns(requests, maxTurns) {
	let runs = 0;
	let start = requests.length;
	let prevTurn;
	for (let i = requests.length - 1; i >= 0; i--) {
		const turn = requests[i].turn;
		if (turn !== prevTurn) {
			if (runs >= maxTurns) break;
			runs++;
			prevTurn = turn;
		}
		start = i;
	}
	return requests.slice(start);
}
function countTurnRuns(requests) {
	let runs = 0;
	let prevTurn;
	for (const r of requests) if (r.turn !== prevTurn) {
		runs++;
		prevTurn = r.turn;
	}
	return runs;
}
function trimState(st, bounds) {
	st.turnRuns = st.turnRuns ?? countTurnRuns(st.requests);
	if (st.turnRuns > bounds.maxKeptTurns) {
		st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns);
		st.turnRuns = countTurnRuns(st.requests);
	}
	if (st.requests.length > bounds.maxRequestSteps) {
		st.requests = st.requests.slice(-bounds.maxRequestSteps);
		st.turnRuns = countTurnRuns(st.requests);
	}
	if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents);
	if (st.spans.length > TIMING_SPANS_MAX) st.spans = st.spans.slice(-TIMING_SPANS_MAX);
	if (st.fileOps.length > bounds.maxFileOps) {
		const drop = st.fileOps.length - bounds.maxFileOps;
		st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq);
		st.fileOps = st.fileOps.slice(drop);
	}
	if (st.archived.length > 0) {
		let drop = 0;
		const oldestReq = st.requests.length > 0 ? st.requests[0].seq : void 0;
		if (oldestReq !== void 0) while (drop < st.archived.length && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++;
		if (st.archived.length - drop > bounds.maxArchiveNodes) drop = st.archived.length - bounds.maxArchiveNodes;
		if (drop > 0) {
			const floor = st.archived[drop - 1].gone;
			if (floor !== void 0) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor);
			st.archived = st.archived.slice(drop);
		}
	}
}
const TIMING_SPANS_MAX = 2e3;
function createTimelineState() {
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
//#endregion
//#region src/shared/officialRates.ts
const OFFICIAL_MODELS = [{
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
function beijingParts(time) {
	const shifted = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS);
	const month = shifted.getUTCMonth() + 1;
	const day = shifted.getUTCDate();
	const year = shifted.getUTCFullYear();
	return {
		year,
		month,
		day,
		hour: shifted.getUTCHours(),
		weekday: shifted.getUTCDay(),
		date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
	};
}
function isPeakBeijing(time, holidays = DEFAULT_HOLIDAYS) {
	const parts = beijingParts(time);
	if (parts.weekday === 0 || parts.weekday === 6) return false;
	if (holidays.includes(parts.date)) return false;
	return PEAK_WINDOWS.some(([from, to]) => parts.hour >= from && parts.hour < to);
}
function matchOfficialModel(model) {
	const name = typeof model === "string" ? model.trim().toLowerCase() : "";
	if (name === "") return null;
	for (const row of OFFICIAL_MODELS) if (row.id === name || row.aliases.includes(name)) return row;
	return null;
}
function holidaysFrom(value) {
	if (!Array.isArray(value)) return void 0;
	const valid = value.filter((entry) => typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry));
	return valid.length > 0 ? valid : void 0;
}
//#endregion
//#region src/shared/providers.ts
const MODELS_DEV_PROVIDER_IDS = {
	"deepseek-official": "deepseek",
	"deepseek-account": "deepseek",
	"kimi-coding": "moonshotai",
	"minimax-cn": "minimax",
	"zai-coding-cn": "zhipuai"
};
function modelsDevProviderOf(dshProviderId) {
	return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId;
}
function isDeepSeekProvider(dshProviderId) {
	return modelsDevProviderOf(dshProviderId) === "deepseek";
}
function pricedByOfficialPeriod(dshProviderId, model) {
	return isDeepSeekProvider(dshProviderId) || matchOfficialModel(model) !== null;
}
//#endregion
//#region src/host/foldMetering.ts
function tokenCountOf(value) {
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
	}
	return null;
}
function isPeakAt(time, provider, holidays = DEFAULT_HOLIDAYS, model) {
	return !pricedByOfficialPeriod(provider, model) || isPeakBeijing(time, holidays);
}
function addBilledUsage(prev, provider, model, time, usage, holidays = DEFAULT_HOLIDAYS) {
	const period = isPeakAt(time, provider, holidays, model) ? "peak" : "off";
	const models = prev?.[provider] ?? {};
	const periods = models[model] ?? {};
	const b = periods[period] ?? {
		uncached: 0,
		cacheRead: 0,
		cacheWrite: 0,
		output: 0
	};
	const nextPeriods = { ...periods };
	nextPeriods[period] = {
		uncached: b.uncached + usage.uncached,
		cacheRead: b.cacheRead + usage.cacheRead,
		cacheWrite: b.cacheWrite + usage.cacheWrite,
		output: b.output + usage.output
	};
	const nextModels = {
		...models,
		[model]: nextPeriods
	};
	return {
		...prev ?? {},
		[provider]: nextModels
	};
}
function copyCostUsage(cost) {
	const copy = {};
	for (const provider in cost) {
		const models = {};
		for (const model in cost[provider]) {
			const periods = cost[provider][model];
			const modelCopy = {};
			if (periods.peak !== void 0) modelCopy.peak = { ...periods.peak };
			if (periods.off !== void 0) modelCopy.off = { ...periods.off };
			models[model] = modelCopy;
		}
		copy[provider] = models;
	}
	return copy;
}
function accumulateCost(st, time, usage, holidays = DEFAULT_HOLIDAYS, turn) {
	const model = st.model;
	if (model === void 0) return;
	const provider = st.provider ?? "";
	st.cost = addBilledUsage(st.cost, provider, model, time, usage, holidays);
	const callsFor = st.calls?.[provider] ?? {};
	st.calls = {
		...st.calls,
		[provider]: {
			...callsFor,
			[model]: (callsFor[model] ?? 0) + 1
		}
	};
	if (turn === void 0 || !Number.isFinite(turn)) return;
	const key = String(turn);
	const prev = st.turnCost?.[key];
	const models = prev?.requests[provider] ?? {};
	const count = models[model] ?? 0;
	st.turnCost = {
		...st.turnCost,
		[key]: {
			usage: addBilledUsage(prev?.usage, provider, model, time, usage, holidays),
			requests: {
				...prev?.requests,
				[provider]: {
					...models,
					[model]: count + 1
				}
			}
		}
	};
}
const TOOL_TIMING_CAP = 16;
const DECODE_KINDS = [
	"reasoning",
	"text",
	"toolarg"
];
function durOf(from, to) {
	if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
	return Math.max(0, to - from);
}
function ensureTiming(st) {
	if (st.timing === void 0) st.timing = {
		wallMs: 0,
		ttftMs: 0,
		genMs: 0,
		calls: 0,
		toolsMs: 0,
		toolCalls: 0,
		tools: {}
	};
	return st.timing;
}
const DECODE_FIELDS = {
	reasoning: {
		ms: "reasoningMs",
		n: "reasoningBlocks"
	},
	text: {
		ms: "textMs",
		n: "textBlocks"
	},
	toolarg: {
		ms: "toolArgMs",
		n: "toolArgBlocks"
	}
};
function addDecode(timing, kind, ms, blocks) {
	const field = DECODE_FIELDS[kind];
	if (ms > 0) timing[field.ms] = (timing[field.ms] ?? 0) + ms;
	if (blocks > 0) timing[field.n] = (timing[field.n] ?? 0) + blocks;
}
function bumpToolTotals(timing, name, ms) {
	if (name === "__proto__") return;
	if (!Object.hasOwn(timing.tools, name)) {
		if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
			let minKey = "";
			let minMs = Infinity;
			for (const k in timing.tools) if (timing.tools[k].ms < minMs) {
				minMs = timing.tools[k].ms;
				minKey = k;
			}
			const kept = {};
			for (const k in timing.tools) if (k !== minKey) kept[k] = timing.tools[k];
			timing.tools = kept;
		}
		timing.tools[name] = {
			calls: 1,
			ms
		};
		return;
	}
	const cur = timing.tools[name];
	timing.tools[name] = {
		calls: cur.calls + 1,
		ms: cur.ms + ms
	};
}
//#endregion
//#region src/shared/creditRates.ts
const CREDIT_AMOUNT = /^\s*x?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?\s*$/i;
function creditAmountOf(text) {
	if (typeof text === "number") return Number.isFinite(text) && text >= 0 ? text : null;
	if (typeof text !== "string") return null;
	const m = CREDIT_AMOUNT.exec(text);
	if (m === null) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) && n >= 0 ? n : null;
}
function creditRatesOf(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const out = {};
	const put = (provider, model, n) => {
		if (provider === "" || model === "") return;
		const models = out[provider] ?? {};
		models[model] = n;
		out[provider] = models;
	};
	const amount = (raw) => typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
	for (const [key, raw] of Object.entries(value)) {
		const at = key.indexOf(":");
		if (at > 0) {
			const n = amount(raw);
			if (n !== null) put(key.slice(0, at).trim().toLowerCase(), key.slice(at + 1).trim().toLowerCase(), n);
			continue;
		}
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
		const provider = key.trim().toLowerCase();
		for (const [model, inner] of Object.entries(raw)) {
			const n = amount(inner);
			if (n !== null) put(provider, model.trim().toLowerCase(), n);
		}
	}
	return Object.keys(out).length > 0 ? out : null;
}
//#endregion
//#region src/host/creditRates.ts
const CATALOG_FORMAT_VERSION = 1;
const CATALOGS = [{
	file: ".workbuddy-catalog.json",
	provider: "workbuddy"
}, {
	file: ".workbuddy-ai-catalog.json",
	provider: "workbuddy-ai"
}];
const CACHE_MS$1 = 3e4;
function dshHome() {
	const env = process.env.DSH_HOME;
	return env !== void 0 && env !== "" ? env : join(homedir(), ".dsh");
}
function creditRatesFromCatalog(value, provider = "workbuddy") {
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
let cached$1 = null;
function platformCreditRates(now = Date.now()) {
	if (cached$1 !== null && now - cached$1.at < CACHE_MS$1) return cached$1.value;
	const out = {};
	for (const { file, provider } of CATALOGS) try {
		const text = readFileSync(join(dshHome(), file), "utf8");
		const one = creditRatesFromCatalog(JSON.parse(text), provider);
		if (one !== null) out[provider] = one[provider];
	} catch {}
	const value = Object.keys(out).length > 0 ? out : null;
	cached$1 = {
		at: now,
		value
	};
	return value;
}
function creditRatesForWire() {
	return creditRatesOf(platformCreditRates()) ?? void 0;
}
//#endregion
//#region src/host/foldWire.ts
function headFieldsOf(state) {
	const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool;
	const result = {
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
		images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
		toolCalls: state.surface.reduce((n, node) => node.cat === "tool" || node.cat === "skill" && node.tool !== void 0 ? n + 1 : n, 0),
		humanInputs: state.humanInputs ?? 0,
		answers: state.answers ?? 0,
		...state.lastUser !== void 0 ? { lastUser: state.lastUser } : {},
		requests: [],
		events: [],
		nodes: [],
		droppedNodes: 0,
		archive: []
	};
	if (state.cost !== void 0) result.cost = copyCostUsage(state.cost);
	if (state.calls !== void 0) {
		const calls = {};
		for (const pv in state.calls) calls[pv] = { ...state.calls[pv] };
		result.calls = calls;
	}
	if (state.turnCost !== void 0) {
		const perTurn = {};
		for (const turn in state.turnCost) {
			const entry = state.turnCost[turn];
			const requests = {};
			for (const pv in entry.requests) requests[pv] = { ...entry.requests[pv] };
			perTurn[turn] = {
				usage: copyCostUsage(entry.usage),
				requests
			};
		}
		result.turnCost = perTurn;
	}
	{
		const credits = creditRatesForWire();
		if (credits !== void 0) result.creditRates = credits;
	}
	if (state.timing !== void 0) {
		const tools = {};
		for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] };
		result.timing = {
			...state.timing,
			tools
		};
	}
	if (state.systems !== void 0 && state.systems.length > 0) result.systems = state.systems.map((n) => ({ ...n }));
	return result;
}
function detailCollectionsOf(state, bounds) {
	const result = {
		requests: state.requests.map((r) => ({ ...r })),
		events: state.events.map((e) => ({ ...e })),
		nodes: [],
		droppedNodes: 0,
		archive: state.archived.map((n) => ({ ...n })),
		fileOps: state.fileOps.map((o) => ({ ...o })),
		...state.fileOpsFloor !== void 0 ? { fileOpsFloor: state.fileOpsFloor } : {},
		spans: state.spans.map((s) => ({ ...s }))
	};
	const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes);
	const overflow = state.surface.slice(0, overflowCount);
	const tail = state.surface.slice(overflowCount);
	const pinned = overflow.filter((n) => n.cat === "inject" || n.cat === "skill");
	result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail;
	result.droppedNodes = overflowCount - pinned.length;
	if (result.droppedNodes > 0) {
		let floor = 0;
		for (const n of overflow) if (n.cat !== "inject" && n.cat !== "skill") floor = Math.max(floor, n.seq);
		result.surfaceFloor = floor;
	}
	if (state.archiveFloor !== void 0) result.archiveFloor = state.archiveFloor;
	const requests = result.requests;
	const events = result.events;
	let ri = 0;
	for (const ev of events) {
		while (ri < requests.length && requests[ri].seq <= ev.seq) ri++;
		const next = requests.at(ri);
		const prev = ri > 0 ? requests.at(ri - 1) : void 0;
		if (next !== void 0 && typeof next.turn === "number" && typeof next.step === "number") {
			ev.turn = next.turn;
			ev.step = next.step;
		}
		if (prev !== void 0 && typeof prev.turn === "number" && typeof prev.step === "number") {
			ev.fromTurn = prev.turn;
			ev.fromStep = prev.step;
		}
	}
	return result;
}
function buildTimelineHead(state) {
	const result = headFieldsOf(state);
	const turns = new Set();
	for (const r of state.requests) turns.add(r.turn ?? 0);
	let injects = 0;
	let compactions = 0;
	let prunes = 0;
	const skills = new Set();
	for (const e of state.events) {
		if (e.kind === "inject") injects++;
		else if (e.kind === "compaction") compactions++;
		else if (e.kind === "prune") prunes++;
		if (e.sub === "skill" && typeof e.name === "string" && e.name !== "") skills.add(e.name);
	}
	result.counts = {
		turns: turns.size,
		steps: state.requests.length,
		injects,
		compactions,
		prunes,
		skills: skills.size
	};
	const last = state.requests.at(-1);
	if (last !== void 0) result.last = {
		seq: last.seq,
		total: last.total,
		...typeof last.prompt === "number" ? { prompt: last.prompt } : {}
	};
	result.detailRev = state.detailRev ?? 0;
	return result;
}
function buildTimelineDetail(state, bounds) {
	return {
		rev: state.detailRev ?? 0,
		head: buildTimelineHead(state),
		...detailCollectionsOf(state, bounds)
	};
}
function buildTimelineView(state, bounds) {
	return {
		...headFieldsOf(state),
		...detailCollectionsOf(state, bounds)
	};
}
//#endregion
//#region src/host/fold.ts
function categoryOf(type, message) {
	if (type === "assistant/message") return "assistant";
	if (type === "tool/result") return "tool";
	if (type === "developer/message") return "inject";
	const kind = message?.source?.kind;
	if (kind === "skill-invocation" || kind === "skill-catalog") return "skill";
	if (isInjection(message?.source)) return "inject";
	return "user";
}
function bumpDetailRev(st) {
	st.detailRev = (st.detailRev ?? 0) + 1;
}
const SYSTEM_NODES_MAX = 8;
function systemTokensOf(systems) {
	for (let i = systems.length - 1; i >= 0; i--) if (systems[i].tokens > 0) return systems[i].tokens;
	return 0;
}
function pushSystem(st, node) {
	const systems = [...st.systems ?? [], node];
	st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-8) : systems;
	st.systemTokens = systemTokensOf(st.systems);
}
const PENDING_CODE_OPS_MAX = 200;
function argsRawOf(value) {
	if (typeof value === "string") return value;
	if (value === void 0 || value === null) return void 0;
	try {
		return JSON.stringify(value);
	} catch {
		return;
	}
}
function pushFileOps(st, ops) {
	for (const op of ops) st.fileOps.push(op);
}
function bufferCodeOps(st, rootCallId, ops) {
	const pending = st.pendingCodeOps ?? {};
	let total = 0;
	for (const k in pending) total += pending[k].length;
	if (total + ops.length > PENDING_CODE_OPS_MAX) return;
	st.pendingCodeOps = {
		...pending,
		[rootCallId]: [...pending[rootCallId] ?? [], ...ops]
	};
}
function archiveRemoved(st, removed, goneSeq) {
	for (const n of removed) st.archived.push({
		...n,
		gone: goneSeq
	});
}
function removeSurfaceSeqs(st, claimed, goneSeq) {
	if (claimed.size === 0) return [];
	const kept = [];
	const removed = [];
	for (const n of st.surface) if (claimed.has(n.seq)) {
		st.sums[n.cat] -= n.tokens;
		removed.push(n);
	} else kept.push(n);
	archiveRemoved(st, removed, goneSeq);
	st.surface = kept;
	return removed;
}
function messageOf$1(data) {
	const message = data?.message;
	return message !== null && typeof message === "object" ? message : null;
}
function firstFullText(blocks) {
	if (!Array.isArray(blocks)) return "";
	for (const item of blocks) {
		if (item === null || typeof item !== "object") continue;
		const block = item;
		if (block.type === "text" && typeof block.text === "string" && block.text !== "") return block.text;
	}
	return "";
}
function skillNameOf(msg) {
	const match = firstFullText(msg !== null && typeof msg === "object" ? msg.content : void 0).match(/<skill_content\s+name="([^"]+)"/);
	return match === null ? "" : match[1];
}
function applySurface(st, ev, type, message) {
	const cat = categoryOf(type, message ?? void 0);
	const node = {
		seq: ev.seq,
		time: ev.time,
		cat,
		tokens: estimateMessage(message, type === "assistant/message" || type === "developer/message")
	};
	const imgs = imageCountOf(message?.content);
	if (imgs > 0) node.imgs = imgs;
	const source = message?.source;
	const form = source?.form;
	if (typeof form === "string") node.form = form;
	if (type === "assistant/message") {
		const text = firstText(message?.content);
		if (text !== "") node.text = text;
		else {
			const names = toolCallNames(message?.content);
			if (names.length > 0) node.calls = names.slice(0, 3);
		}
	} else if (type === "tool/result") {
		const srcId = source?.callId;
		const toolEntry = typeof srcId === "string" ? st.callNames[srcId] : void 0;
		if (toolEntry !== void 0) {
			node.tool = toolEntry.name;
			const timing = ensureTiming(st);
			const dur = durOf(toolEntry.start, ev.time);
			timing.toolsMs += dur;
			timing.toolCalls += 1;
			bumpToolTotals(timing, toolEntry.name, dur);
			if (st.stepStart !== void 0) st.stepSpans = [...st.stepSpans ?? [], {
				kind: "tools",
				start: toolEntry.start,
				end: ev.time
			}];
		}
		if (typeof srcId === "string") {
			const kept = {};
			for (const k in st.callNames) if (k !== srcId) kept[k] = st.callNames[k];
			st.callNames = kept;
		}
		if (message?.isError === true) node.err = true;
	} else if (source?.kind === "skill-invocation") node.skill = typeof source.name === "string" ? source.name : "?";
	else if (source?.kind === "plugin") {
		if (source.form === "notice" && typeof source.summary === "string") node.text = source.summary;
		else if (source.form === "snapshot" && Array.isArray(source.sections)) node.text = source.sections.map((s) => s?.name).filter(Boolean).join(", ").slice(0, 80);
		else {
			const ptext = firstText(message?.content);
			if (ptext !== "") node.text = ptext;
		}
	} else {
		const utext = firstText(message?.content);
		if (utext !== "") node.text = utext;
	}
	const shadowedSeqs = st.pendingShadowedSeqs;
	const shadowEventSeq = st.pendingShadowEventSeq;
	delete st.pendingShadowedSeqs;
	delete st.pendingShadowEventSeq;
	const op = replaceRangeOf(ev.surfaceOp);
	if (op !== null) {
		if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
			const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq);
			st.sums[cat] += node.tokens;
			st.surface.push(node);
			if (shadowEventSeq !== void 0) {
				const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0);
				const i = st.events.findIndex((e) => e.seq === shadowEventSeq);
				if (i >= 0) st.events[i] = {
					...st.events[i],
					tokens: Math.max(0, removedSum - node.tokens)
				};
			}
			return node;
		}
		let si = -1;
		let ei = -1;
		for (let i = 0; i < st.surface.length; i++) {
			if (si < 0 && st.surface[i].seq === op.start) si = i;
			if (st.surface[i].seq === op.end) {
				ei = i;
				break;
			}
		}
		if (si >= 0 && ei >= si) {
			const removed = st.surface.splice(si, ei - si + 1, node);
			archiveRemoved(st, removed, ev.seq);
			for (const r of removed) st.sums[r.cat] -= r.tokens;
			st.sums[cat] += node.tokens;
			return node;
		}
	}
	st.surface.push(node);
	st.sums[cat] += node.tokens;
	return node;
}
const ASK_USER_TOOL = "ask_user_question";
const CLONE_ALL = [
	"surface",
	"sums",
	"requests",
	"events",
	"archived",
	"callNames",
	"fileOps",
	"timing"
];
function applyTimeline(state, event, bounds) {
	let st;
	const ensure = (keys = CLONE_ALL) => {
		st = { ...state };
		for (const key of keys) if (key === "surface") st.surface = [...state.surface];
		else if (key === "sums") st.sums = { ...state.sums };
		else if (key === "requests") st.requests = [...state.requests];
		else if (key === "events") st.events = [...state.events];
		else if (key === "archived") st.archived = [...state.archived];
		else if (key === "callNames") st.callNames = { ...state.callNames };
		else if (key === "fileOps") st.fileOps = [...state.fileOps];
		else if (state.timing !== void 0) st.timing = {
			...state.timing,
			tools: { ...state.timing.tools }
		};
		return st;
	};
	const data = event.data;
	try {
		switch (event.type) {
			case "request/header": {
				const header = data?.header ?? {};
				const tools = Array.isArray(header.tools) ? header.tools : [];
				const s = ensure(["events"]);
				s.toolsTokens = estimateToolsTotal(tools);
				if (header.config && typeof header.config.model === "string") s.model = header.config.model;
				if (header.config && typeof header.config.provider === "string") s.provider = header.config.provider;
				if ((data?.reason === "change" || data?.reason === "resume") && s.model && s.lastModel && s.model !== s.lastModel) {
					s.events.push({
						seq: event.seq,
						time: event.time,
						kind: "model",
						from: s.lastModel,
						to: s.model
					});
					bumpDetailRev(s);
				}
				if (s.model) s.lastModel = s.model;
				break;
			}
			case "system/message": {
				const s = ensure([
					"surface",
					"sums",
					"archived"
				]);
				delete s.pendingShadowedSeqs;
				delete s.pendingShadowEventSeq;
				const op = replaceRangeOf(event.surfaceOp);
				if (op !== null) {
					s.systems = (s.systems ?? []).filter((n) => n.seq < op.start || n.seq > op.end);
					const claimed = new Set();
					for (const n of s.surface) if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq);
					if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s);
				}
				pushSystem(s, {
					seq: event.seq,
					time: event.time,
					tokens: estimateSystemContent(messageOf$1(data)?.content)
				});
				break;
			}
			case "request/context": {
				const s = ensure([]);
				if (data && typeof data.contextWindow === "number") s.contextWindow = data.contextWindow;
				if (data && typeof data.model === "string") s.model = data.model;
				if (data && typeof data.provider === "string") s.provider = data.provider;
				break;
			}
			case "tool/call":
				if (data && typeof data.callId === "string" && typeof data.name === "string") {
					const s = ensure(["callNames"]);
					const argsRaw = rawArgsNeeded(data.name) ? argsRawOf(data.arguments) : void 0;
					s.callNames[data.callId] = {
						name: data.name,
						start: event.time,
						...argsRaw !== void 0 ? { argsRaw } : {}
					};
				}
				break;
			case "tool/ptc-dispatch": {
				const rootCallId = data?.rootCallId;
				const name = data?.name;
				if (typeof rootCallId === "string" && typeof name === "string") {
					const argsRaw = opBearingTool(name) ? argsRawOf(data?.arguments) : void 0;
					const ops = opsOfCall({
						seq: event.seq,
						time: event.time,
						tool: name,
						argsRaw,
						err: data?.isError === true
					});
					if (ops.length > 0) bufferCodeOps(ensure([]), rootCallId, ops);
				}
				break;
			}
			case "assistant/attempt": {
				const start = state.stepStart;
				if (start === void 0 || start.firstToken !== void 0) return state;
				const first = firstTokenTimeOfStream(data?.stream);
				if (first === void 0) return state;
				const s = ensure([]);
				s.stepStart = {
					time: start.time,
					firstToken: first
				};
				break;
			}
			case "step/start": {
				const s = ensure([]);
				s.stepStart = { time: event.time };
				delete s.stepSpans;
				delete s.stepWaits;
				delete s.stepApprovals;
				delete s.stepRequestSeq;
				break;
			}
			case "step/end": {
				const start = state.stepStart;
				if (start === void 0) return state;
				const s = ensure(state.stepRequestSeq !== void 0 ? ["timing", "requests"] : ["timing"]);
				ensureTiming(s).wallMs += durOf(start.time, event.time);
				const waits = [...state.stepWaits ?? []];
				for (const id in state.stepApprovals) waits.push({
					start: state.stepApprovals[id],
					end: event.time
				});
				waits.sort((a, b) => a.start - b.start || a.end - b.end);
				let waitMs = 0;
				let waitCursor = start.time;
				for (const wait of waits) {
					const from = Math.max(waitCursor, wait.start);
					const to = Math.min(wait.end, event.time);
					if (to > from) {
						waitMs += to - from;
						waitCursor = to;
					}
				}
				const activeMs = durOf(start.time, event.time) - waitMs;
				const last = state.requests.at(-1);
				if (last !== void 0 && last.seq === state.stepRequestSeq) s.requests[s.requests.length - 1] = {
					...last,
					activeMs
				};
				const painted = [];
				for (const span of state.stepSpans ?? []) {
					const from = Math.max(start.time, span.start);
					const to = Math.min(event.time, span.end);
					if (to > from) painted.push({
						kind: span.kind,
						start: from,
						end: to
					});
				}
				painted.sort((a, b) => a.start - b.start || a.end - b.end);
				const flushed = [];
				let cursor = start.time;
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
				if (event.time > cursor) flushed.push({
					kind: "other",
					start: cursor,
					end: event.time
				});
				s.spans = [...state.spans, ...flushed];
				delete s.stepStart;
				delete s.stepSpans;
				delete s.stepWaits;
				delete s.stepApprovals;
				delete s.stepRequestSeq;
				bumpDetailRev(s);
				break;
			}
			case "approval/asked": {
				const id = data?.id;
				if (state.stepStart === void 0 || typeof id !== "string") return state;
				const s = ensure([]);
				s.stepApprovals = {
					...state.stepApprovals,
					[id]: event.time
				};
				break;
			}
			case "approval/decided": {
				const id = data?.id;
				const open = state.stepApprovals;
				const askedAt = typeof id === "string" ? open?.[id] : void 0;
				if (open === void 0 || askedAt === void 0) return state;
				const s = ensure([]);
				s.stepWaits = [...state.stepWaits ?? [], {
					start: askedAt,
					end: event.time
				}];
				const kept = {};
				for (const k in open) if (k !== id) kept[k] = open[k];
				if (Object.keys(kept).length > 0) s.stepApprovals = kept;
				else delete s.stepApprovals;
				break;
			}
			case "user/message":
			case "developer/message": {
				const developer = event.type === "developer/message";
				const msg = developer ? messageOf$1(data) : deriveEventMessage(event);
				if (developer && (msg === null || !Array.isArray(msg.content))) return state;
				const s = ensure([
					"surface",
					"sums",
					"archived",
					"events"
				]);
				bumpDetailRev(s);
				const node = applySurface(s, event, event.type, msg);
				const source = msg?.source;
				if (developer || isInjection(source)) {
					const rec = {
						seq: event.seq,
						time: event.time,
						kind: "inject",
						form: typeof source?.form === "string" && source.form !== "" ? source.form : "context",
						tokens: node.tokens
					};
					if (source?.kind === "skill-invocation") {
						rec.sub = "skill";
						rec.name = typeof source.name === "string" ? source.name : "?";
					} else {
						const label = injectionSourceName(source);
						if (label !== "") {
							rec.name = label;
							node.name = label;
						}
						if (source?.form === "notice" && typeof source.summary === "string" && source.summary !== "") rec.detail = source.summary;
					}
					s.events.push(rec);
				} else {
					s.humanInputs = (s.humanInputs ?? 0) + 1;
					if (node.text !== void 0 && node.text !== "") s.lastUser = node.text;
				}
				break;
			}
			case "tool/result": {
				const toolMsg = deriveEventMessage(event);
				const srcId = (toolMsg?.source)?.callId;
				const pendingEntry = typeof srcId === "string" ? state.callNames[srcId] : void 0;
				const buffered = typeof srcId === "string" ? state.pendingCodeOps?.[srcId] : void 0;
				const s = ensure([
					"surface",
					"sums",
					"archived",
					"events",
					"fileOps",
					"timing"
				]);
				bumpDetailRev(s);
				const node = applySurface(s, event, event.type, toolMsg);
				if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1;
				if (pendingEntry !== void 0 && pendingEntry.name === ASK_USER_TOOL && state.stepStart !== void 0) s.stepWaits = [...state.stepWaits ?? [], {
					start: pendingEntry.start,
					end: event.time
				}];
				if (pendingEntry !== void 0) pushFileOps(s, opsOfCall({
					seq: event.seq,
					time: event.time,
					tool: pendingEntry.name,
					argsRaw: pendingEntry.argsRaw,
					meta: data?.meta,
					err: toolMsg?.isError === true
				}));
				if (buffered !== void 0 && buffered.length > 0) {
					const program = parseCallArgs(pendingEntry?.argsRaw)?.description;
					pushFileOps(s, buffered.map((op) => ({
						...op,
						parent: event.seq,
						...typeof program === "string" && program !== "" ? { program } : {}
					})));
					const kept = {};
					for (const k in s.pendingCodeOps) if (k !== srcId) kept[k] = s.pendingCodeOps[k];
					if (Object.keys(kept).length > 0) s.pendingCodeOps = kept;
					else delete s.pendingCodeOps;
				}
				if (node.tool === "skill" || node.tool === void 0) {
					const name = skillNameOf(toolMsg);
					if (name !== "") {
						node.skill = name;
						if (node.tool === void 0) node.tool = "skill";
						s.sums.tool -= node.tokens;
						node.cat = "skill";
						s.sums.skill += node.tokens;
						s.events.push({
							seq: event.seq,
							time: event.time,
							kind: "inject",
							form: "instructions",
							sub: "skill",
							name,
							tokens: node.tokens
						});
					}
				}
				break;
			}
			case "assistant/message": {
				const usage = data?.usage;
				const s = ensure([
					"surface",
					"sums",
					"archived",
					"events",
					"requests",
					"timing"
				]);
				bumpDetailRev(s);
				const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool;
				const record = {
					time: event.time,
					seq: event.seq,
					system: s.systemTokens,
					tools: s.toolsTokens,
					user: s.sums.user,
					inject: s.sums.inject,
					skill: s.sums.skill,
					assistant: s.sums.assistant,
					tool: s.sums.tool,
					total
				};
				if (data && typeof data.turn === "number") record.turn = data.turn;
				if (data && typeof data.step === "number") record.step = data.step;
				if (state.stepStart !== void 0) s.stepRequestSeq = record.seq;
				let output = null;
				if (usage !== null && typeof usage === "object") {
					const input = tokenCountOf(usage.inputTokens);
					const cacheRead = tokenCountOf(usage.cacheReadTokens);
					const cacheWrite = tokenCountOf(usage.cacheWriteTokens);
					output = tokenCountOf(usage.outputTokens);
					if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
						record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
						if (cacheRead !== null) record.cacheRead = cacheRead;
						if (output !== null) record.output = output;
						accumulateCost(s, event.time, {
							uncached: input ?? 0,
							cacheRead: cacheRead ?? 0,
							cacheWrite: cacheWrite ?? 0,
							output: output ?? 0
						}, bounds.holidays, record.turn);
					}
				}
				s.requests.push(record);
				const prevLast = state.requests.at(-1);
				s.turnRuns = (state.turnRuns ?? countTurnRuns(state.requests)) + (prevLast === void 0 ? record.turn !== void 0 ? 1 : 0 : record.turn === prevLast.turn ? 0 : 1);
				const timing = ensureTiming(s);
				timing.calls += 1;
				const stepStart = state.stepStart;
				if (stepStart !== void 0) {
					const firstToken = stepStart.firstToken ?? firstTokenTimeOfStream(data?.stream);
					if (firstToken !== void 0) {
						const decodeBlocks = decodeSpansOfStream(data?.stream, event.time);
						let decodeStart = firstToken;
						for (const block of decodeBlocks) decodeStart = Math.min(decodeStart, block.start);
						timing.ttftMs += durOf(stepStart.time, decodeStart);
						timing.genMs += durOf(decodeStart, event.time);
						const modelSpans = [{
							kind: "ttft",
							start: stepStart.time,
							end: decodeStart
						}];
						for (const block of decodeBlocks) {
							const to = Math.min(event.time, block.end);
							if (to <= block.start) continue;
							modelSpans.push({
								kind: block.kind,
								start: modelSpans.length === 1 ? decodeStart : block.start,
								end: to
							});
						}
						s.stepSpans = [...s.stepSpans ?? [], ...modelSpans];
						if (output !== null) {
							timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time);
							timing.speedTokens = (timing.speedTokens ?? 0) + output;
						}
						const tally = decodeTallyOfStream(data?.stream, event.time);
						for (const kind of DECODE_KINDS) addDecode(timing, kind, tally.spans[kind], tally.blocks[kind]);
					}
				}
				const asstMsg = deriveEventMessage(event);
				if (applySurface(s, event, event.type, asstMsg).text !== void 0) s.answers = (s.answers ?? 0) + 1;
				break;
			}
			case "session/end-seed": {
				if (data?.inherited !== true) break;
				const s = ensure([]);
				s.cost = {};
				s.turnCost = {};
				break;
			}
			case "plan/mode":
				if (data && typeof data.active === "boolean") {
					const s = ensure(["events"]);
					s.events.push({
						seq: event.seq,
						time: event.time,
						kind: "mode",
						name: data.active ? "plan.on" : "plan.off"
					});
					bumpDetailRev(s);
				}
				break;
			case "compaction/summary":
			case "compaction/prune": {
				const s = ensure(["events"]);
				bumpDetailRev(s);
				if (data && Array.isArray(data.shadowedSeqs)) {
					s.pendingShadowedSeqs = data.shadowedSeqs.filter((x) => typeof x === "number");
					s.pendingShadowEventSeq = event.seq;
				}
				s.events.push({
					seq: event.seq,
					time: event.time,
					kind: event.type === "compaction/summary" ? "compaction" : "prune",
					tokens: data && typeof data.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0,
					...event.type === "compaction/summary" && data && Array.isArray(data.shadowedSeqs) ? { count: data.shadowedSeqs.length } : {}
				});
				break;
			}
			default: return state;
		}
	} catch {
		st = void 0;
	}
	if (st !== void 0) {
		trimState(st, bounds);
		return st;
	}
	return state;
}
//#endregion
//#region src/host/config.ts
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
		holidays: holidaysFrom(resolved.holidays) ?? [...DEFAULT_HOLIDAYS]
	};
}
//#endregion
//#region src/host/timeline.ts
const surfaceNodeSchema = z.object({
	seq: z.number().int().nonnegative(),
	time: z.number().optional(),
	cat: z.enum([
		"user",
		"inject",
		"skill",
		"assistant",
		"tool"
	]),
	tokens: z.number().int().nonnegative(),
	imgs: z.number().int().nonnegative().optional(),
	gone: z.number().int().nonnegative().optional(),
	form: z.string().optional(),
	name: z.string().optional(),
	text: z.string().optional(),
	tool: z.string().optional(),
	err: z.boolean().optional(),
	skill: z.string().optional(),
	calls: z.array(z.string()).optional()
}).strict();
const systemPromptNodeSchema = z.object({
	seq: z.number().int().nonnegative(),
	time: z.number(),
	tokens: z.number().int().nonnegative()
}).strict();
const requestRecordSchema = z.object({
	turn: z.number().optional(),
	step: z.number().optional(),
	time: z.number(),
	seq: z.number(),
	system: z.number().int().nonnegative(),
	tools: z.number().int().nonnegative(),
	user: z.number().int().nonnegative(),
	inject: z.number().int().nonnegative(),
	assistant: z.number().int().nonnegative(),
	tool: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	prompt: z.number().int().nonnegative().optional(),
	skill: z.number().int().nonnegative().optional(),
	cacheRead: z.number().int().nonnegative().optional(),
	output: z.number().int().nonnegative().optional(),
	activeMs: z.number().nonnegative().optional(),
	stepCount: z.number().int().positive().optional()
}).strict();
const contextEventSchema = z.object({
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
const fileOpSchema = z.object({
	seq: z.number().int().nonnegative(),
	path: z.string(),
	kind: z.enum([
		"read",
		"write",
		"search"
	]),
	tool: z.string(),
	time: z.number().optional(),
	err: z.boolean(),
	added: z.number().int().nonnegative(),
	removed: z.number().int().nonnegative(),
	detail: z.string().optional(),
	hits: z.number().int().positive().optional(),
	read: z.union([z.object({
		start: z.number().int().positive(),
		count: z.number().int().nonnegative()
	}).strict(), z.object({
		count: z.number().int().positive(),
		est: z.literal(true)
	}).strict()]).optional(),
	parent: z.number().int().nonnegative().optional(),
	program: z.string().optional(),
	pattern: z.literal(true).optional(),
	gone: z.number().int().nonnegative().optional()
}).strict();
const timingSpanSchema = z.object({
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
const currentSchema = z.object({
	system: z.number().int().nonnegative(),
	tools: z.number().int().nonnegative(),
	user: z.number().int().nonnegative(),
	inject: z.number().int().nonnegative(),
	skill: z.number().int().nonnegative(),
	assistant: z.number().int().nonnegative(),
	tool: z.number().int().nonnegative(),
	total: z.number().int().nonnegative()
}).strict();
const costBucketsSchema = z.object({
	uncached: z.number().int().nonnegative(),
	cacheRead: z.number().int().nonnegative(),
	cacheWrite: z.number().int().nonnegative(),
	output: z.number().int().nonnegative()
}).strict();
const costModelSchema = z.object({
	peak: costBucketsSchema.optional(),
	off: costBucketsSchema.optional()
}).strict();
const costModelsSchema = z.record(z.string(), costModelSchema);
const costUsageSchema = z.record(z.string(), costModelsSchema);
const callCountsSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()));
const creditRatesSchema = z.record(z.string(), z.record(z.string(), z.number().nonnegative()));
const turnCostUsageSchema = z.record(z.string(), z.object({
	usage: costUsageSchema,
	requests: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()))
}).strict());
const toolTimingSchema = z.object({
	calls: z.number().int().nonnegative(),
	ms: z.number().nonnegative()
}).strict();
const timingTotalsSchema = z.object({
	wallMs: z.number().nonnegative(),
	ttftMs: z.number().nonnegative(),
	genMs: z.number().nonnegative(),
	reasoningMs: z.number().nonnegative().optional(),
	reasoningBlocks: z.number().int().nonnegative().optional(),
	textMs: z.number().nonnegative().optional(),
	textBlocks: z.number().int().nonnegative().optional(),
	toolArgMs: z.number().nonnegative().optional(),
	toolArgBlocks: z.number().int().nonnegative().optional(),
	speedTokens: z.number().nonnegative().optional(),
	speedMs: z.number().nonnegative().optional(),
	calls: z.number().int().nonnegative(),
	toolsMs: z.number().nonnegative(),
	toolCalls: z.number().int().nonnegative(),
	tools: z.record(z.string(), toolTimingSchema)
}).strict();
const unsupportedSchema = z.object({
	current: z.string(),
	minimum: z.string()
}).strict();
const countsSchema = z.object({
	turns: z.number().int().nonnegative(),
	steps: z.number().int().nonnegative(),
	injects: z.number().int().nonnegative(),
	compactions: z.number().int().nonnegative(),
	prunes: z.number().int().nonnegative(),
	skills: z.number().int().nonnegative().optional()
}).strict();
const lastSchema = z.object({
	seq: z.number(),
	total: z.number().int().nonnegative(),
	prompt: z.number().int().nonnegative().optional()
}).strict();
const contextTimelineSchema = z.object({
	ok: z.literal(true),
	unsupported: unsupportedSchema.optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	contextWindow: z.number().optional(),
	current: currentSchema,
	images: z.number().int().nonnegative().optional(),
	toolCalls: z.number().int().nonnegative().optional(),
	humanInputs: z.number().int().nonnegative().optional(),
	answers: z.number().int().nonnegative().optional(),
	lastUser: z.string().optional(),
	counts: countsSchema.optional(),
	last: lastSchema.optional(),
	detailRev: z.number().int().nonnegative().optional(),
	requests: z.array(requestRecordSchema).optional(),
	events: z.array(contextEventSchema).optional(),
	cost: costUsageSchema.optional(),
	turnCost: turnCostUsageSchema.optional(),
	calls: callCountsSchema.optional(),
	creditRates: creditRatesSchema.optional(),
	timing: timingTotalsSchema.optional(),
	systems: z.array(systemPromptNodeSchema).optional(),
	nodes: z.array(surfaceNodeSchema).optional(),
	droppedNodes: z.number().int().nonnegative().optional(),
	archive: z.array(surfaceNodeSchema).optional(),
	surfaceFloor: z.number().int().nonnegative().optional(),
	archiveFloor: z.number().int().nonnegative().optional(),
	fileOps: z.array(fileOpSchema).optional(),
	fileOpsFloor: z.number().int().nonnegative().optional(),
	spans: z.array(timingSpanSchema).optional()
}).strict();
const timelineStateSchema = z.object({
	surface: z.array(surfaceNodeSchema),
	sums: z.object({
		user: z.number().int().nonnegative(),
		inject: z.number().int().nonnegative(),
		skill: z.number().int().nonnegative(),
		assistant: z.number().int().nonnegative(),
		tool: z.number().int().nonnegative()
	}).strict(),
	systemTokens: z.number().int().nonnegative(),
	systems: z.array(systemPromptNodeSchema).optional(),
	toolsTokens: z.number().int().nonnegative(),
	model: z.string().optional(),
	provider: z.string().optional(),
	lastModel: z.string().optional(),
	contextWindow: z.number().optional(),
	requests: z.array(requestRecordSchema),
	turnRuns: z.number().int().nonnegative().optional(),
	events: z.array(contextEventSchema),
	archived: z.array(surfaceNodeSchema),
	cost: costUsageSchema.optional(),
	turnCost: turnCostUsageSchema.optional(),
	calls: callCountsSchema.optional(),
	archiveFloor: z.number().optional(),
	timing: timingTotalsSchema.optional(),
	humanInputs: z.number().int().nonnegative().optional(),
	answers: z.number().int().nonnegative().optional(),
	lastUser: z.string().optional(),
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
	callNames: z.record(z.string(), z.object({
		name: z.string(),
		start: z.number(),
		argsRaw: z.string().optional()
	}).strict()),
	pendingShadowedSeqs: z.array(z.number()).optional(),
	pendingShadowEventSeq: z.number().optional(),
	detailRev: z.number().int().nonnegative().optional(),
	fileOps: z.array(fileOpSchema),
	fileOpsFloor: z.number().int().nonnegative().optional(),
	spans: z.array(timingSpanSchema),
	stepSpans: z.array(timingSpanSchema).optional(),
	pendingCodeOps: z.record(z.string(), z.array(fileOpSchema)).optional()
});
function createContextTimelineDefinition(config, slim) {
	const bounds = resolveBounds(config);
	const view = (state) => slim() ? buildTimelineHead(state) : buildTimelineView(state, bounds);
	return {
		key: "contextTimeline",
		stateSchema: timelineStateSchema,
		wire: {
			viewSchema: contextTimelineSchema,
			view
		},
		init: () => createTimelineState(),
		apply: (state, event) => applyTimeline(state, event, bounds),
		stateVersion: 29
	};
}
//#endregion
//#region src/shared/days.ts
function dayKeyOf(time) {
	if (!Number.isFinite(time)) return null;
	const d = new Date(time);
	const y = d.getFullYear();
	if (!Number.isFinite(y) || y < 1970 || y > 9999) return null;
	return `${String(y).padStart(4, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
//#endregion
//#region src/host/activity.ts
const MAX_KEPT_DAYS = 400;
const MAX_SKILLS_PER_DAY = 100;
const activitySkillSchema = z.object({
	n: z.number().int().nonnegative(),
	last: z.number()
}).strict();
const activityDaySchema = z.object({
	tokens: z.number().int().nonnegative(),
	requests: z.number().int().nonnegative(),
	cost: costUsageSchema.optional(),
	skills: z.record(z.string(), activitySkillSchema).optional()
}).strict();
const contextActivitySchema = z.object({ days: z.record(z.string(), activityDaySchema) }).strict();
const activityStateSchema = z.object({
	days: z.record(z.string(), activityDaySchema),
	model: z.string().optional(),
	provider: z.string().optional(),
	stepStart: z.number().optional(),
	skillCalls: z.array(z.string()).optional()
});
function billedBucketsOf(value) {
	if (value === null || typeof value !== "object") return null;
	const usage = value;
	const input = tokenCountOf(usage.inputTokens);
	const cacheRead = tokenCountOf(usage.cacheReadTokens);
	const cacheWrite = tokenCountOf(usage.cacheWriteTokens);
	const output = tokenCountOf(usage.outputTokens);
	if (input === null && cacheRead === null && cacheWrite === null && output === null) return null;
	return {
		uncached: input ?? 0,
		cacheRead: cacheRead ?? 0,
		cacheWrite: cacheWrite ?? 0,
		output: output ?? 0
	};
}
function withDayEntry(state, key, entry) {
	let days = {
		...state.days,
		[key]: entry
	};
	const keys = Object.keys(days);
	if (keys.length > MAX_KEPT_DAYS) {
		keys.sort();
		const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS));
		days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)));
	}
	return {
		...state,
		days
	};
}
function bookSkillLoad(state, name, time) {
	const key = dayKeyOf(time);
	if (key === null) return state;
	const prev = state.days[key];
	const existing = prev?.skills?.[name];
	if (existing === void 0 && prev?.skills !== void 0 && Object.keys(prev.skills).length >= MAX_SKILLS_PER_DAY) return state;
	const skills = {
		...prev?.skills,
		[name]: {
			n: (existing?.n ?? 0) + 1,
			last: existing === void 0 ? time : Math.max(existing.last, time)
		}
	};
	return withDayEntry(state, key, {
		tokens: prev?.tokens ?? 0,
		requests: prev?.requests ?? 0,
		...prev?.cost !== void 0 ? { cost: prev.cost } : {},
		skills
	});
}
function invokedSkillOf(event) {
	const data = event.data;
	const carrier = event.type === "developer/message" ? data?.message : data;
	const source = carrier !== null && typeof carrier === "object" ? carrier.source : void 0;
	if (source === null || typeof source !== "object") return "";
	const rec = source;
	return rec.kind === "skill-invocation" && typeof rec.name === "string" ? rec.name : "";
}
function toolResultCallIdOf(message) {
	if (message === null || typeof message !== "object") return null;
	const rec = message;
	if (typeof rec.toolCallId === "string" && rec.toolCallId !== "") return rec.toolCallId;
	const source = rec.source;
	if (source === null || typeof source !== "object") return null;
	const callId = source.callId;
	return typeof callId === "string" && callId !== "" ? callId : null;
}
function applyActivity(state, event, holidays = DEFAULT_HOLIDAYS) {
	if (event.type === "request/header") {
		const config = event.data?.header?.config;
		if (config === null || typeof config !== "object") return state;
		const model = typeof config.model === "string" ? config.model : void 0;
		const provider = typeof config.provider === "string" ? config.provider : void 0;
		const nextModel = model !== void 0 ? model : state.model;
		const nextProvider = provider !== void 0 ? provider : state.provider;
		if (nextModel === state.model && nextProvider === state.provider) return state;
		return {
			...state,
			...nextModel !== void 0 ? { model: nextModel } : {},
			...nextProvider !== void 0 ? { provider: nextProvider } : {}
		};
	}
	if (event.type === "step/start") {
		if (!Number.isFinite(event.time)) return state;
		return state.stepStart === event.time ? state : {
			...state,
			stepStart: event.time
		};
	}
	if (event.type === "step/end") {
		if (state.stepStart === void 0) return state;
		const next = { ...state };
		delete next.stepStart;
		return next;
	}
	if (event.type === "session/end-seed") {
		if (event.data?.inherited !== true) return state;
		return { days: {} };
	}
	if (event.type === "user/message" || event.type === "developer/message") {
		const name = invokedSkillOf(event);
		return name === "" ? state : bookSkillLoad(state, name, event.time);
	}
	if (event.type === "tool/call") {
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
	if (event.type === "tool/result") {
		const message = event.data?.message;
		const callId = toolResultCallIdOf(message);
		const pending = state.skillCalls;
		if (callId === null || pending === void 0 || !pending.includes(callId)) return state;
		const skillCalls = pending.filter((id) => id !== callId);
		const next = { ...state };
		if (skillCalls.length > 0) next.skillCalls = skillCalls;
		else delete next.skillCalls;
		const name = skillNameOf(message);
		return name === "" ? next : bookSkillLoad(next, name, event.time);
	}
	if (event.type !== "assistant/message") return state;
	const initiated = state.stepStart !== void 0 ? state.stepStart : event.time;
	const key = dayKeyOf(initiated);
	if (key === null) return state;
	const data = event.data;
	const buckets = billedBucketsOf(data?.usage);
	const prev = state.days[key];
	let cost = prev?.cost;
	if (buckets !== null && state.model !== void 0) cost = addBilledUsage(cost, state.provider ?? "", state.model, initiated, buckets, holidays);
	return withDayEntry(state, key, {
		tokens: (prev === void 0 ? 0 : prev.tokens) + (buckets === null ? 0 : buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output),
		requests: (prev === void 0 ? 0 : prev.requests) + 1,
		...cost !== void 0 ? { cost } : {},
		...prev?.skills !== void 0 ? { skills: prev.skills } : {}
	});
}
function createContextActivityDefinition(holidays = DEFAULT_HOLIDAYS) {
	return {
		key: "contextActivity",
		stateSchema: activityStateSchema,
		init: () => ({ days: {} }),
		apply: (state, event) => applyActivity(state, event, holidays),
		wire: {
			viewSchema: contextActivitySchema,
			view: (state) => ({ days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, {
				...v,
				...v.cost !== void 0 ? { cost: copyCostUsage(v.cost) } : {},
				...v.skills !== void 0 ? { skills: Object.fromEntries(Object.entries(v.skills).map(([n, t]) => [n, { ...t }])) } : {}
			}])) })
		},
		stateVersion: 6
	};
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
function pinnedSourceOf(name) {
	return FIRST_PARTY_SOURCES[name];
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
//#endregion
//#region src/host/attribution.ts
const selfUrl = normalize(fileURLToPath(import.meta.url));
const packageCache = new Map();
function packageNameFrom(file) {
	let dir = dirname(file);
	for (let depth = 0; depth < 12; depth++) {
		const cached = packageCache.get(dir);
		if (cached !== void 0) return cached;
		const packageFile = join(dir, "package.json");
		if (existsSync(packageFile)) try {
			const name = JSON.parse(readFileSync(packageFile, "utf8")).name;
			if (typeof name === "string" && name) {
				packageCache.set(dir, name);
				return name;
			}
		} catch {}
		const parent = dirname(dir);
		packageCache.set(dir, void 0);
		if (parent === dir) return void 0;
		dir = parent;
	}
}
const FRAME_POSITION = /:\d+:\d+$/;
const CORDIS_ORIGINAL = Symbol.for("cordis.original");
function rawInstanceOf(tools) {
	return tools?.[CORDIS_ORIGINAL] ?? tools;
}
const selfPackage = packageNameFrom(selfUrl);
function callerPackageFrom(stack) {
	if (!stack) return void 0;
	for (const raw of stack.split("\n").slice(1)) {
		let line = raw.trim();
		if (!line.startsWith("at ")) continue;
		line = line.slice(3);
		if (line.startsWith("async ")) line = line.slice(6);
		line = line.replace(/\)\s*$/, "");
		const position = FRAME_POSITION.exec(line);
		if (!position) continue;
		let target = line.slice(0, -position[0].length);
		if (target.includes("(")) target = target.slice(target.lastIndexOf("(") + 1);
		if (target.startsWith("file://")) try {
			target = normalize(fileURLToPath(target));
		} catch {
			continue;
		}
		else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith("/") && !target.startsWith("\\\\")) continue;
		else target = normalize(target);
		if (target === selfUrl) continue;
		const name = packageNameFrom(target);
		if (name !== void 0 && name !== selfPackage) return name;
	}
}
function createToolAttribution(ctx) {
	const live = new Map();
	const wrapped = new WeakSet();
	const self = ctx.fiber.name;
	let lastReader;
	const patched = [];
	const wrapInstance = (tools) => {
		if (!tools || typeof tools !== "object" || wrapped.has(tools)) return;
		const register = tools.register;
		if (typeof register !== "function") return;
		wrapped.add(tools);
		const original = register.attributedOriginal ?? register;
		if (typeof original !== "function") return;
		const instance = tools;
		const wrappedRegister = function(definition) {
			const toolName = definition?.name;
			let owner = lastReader;
			if (!owner || owner === "root" || owner === self) owner = callerPackageFrom(new Error().stack);
			const dispose = original.call(this, definition);
			if (typeof toolName === "string" && owner && owner !== "root" && owner !== self && owner !== selfPackage) {
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
		patched.push(() => {
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
		for (const restore of patched.splice(0)) restore();
	}, "tools.register attribution");
	const toolsService = rawInstanceOf(ctx.get("tools", false));
	wrapInstance(toolsService);
	const boot = new Set();
	try {
		const toolEntries = toolsService?.layers?.global?.tools;
		if (toolEntries !== void 0 && typeof toolEntries.entries === "function") for (const [name] of toolEntries.entries()) boot.add(name);
	} catch {}
	return { ownerOf: (name) => mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name) ?? (boot.has(name) ? "<unknown-plugin>" : void 0) };
}
//#endregion
//#region src/host/record.ts
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
//#endregion
//#region src/host/connection.ts
function fetchRouteRegistrar(connection) {
	return typeof connection?.fetch?.register === "function" ? connection.fetch.register.bind(connection.fetch) : void 0;
}
function registerPostRoute(c, connection, path, fetch, label) {
	const register = fetchRouteRegistrar(connection);
	if (register === void 0) return false;
	try {
		c.effect(() => register({
			path,
			methods: ["POST"],
			requestBody: "buffered",
			fetch
		}), label);
	} catch {
		return false;
	}
	return true;
}
//#endregion
//#region src/host/balance.ts
const BALANCE_ROUTE = "/api/dsh-cost-breakdown/balance";
const DEEPSEEK_SETTINGS_NS = "llm-deepseek";
const PUBLIC_BASE_URL = "https://api.deepseek.com";
const FETCH_TIMEOUT_MS = 1e4;
function amountOf(value) {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}
function clientMetadata() {
	return {
		version: "1",
		locale: "zh-CN",
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
	};
}
function addWallets(into, wallets, field) {
	for (const wallet of Array.isArray(wallets) ? wallets : []) try {
		const entry = asRecord(wallet);
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
async function readWithAccount(ctx) {
	const account = ctx.get("deepseekAccount");
	const getBalance = typeof account?.getBalance === "function" ? account.getBalance.bind(account) : void 0;
	if (getBalance === void 0) return null;
	try {
		if (typeof account?.getState === "function") {
			if (asRecord(await account.getState())?.status === "signed-out") return null;
		}
	} catch {}
	try {
		const outcome = asRecord(await getBalance(clientMetadata()));
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
function deepseekSectionOf(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe !== "function") return null;
	try {
		const rows = settings.describe();
		if (!Array.isArray(rows)) return null;
		let shaped = null;
		for (const row of rows) try {
			const record = asRecord(row);
			if (record === null) continue;
			const value = asRecord(record.value);
			if (value === null || typeof value.apiKeyEnv !== "string" || value.apiKeyEnv === "") continue;
			if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === "llm-deepseek-api-key") return value;
			shaped ??= value;
		} catch {
			continue;
		}
		return shaped;
	} catch {
		return null;
	}
}
async function resolveFacts(ctx) {
	const section = deepseekSectionOf(ctx);
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
	const data = asRecord(value);
	if (data === null) return null;
	const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
	const balances = [];
	for (const info of infos) try {
		const entry = asRecord(info);
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
async function readBalance(facts) {
	if (inFlight !== null) return inFlight;
	inFlight = (async () => {
		let value = null;
		try {
			const response = await fetcher$1(facts.baseUrl.replace(/\/+$/, "") + "/user/balance", {
				headers: {
					accept: "application/json",
					authorization: "Bearer " + facts.apiKey
				},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
			if (response.ok) value = balanceOfPayload(await response.json());
		} catch {}
		return value;
	})();
	const settled = inFlight;
	try {
		return await settled;
	} finally {
		inFlight = null;
	}
}
function watchBalanceChannel(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async () => {
			let value = await readWithAccount(ctx);
			if (value === null) {
				const facts = await resolveFacts(ctx);
				value = facts !== null ? await readBalance(facts) : null;
			}
			return Response.json({
				ok: true,
				value
			}, { headers: { "cache-control": "no-store" } });
		};
		registerPostRoute(c, c.get("connection"), BALANCE_ROUTE, handler, "dsh-cost-breakdown: balance route");
	});
}
//#endregion
//#region src/host/platformCredits.ts
const CREDITS_ROUTES = [{
	provider: "workbuddy",
	url: "http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status"
}, {
	provider: "workbuddy-ai",
	url: "http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status"
}];
const CACHE_MS = 6e4;
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
let cached = null;
async function platformCredits(now = Date.now()) {
	if (cached !== null && now - cached.at < CACHE_MS) return cached.value;
	const table = {};
	await Promise.all(CREDITS_ROUTES.map(async ({ provider, url }) => {
		try {
			const response = await fetcher(url, { signal: AbortSignal.timeout(8e3) });
			if (!response.ok) return;
			const value = creditsOfPayload(await response.json());
			if (value !== null) table[provider] = value;
		} catch {}
	}));
	const value = Object.keys(table).length > 0 ? table : null;
	cached = {
		at: now,
		value
	};
	return value;
}
const CREDITS_ROUTE = "/api/dsh-cost-breakdown/credits";
function watchPlatformCreditsChannel(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async () => Response.json({
			ok: true,
			value: await platformCredits()
		}, { headers: { "cache-control": "no-store" } });
		registerPostRoute(c, c.get("connection"), CREDITS_ROUTE, handler, "dsh-cost-breakdown: platform credits route");
	});
}
//#endregion
//#region src/host/coldRead.ts
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
//#region src/host/backfill.ts
const BACKFILL_ROUTE = "/api/dsh-cost-breakdown/backfill";
const YIELD_MS = 100;
const UNSUPPORTED_FORMAT = "SessionFormatUnsupported";
function headerOf(record) {
	const header = asRecord(asRecord(record)?.header);
	if (header === null) return null;
	if (typeof header.id !== "string" || header.id === "") return null;
	return header;
}
const PROBE_KEYS = ["contextActivity", "contextTimeline"];
function servesRows(cache, header) {
	try {
		const values = asRecord(asRecord(cache.cachedSnapshot(header, PROBE_KEYS))?.values);
		return values !== null && values.contextActivity !== void 0 && values.contextTimeline !== void 0;
	} catch {
		return false;
	}
}
async function readColdLog(persistence, id, signal) {
	const handle = await persistence.open(id, "read", { signal });
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
		events: [...events, ...interruptedTurnClosers(events)]
	};
}
function isLive(sessions, id) {
	if (sessions === null || typeof sessions.get !== "function") return false;
	try {
		return sessions.get(id) !== void 0;
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
function messageOf(error) {
	try {
		return String(error);
	} catch {
		return "unprintable error";
	}
}
function watchActivityBackfill(ctx, coldReads = makeColdReadGate()) {
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
			return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
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
		if (query === null || typeof query.listSessions !== "function") return;
		if (cache === null || typeof cache.cachedSnapshot !== "function" || typeof cache.coldSnapshot !== "function") return;
		if (persistence === null || typeof persistence.open !== "function") return;
		const sessions = asRecord(injected.sessions);
		const abort = new AbortController();
		const run = async () => {
			const listed = await query.listSessions(abort.signal);
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
						cache.coldSnapshot(log.header, log.inheritedEventCount, log.events);
						return true;
					}) === void 0) {
						paused = true;
						break;
					}
					folded++;
				} catch (error) {
					if (isUnsupportedFormat(error)) {
						refused++;
						ctx.logger.debug(`dsh-cost-breakdown: projection backfill skipped "${header.id}" (${messageOf(error)})`);
					} else ctx.logger.warn(`dsh-cost-breakdown: projection backfill skipped "${header.id}" (${messageOf(error)})`);
				}
				await new Promise((resolve) => setTimeout(resolve, YIELD_MS));
			}
			if (folded > 0) ctx.logger.info(`dsh-cost-breakdown: projection rows backfilled for ${folded} session(s)`);
			if (paused) ctx.logger.info("dsh-cost-breakdown: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)");
			if (refused > 0) ctx.logger.info(`dsh-cost-breakdown: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`);
		};
		launch = () => {
			run().catch((error) => {
				if (!abort.signal.aborted) ctx.logger.warn(`dsh-cost-breakdown: projection backfill stopped early (${messageOf(error)})`);
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
function reply(value) {
	return Response.json(value, { headers: { "cache-control": "no-store" } });
}
function failure(code, message) {
	return reply({
		ok: false,
		error: {
			code,
			message
		}
	});
}
function watchDetailChannel(ctx, bounds, coldReads = makeColdReadGate()) {
	const gate = { live: false };
	ctx.inject(["connection", "sessions"], (c) => {
		const sessions = c.get("sessions");
		const getSession = typeof sessions?.get === "function" ? sessions.get.bind(sessions) : void 0;
		if (getSession === void 0) return;
		const projections = ctx.sessionProjections;
		const handler = async (request) => {
			let sessionId;
			try {
				const body = await request.json();
				sessionId = body !== null && typeof body === "object" ? body.sessionId : void 0;
			} catch {
				return failure("dsh-cost-breakdown/bad-request", "body is not JSON");
			}
			if (typeof sessionId !== "string" || sessionId === "") return failure("dsh-cost-breakdown/bad-request", "missing sessionId");
			try {
				const session = getSession(sessionId);
				if (session !== void 0 && session !== null) {
					const state = projections.stateOf(session, "contextTimeline");
					if (state === void 0) return reply({
						ok: true,
						value: null
					});
					return reply({
						ok: true,
						value: buildTimelineDetail(state, bounds)
					});
				}
				const query = ctx.get("sessionQuery");
				const observe = typeof query?.observeSession === "function" ? query.observeSession.bind(query) : void 0;
				if (observe === void 0) return reply({
					ok: true,
					value: null
				});
				return reply({
					ok: true,
					value: await coldReads.admit(async () => {
						const observation = await observe(sessionId, { projectionMode: "none" });
						const events = observation?.events;
						if (!Array.isArray(events)) return null;
						let state = createTimelineState();
						try {
							for (const ev of events) state = applyTimeline(state, ev, bounds);
						} finally {
							const dispose = observation?.[Symbol.dispose];
							if (typeof dispose === "function") dispose.call(observation);
						}
						return buildTimelineDetail(state, bounds);
					}) ?? null
				});
			} catch (err) {
				return failure("gateway/internal", err instanceof Error ? err.message : String(err));
			}
		};
		if (!registerPostRoute(c, c.get("connection"), "/api/dsh-cost-breakdown/detail", handler, "dsh-cost-breakdown: detail route")) return;
		gate.live = true;
		return () => {
			gate.live = false;
		};
	});
	return gate;
}
//#endregion
//#region src/shared/version.ts
const BASELINE_DSH_VERSION = "0.1.7-rc.2";
function channelRank(channel) {
	return channel === "rc" ? 3 : channel === "beta" ? 2 : 1;
}
const RELEASE_RANK = 4;
function parseVersion(version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim());
	if (match === null) return null;
	const channel = match[4]?.toLowerCase();
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		rank: channel === void 0 ? RELEASE_RANK : channelRank(channel),
		serial: match[5] ? Number(match[5]) : 0
	};
}
function compareParsed(a, b) {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (a.rank !== b.rank) return a.rank - b.rank;
	return a.serial - b.serial;
}
function meetsBaseline(version, baseline = BASELINE_DSH_VERSION) {
	const v = parseVersion(version);
	const b = parseVersion(baseline);
	if (v === null || b === null) return true;
	return compareParsed(v, b) >= 0;
}
//#endregion
//#region src/host/headers.ts
const HEADERS_MAX = 50;
const storedToolSchema = z.object({
	name: z.string(),
	tokens: z.number().int().nonnegative(),
	description: z.string().optional(),
	plugin: z.string().optional(),
	schema: z.unknown().optional()
}).strict();
const storedEpochSchema = z.object({
	seq: z.number(),
	time: z.number(),
	system: z.string().optional(),
	systemTokens: z.number().int().nonnegative().optional(),
	tools: z.array(storedToolSchema)
}).strict();
const contextHeadersStateSchema = z.object({ headers: z.array(storedEpochSchema) }).strict();
const headerToolWireSchema = z.object({
	name: z.string(),
	tokens: z.number().int().nonnegative(),
	plugin: z.string().optional()
}).strict();
const contextHeadersSchema = z.object({ headers: z.array(z.object({
	seq: z.number(),
	time: z.number(),
	systemTokens: z.number().int().nonnegative().optional(),
	tools: z.array(headerToolWireSchema)
}).strict()) }).strict();
function recordOf(event) {
	if (event.type !== "request/header") return null;
	const rawHeader = event.data?.header;
	if (rawHeader === null || rawHeader === void 0 || typeof rawHeader !== "object") return null;
	const header = rawHeader;
	const tools = Array.isArray(header.tools) ? header.tools : [];
	return {
		seq: event.seq,
		time: event.time,
		tools: tools.map((t) => {
			const tool = t !== null && typeof t === "object" ? t : {};
			const entry = {
				name: typeof tool.name === "string" ? tool.name : "?",
				tokens: estimateToolSchema(t)
			};
			if (typeof tool.plugin === "string" && tool.plugin !== "") entry.plugin = tool.plugin;
			return entry;
		})
	};
}
function createContextHeadersDefinition(resolve) {
	const view = (state) => ({ headers: state.headers.map((h) => {
		const record = {
			seq: h.seq,
			time: h.time,
			tools: h.tools.map((t) => {
				const entry = {
					name: t.name,
					tokens: t.tokens
				};
				const plugin = t.plugin ?? (resolve !== void 0 ? resolve(t.name) : void 0);
				if (plugin !== void 0) entry.plugin = plugin;
				return entry;
			})
		};
		const systemTokens = h.systemTokens ?? (typeof h.system === "string" && h.system !== "" ? estimateSystemTokens(h.system) : void 0);
		if (systemTokens !== void 0) record.systemTokens = systemTokens;
		return record;
	}) });
	return {
		key: "contextHeaders",
		stateSchema: contextHeadersStateSchema,
		wire: {
			viewSchema: contextHeadersSchema,
			view
		},
		init: () => ({ headers: [] }),
		apply: (state, event) => {
			const record = recordOf(event);
			if (record === null) return state;
			const last = state.headers.at(-1);
			if (last !== void 0 && last.seq === record.seq) return state;
			const headers = [...state.headers, record];
			return { headers: headers.length > HEADERS_MAX ? headers.slice(-50) : headers };
		},
		stateVersion: 1
	};
}
//#endregion
//#region src/host/fallback.ts
const fallbackStateSchema = z.object({});
function fallbackDefinition(key, wireSchema, value) {
	const view = () => value;
	return {
		key,
		stateSchema: fallbackStateSchema,
		init: () => ({}),
		apply: (state) => state,
		wire: {
			viewSchema: wireSchema,
			view
		},
		schema: wireSchema,
		view,
		stateVersion: 1
	};
}
function createFallbackTimelineDefinition(current) {
	return fallbackDefinition("contextTimeline", contextTimelineSchema, {
		ok: true,
		unsupported: {
			current,
			minimum: BASELINE_DSH_VERSION
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
function createFallbackHeadersDefinition() {
	return fallbackDefinition("contextHeaders", contextHeadersSchema, { headers: [] });
}
function createFallbackActivityDefinition() {
	return fallbackDefinition("contextActivity", contextActivitySchema, { days: {} });
}
//#endregion
//#region src/host/stepIdentity.ts
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
function watchStepIdentity(ctx) {
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
//#region src/host/skills.ts
const SKILLS_ROUTE = "/api/dsh-cost-breakdown/skills";
const MAX_SKILLS = 500;
function stringOf(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
async function disposeOf(resource) {
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
function skillInfoOf(value) {
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
		await disposeOf(observation);
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
function watchSkillCatalog(ctx) {
	ctx.inject(["connection"], (c) => {
		const handler = async (request) => {
			let value = null;
			let lease;
			try {
				const body = asRecord(await request.json());
				const sessionId = stringOf(body?.sessionId);
				const view = await sessionViewOf(ctx, sessionId);
				const cwd = view.cwd ?? stringOf(body?.cwd);
				const resolved = await resolveRegistry(ctx, sessionId, view.agentPreset);
				if (resolved !== null) {
					lease = resolved.lease;
					const listed = await resolved.registry.list({
						...cwd === void 0 ? {} : { cwd },
						...resolved.scope === void 0 ? {} : { scope: resolved.scope }
					});
					const rows = Array.isArray(listed) ? listed : [];
					const skills = [];
					for (const row of rows) {
						const info = skillInfoOf(row);
						if (info !== null) skills.push(info);
						if (skills.length >= MAX_SKILLS) break;
					}
					value = { skills };
				}
			} catch {} finally {
				await disposeOf(lease);
			}
			return Response.json({
				ok: true,
				value
			}, { headers: { "cache-control": "no-store" } });
		};
		registerPostRoute(c, c.get("connection"), SKILLS_ROUTE, handler, "dsh-cost-breakdown: skills route");
	});
}
//#endregion
//#region src/host/version.ts
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
function detectHarnessVersion(ctx, resolveUrl = resolveRunningModule, pluginRoot = PLUGIN_ROOT) {
	const running = probeRunningTree((specifier) => {
		const url = resolveUrl(specifier);
		if (!url.startsWith("file:")) throw new Error(`dsh-cost-breakdown: non-file module URL for ${specifier}`);
		return fileURLToPath(url);
	}, pluginRoot);
	if (running !== void 0) return running;
	try {
		const homePath = ctx.get("dshHomePath");
		if (typeof homePath === "function") {
			const req = createRequire(homePath("profiles", "dsh-cost-breakdown-version-probe.cjs"));
			const home = probeAnchor((specifier) => req.resolve(specifier), HOME_PROBE_PACKAGES);
			if (home !== void 0) return home;
		}
	} catch {}
}
//#endregion
//#region src/host/index.ts
const name = "dsh-cost-breakdown";
const inject = ["sessionProjections"];
function apply(ctx, config) {
	watchBalanceChannel(ctx);
	watchPlatformCreditsChannel(ctx);
	watchSkillCatalog(ctx);
	const harnessVersion = detectHarnessVersion(ctx);
	if (harnessVersion !== void 0 && !meetsBaseline(harnessVersion)) {
		ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion));
		ctx.sessionProjections.register(createFallbackHeadersDefinition());
		ctx.sessionProjections.register(createFallbackActivityDefinition());
		return;
	}
	const attribution = createToolAttribution(ctx);
	watchStepIdentity(ctx);
	const coldReads = makeColdReadGate();
	const gate = watchDetailChannel(ctx, resolveBounds(config), coldReads);
	ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live));
	ctx.sessionProjections.register(createContextHeadersDefinition((name) => attribution.ownerOf(name)));
	ctx.sessionProjections.register(createContextActivityDefinition(resolveBounds(config).holidays));
	watchActivityBackfill(ctx, coldReads);
}
//#endregion
export { Config, apply, inject, name };
