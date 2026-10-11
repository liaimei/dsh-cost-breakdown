/**
 * Context Insights 页面的技能卡片——活动列的第二张卡片，
 * 位于热力图之下。在页面作用域内加载过的每个技能一行（
 * 区间选择器的日期下界，或恰好是热力图钉住的那一天——聚合由
 * overview.ts 的 skillLoadsOf 在各界账本上算出），
 * 按选定的顺序排列（标题上的分段开关：加载次数 / 最近使用）：一个
 * 按名字哈希取色的圆点、加载计数、一条
 * 按比例的发丝级横条（占最重那一行的计数之比），以及最近一次
 * 加载的相对时间。标题下方那一行承载作用域的
 * 总量与一个名称过滤（不分大小写的子串匹配，同时收窄
 * 行与计数）。点击某一行会把会话列表「钉」到加载过
 * 该技能的那些会话（本列的钻取，紧邻热力图的日钉选——
 * 再点一次释放）。
 *
 * 这张卡片还用两种方式回答「一个技能是什么」：
 * - 一张悬停卡片（像页面的 hoverTip 一样 portal 出去，但结构更丰富——
 *   页面那个纯文本气泡装不下层级）：名字 + 来源徽标、
 *   registry 描述、磁盘路径，以及底部按
 *   加载统计与点击动作分列；
 * - 被钉住技能的明细，就地展开在它那一行正下方（长
 *   列表会把底部的块埋掉）：先描述，然后是一张两列的
 *   事实网格（来源 / 用法 / 最近加载 / 可点击复制的路径）。
 *   行不在作用域内的钉选，退回卡片底部一个独立的
 *   块，包含头部行。
 *
 * 目录（client/skills.ts，取自插件的 `/api/dsh-cost-breakdown/skills`
 * 路由）从头到尾都是尽力而为——路由缺失时两种方式
 * 都只渲染计数，不做富集。
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { dayKeyOf } from '../../shared/days'
import type { SkillInfo } from '../../shared/types'
import { relativeTime, type SkillLoadStat, type SkillSort } from '../overview'
import { copySkillPath } from '../skills'
import { IconCheck, IconCopy } from '../primitives'
import type { ViewKit } from '../viewkit'

/** 列出技能条数的渲染上限——一个恶意语料可以为每次
 * 注入现造一个名字；溢出那一行让计数保持诚实，而不必做出一张上千行的卡片。 */
const MAX_ROWS = 20

/** 描述的显示上限——registry 的描述可能长达数段。 */
const MAX_DESC = 160

/** 复制成功提示在路径行上的停留时间。 */
const COPIED_MS = 1500

/** 锚点到气泡的距离，以及悬停卡片被夹在其中的视口边距，单位 px。 */
const TIP_GAP = 6
const TIP_MARGIN = 8

/** 悬停卡片在行的 `aria-describedby` 里用的身份（同一时刻只有一张卡片是活的）。 */
const TIP_ID = 'lc-skilltip-bubble'

/** 每个技能的圆点/横条颜色：沿用组成图自己的调色板，按名字哈希选取，好让一个技能在不同作用域下保持同色。 */
const SKILL_COLORS = [
  'var(--color-blue-500)',
  'var(--color-green-500)',
  'var(--color-purple-500)',
  'var(--color-orange-500)',
  'var(--color-teal-500)',
  'var(--color-pink-500)',
  'var(--color-indigo-500)',
  'var(--color-amber-500)',
] as const

/** 排序开关的选项，按显示顺序排列；第一个是默认值。 */
const SKILL_SORTS: readonly SkillSort[] = ['loads', 'recent']

/** 技能的稳定调色板颜色（对名字做 djb2——够小、确定，用作区分性的提示足够了）。 */
export function skillColorOf(name: string): string {
  let hash = 5381
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0
  return SKILL_COLORS[hash % SKILL_COLORS.length]
}

/** 来源分桶的显示标签：registry 已知的发现来源
 * 走本地化；未知或由 provider 命名的来源原样显示（那是
 * registry 的数据，不是 UI 装饰），而没有来源的条目没有标签。 */
function originLabelOf(t: ViewKit['t'], info: SkillInfo): string {
  const source = info.source
  if (source === 'project-dsh' || source === 'project-agents') return t('ov.skills.src.project')
  if (source === 'user-dsh' || source === 'user-agents') return t('ov.skills.src.user')
  if (source === 'bundled') return t('ov.skills.src.bundled')
  return source ?? ''
}

/** 描述的显示形态：空白压平、截断、加省略号；没有可展示内容时为 ''。 */
function descriptionOf(info: SkillInfo): string {
  const flat = info.description.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DESC ? flat.slice(0, MAX_DESC) + '…' : flat
}

/** 用法对的一行形式（加载数 · 会话数），悬停卡片底部与明细网格共用。 */
function usageLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${kit.t('ov.skills.loads', { n: kit.fmt(s.loads) })} · ${kit.t('ov.skills.sessions', { n: kit.fmt(s.sessions) })}`
}

/** 最近加载的精确时间戳（日期 + 时刻），能扛住恶意的时刻值。 */
function lastLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${dayKeyOf(s.last) ?? ''} ${kit.fmtTime(s.last)}`.trim()
}

/** 加载统计在悬停卡片底部用的一行形式。 */
function statsLineOf(kit: ViewKit, s: SkillLoadStat): string {
  return `${usageLineOf(kit, s)} · ${lastLineOf(kit, s)}`
}

/** 两种方式的共用头部：颜色圆点、名字，以及目录知道来源时的来源徽标。 */
function DetailHead(props: { name: string; origin: string }): ReactElement {
  return (
    <div className="lc-skilld-head">
      <i className="lc-ov-skill-dot" style={{ background: skillColorOf(props.name) }} />
      <span className="lc-skilld-name">{props.name}</span>
      {props.origin !== '' && <span className="lc-skilld-chip">{props.origin}</span>}
    </div>
  )
}

/** 被悬停行的锚点几何（用一个普通记录，好让 state 身份就等于锚点身份）。 */
interface HoverRow {
  name: string
  rect: { left: number; top: number; width: number; bottom: number }
}

/** 技能卡片的输入。`stats` 由调用方按当前作用域预先聚合、预先排序，
 *  而 `catalog`（registry 读取）是可选的：没有它卡片仍然
 *  渲染计数，只是不做富集。 */
export interface OverviewSkillsProps {
  /** 已按作用域聚合的结果（skillLoadsOf），并且已经排好序。 */
  stats: SkillLoadStat[]
  /** 热力图钉住的日期（本列被过滤到某一天时）——标题会点名它。 */
  day?: string | null
  /** 会话列表被钉到哪个技能（若有时）。 */
  selected?: string | null
  /** 行钉选中继：被点击的技能，或 null 以释放当前钉选。 */
  onSelect?: (name: string | null) => void
  /** 选定的行排序；不传读作 'default'。 */
  sort?: SkillSort
  /** 排序开关中继。 */
  onSort?: (sort: SkillSort) => void
  /** 面板的目录读取结果，按名字索引；未读取或未提供服务时为 null。 */
  catalog?: ReadonlyMap<string, SkillInfo> | null
  /** 各行相对时间背后的渲染时刻。 */
  now: number
}

/**
 * 绑定 `kit`，返回技能活动卡片。横条的刻度是「作用域」内最重的计数，
 * 而不是排头那一行的，所以名称过滤或重新排序打乱各行时
 * 横条保持不动；被钉住的行与它的内联明细作为一个整体渲染，
 * 而过滤藏起来的钉选则退回卡片底部那个独立的块。
 */
export function makeOverviewSkills(kit: ViewKit): (props: OverviewSkillsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewSkills(props: OverviewSkillsProps): ReactElement {
    const { stats } = props
    // 横条的分母是整个作用域内最重那一行的计数，
    // 无论它被排到哪里——以第一行为准的话，只要另一种排序
    // （按会话数 / 最近）让一个更轻的行排到最前，卡片立刻就会溢出，
    // 而保住作用域的分母则能让横条在名称过滤收窄各行时也不跳。
    const max = stats.reduce((top, s) => Math.max(top, s.loads), 0)

    // ---- 名称过滤 ---------------------------------------------------
    // 一个本地的不分大小写子串过滤，作用于技能名；
    // 摘要计数与渲染出的行都跟随它，所以卡片
    // 永远说的是它显示的东西。匹配为空时输入框保持挂载，好让过滤条件随时都能从界面上清掉。
    const [query, setQuery] = useState('')
    const needle = query.trim().toLowerCase()
    const visible = needle === '' ? stats : stats.filter(s => s.name.toLowerCase().includes(needle))
    const visibleTotal = visible.reduce((sum, s) => sum + s.loads, 0)

    // ---- 悬停卡片 ---------------------------------------------------
    const [hoverRow, setHoverRow] = useState<HoverRow | null>(null)
    const [spot, setSpot] = useState<{ forRow: HoverRow; left: number; top: number } | null>(null)
    const bubbleRef = useRef<HTMLDivElement | null>(null)
    const hoverStat = hoverRow === null ? undefined : stats.find(s => s.name === hoverRow.name)

    // 任何滚动或尺寸变化都会移动每一个锚点——收回而不是让它悬空（页面 hoverTip 区域自己的规则）。
    useEffect(() => {
      if (hoverRow === null) return undefined
      const retract = (): void => { setHoverRow(null) }
      window.addEventListener('resize', retract)
      window.addEventListener('scroll', retract, true)
      return () => {
        window.removeEventListener('resize', retract)
        window.removeEventListener('scroll', retract, true)
      }
    }, [hoverRow])

    // 每张显示出来的卡片只测量一次（以悬停记录为 key，所以同一行的重渲染绝不会重新隐藏）。
    useLayoutEffect(() => {
      if (hoverRow === null) return
      const el = bubbleRef.current
      /* 不可到达：portal 在布局 effect 运行之前就已经提交了它的 ref。 */
      if (el === null) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      const { rect } = hoverRow
      const left = Math.max(TIP_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - TIP_MARGIN))
      const top = rect.top - h - TIP_GAP < TIP_MARGIN ? rect.bottom + TIP_GAP : rect.top - h - TIP_GAP
      setSpot({ forRow: hoverRow, left, top })
    }, [hoverRow])

    // ---- 被钉住技能的复制提示 ------------------------------------
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // 钉选变化（或释放）会丢掉任何残留的提示；挂起的计时器在卸载时清理。
    useEffect(() => { setCopied(false) }, [props.selected])
    useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
    const copyPath = async (path: string): Promise<void> => {
      if (await copySkillPath(path)) {
        setCopied(true)
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => { setCopied(false) }, COPIED_MS)
      }
    }

    // ---- 被钉住技能的明细 ----------------------------------------
    // 就地展开在它那一行正下方——长列表会把底部的
    // 块埋掉。描述排在前面（它回答技能「是什么」）；事实
    // 随后以两列标签网格呈现——来源、用法、最近加载，以及
    // 可点击复制的完整路径——所以没有任何东西悬空无标签。一个
    // 行未被渲染的钉选——掉出过滤后的作用域，或超出
    // 渲染上限——退回卡片底部一个独立的块，
    // 包含头部行；没有目录、但有作用域内计数的钉选仍然显示它的用法行。
    const selected = props.selected
    const pinnedStat = selected === null || selected === undefined
      ? undefined
      : stats.find(s => s.name === selected)
    const pinnedInfo = selected === null || selected === undefined
      ? undefined
      : props.catalog?.get(selected)
    const detail = selected === null || selected === undefined || (pinnedInfo === undefined && pinnedStat === undefined)
      ? null
      : {
        name: selected,
        origin: pinnedInfo === undefined ? '' : originLabelOf(t, pinnedInfo),
        description: pinnedInfo === undefined ? '' : descriptionOf(pinnedInfo),
        path: pinnedInfo?.path,
      }
    // 复制值里的路径，在这里收窄一次（const 的收窄在闭包里依然成立）。
    const detailPath = detail?.path
    // 被钉住技能自己那一行是否渲染（在过滤后的作用域内，且在
    // 渲染上限之内）——只有那时才有内联座位；被过滤
    // 藏起来的钉选退回卡片底部那个独立的块。
    const pinnedRowVisible = selected !== null && selected !== undefined
      && visible.slice(0, MAX_ROWS).some(s => s.name === selected)
    const detailBlock = detail === null ? null : (
      <div className="lc-ov-skill-detail">
        {!pinnedRowVisible && <DetailHead name={detail.name} origin="" />}
        {detail.description !== '' && <p className="lc-skilld-desc">{detail.description}</p>}
        <div className="lc-skilld-grid">
          {detail.origin !== '' && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.source')}</span>
              <span className="lc-skilld-v">{detail.origin}</span>
            </Fragment>
          )}
          {pinnedStat !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.usage')}</span>
              <span className="lc-skilld-v">{usageLineOf(kit, pinnedStat)}</span>
              <span className="lc-skilld-k">{t('ov.skills.k.last')}</span>
              <span className="lc-skilld-v">{lastLineOf(kit, pinnedStat)}</span>
            </Fragment>
          )}
          {detailPath !== undefined && (
            <Fragment>
              <span className="lc-skilld-k">{t('ov.skills.k.path')}</span>
              <button
                type="button"
                className="lc-skilld-v lc-skilld-pathv"
                data-lc-tip={t('ov.skills.copyPath')}
                onClick={() => { void copyPath(detailPath) }}
              >
                <span className="lc-skilld-pathv-text">{copied ? t('ov.skills.copied') : detailPath}</span>
                {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
              </button>
            </Fragment>
          )}
        </div>
      </div>
    )

    const hoverTip = hoverStat === undefined ? null : (() => {
      const info = props.catalog?.get(hoverStat.name)
      const origin = info === undefined ? '' : originLabelOf(t, info)
      const description = info === undefined ? '' : descriptionOf(info)
      const pinned = props.selected === hoverStat.name
      const shown = spot !== null && spot.forRow === hoverRow ? spot : null
      return createPortal(
        <div
          ref={bubbleRef}
          id={TIP_ID}
          role="tooltip"
          className="lc-tip lc-skilltip"
          style={shown === null
            ? { left: 0, top: 0, visibility: 'hidden' }
            : { left: shown.left, top: shown.top, opacity: 1 }}
        >
          <DetailHead name={hoverStat.name} origin={origin} />
          {description !== '' && <p className="lc-skilld-desc">{description}</p>}
          {info?.path !== undefined && <div className="lc-skilld-path">{info.path}</div>}
          <div className="lc-skilld-foot">
            <span>{statsLineOf(kit, hoverStat)}</span>
            <span className="lc-skilld-hint">{pinned ? t('ov.skills.clickRelease') : t('ov.skills.clickFilter')}</span>
          </div>
        </div>,
        document.body,
      )
    })()

    const sort = props.sort ?? 'loads'
    return (
      <div className="lc-card lc-ov-skills-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.skills')}</span>
          {props.day !== null && props.day !== undefined && <span className="lc-card-sub">{props.day}</span>}
          {/* 排序开关钉在标题行的右角（gran 自带的
              自动边距）；只有一行时没什么可排序。 */}
          {stats.length > 1 && (
            <div className="lc-gran" role="group" aria-label={t('ov.skills.sortLabel')}>
              {SKILL_SORTS.map(so => (
                <button
                  key={so}
                  type="button"
                  className={'lc-gran-btn' + (sort === so ? ' lc-gran-on' : '')}
                  aria-pressed={sort === so}
                  onClick={() => { props.onSort?.(so) }}
                >{t('ov.skills.sort.' + so)}</button>
              ))}
            </div>
          )}
        </div>
        {/* 作用域的总量住在标题下方，避开那个开关；
            名称过滤搭同一行，向右折并在宽度吃紧时换行到下方。
            只有一行时没什么可过滤。 */}
        {stats.length > 0 && (
          <div className="lc-ov-skills-sub">
            <span className="lc-card-sub lc-ov-skills-sub-n">
              {t('ov.skills.summary', { skills: fmt(visible.length), loads: fmt(visibleTotal) })}
            </span>
            {stats.length > 1 && (
              <input
                className="lc-ov-search lc-ov-skills-search"
                type="search"
                value={query}
                placeholder={t('ov.skills.search')}
                aria-label={t('ov.skills.search')}
                onChange={(ev) => { setQuery(ev.target.value) }}
              />
            )}
          </div>
        )}
        {stats.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.empty')}</div>
        ) : visible.length === 0 ? (
          <div className="lc-empty">{t('ov.skills.noMatch')}</div>
        ) : (
          <div className="lc-ov-skills" role="group" aria-label={t('stats.skills')}>
            {visible.slice(0, MAX_ROWS).map((s) => {
              const color = skillColorOf(s.name)
              const pinned = props.selected === s.name
              // 横条的百分比是按行的 padding box 解算的，
              // 但它的轨道是 content box——减去水平
              // 内缩（6px + 6px），否则 100% 会捅穿单元的环。
              const share = Math.round(s.loads / Math.max(max, 1) * 100)
              const bar = <i className="lc-ov-skill-bar" style={{ width: `calc(${share}% - ${Math.round(share * 12) / 100}px)`, background: color }} />
              const rowButton = (
                <button
                  type="button"
                  className="lc-ov-skill"
                  aria-pressed={pinned}
                  aria-describedby={hoverRow?.name === s.name ? TIP_ID : undefined}
                  onMouseEnter={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    setHoverRow({ name: s.name, rect: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } })
                  }}
                  onMouseLeave={() => { setHoverRow(null) }}
                  onFocus={(ev) => {
                    const r = ev.currentTarget.getBoundingClientRect()
                    setHoverRow({ name: s.name, rect: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } })
                  }}
                  onBlur={() => { setHoverRow(null) }}
                  onClick={() => { props.onSelect?.(pinned ? null : s.name) }}
                >
                  <i className="lc-ov-skill-dot" style={{ background: color }} />
                  <span className="lc-ov-skill-name">{s.name}</span>
                  <span className="lc-ov-skill-count">×{fmt(s.loads)}</span>
                  <span className="lc-ov-skill-last">{relativeTime(t, s.last, props.now)}</span>
                  {bar}
                </button>
              )
              // 被钉住的行与它的明细读作一个整体——一对共享的
              // 填充和一圈包围两者的环（`.lc-ov-skill-unit`），绝不是两个叠在一起、中间有道缝的盒子。
              return pinned
                ? <div key={s.name} className="lc-ov-skill-unit">{rowButton}{detailBlock}</div>
                : <Fragment key={s.name}>{rowButton}</Fragment>
            })}
            {visible.length > MAX_ROWS && (
              <div className="lc-ov-skill-more">{t('ov.skills.more', { n: visible.length - MAX_ROWS })}</div>
            )}
          </div>
        )}
        {/* 独立座位：被钉住技能的那一行不在可见
            作用域内（或超出渲染上限）——钉选仍然拿到它的明细。 */}
        {!pinnedRowVisible && detailBlock}
        {hoverTip}
      </div>
    )
  }
}
