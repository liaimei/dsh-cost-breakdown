/**
 * DSH Usage Meter — browser half.
 *
 * This file IS the bundle: DSH's module loader asks the boot graph for
 * `lib/client.js` and evaluates it as a plain script, so the
 * `window.__ModuleLoader__.load({ id, factory })` call below is part of the
 * source rather than something a bundler adds. `tsc` compiles it to the same
 * single file (`tsconfig.client.json`), which is why every type here is erased
 * and the emitted body stays the one the loader expects.
 *
 * `react` is the only external: the shell seeds it into the platform module
 * table, so the panel renders on the same React instance as the rest of the UI.
 */

/** One entry the module loader accepts. */
interface DshModuleLoaderEntry {
  id: string;
  /** Receives the shell's `require`; returns the module's exports. */
  factory: (require: (id: string) => unknown) => unknown;
}

// The loader is provided by the shell, not by a module this file imports, so
// there is no ambient declaration for it: this augmentation is the contract.
interface Window {
  __ModuleLoader__: { load(entry: DshModuleLoaderEntry): void };
}

/** The framework translate seat, as the slot props carry it. */
type Translate = (key: string) => string;

/** Props every slot body receives: the translate seat, plus host extras. */
interface SlotProps {
  t?: Translate;
  sessionId?: unknown;
  className?: unknown;
  size?: unknown;
  [key: string]: unknown;
}

/** What `react.createElement` returns here: an opaque node the host renders. */
type Rendered = unknown;

/**
 * The slice of React this half uses. Declared rather than imported so that
 * `react` stays the loader's external; the signatures match the hooks as called.
 */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): Rendered;
  Fragment: unknown;
  useState<T>(initial: T): [T, (next: T | ((prev: T) => T)) => void];
  useReducer<S>(reducer: (state: S) => S, initial: S): [S, () => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One rate set, as the host's price table reports it. */
interface Rate {
  cacheHit?: number;
  cacheMiss?: number;
  output?: number;
}

/** One price-table row. */
interface PriceRow {
  id: string;
  label: string;
  peak?: Rate;
  offPeak?: Rate;
}

/** One wallet, already split into its two parts by the host. */
interface Wallet {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

/** The balance section of the status payload. */
interface BalancePayload {
  source: string;
  balances: Wallet[];
}

/** The pricing period in force, and when it next flips. */
interface PeriodPayload {
  peak: boolean;
  label: string;
  next: { at: number; peak: boolean } | null;
}

/** The status route's payload. */
interface StatusPayload {
  balance: BalancePayload;
  period: PeriodPayload;
  prices: PriceRow[];
}

/** The three billed token buckets. */
interface TokenBuckets {
  input: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  total: number;
}

/** A folded cost picture, as the session route reports it. */
interface TotalsPayload {
  cost: number;
  requests: number;
  unpriced: number;
  unpricedModels: string[];
  tokens: TokenBuckets;
  byPeriod: { peak: number; offPeak: number };
}

/** One descendant session in the session route's payload. */
interface ChildSession {
  sessionId: string;
  title?: string;
  cost?: number;
  requests?: number;
}

/** The session route's payload. */
interface SessionReport {
  sessionId: string;
  title: string | null;
  own: TotalsPayload;
  children: ChildSession[];
  combined: TotalsPayload;
  lineageTruncated: boolean;
}

/** Where the floating detail card is pinned, in viewport coordinates. */
interface Anchor {
  left: number;
  top: number;
  maxHeight: number;
}

/** The per-session store every mounted surface reads through. */
interface UsageStore {
  sessionId: string;
  status: StatusPayload | null;
  report: SessionReport | null;
  error: boolean;
  loading: boolean;
  loaded: boolean;
  listeners: Set<() => void>;
  /** Status-only refresh: cheap, safe to repeat on a timer. */
  statusInFlight: Promise<void> | null;
  /** Full refresh: status + this session's report. */
  fullInFlight: Promise<void> | null;
  /** The one 1s countdown ticker for this session, shared by all surfaces. */
  countdownTimer: number | null;
  emit(): void;
  watchCountdown(deadline: number | null): void;
  refreshStatus(): Promise<void>;
  refresh(): Promise<void>;
}

/** A card's parts, as the two builders assemble them. */
interface CardParts {
  accent: string;
  title: Rendered;
  headline: Rendered;
  body: Rendered;
}

/** One legend/stack segment: a named, coloured share of a whole. */
interface Segment {
  key: string;
  label: string;
  color: string;
  value: number;
  sub: string;
}

/** The arc one donut segment draws. */
interface Arc {
  key: string;
  color: string;
  len: number;
  offset: number;
}

/** The slots service this half contributes into. */
interface SlotService {
  inject(name: string, factory: () => unknown): unknown;
  register(options: Record<string, unknown>, body: (props: SlotProps) => Rendered): unknown;
}

/** The right-Sidebar tab registry. */
interface TabService {
  register(options: Record<string, unknown>): unknown;
}

/** The fiber `ctx.inject` hands the plugin. */
interface ClientScope {
  slots: SlotService;
  sidebarRightTabs: TabService;
}

/** The client plugin context. */
interface ClientContext {
  effect(callback: () => unknown, label?: string): unknown;
  inject(services: readonly string[], callback: (scope: ClientScope) => unknown): unknown;
  locale: {
    register(namespace: string, dictionaries: Record<string, unknown>): unknown;
    bind(namespace: string): Translate;
  };
}

window.__ModuleLoader__.load({
  id: 'dsh-cost-breakdown',
  factory: (require: (id: string) => unknown) => {
    var module: { exports: Record<string, unknown> } = { exports: {} };
    var exports = module.exports;

    // `react` is the only external this bundle needs: the shell seeds it into
    // the platform module table, and the panel renders without portals.
    let react = require('react') as ReactLike;

    //#region constants
    /** Must match the host half's route table. */
    const ROUTE_STATUS = '/api/dsh-cost-breakdown/status';
    const ROUTE_SESSION = '/api/dsh-cost-breakdown/session';

    /** The right Sidebar tab this plugin contributes. */
    const TAB_ID = 'dsh-cost-breakdown';
    const TAB_KIND = 'dsh-cost-breakdown';

    /**
     * The composer-dock cell id. It is NOT the tab id: the dock slot is shared
     * with other plugins (the shipped stats cell holds id `stats`), and a fresh
     * id is added beside them, whereas reusing one would replace that cell.
     */
    const DOCK_ID = 'dsh-cost-breakdown/cost';

    /** The locale namespace; the framework synthesizes `t` for it. */
    const NS = 'dsh-cost-breakdown';

    /**
     * The semantic colour scale, taken from the shipped Context dashboard
     * (`--color-*-500`). Reusing its hues keeps a token-usage ring here reading
     * the same way as the one next to it, and the variables carry light/dark
     * variants, so nothing is hard-coded per theme.
     */
    const COLOR = {
      balance: 'var(--dcb-yellow)',
      granted: 'var(--dcb-blue)',
      toppedUp: 'var(--dcb-purple)',
      cacheHit: 'var(--dcb-green)',
      cacheMiss: 'var(--dcb-amber)',
      output: 'var(--dcb-blue)',
      reasoning: 'var(--dcb-violet)',
      peak: 'var(--dcb-red)',
      offPeak: 'var(--dcb-green)',
      own: 'var(--dcb-blue)',
      children: 'var(--dcb-purple)',
    };

    /** How often the panel re-reads the balance while it is visible. */
    const POLL_MS = 60_000;

    const DICT_ZH = {
      'tab.title': '用量与费用',
      'tab.guide': '盯住余额、峰谷价格与每个会话的花费',
      'panel.title': '用量与费用',
      'panel.loading': '读取中…',
      'balance.title': '账号余额',
      'balance.none': '未取到余额',
      'balance.hint.key':
        '未检测到 DSH 账号登录，也未配置 DEEPSEEK_API_KEY。可在「设置 → 账号与余额」登录，或在凭据里配置 API key。',
      'balance.hint.signedOut': '账号未登录，且没有可用的 API key。',
      'balance.source.account': '账号登录',
      'balance.source.api-key': 'API Key',
      'balance.source.none': '未配置',
      'balance.granted': '赠送',
      'balance.toppedUp': '充值',
      'period.title': '当前计费时段',
      'period.next': '距切换到',
      'period.peak': '峰',
      'period.offPeak': '谷',
      'period.until': '距离切换到「{next}」还有 {time}',
      'period.nextUnknown': '切换时间待定',
      'period.note': '高峰：北京时间周一至周五 09:00–12:00、14:00–18:00（法定节假日除外）；空闲时段价格为高峰的一半。',
      'price.title': '价目表',
      'price.unit': '元 / 百万 tokens',
      'price.cacheHit': '缓存命中',
      'price.cacheMiss': '缓存未命中',
      'price.output': '输出',
      'price.model': '模型',
      'price.current': '当前',
      'session.title': '本会话消耗',
      'session.none': '暂无计费请求 — 本会话还没有产生带用量的模型调用。',
      'session.noSession': '未选择会话',
      'tokens.title': 'Token 统计',
      'tokens.total': '总用量',
      'tokens.hitRate': '缓存命中 {pct}%',
      'tokens.cacheHit': '缓存命中',
      'tokens.cacheMiss': '未缓存输入',
      'tokens.output': '输出',
      'tokens.outputSub': '{n} tok 思考',
      'cost.title': '费用构成',
      'dock.title': '本会话消耗（点击展开余额与峰谷价格）',
      'dock.loading': '读取中…',
      'dock.free': '¥0.00',
      'session.unavailable': '读取不到本会话日志（可能尚未落盘）。',
      'session.total': '合计（含衍生会话）',
      'session.own': '本会话',
      'session.children': '衍生会话',
      'session.requests': '{count} 次请求',
      'session.peak': '高峰 {peak}',
      'session.offPeak': '空闲 {off}',
      'session.childCount': '{count} 个子会话',
      'session.truncated': '衍生会话过多，统计已截断',
      'session.unpriced': '{count} 次请求使用了未收录的模型，未计入费用',
      'session.tokens': '输入 {input} · 缓存 {cache} · 输出 {output}',
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.error': '读取失败',
      'common.note': '费用按 DSH 记录的 token 用量与官方价目表估算，仅供参考；实际扣费以平台账单为准。',
      'common.currency': '元',
      'common.unknown': '未知',
    };

    const DICT_EN = {
      'tab.title': 'Usage & Cost',
      'tab.guide': 'Balance, peak/off-peak pricing, and per-session spend',
      'panel.title': 'Usage & Cost',
      'panel.loading': 'Loading…',
      'balance.title': 'Account balance',
      'balance.none': 'No balance',
      'balance.hint.key':
        'No DSH account sign-in and no DEEPSEEK_API_KEY. Sign in under Settings → Account & balance, or configure an API key.',
      'balance.hint.signedOut': 'The account is signed out and no API key is available.',
      'balance.source.account': 'Account',
      'balance.source.api-key': 'API key',
      'balance.source.none': 'Not configured',
      'balance.granted': 'Granted',
      'balance.toppedUp': 'Topped up',
      'period.title': 'Current pricing period',
      'period.next': 'switches to',
      'period.peak': 'Peak',
      'period.offPeak': 'Valley',
      'period.until': '{time} until it switches to “{next}”',
      'period.nextUnknown': 'Next switch unknown',
      'period.note':
        'Peak: Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time, excluding public holidays. Off-peak is half the peak rate.',
      'price.title': 'Price list',
      'price.unit': 'CNY / 1M tokens',
      'price.cacheHit': 'Cache hit',
      'price.cacheMiss': 'Cache miss',
      'price.output': 'Output',
      'price.model': 'Model',
      'price.current': 'now',
      'session.title': 'This session',
      'session.none': 'No billed requests yet — this session has made no model call reporting usage.',
      'session.noSession': 'No session selected',
      'tokens.title': 'Token usage',
      'tokens.total': 'total',
      'tokens.hitRate': 'cache hit {pct}%',
      'tokens.cacheHit': 'Cached input',
      'tokens.cacheMiss': 'Uncached input',
      'tokens.output': 'Output',
      'tokens.outputSub': '{n} tok reasoning',
      'cost.title': 'Cost breakdown',
      'dock.title': 'This session\u2019s spend (click for balance and peak/off-peak pricing)',
      'dock.loading': 'Loading\u2026',
      'dock.free': '¥0.00',
      'session.unavailable': 'This session log could not be read (it may not be persisted yet).',
      'session.total': 'Total (with descendants)',
      'session.own': 'This session',
      'session.children': 'Descendants',
      'session.requests': '{count} requests',
      'session.peak': 'peak {peak}',
      'session.offPeak': 'off-peak {off}',
      'session.childCount': '{count} child sessions',
      'session.truncated': 'Too many descendants — the walk was truncated',
      'session.unpriced': '{count} requests used an unlisted model and are not priced',
      'session.tokens': 'in {input} · cache {cache} · out {output}',
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.error': 'Read failed',
      'common.note': 'Costs are estimated from DSH-recorded token usage and the official price table. Platform billing is authoritative.',
      'common.currency': 'CNY',
      'common.unknown': 'unknown',
    };
    //#endregion

    //#region styles
    const CSS = `
/* The semantic scale this plugin's charts use. Declared here rather than
   inherited: these variables are NOT part of DSH's own token set — they come
   from another plugin's global :root — so depending on them would silently
   break the moment that plugin is disabled. Values are the standard OKLCH
   ramp (the same one that plugin uses), which keeps the hues familiar. */
:root,:host{
--dcb-red:oklch(63.7% .237 25.331);
--dcb-orange:oklch(70.5% .213 47.604);
--dcb-amber:oklch(76.9% .188 70.08);
--dcb-yellow:oklch(79.5% .184 86.047);
--dcb-green:oklch(72.3% .219 149.579);
--dcb-teal:oklch(70.4% .14 182.503);
--dcb-blue:oklch(62.3% .214 259.815);
--dcb-indigo:oklch(58.5% .233 277.117);
--dcb-violet:oklch(60.6% .25 292.717);
--dcb-purple:oklch(62.7% .265 303.9);
--dcb-pink:oklch(65.6% .241 354.308);
--dcb-neutral:oklch(55.6% 0 none);
}
.dcb-root{display:flex;flex-direction:column;gap:14px;padding:14px;font-size:var(--dsl-g-font-title,13px);color:var(--dsw-alias-label-primary);overflow-y:auto;height:100%;box-sizing:border-box}
.dcb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 13px;display:flex;flex-direction:column;gap:9px;flex:0 0 auto}
.dcb-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dcb-title{font-weight:650;font-size:var(--dsl-g-font-title,13px);color:var(--dsw-alias-label-primary)}
.dcb-sub{font-size:var(--dsl-g-font-meta,11px);color:var(--dsw-alias-label-secondary)}
.dcb-hero{font-family:var(--dsl-g-font-mono,ui-monospace,monospace);font-size:26px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);display:flex;align-items:baseline;gap:6px;flex:0 0 auto}
.dcb-hero small{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dcb-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-variant-numeric:tabular-nums;flex:0 0 auto}
.dcb-k{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:var(--dsl-g-font-meta,11px)}
.dcb-v{font-family:var(--dsl-g-font-mono,ui-monospace,monospace);font-weight:600}
.dcb-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:650;line-height:14px;border:1px solid transparent}
.dcb-badge-peak{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent)}
.dcb-badge-off{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,transparent)}
.dcb-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;flex:0 0 auto}
.dcb-table th{text-align:right;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:3px 5px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dcb-table th:first-child,.dcb-table td:first-child{text-align:left;padding-right:12px}
.dcb-table th:last-child,.dcb-table td:last-child{padding-right:2px}
/* The rate columns carry their bucket's colour, so 缓存命中 / 未缓存输入 / 输出
   read as the same three subjects the ring legend above names. */
.dcb-table td.dcb-rate-0{color:var(--dcb-green)}
.dcb-table td.dcb-rate-1{color:var(--dcb-amber)}
.dcb-table td.dcb-rate-2{color:var(--dcb-blue)}
.dcb-table td{text-align:right;padding:4px 5px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 45%,transparent);font-family:var(--dsl-g-font-mono,ui-monospace,monospace);font-size:11.5px}
.dcb-table tr:last-child td{border-bottom:none}
.dcb-current{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dcb-btn{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;padding:3px 10px;transition:color .15s,border-color .15s}
.dcb-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dcb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcb-btn:disabled{opacity:.5;cursor:default}
.dcb-hint{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
/* The countdown sits under the period badge and takes the period's own colour, so
   the current window reads at a glance instead of only from the badge. */
.dcb-until{display:flex;align-items:center;gap:5px;font-size:11.5px;line-height:1.5;font-variant-numeric:tabular-nums;flex:0 0 auto}
.dcb-bar{height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);overflow:hidden}
.dcb-bar>span{display:block;height:100%;border-radius:2px}
.dcb-err{font-size:11.5px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:7px;padding:6px 9px;flex:0 0 auto}
.dcb-child{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:3px 0;flex:0 0 auto}
.dcb-childRow{display:flex;flex-direction:column;gap:4px;flex:0 0 auto}
.dcb-child .dcb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dcb-bar{height:4px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);overflow:hidden}
.dcb-bar>span{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:2px}
.dcb-scroll{max-height:190px;overflow-y:auto;flex:0 0 auto}
.dcb-mono{font-family:var(--dsl-g-font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
/* Composer-dock readout: a quiet one-line cell matching the shipped stats row,
   with its detail card floating above it. The card reuses the shipped context
   meter's own surface tokens (menu background + backdrop + prominent elevation)
   so the two panels are visually indistinguishable. */
.dcb-dock{position:relative;display:inline-flex;align-items:center}
.dcb-dockTrigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dcb-dockTrigger:hover,.dcb-dockTrigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dcb-dockTrigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dcb-dockValue{color:var(--dsw-alias-label-secondary);font-weight:500}
.dcb-dockSep{color:var(--dsw-alias-label-tertiary);opacity:.45}
.dcb-dockCaret{font-size:8px;opacity:.7}
.dcb-detail{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(380px,100vw - 24px);max-height:min(70vh,560px);overflow-y:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:fixed;display:flex;flex-direction:column;gap:7px;text-align:left}
.dcb-sep{height:1px;background:var(--dsw-alias-border-l1);margin:1px 0}
/* Dashboard language borrowed from the shipped Context panel: layered cards,
   an 11px uppercase-ish label voice, tabular numerals, and semantic colour dots
   whose hues come from the same --color-*-500 scale that panel uses. */
.dcb-card2{position:relative;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;display:flex;flex-direction:column;gap:8px;padding:9px 11px 10px;flex:0 0 auto}
/* A soft tint behind the heading names the card's subject without adding a
   coloured bar down the side. */
.dcb-card2>.dcb-head2{background:linear-gradient(90deg,color-mix(in srgb,var(--dcb-accent,transparent) 12%,transparent),transparent 70%);border-radius:6px;margin:-2px -4px 0;padding:2px 4px}
.dcb-card2[data-accent="balance"]>.dcb-head2{--dcb-accent:var(--dcb-yellow)}
.dcb-card2[data-accent="granted"]>.dcb-head2{--dcb-accent:var(--dcb-blue)}
.dcb-card2[data-accent="toppedUp"]>.dcb-head2{--dcb-accent:var(--dcb-purple)}
.dcb-card2[data-accent="tokens"]>.dcb-head2{--dcb-accent:var(--dcb-green)}
.dcb-card2[data-accent="cost"]>.dcb-head2{--dcb-accent:var(--dcb-blue)}
.dcb-card2[data-accent="children"]>.dcb-head2{--dcb-accent:var(--dcb-purple)}
.dcb-card2[data-accent="price"]>.dcb-head2{--dcb-accent:var(--dcb-teal)}
.dcb-card2[data-accent="peak"]>.dcb-head2{--dcb-accent:var(--dcb-red)}
.dcb-card2[data-accent="offPeak"]>.dcb-head2{--dcb-accent:var(--dcb-green)}
/* A row of headline figures, one tile per number. */
.dcb-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px;flex:0 0 auto}
.dcb-tile{border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:2px;min-width:0;background:color-mix(in srgb,var(--dcb-tile,var(--dcb-blue)) 12%,transparent);border:1px solid color-mix(in srgb,var(--dcb-tile,var(--dcb-blue)) 26%,transparent)}
.dcb-tileLabel{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcb-tileValue{font-size:16px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;color:var(--dcb-tile,var(--dsw-alias-label-primary));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcb-tileSub{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcb-tile[data-tone="balance"]{--dcb-tile:var(--dcb-yellow)}
.dcb-tile[data-tone="granted"]{--dcb-tile:var(--dcb-blue)}
.dcb-tile[data-tone="toppedUp"]{--dcb-tile:var(--dcb-purple)}
.dcb-tile[data-tone="peak"]{--dcb-tile:var(--dcb-red)}
.dcb-tile[data-tone="offPeak"]{--dcb-tile:var(--dcb-green)}
.dcb-head2{display:flex;align-items:baseline;gap:8px}
/* Collapsible cards, following the shipped Context browser: a chevron-led header
   row that toggles a body. A collapsed card stays one line, so a reader who only
   wants the headline never scrolls past detail they did not ask for. */
.dcb-body{display:flex;flex-direction:column;gap:8px;min-width:0}
.dcb-head2 .dcb-h2{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}
.dcb-head2 .dcb-h2v{margin-left:auto;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.dcb-hero2{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.dcb-hero2 small{margin-left:5px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600}
.dcb-split{display:flex;align-items:center;gap:12px;flex:0 0 auto}
.dcb-donut{position:relative;flex:none;width:76px;height:76px}
.dcb-donut svg{display:block;width:100%;height:100%}
.dcb-donutTrack{fill:none;stroke:color-mix(in srgb,var(--dcb-neutral) 18%,transparent);stroke-width:4}
.dcb-donutSeg{fill:none;stroke-width:4;transition:opacity .2s ease-in-out}
.dcb-donutCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;text-align:center;pointer-events:none;padding:0 7px;box-sizing:border-box}
.dcb-donutTotal{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
.dcb-donutCap{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1.2}
.dcb-legend{display:grid;grid-template-columns:1fr;gap:4px;flex:1;min-width:0}
.dcb-lrow{display:flex;flex-direction:column;gap:1px;min-width:0;border-radius:6px;padding:1px 4px;margin:0 -4px;font-size:12px;transition:background-color .2s ease-in-out}
.dcb-lrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dcb-lmain{display:flex;align-items:center;gap:6px;min-width:0}
.dcb-ldot{width:8px;height:8px;border-radius:2px;flex:none}
.dcb-llabel{flex:auto;min-width:0;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcb-lpct{flex:none;min-width:34px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums}
.dcb-lsub{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.3;margin-left:14px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcb-meter{display:flex;flex-direction:column;gap:5px}
.dcb-meterRow{display:flex;align-items:baseline;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcb-meterRow .dcb-mv{margin-left:auto;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600}
.dcb-stack{display:flex;height:8px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dcb-neutral) 18%,transparent)}
.dcb-stack>span{display:block;height:100%}
/* Text coloured with the 500-step ramp is fine on the dark surface but too light
   on the light one (yellow especially). These 600/700 steps keep every label
   readable in both themes; the chart fills keep using the 500 steps above,
   because a fill only needs to be distinguishable, not legible as text. */
body:not([data-ds-dark-theme]){
--dcb-red:#c81e1e;
--dcb-orange:#c2410c;
--dcb-amber:#a16207;
--dcb-yellow:#a16207;
--dcb-green:#15803d;
--dcb-teal:#0f766e;
--dcb-blue:#1d4ed8;
--dcb-indigo:#4338ca;
--dcb-violet:#6d28d9;
--dcb-purple:#7e22ce;
--dcb-pink:#be185d;
}
`;

    /**
     * Keep the injected stylesheet in step with this bundle.
     *
     * It must REPLACE the tag's content when it differs, not just skip an
     * existing tag: a hot-reloaded bundle re-runs `apply()` in a page that still
     * holds the previous version's <style>. Skipping it left every CSS change
     * invisible until a full page reload — which is exactly how a correctly
     * shipped fix can still look broken on screen.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      const key = 'dsh-cost-breakdown/styles';
      const existing = document.getElementById(key);
      if (existing !== null) {
        // Reusing the tag keeps one stylesheet per page rather than stacking them.
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const element = document.createElement('style');
      element.id = key;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    /** Inline SVG icons: a small gauge, drawn in `currentColor`. */
    function GaugeIcon(props: SlotProps) {
      const size = typeof props.size === 'number' ? props.size : 16;
      // The guide hands its glyph a `className` so a registered icon can opt
      // into the placeholder ink; forward it rather than swallowing it.
      const className = typeof props.className === 'string' ? props.className : undefined;
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          ...(className === undefined ? {} : { className }),
        },
        react.createElement('path', {
          d: 'M2.2 12.3a6.5 6.5 0 1 1 11.6 0',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
        }),
        react.createElement('path', {
          d: 'M8 12.3 11 7.6',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
        }),
        react.createElement('circle', { cx: 8, cy: 12.3, r: 1.15, fill: 'currentColor' }),
      );
    }
    //#endregion

    //#region formatting
    /** Format one CNY amount, keeping small values readable. */
    function money(value: unknown, digits?: number): string {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (n === 0) return '0.00';
      if (n < 0.01) return n.toFixed(4);
      if (n < 1) return n.toFixed(3);
      return n.toFixed(digits ?? 2);
    }

    /** Compact token counts (13102 -> 13.1K). */
    function compact(value: unknown): string {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (n < 1000) return String(Math.round(n));
      if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
      return `${(n / 1_000_000).toFixed(2)}M`;
    }

    /** A countdown like "2 小时 5 分". */
    function countdown(ms: number): string {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return `${hours} 小时 ${minutes} 分`;
      if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
      return `${seconds} 秒`;
    }

    //#endregion

    //#region host reads
    /** One POST to a host route; resolves null on any failure. */
    async function post(path: string, body?: unknown): Promise<unknown> {
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as { ok?: unknown; value?: unknown } | null;
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) return null;
        return payload.value ?? null;
      } catch {
        return null;
      }
    }
    //#endregion

    //#region shared store
    /**
     * One read cycle shared by every surface this plugin renders.
     *
     * The cost of a session is folded from its whole event log (plus its
     * descendants'), so two independent surfaces each polling would double that
     * work and could show different numbers side by side. Instead one store per
     * session id holds the state, reads at most once at a time, and notifies
     * every subscriber that changed.
     */
    const stores = new Map<string, UsageStore>();

    function storeFor(sessionId: string): UsageStore {
      const existing = stores.get(sessionId);
      if (existing !== undefined) return existing;
      const store = {
        sessionId,
        status: null,
        report: null,
        error: false,
        loading: false,
        loaded: false,
        listeners: new Set<() => void>(),
        /** Status-only refresh: cheap, safe to repeat on a timer. */
        statusInFlight: null,
        /** Full refresh: status + this session's report. */
        fullInFlight: null,
        /** The one 1s countdown ticker for this session, shared by all surfaces. */
        countdownTimer: null,
      } as UsageStore;
      store.emit = () => {
        for (const listener of [...store.listeners]) {
          try {
            listener();
          } catch {
            /* one surface failing must not stop the others */
          }
        }
      };
      /**
       * Re-render subscribers once per second while a counted-down instant is in
       * range, so `period.until` ticks in every surface that shows it rather than
       * only in whichever one happened to own a ticker.
       */
      store.watchCountdown = (deadline) => {
        if (store.countdownTimer !== null) clearInterval(store.countdownTimer);
        if (deadline === null) {
          store.countdownTimer = null;
          return;
        }
        store.countdownTimer = setInterval(() => {
          if (Date.now() >= deadline) {
            clearInterval(store.countdownTimer as number);
            store.countdownTimer = null;
            // The window just flipped: re-read so the badge and rates follow.
            void store.refreshStatus();
            return;
          }
          store.emit();
        }, 1_000);
      };
      store.refreshStatus = () => {
        if (store.statusInFlight !== null) return store.statusInFlight;
        store.statusInFlight = (async () => {
          const next = (await post(ROUTE_STATUS)) as StatusPayload | null;
          // A failed poll keeps the last good figure rather than blanking it.
          if (next !== null) {
            store.status = next;
            store.emit();
          }
          store.statusInFlight = null;
        })();
        return store.statusInFlight;
      };
      store.refresh = () => {
        if (store.fullInFlight !== null) return store.fullInFlight;
        store.loading = true;
        store.emit();
        store.fullInFlight = (async () => {
          const nextStatus = (await post(ROUTE_STATUS)) as StatusPayload | null;
          store.status = nextStatus ?? store.status;
          store.error = nextStatus === null;
          if (sessionId !== '') store.report = (await post(ROUTE_SESSION, { sessionId })) as SessionReport | null;
          else store.report = null;
          store.loading = false;
          store.loaded = true;
          store.emit();
          store.fullInFlight = null;
        })();
        return store.fullInFlight;
      };
      stores.set(sessionId, store);
      return store;
    }

    /** Subscribe one component to a session store, reading it once on mount. */
    function useUsageStore(sessionId: string): UsageStore {
      const store = react.useMemo(() => storeFor(sessionId), [sessionId]);
      const [, bump] = react.useReducer((value) => value + 1, 0);
      react.useEffect(() => {
        const listener = () => bump();
        store.listeners.add(listener);
        return () => {
          store.listeners.delete(listener);
          // Drop a store no surface is watching, so a long session list cannot
          // accumulate one entry per session ever opened.
          if (store.listeners.size === 0) stores.delete(sessionId);
        };
      }, [store, sessionId, bump]);
      react.useEffect(() => {
        void store.refresh();
      }, [store]);
      // Balance only, on a timer: it moves with every request the harness bills,
      // while the report is far too heavy to re-fold every minute.
      react.useEffect(() => {
        const id = setInterval(() => void store.refreshStatus(), POLL_MS);
        return () => clearInterval(id);
      }, [store]);
      // One shared countdown ticker for the window in force, so every surface
      // that prints the remaining time stays live.
      const deadline = store.status?.period?.next?.at ?? null;
      react.useEffect(() => {
        store.watchCountdown(typeof deadline === 'number' ? deadline : null);
        return () => store.watchCountdown(null);
      }, [store, deadline]);
      return store;
    }
    //#endregion

    //#region panel
    /** One balance line per currency. */
    function balancesOf(balance: BalancePayload | null): Wallet[] {
      if (balance === null || typeof balance !== 'object' || !Array.isArray(balance.balances)) return [];
      return balance.balances.filter(
        (row) => row !== null && typeof row === 'object' && typeof row.currency === 'string' &&
          typeof row.total === 'number' && Number.isFinite(row.total),
      );
    }

    /**
     * Stable fallback translate. It must be module-level, not an inline arrow:
     * the value lands in effect dependency arrays, and a fresh function identity
     * on every render would re-run those effects forever.
     */
    function identityTranslate(key: string): string {
      return key;
    }

    /** Resolve the framework translate seat, or the stable fallback. */
    function translateOf(props: SlotProps): Translate {
      return typeof props.t === 'function' ? props.t : identityTranslate;
    }

    /**
     * The panel body. Root-scoped through the Sidebar tab it is registered into:
     * `props.sessionId` is present whenever the session is live, and the balance
     * and pricing sections render regardless.
     */
    function UsagePanel(props: SlotProps) {
      const t = translateOf(props);
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : '';
      // One shared store per session: the composer dock and this panel read the
      // same numbers through it, so they cannot disagree and only one read cycle
      // runs per session no matter how many surfaces are mounted.
      const store = useUsageStore(sessionId);
      const status: StatusPayload | null = store.status;
      const session: SessionReport | null = store.report;
      const error = store.error === true ? t('common.error') : '';
      const busy = store.loading === true;
      const load = () => {
        void store.refresh();
      };

      const period: PeriodPayload | null = status?.period ?? null;

      // Each wallet renders its own currency symbol, so the payment status's
      // `currency` field is not read here.
      /** Wrap one card's parts in the shared collapsible chrome. */
      const panelCard = (parts: CardParts | null, key: string): Rendered =>
        parts === null
          ? null
          : react.createElement(
              Card,
              {
                key,
                accent: parts.accent,
                title: parts.title,
                headline: parts.headline,
              },
              parts.body,
            );

      const balances = balancesOf(status?.balance ?? null);
      const source = status?.balance?.source ?? 'none';
      const prices: PriceRow[] = Array.isArray(status?.prices) ? status.prices : [];
      const activePeriod = period !== null && period.peak === true;
      const rateKey = activePeriod ? 'peak' : 'offPeak';

      const combined = session?.combined ?? null;
      const own = session?.own ?? null;
      const children: ChildSession[] = Array.isArray(session?.children) ? session.children : [];
      const unpriced = typeof combined?.unpriced === 'number' ? combined.unpriced : 0;
      const unpricedModels = Array.isArray(combined?.unpricedModels) ? combined.unpricedModels : [];
      const childTotal = children.reduce((sum, child) => sum + (typeof child.cost === 'number' ? child.cost : 0), 0);
      const maxChild = children.reduce((max, child) => Math.max(max, child.cost ?? 0), 0);

      const children_: Rendered[] = [];
      children_.push(
        react.createElement(
          'div',
          { className: 'dcb-card', key: 'balance' },
          react.createElement(
            'div',
            { className: 'dcb-head' },
            react.createElement('div', { className: 'dcb-title' }, t('balance.title')),
            react.createElement(
              'span',
              { className: 'dcb-sub' },
              t(`balance.source.${source === 'account' || source === 'api-key' ? source : 'none'}`),
            ),
          ),
          balances.length > 0
            ? balances.map((row, index) =>
                react.createElement(
                  'div',
                  { key: `b${index}`, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                  react.createElement(
                    'div',
                    { className: 'dcb-hero', style: { color: COLOR.balance } },
                    money(row.total),
                    react.createElement('small', null, row.currency === 'CNY' ? '¥' : '$'),
                  ),
                  react.createElement(
                    'div',
                    { className: 'dcb-row' },
                    react.createElement(
                      'span',
                      { className: 'dcb-k' },
                      react.createElement('span', { className: 'dcb-ldot', style: { background: COLOR.granted } }),
                      t('balance.granted'),
                    ),
                    react.createElement('span', { className: 'dcb-v', style: { color: COLOR.granted } }, money(row.granted)),
                  ),
                  react.createElement(
                    'div',
                    { className: 'dcb-row' },
                    react.createElement(
                      'span',
                      { className: 'dcb-k' },
                      react.createElement('span', { className: 'dcb-ldot', style: { background: COLOR.toppedUp } }),
                      t('balance.toppedUp'),
                    ),
                    react.createElement('span', { className: 'dcb-v', style: { color: COLOR.toppedUp } }, money(row.toppedUp)),
                  ),
                ),
              )
            : react.createElement('div', { className: 'dcb-sub' }, t('balance.none')),
          balances.length === 0 && source === 'none'
            ? react.createElement('div', { className: 'dcb-hint' }, t('balance.hint.key'))
            : null,
          balances.length === 0 && source === 'account'
            ? react.createElement('div', { className: 'dcb-hint' }, t('balance.hint.signedOut'))
            : null,
        ),
      );

      if (period !== null) {
        const remaining = period.next !== null ? period.next.at - Date.now() : null;
        children_.push(
          react.createElement(
            'div',
            { className: 'dcb-card', key: 'period' },
            react.createElement(
              'div',
              { className: 'dcb-head' },
              react.createElement('div', { className: 'dcb-title' }, t('period.title')),
              react.createElement(
                'span',
                { className: `dcb-badge ${activePeriod ? 'dcb-badge-peak' : 'dcb-badge-off'}` },
                activePeriod ? t('period.peak') : t('period.offPeak'),
              ),
            ),
            remaining !== null
              ? react.createElement(
                  'div',
                  { className: 'dcb-hint', style: { color: activePeriod ? COLOR.peak : COLOR.offPeak } },
                  t('period.until')
                    .replace('{next}', period.next!.peak ? t('period.peak') : t('period.offPeak'))
                    .replace('{time}', countdown(remaining)),
                )
              : react.createElement('div', { className: 'dcb-hint' }, t('period.nextUnknown')),
            react.createElement('div', { className: 'dcb-hint' }, t('period.note')),
          ),
        );
      }

      if (prices.length > 0) {
        children_.push(
          react.createElement(
            'div',
            { className: 'dcb-card', key: 'prices' },
            react.createElement(
              'div',
              { className: 'dcb-head' },
              react.createElement(
                'div',
                { className: 'dcb-title' },
                // The table lists the period in force, so say which one that is.
                `${t('price.title')} · ${activePeriod ? t('period.peak') : t('period.offPeak')}`,
              ),
              react.createElement('span', { className: 'dcb-sub' }, t('price.unit')),
            ),
            react.createElement(
              'table',
              { className: 'dcb-table' },
              react.createElement(
                'thead',
                null,
                react.createElement(
                  'tr',
                  null,
                  react.createElement('th', null, t('price.model')),
                  react.createElement('th', null, t('price.cacheHit')),
                  react.createElement('th', null, t('price.cacheMiss')),
                  react.createElement('th', null, t('price.output')),
                ),
              ),
              react.createElement(
                'tbody',
                null,
                prices.map((row) => {
                  const rates = row[rateKey] ?? row.offPeak ?? {};
                  return react.createElement(
                    'tr',
                    { key: row.id },
                    react.createElement('td', null, row.label ?? row.id),
                    react.createElement('td', { className: 'dcb-rate-0' }, rates.cacheHit),
                    react.createElement('td', { className: 'dcb-rate-1' }, rates.cacheMiss),
                    react.createElement('td', { className: 'dcb-rate-2' }, rates.output),
                  );
                }),
              ),
            ),
          ),
        );
      }

      children_.push(
        react.createElement(
          'div',
          { className: 'dcb-card', key: 'session' },
          react.createElement(
            'div',
            { className: 'dcb-head' },
            react.createElement('div', { className: 'dcb-title' }, t('session.title')),
            react.createElement(
              'button',
              { className: 'dcb-btn', type: 'button', onClick: load, disabled: busy },
              busy ? t('panel.loading') : t('common.refresh'),
            ),
          ),
          error !== '' ? react.createElement('div', { className: 'dcb-err' }, error) : null,
          // The same two cards the composer dock shows, in the same collapsible
          // form, so the two surfaces present identical figures identically.
          panelCard(makeTokenCard({ t, combined }), 'tokens'),
          panelCard(makeCostCard({ t, combined, own, children }), 'cost'),
          sessionId === ''
            ? react.createElement('div', { className: 'dcb-sub' }, t('session.noSession'))
            : null,
          sessionId !== '' && busy === true && combined === null
            ? react.createElement('div', { className: 'dcb-sub' }, t('panel.loading'))
            : null,
          combined !== null && combined.requests > 0
            ? react.createElement(
                react.Fragment,
                null,
                // The cost card above owns the totals and splits; this keeps only
                // the per-child detail and the caveats, so no figure appears twice.
                children.length > 0
                  ? react.createElement(
                      'div',
                      { className: 'dcb-sub' },
                      `${t('session.children')} · ${t('session.childCount').replace('{count}', String(children.length))} · ¥${money(childTotal)}`,
                    )
                  : null,
                session!.lineageTruncated === true
                  ? react.createElement('div', { className: 'dcb-hint' }, t('session.truncated'))
                  : null,
                unpriced > 0
                  ? react.createElement(
                      'div',
                      { className: 'dcb-hint' },
                      t('session.unpriced').replace('{count}', String(unpriced)) +
                        (unpricedModels.length > 0 ? ` (${unpricedModels.join(', ')})` : ''),
                    )
                  : null,
              )
            : combined === null
              ? sessionId !== '' && busy === false
                // The read landed but produced no report: say so rather than
                // rendering nothing, which reads as a broken panel.
                ? react.createElement('div', { className: 'dcb-sub' }, t('session.unavailable'))
                : null
              : react.createElement('div', { className: 'dcb-sub' }, t('session.none')),
        ),
      );

      if (children.length > 0) {
        // The same card the dock shows, with the same ¥ prefix — the panel used to
        // print a bare number where the dock printed a priced one.
        children_.push(
          react.createElement(
            Card,
            {
              key: 'children',
              accent: 'children',
              title: react.createElement('span', { className: 'dcb-h2' }, t('session.children')),
              headline: t('session.childCount').replace('{count}', String(children.length)),
            },
            react.createElement(
              'div',
              { className: 'dcb-scroll' },
              children.map((child, index) =>
                react.createElement(
                  'div',
                  { key: child.sessionId ?? index, className: 'dcb-childRow' },
                  react.createElement(
                    'div',
                    { className: 'dcb-child' },
                    react.createElement(
                      'span',
                      { className: 'dcb-name', title: child.title ?? child.sessionId },
                      child.title ?? child.sessionId,
                    ),
                    react.createElement(
                      'span',
                      { className: 'dcb-v', style: { color: COLOR.children } },
                      `¥${money(child.cost ?? 0)}`,
                    ),
                  ),
                  maxChild > 0
                    ? react.createElement(
                        'div',
                        { className: 'dcb-bar' },
                        react.createElement('span', {
                          style: {
                            width: `${Math.max(2, Math.round(((child.cost ?? 0) / maxChild) * 100))}%`,
                            background: COLOR.children,
                          },
                        }),
                      )
                    : null,
                ),
              ),
            ),
          ),
        );
      }

      children_.push(react.createElement('div', { className: 'dcb-hint', key: 'note' }, t('common.note')));

      return react.createElement('div', { className: 'dcb-root' }, children_);
    }

    //#region dashboard parts
    /**
     * A donut built the way the shipped Context panel builds its own: one SVG
     * circle per segment on a `viewBox 0 0 42 42` with `r = 15.9155`, which makes
     * the circumference exactly 100 so dash lengths read directly as percentages.
     */
    function Donut({ size, total, caption, segments }: {
      size: number;
      total?: unknown;
      caption: { value: unknown; label: string };
      segments: Segment[];
    }) {
      const sum = segments.reduce((acc, part) => acc + (part.value > 0 ? part.value : 0), 0);
      const live = sum > 0 ? segments.filter((part) => part.value > 0) : [];
      let offset = 25;
      const arcs: Arc[] = live.map((part) => {
        const len = (part.value / sum) * 100;
        const arc = { key: part.key, color: part.color, len, offset };
        offset -= len;
        return arc;
      });
      return react.createElement(
        'div',
        { className: 'dcb-donut', style: { width: size, height: size } },
        react.createElement(
          'svg',
          { viewBox: '0 0 42 42', 'aria-hidden': 'true' },
          arcs.length === 0
            ? react.createElement('circle', { className: 'dcb-donutTrack', cx: 21, cy: 21, r: 15.9155 })
            : arcs.map((arc) =>
                react.createElement('circle', {
                  key: arc.key,
                  className: 'dcb-donutSeg',
                  cx: 21,
                  cy: 21,
                  r: 15.9155,
                  stroke: arc.color,
                  strokeDasharray: `${arc.len} ${100 - arc.len}`,
                  strokeDashoffset: arc.offset,
                  transform: 'rotate(-90 21 21)',
                }),
              ),
        ),
        react.createElement(
          'div',
          { className: 'dcb-donutCenter' },
          react.createElement('div', { className: 'dcb-donutTotal' }, caption.value),
          react.createElement('div', { className: 'dcb-donutCap' }, caption.label),
        ),
      );
    }

    /** One legend row: dot, label, share, and a smaller detail line beneath. */
    function LegendRow({ part, share }: { part: Segment; share: number }) {
      return react.createElement(
        'div',
        { className: 'dcb-lrow' },
        react.createElement(
          'div',
          { className: 'dcb-lmain' },
          react.createElement('span', { className: 'dcb-ldot', style: { background: part.color } }),
          react.createElement('span', { className: 'dcb-llabel' }, part.label),
          react.createElement('span', { className: 'dcb-lpct' }, `${share}%`),
        ),
        part.sub ? react.createElement('div', { className: 'dcb-lsub' }, part.sub) : null,
      );
    }

    /**
     * One headline tile: a small coloured slab carrying a label, a big number,
     * and an optional sub-line. `tone` picks the hue from the shared scale.
     */
    function Tile({ tone, label, value, sub }: { tone: string; label: string; value: unknown; sub?: unknown }) {
      return react.createElement(
        'div',
        { className: 'dcb-tile', 'data-tone': tone },
        react.createElement('span', { className: 'dcb-tileLabel' }, label),
        react.createElement('span', { className: 'dcb-tileValue' }, value),
        sub === undefined ? null : react.createElement('span', { className: 'dcb-tileSub' }, sub),
      );
    }

    /**
     * A titled card: heading on the left (with its subject tint), a headline figure
     * on the right, and the body beneath. The heading is text, not a control — the
     * card has no folded state, so every figure it reports is always on screen.
     */
    function Card({ accent, title, headline, children }: {
      accent: string;
      title: Rendered;
      headline?: Rendered;
      children?: Rendered;
    }) {
      return react.createElement(
        'div',
        { className: 'dcb-card2', 'data-accent': accent },
        react.createElement(
          'div',
          { className: 'dcb-head2' },
          title,
          headline === undefined ? null : react.createElement('span', { className: 'dcb-h2v' }, headline),
        ),
        react.createElement('div', { className: 'dcb-body' }, children),
      );
    }

    /** A stacked bar with a caption row, used for the period split. */
    function StackBar({ total, segments }: { total?: unknown; segments: Segment[] }) {
      const sum = segments.reduce((acc, part) => acc + part.value, 0);
      return react.createElement(
        'div',
        { className: 'dcb-stack' },
        sum <= 0
          ? null
          : segments
              .filter((part) => part.value > 0)
              .map((part) =>
                react.createElement('span', {
                  key: part.key,
                  style: { width: `${(part.value / sum) * 100}%`, background: part.color },
                  title: part.label,
                }),
              ),
      );
    }
    //#endregion

    /** The tab chip's title: a gauge plus the localized label. */
    function UsageTabTitle(props: SlotProps) {
      const t = translateOf(props);
      return react.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        react.createElement(GaugeIcon, { size: 14 }),
        react.createElement('span', null, t('tab.title')),
      );
    }
    //#endregion

    //#region bottom bar
    /**
     * The composer dock readout: this session's spend, sitting beside the shipped
     * stats cell under the composer. It is the always-visible surface — the same
     * store also feeds the right-Sidebar panel, so both agree and only one read
     * cycle runs.
     *
     * Keeping it cheap matters here: it renders on every composer frame, so the
     * trigger is a single line of text and the detail panel is built only while
     * open.
     */
    function UsageDock(props: SlotProps) {
      const t = translateOf(props);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const store = useUsageStore(sessionId);
      const [open, setOpen] = react.useState(false);
      const [anchor, setAnchor] = react.useState<Anchor | null>(null);
      const rootRef = react.useRef<{ contains(target: unknown): boolean } | null>(null);
      const buttonRef = react.useRef<{ getBoundingClientRect(): DOMRect } | null>(null);
      const panelRef = react.useRef<{ getBoundingClientRect(): DOMRect; contains(target: unknown): boolean } | null>(null);

      // The card uses the shipped menu surface, which is `position: fixed`, so it
      // can escape the composer's overflow clipping. That means measuring the
      // trigger and pinning the card above it, flipped into the viewport when
      // there is no room above.
      const place = react.useCallback(() => {
        const button = buttonRef.current;
        if (button === null || typeof button.getBoundingClientRect !== 'function') return;
        const rect = button.getBoundingClientRect();
        const panel = panelRef.current;
        const height = panel === null ? 320 : panel.getBoundingClientRect().height;
        const above = rect.top - height - 10;
        const flip = above < 8;
        setAnchor({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - (panel?.getBoundingClientRect().width ?? 380) - 8)),
          top: flip ? rect.bottom + 10 : above,
          maxHeight: flip ? Math.max(160, window.innerHeight - rect.bottom - 20) : Math.max(160, rect.top - 18),
        });
      }, []);

      react.useEffect(() => {
        if (!open) {
          setAnchor(null);
          return undefined;
        }
        // First pass runs before the card is in the DOM, so it uses fallback
        // dimensions; the second pass measures the real card once committed.
        place();
        const settle = setTimeout(place, 0);
        const onResize = () => place();
        window.addEventListener('resize', onResize);
        window.addEventListener('scroll', onResize, true);
        return () => {
          clearTimeout(settle);
          window.removeEventListener('resize', onResize);
          window.removeEventListener('scroll', onResize, true);
        };
      }, [open, place]);

      // Close on an outside pointer press or Escape, the same dismissal contract
      // the shipped context meter uses for its own panel.
      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event: { target: unknown }) => {
          const root = rootRef.current;
          const panel = panelRef.current;
          const insideRoot = root !== null && root.contains(event.target);
          const insidePanel = panel !== null && panel.contains(event.target);
          if (!insideRoot && !insidePanel) setOpen(false);
        };
        const onKeyDown = (event: { key: string }) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const balance = balancesOf(store.status?.balance ?? null)[0] ?? null;
      const period = store.status?.period ?? null;
      const combined = store.report?.combined ?? null;
      const cost = typeof combined?.cost === 'number' ? combined.cost : 0;
      const requests = typeof combined?.requests === 'number' ? combined.requests : 0;
      // Before the first read lands there is nothing truthful to show; an
      // optimistic ¥0.00 would flash on every mount and read as "free".
      const ready = store.loaded === true;
      const costText = !ready ? t('dock.loading') : requests === 0 ? t('dock.free') : `¥${money(cost)}`;

      const parts: Rendered[] = [];
      parts.push(react.createElement('span', { className: 'dcb-dockValue', key: 'cost' }, costText));
      if (balance !== null) {
        parts.push(react.createElement('span', { className: 'dcb-dockSep', key: 's1' }, '·'));
        parts.push(
          react.createElement(
            'span',
            { className: 'dcb-dockValue', key: 'bal' },
            `${balance.currency === 'CNY' ? '¥' : '$'}${money(balance.total)}`,
          ),
        );
      }
      if (period !== null) {
        parts.push(react.createElement('span', { className: 'dcb-dockSep', key: 's2' }, '·'));
        parts.push(
          react.createElement(
            'span',
            { key: 'period', className: `dcb-badge ${period.peak === true ? 'dcb-badge-peak' : 'dcb-badge-off'}` },
            period.peak === true ? t('period.peak') : t('period.offPeak'),
          ),
        );
      }
      parts.push(react.createElement('span', { className: 'dcb-dockCaret', key: 'caret', 'aria-hidden': 'true' }, open ? '▾' : '▴'));

      return react.createElement(
        'span',
        { className: 'dcb-dock', ref: rootRef },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dcb-dockTrigger',
            ref: buttonRef,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            title: t('dock.title'),
            onClick: () => setOpen((value) => !value),
            onMouseDown: (event: { preventDefault(): void }) => event.preventDefault(),
          },
          react.createElement(GaugeIcon, { size: 13 }),
          ...parts,
        ),
        open ? react.createElement(UsageDetail, { t, store, sessionId, panelRef, anchor }) : null,
      );
    }

    //#region dashboard cards
    /**
     * The token-statistics card: a semantic ring plus a legend over the three
     * billed buckets.
     *
     * Returns null when nothing was measured, so no surface can draw an empty
     * ring and a 0% legend that would read as a measured zero.
     */
    function makeTokenCard({ t, combined }: { t: Translate; combined: TotalsPayload | null }): CardParts | null {
      const totals = combined?.tokens ?? null;
      if (totals === null || !(totals.total > 0 || totals.output > 0)) return null;

      const prompt = (totals.input ?? 0) + (totals.cacheRead ?? 0);
      const hitRate = prompt > 0 ? Math.round(((totals.cacheRead ?? 0) / prompt) * 1000) / 10 : 0;
      const buckets = [
        {
          key: 'cacheRead',
          label: t('tokens.cacheHit'),
          color: COLOR.cacheHit,
          value: totals.cacheRead ?? 0,
          sub: `${compact(totals.cacheRead ?? 0)} tok`,
        },
        {
          key: 'input',
          label: t('tokens.cacheMiss'),
          color: COLOR.cacheMiss,
          value: totals.input ?? 0,
          sub: `${compact(totals.input ?? 0)} tok`,
        },
        {
          key: 'output',
          label: t('tokens.output'),
          color: COLOR.output,
          value: totals.output ?? 0,
          sub: t('tokens.outputSub').replace('{n}', compact(totals.reasoning ?? 0)),
        },
      ];
      const sum = buckets.reduce((acc, part) => acc + part.value, 0);

      return {
        accent: 'tokens',
        title: react.createElement('span', { className: 'dcb-h2' }, t('tokens.title')),
        headline: t('tokens.hitRate').replace('{pct}', String(hitRate)),
        body: react.createElement(
          'div',
          { className: 'dcb-split' },
          react.createElement(Donut, {
            size: 76,
            segments: buckets,
            caption: { value: compact(totals.total ?? 0), label: t('tokens.total') },
          }),
          react.createElement(
            'div',
            { className: 'dcb-legend' },
            buckets.map((part) =>
              react.createElement(LegendRow, {
                key: part.key,
                part,
                share: sum > 0 ? Math.round((part.value / sum) * 1000) / 10 : 0,
              }),
            ),
          ),
        ),
      };
    }

    /**
     * The cost card: the total split two ways — by pricing period, and by session
     * scope (this session versus its descendants).
     */
    function makeCostCard({ t, combined, own, children }: {
      t: Translate;
      combined: TotalsPayload | null;
      own: TotalsPayload | null;
      children: ChildSession[];
    }): CardParts | null {
      if (combined === null || !(combined.requests > 0)) return null;

      const periods = [
        {
          key: 'peak',
          label: t('period.peak'),
          color: COLOR.peak,
          value: combined.byPeriod?.peak ?? 0,
          sub: `¥${money(combined.byPeriod?.peak ?? 0)}`,
        },
        {
          key: 'offPeak',
          label: t('period.offPeak'),
          color: COLOR.offPeak,
          value: combined.byPeriod?.offPeak ?? 0,
          sub: `¥${money(combined.byPeriod?.offPeak ?? 0)}`,
        },
      ];
      const childCost = children.reduce((sum, child) => sum + (child.cost ?? 0), 0);
      const childRequests = children.reduce((sum, child) => sum + (child.requests ?? 0), 0);
      const scopes = [
        {
          key: 'own',
          label: t('session.own'),
          color: COLOR.own,
          value: own?.cost ?? 0,
          sub: `¥${money(own?.cost ?? 0)} · ${t('session.requests').replace('{count}', String(own?.requests ?? 0))}`,
        },
        {
          key: 'children',
          label: t('session.children'),
          color: COLOR.children,
          value: childCost,
          sub: `¥${money(childCost)} · ${t('session.childCount').replace('{count}', String(children.length))} · ${t('session.requests').replace('{count}', String(childRequests))}`,
        },
      ];
      const periodSum = periods.reduce((acc, part) => acc + part.value, 0);

      const legend = (parts: Segment[], whole: number) =>
        react.createElement(
          'div',
          { className: 'dcb-legend' },
          parts.map((part: Segment) =>
            react.createElement(LegendRow, {
              key: part.key,
              part,
              share: whole > 0 ? Math.round((part.value / whole) * 1000) / 10 : 0,
            }),
          ),
        );

      return {
        accent: 'cost',
        title: react.createElement('span', { className: 'dcb-h2' }, t('cost.title')),
        headline: `¥${money(combined.cost)}`,
        body: react.createElement(
          react.Fragment,
          null,
          react.createElement(StackBar, { segments: periods }),
          legend(periods, periodSum),
          react.createElement(StackBar, { segments: scopes }),
          legend(scopes, combined.cost),
        ),
      };
    }
    //#endregion

    /** The expanded detail card: balance, period, price table, and the breakdown. */
    function UsageDetail({ t, store, sessionId, panelRef, anchor }: {
      t: Translate;
      store: UsageStore;
      sessionId: string;
      panelRef: { current: unknown };
      anchor: Anchor | null;
    }) {
      const status: StatusPayload | null = store.status;
      const report: SessionReport | null = store.report;
      const balances = balancesOf(status?.balance ?? null);
      const period: PeriodPayload | null = status?.period ?? null;
      const prices: PriceRow[] = Array.isArray(status?.prices) ? status.prices : [];
      const combined = report?.combined ?? null;
      const own = report?.own ?? null;
      const children: ChildSession[] = Array.isArray(report?.children) ? report.children : [];
      const activePeriod = period !== null && period.peak === true;
      const rateKey = activePeriod ? 'peak' : 'offPeak';
      const maxChild = children.reduce((max, child) => Math.max(max, child.cost ?? 0), 0);

      const rows: Rendered[] = [];

      // ---- 余额：紧凑行，总额 / 赠送 / 充值各一行，行首色点 ---------------------------------
      for (const [index, row] of balances.entries()) {
        const symbol = row.currency === 'CNY' ? '¥' : '$';
        rows.push(
          react.createElement(
            'div',
            { className: 'dcb-row', key: `b${index}` },
            react.createElement(
              'span',
              { className: 'dcb-k' },
              react.createElement('span', { className: 'dcb-ldot', style: { background: COLOR.balance } }),
              t('balance.title'),
            ),
            react.createElement(
              'span',
              { className: 'dcb-v', style: { color: COLOR.balance } },
              `${symbol}${money(row.total)}`,
            ),
          ),
        );
        rows.push(
          react.createElement(
            'div',
            { className: 'dcb-row', key: `bd${index}` },
            react.createElement(
              'span',
              { className: 'dcb-k' },
              react.createElement('span', { className: 'dcb-ldot', style: { background: COLOR.granted } }),
              t('balance.granted'),
            ),
            react.createElement('span', { className: 'dcb-v', style: { color: COLOR.granted } }, money(row.granted)),
          ),
        );
        rows.push(
          react.createElement(
            'div',
            { className: 'dcb-row', key: `bt${index}` },
            react.createElement(
              'span',
              { className: 'dcb-k' },
              react.createElement('span', { className: 'dcb-ldot', style: { background: COLOR.toppedUp } }),
              t('balance.toppedUp'),
            ),
            react.createElement('span', { className: 'dcb-v', style: { color: COLOR.toppedUp } }, money(row.toppedUp)),
          ),
        );
      }
      if (balances.length === 0) {
        rows.push(react.createElement('div', { className: 'dcb-k', key: 'bn' }, t('balance.none')));
      }

      // ---- 当前计费时段 + 实时倒计时：紧凑行 --------------------------------
      if (period !== null) {
        const remaining = period.next !== null ? period.next.at - Date.now() : null;
        rows.push(react.createElement('div', { className: 'dcb-sep', key: 'psep' }));
        rows.push(
          react.createElement(
            'div',
            { className: 'dcb-row', key: 'period' },
            react.createElement('span', { className: 'dcb-k' }, t('period.title')),
            react.createElement(
              'span',
              { className: `dcb-badge ${activePeriod ? 'dcb-badge-peak' : 'dcb-badge-off'}` },
              activePeriod ? t('period.peak') : t('period.offPeak'),
            ),
          ),
        );
        if (remaining !== null) {
          rows.push(
            react.createElement(
              'div',
              { className: 'dcb-until', key: 'until' },
              react.createElement('span', {
                className: 'dcb-ldot',
                style: { background: activePeriod ? COLOR.peak : COLOR.offPeak },
              }),
              t('period.until')
                .replace('{next}', period.next!.peak ? t('period.peak') : t('period.offPeak'))
                .replace('{time}', countdown(remaining)),
            ),
          );
        }
      }

      // ---- 可折叠卡片：Token 统计 + 费用构成 -------------------------------
      // Each card folds to its headline, so a reader who only wants "how much"
      // gets one line per section and unfolds only what they care about.
      const card = (parts: CardParts | null, key: string): Rendered =>
        parts === null
          ? null
          : react.createElement(
              Card,
              {
                key,
                accent: parts.accent,
                title: parts.title,
                headline: parts.headline,
              },
              parts.body,
            );
      rows.push(card(makeTokenCard({ t, combined }), 'tokens'));
      rows.push(card(makeCostCard({ t, combined, own, children }), 'cost'));
      // The cost card above already reports the own/descendant and peak/valley
      // splits, so this section carries only what it does not: the per-child
      // detail and the caveats.
      if (combined !== null && combined.requests > 0) {
        if (children.length > 0) {
          // A card like the others, so a child session reads as a section rather
          // than a stray line under the cost card. The headline repeats no figure:
          // the cost card's legend already carries the descendant total.
          rows.push(
            react.createElement(
              Card,
              {
                key: 'children',
                accent: 'children',
                title: react.createElement('span', { className: 'dcb-h2' }, t('session.children')),
                headline: t('session.childCount').replace('{count}', String(children.length)),
              },
              children.slice(0, 6).map((child, index) =>
                react.createElement(
                  'div',
                  { key: child.sessionId ?? index, className: 'dcb-childRow' },
                  react.createElement(
                    'div',
                    { className: 'dcb-child' },
                    react.createElement(
                      'span',
                      { className: 'dcb-name', title: child.title ?? child.sessionId },
                      child.title ?? child.sessionId,
                    ),
                    react.createElement(
                      'span',
                      { className: 'dcb-v', style: { color: COLOR.children } },
                      `¥${money(child.cost ?? 0)}`,
                    ),
                  ),
                  react.createElement(
                    'div',
                    { className: 'dcb-bar' },
                    react.createElement('span', {
                      style: {
                        width: `${maxChild > 0 ? Math.max(2, Math.round(((child.cost ?? 0) / maxChild) * 100)) : 0}%`,
                        background: COLOR.children,
                      },
                    }),
                  ),
                ),
              ),
            ),
          );
        }
        if (combined.unpriced > 0) {
          rows.push(
            react.createElement(
              'div',
              { className: 'dcb-hint', key: 'unpriced' },
              t('session.unpriced').replace('{count}', String(combined.unpriced)),
            ),
          );
        }
      } else if (store.loaded === true && sessionId !== '') {
        rows.push(react.createElement('div', { className: 'dcb-hint', key: 'none' }, t('session.none')));
      }
      if (store.error === true) {
        rows.push(react.createElement('div', { className: 'dcb-err', key: 'err' }, t('common.error')));
      }

      if (prices.length > 0) {
        // One card: the period in force in the heading, its rates in the table.
        rows.push(
          react.createElement(
            Card,
            {
              key: 'priceCard',
              accent: 'price',
              title: react.createElement(
                'span',
                { className: 'dcb-h2' },
                react.createElement('span', {
                  className: 'dcb-ldot',
                  style: { background: activePeriod ? COLOR.peak : COLOR.offPeak },
                }),
                `${t('price.title')} · ${activePeriod ? t('period.peak') : t('period.offPeak')}`,
              ),
              headline: t('price.unit'),
            },
            react.createElement(
              'table',
              { className: 'dcb-table' },
              react.createElement(
                'thead',
                null,
                react.createElement(
                  'tr',
                  null,
                  react.createElement('th', null, t('price.model')),
                  react.createElement('th', null, t('price.cacheHit')),
                  react.createElement('th', null, t('price.cacheMiss')),
                  react.createElement('th', null, t('price.output')),
                ),
              ),
              react.createElement(
                'tbody',
                null,
                prices.map((row) => {
                  const rates = row[rateKey] ?? row.offPeak ?? {};
                  return react.createElement(
                    'tr',
                    { key: row.id },
                    react.createElement('td', null, row.label ?? row.id),
                    react.createElement('td', { className: 'dcb-rate-0' }, rates.cacheHit),
                    react.createElement('td', { className: 'dcb-rate-1' }, rates.cacheMiss),
                    react.createElement('td', { className: 'dcb-rate-2' }, rates.output),
                  );
                }),
              ),
            ),
          ),
        );
      }

      rows.push(react.createElement('div', { className: 'dcb-hint', key: 'note' }, t('common.note')));

      // `anchor` is measured from the trigger; until the first measurement lands
      // the card renders off-screen rather than flashing at the top-left corner.
      const style = anchor === null
        ? { left: 0, top: 0, visibility: 'hidden' }
        : { left: anchor.left, top: anchor.top, maxHeight: anchor.maxHeight };
      return react.createElement('div', { className: 'dcb-detail', role: 'dialog', ref: panelRef, style }, rows);
    }
    //#endregion

    //#region apply
    /**
     * The client half: register the locale dictionary, then contribute one right
     * Sidebar tab. Registration rides `ctx.effect` so disabling the plugin
     * withdraws the tab with it.
     */
    function apply(ctx: ClientContext) {
      ensureStyles();

      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-cost-breakdown: dictionaries');

      // The composer-dock readout is the always-visible surface. It needs only
      // `slots`, so it is contributed independently of the right Sidebar: a
      // harness without that column still shows the cost under the composer.
      ctx.inject(['slots'], (scope) => {
        const slots = scope.slots;
        if (slots === undefined || typeof slots.inject !== 'function') return;
        slots.inject('conversation.composer.dock', () =>
          slots.register(
            { name: 'conversation.composer.dock', id: DOCK_ID, order: 10, locale: NS },
            (props) => react.createElement(UsageDock, props),
          ),
        );
      });

      ctx.inject(['sidebarRightTabs'], (scope) => {
        const tabs = scope.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== 'function') return;

        const disposers: Array<() => void> = [];
        const own = (result: unknown) => {
          if (typeof result === 'function') disposers.push(result as () => void);
        };
        try {
          own(
            tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              title: () => ctx.locale.bind(NS)('tab.title'),
              guide: [
                {
                  id: TAB_ID,
                  order: 40,
                  title: () => ctx.locale.bind(NS)('tab.title'),
                  description: () => ctx.locale.bind(NS)('tab.guide'),
                  icon: GaugeIcon,
                },
              ],
            }),
          );
          own(
            scope.slots.inject('sidebar.right.pane.tab', () =>
              scope.slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS },
                (props) => react.createElement(UsagePanel, props),
              ),
            ),
          );
          own(
            scope.slots.inject('sidebar.right.pane.tab.title', () =>
              scope.slots.register(
                { name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS },
                (props) => react.createElement(UsageTabTitle, props),
              ),
            ),
          );
        } catch (error) {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* unwinding is best-effort */
            }
          }
          throw error;
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* unwinding is best-effort */
            }
          }
        };
      });
    }
    //#endregion

    exports.apply = apply;
    exports.inject = ['slots', 'locale'];
    exports.name = 'dsh-cost-breakdown';
    return module.exports;
  },
});
