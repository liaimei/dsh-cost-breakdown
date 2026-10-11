import { memo, useState, type ChangeEvent, type ComponentType, type MouseEvent, type ReactElement } from 'react'
import { absPathOf, displayPathOf, glyphOf } from '../fileActivity'
import type { FileActivity, FileEntry, FileOp, FileOpKind } from '../fileActivity'
import type { ContextSettings, DefaultFileSort } from '../settings'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'

/** 列表的种类徽标：三种操作类型，外加图片形态与不过滤的 'all'。 */
export type FileFilter = 'all' | FileOpKind | 'image'

/** 文件卡片的输入；每个交互中继都是可选的，所以卡片能在
 *  只读/仅预览的语境下渲染。 */
export interface FileCardProps {
  activity: FileActivity
  scope: string
  workspace?: string
  /** 返回预览列是否收下了这个文件，于是被拒时会继续落到系统打开方式；不传 = 没有预览列。 */
  onPreview?: (entry: FileEntry) => boolean
  onOpen?: (absPath: string) => void
  onLocate?: (op: FileOp) => void
  state?: DetailState
  onRetry?: () => void
}

/** 绑定 `kit` 与 `settings`，返回带 memo 的文件活动卡片。memo 放在这一层，
 *  是为了让父级引用稳定的 `activity`/`scope` props 在视图别处的
 *  纯悬停重渲染中跳过协调。 */
export function makeFileCard(kit: ViewKit, settings: ContextSettings): ComponentType<FileCardProps> {
  const { t, fmt, fmtTime } = kit
  // 卡片自己的重试/加载提示，构建一次即可，这样失败的读取永远不会落到
  // 「没有文件」的空状态上，把一次传输故障误算成空工作区。
  const DetailNote = makeDetailNote(kit)

  /** 徽标按条目的「种类」匹配，而不是按单次操作：一个既被读又被写的文件
   *  会同时出现在两个徽标下，而 'image' 则以条目的形态为键。 */
  function matches(e: FileEntry, f: FileFilter): boolean {
    if (f === 'all') return true
    if (f === 'image') return e.form === 'image'
    if (f === 'read') return e.reads > 0
    if (f === 'write') return e.writes > 0
    return e.searches > 0
  }

  /** 带符号的行数对，沿用 harness 的 diff 语义：增长用成功色，缩减用错误色。
   *  为零的那一半直接省略，而不是打印成 `+0`。 */
  function DeltaPair(props: { added: number; removed: number }): ReactElement {
    return (
      <span className="lc-fa-delta">
        {props.added > 0 ? <span className="lc-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="lc-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  // 在工厂层做 memo：父级的 activity/scope/onLocate props 在悬停/选中渲染之间引用稳定
  // （见 contextView），所以只要卡片自己的输入没动，它就跳过协调。
  return memo(function FileCard(props: FileCardProps): ReactElement {
    const { activity } = props
    const [filter, setFilter] = useState<FileFilter>('all')
    // 挂载时的默认值；卡片内的切换保持挂载本地，绝不写回。
    const [sort, setSort] = useState<DefaultFileSort>(() => settings.defaultFileSort())
    const [query, setQuery] = useState('')
    // 同一时刻只展开一行的操作清单，所以长清单不会把后面每一行都推下去。
    const [openPath, setOpenPath] = useState<string | null>(null)

    const q = query.trim().toLowerCase()
    // 条目路径的显示形态：工作区内用 './' 相对路径，工作区外原样——搜索行
    // 例外，它那个「路径」其实是一个模式。
    const displayOf = (e: FileEntry): string => (e.pattern === true ? e.path : displayPathOf(e.path, props.workspace))
    // 计数排序的量级：选中种类徽标时用该种类自己的操作数，否则用文件的总操作数。
    const countOf = (e: FileEntry): number =>
      filter === 'read' ? e.reads : filter === 'write' ? e.writes : filter === 'search' ? e.searches : e.ops.length
    const shown = activity.entries
      .filter(e => matches(e, filter) && (q === '' || displayOf(e).toLowerCase().includes(q)))
      // 同分时退回按时间，好让排序是全序、不会在渲染之间闪动。
      .sort((a, b) => sort === 'count'
        ? (countOf(b) - countOf(a)) || (b.ops[0].seq - a.ops[0].seq)
        : sort === 'latest'
          ? b.ops[0].seq - a.ops[0].seq
          : (a.path < b.path ? -1 : 1))

    const chips: { key: FileFilter; files: number; ops: number }[] = [
      {
        key: 'all',
        files: activity.entries.length,
        ops: activity.totals.read.ops + activity.totals.write.ops + activity.totals.search.ops,
      },
      { key: 'read', files: activity.totals.read.files, ops: activity.totals.read.ops },
      { key: 'write', files: activity.totals.write.files, ops: activity.totals.write.ops },
      { key: 'search', files: activity.totals.search.files, ops: activity.totals.search.ops },
      { key: 'image', files: activity.totals.image.files, ops: activity.totals.image.ops },
    ]

    const opLine = (op: FileOp): ReactElement => (
      <>
        <span className="lc-fa-op-tool" title={op.tool}>{op.tool}</span>
        {op.read !== undefined
          ? (
            <span
              className="lc-fa-read"
              title={'est' in op.read
                ? t('files.readEst')
                : t('files.readTip', { a: fmt(op.read.start), b: fmt(op.read.start + op.read.count - 1) })}
            >
              {('est' in op.read ? '≈' : '>>') + fmt(op.read.count)}
            </span>
          )
          : null}
        {op.detail !== undefined ? <span className="lc-fa-op-detail">{op.detail}</span> : null}
        {op.hits !== undefined ? <span className="lc-fa-op-detail">{t('files.hits', { n: fmt(op.hits) })}</span> : null}
        {/* 没有其他明细的嵌套 PTC 操作至少还能报出它的程序名。 */}
        {op.detail === undefined && op.hits === undefined && op.program !== undefined
          ? <span className="lc-fa-op-detail">{op.program}</span>
          : null}
        {op.added + op.removed > 0 ? <DeltaPair added={op.added} removed={op.removed} /> : null}
        {op.err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
        <span className="lc-fa-op-time">{op.time !== undefined ? fmtTime(op.time) : '—'}</span>
      </>
    )

    return (
      <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('files.title')}</span>
          <span className="lc-card-sub">{props.scope}</span>
        </div>
        {activity.entries.length === 0 && props.state === 'loading' ? (
          <DetailNote state="loading" />
        ) : activity.entries.length === 0 && props.state === 'failed' && props.onRetry !== undefined ? (
          <DetailNote state="failed" onRetry={props.onRetry} />
        ) : activity.entries.length === 0 ? (
          <div className="lc-empty">{t('files.empty')}</div>
        ) : (
          <div>
            <div className="lc-fa-ctl">
              {/* 英文下五个徽标会撑爆约 300px 的卡片——把这一组折成两行。 */}
              <div className="lc-gran @max-[380px]/lc-card:flex-wrap">
                {chips.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    className={'lc-gran-btn' + (filter === c.key ? ' lc-gran-on' : '')
                      + (c.key === 'read' || c.key === 'write' || c.key === 'search' ? ' lc-fa-chip-' + c.key : '')}
                    title={t('files.chipTip', { files: c.files, ops: c.ops })}
                    onClick={() => { setFilter(cur => (cur === c.key ? 'all' : c.key)) }}
                  >
                    {t('files.kind.' + c.key)}
                    <b className="lc-fa-n">{fmt(c.ops)}</b>
                  </button>
                ))}
              </div>
              <input
                className="lc-fa-search focus:border-(--dsw-alias-label-dimmed)"
                value={query}
                placeholder={t('files.search')}
                onChange={(ev: ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
              />
            </div>
            <div className="lc-fa-meta">
              <span>{t('files.files', { n: activity.entries.length })}</span>
              {activity.totals.added + activity.totals.removed > 0 ? (
                /* 卡片唯一那条样式化提示住在滚动列表之外，所以气泡永远不会被裁掉。 */
                <span className="lc-fa-meta-delta group/tip">
                  <DeltaPair added={activity.totals.added} removed={activity.totals.removed} />
                  <span className="lc-tip lc-fa-meta-tip group-hover/tip:opacity-100" role="tooltip">{t('files.deltaTip')}</span>
                </span>
              ) : null}
              <span className="lc-gran lc-fa-sort" role="group" title={t('files.sortTip')}>
                {(['count', 'latest', 'path'] as const).map(k => (
                  <button
                    key={k}
                    type="button"
                    className={'lc-gran-btn' + (sort === k ? ' lc-gran-on' : '')}
                    onClick={() => { setSort(k) }}
                  >
                    {t('files.sort.' + k)}
                  </button>
                ))}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="lc-empty">{t('files.noMatch')}</div>
            ) : (
              <div className="lc-fa-list">
                {shown.map((e) => {
                  const open = openPath === e.path
                  const display = displayOf(e)
                  const trimmed = display.endsWith('/') ? display.slice(0, -1) : display
                  const slash = trimmed.lastIndexOf('/')
                  const dir = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
                  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
                  const glyph = glyphOf(e.path, e.form)
                  const abs = e.pattern === true ? undefined : absPathOf(e.path, props.workspace)
                  const previewable = props.onPreview !== undefined && e.pattern !== true && e.form !== 'dir'
                  // 预览列拒绝该文件时会落到系统打开方式；而搜索模式
                  // 根本没有可打开的路径。
                  const openable = previewable || (abs !== undefined && props.onOpen !== undefined)
                  return (
                    <div key={e.path} className={'lc-fa-item' + (open ? ' lc-fa-item-on' : '')}>
                      <button
                        type="button"
                        className="lc-fa-row hover:bg-(--dsw-alias-interactive-bg-hover) @max-[380px]/lc-card:flex-wrap"
                        title={e.path}
                        onClick={() => { setOpenPath(open ? null : e.path) }}
                      >
                        <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                        <span className="lc-fa-form" title={t(glyph.tip)}>
                          {glyph.color !== undefined
                            ? (
                              <span className="lc-fa-lang" style={{ background: glyph.color, color: glyph.text }}>
                                {glyph.glyph}
                              </span>
                            )
                            : glyph.glyph}
                        </span>
                        {/* 窄卡片换行而不是硬挤：路径用接近整宽的基准把第 1 行留给
                            箭头 + 图标 + 路径，徽标/delta/时间折到第 2 行。那 46px 的预留量是
                            箭头（12）+ 间隙（2×7）+ 形态图标（20）。 */}
                        <span className="lc-fa-path flex-1 @max-[380px]/lc-card:basis-[calc(100%-46px)]">
                          {dir !== '' ? <em>{dir}</em> : null}
                          {openable
                            ? (
                              <b
                                className="lc-fa-file hover:underline"
                                title={t(previewable ? 'files.preview' : 'files.open')}
                                onClick={(ev: MouseEvent) => {
                                  ev.stopPropagation()
                                  if (previewable && props.onPreview?.(e) === true) return
                                  if (abs !== undefined) props.onOpen?.(abs)
                                }}
                              >
                                {base}
                              </b>
                            )
                            : <b>{base}</b>}
                        </span>
                        {e.reads > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-read" title={t('files.kind.read')}><i />{fmt(e.reads)}</span>
                        ) : null}
                        {e.writes > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-write" title={t('files.kind.write')}><i />{fmt(e.writes)}</span>
                        ) : null}
                        {e.searches > 0 ? (
                          <span className="lc-fa-badge lc-fa-b-search" title={t('files.kind.search')}><i />{fmt(e.searches)}</span>
                        ) : null}
                        {e.added + e.removed > 0 ? <DeltaPair added={e.added} removed={e.removed} /> : null}
                        {e.errs > 0 ? <span className="lc-br-err-dot" title={t('files.errs', { n: e.errs })} /> : null}
                        {e.ops[0].time !== undefined
                          ? <span className="lc-fa-time">{fmtTime(e.ops[0].time)}</span>
                          : null}
                      </button>
                      {open ? (
                        <div className="lc-fa-ops">
                          {e.ops.map((op, i) => {
                            const onLocate = props.onLocate
                            // 由 meta 归属的搜索会为每个命中的文件从「同一条」结果拆出一行操作——它们共享
                            // 那条结果的 seq，所以 key 要并入下标。
                            const key = `${op.seq}:${i}`
                            return onLocate !== undefined
                              ? (
                                <button
                                  key={key}
                                  type="button"
                                  className="lc-fa-op lc-fa-op-link hover:bg-(--dsw-alias-interactive-bg-hover)"
                                  title={t('files.locate')}
                                  onClick={() => { onLocate(op) }}
                                >
                                  {opLine(op)}
                                </button>
                              )
                              : <div key={key} className="lc-fa-op">{opLine(op)}</div>
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  })
}
