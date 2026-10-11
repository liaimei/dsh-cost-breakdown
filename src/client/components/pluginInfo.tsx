/** Context stats 旁边那张介绍插件的卡片。元数据由 tsdown 的 `define` 从 package.json 烘进来；
 * 一次实时的 npm registry 查询会在有更新时追加一个 `↑ vX.Y.Z` 徽标。 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { IconSettings } from '../primitives'
import { siDeepseek, siGithub, type SimpleIcon } from 'simple-icons'
import { fetchLatestVersion, isNewerVersion } from '../latestVersion'
import { PLUGIN_NAME, PLUGIN_REPO, PLUGIN_REPO_SHORT, PLUGIN_VERSION } from '../meta'
import { openPluginSettings } from '../settingsJump'
import type { ViewKit } from '../viewkit'

// 这些标志图形会铺满 24 单位的画布到边到角，所以用 -2 内缩补回 harness SiteGlyph 约 8% 的留白。
function SiteMark({ icon }: { icon: SimpleIcon }): ReactElement {
  return (
    <svg width={12} height={12} className="lc-pi-labelicon" viewBox="-2 -2 28 28" fill="none" aria-hidden>
      <path d={icon.path} fill="currentColor" />
    </svg>
  )
}

/**
 * Context stats 旁边的「关于」卡片。`kit` 只绑定一次；npm 版本检查每次挂载跑一遍，
 * 而 `-dev` 构建会被跳过——它烘进去的版本号永远不可能与某个正式发布对上。
 */
export function makePluginInfo(kit: ViewKit): () => ReactElement {
  const { t } = kit
  // `title` 带的是未截断的完整值，因为窄宽度下这一行的省略号会把它切掉。
  const row = (icon: ReactElement, label: string, value: ReactNode, href: string, hint: string) => (
    <a className="lc-pi-row group/pi" href={href} target="_blank" rel="noreferrer">
      <div className="lc-pi-label">{icon}{label}</div>
      <div className="lc-pi-value group-hover/pi:underline" title={hint}>{value}</div>
    </a>
  )
  return function PluginInfo(): ReactElement {
    const [latest, setLatest] = useState<string | null>(null)
    useEffect(() => {
      if (PLUGIN_VERSION.includes('-dev')) return
      let on = true
      // fetchLatestVersion 从不 reject（任何失败都收敛成 null）；`on` 标记用来丢弃迟到的结果。
      void fetchLatestVersion().then((v) => { if (on && v) setLatest(v) })
      return () => { on = false }
    }, [])
    const update = latest !== null && isNewerVersion(latest, PLUGIN_VERSION) ? latest : null
    const nameText = PLUGIN_NAME + ' (v' + PLUGIN_VERSION + ')'
    const nameValue: ReactNode[] = [nameText]
    if (update) nameValue.push(<span key="update" className="lc-pi-update">{'↑ v' + update}</span>)
    // 这几行会在窄处省略、悬停时恢复显示完整值，所以 240px 的下限就够用。
    return (
      <div className="lc-card flex-1 min-w-[min(240px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('plugin.title')}</span>
          {/* 这句标语同时充当仓库链接：悬停加下划线，点击打开 GitHub。 */}
          <a className="lc-card-sub lc-pi-hint hover:underline" href={PLUGIN_REPO} target="_blank" rel="noreferrer">
            {t('plugin.hint')}
          </a>
        </div>
        <div className="lc-pi-grid">
          {row(<SiteMark icon={siDeepseek} />, t('plugin.name'), nameValue, PLUGIN_REPO, update !== null ? nameText + ' ↑ v' + update : nameText)}
          {row(<SiteMark icon={siGithub} />, t('plugin.github'), PLUGIN_REPO_SHORT, PLUGIN_REPO, PLUGIN_REPO_SHORT)}
          {/* 尽力跳转到本插件的偏好设置——宿主 chrome 对不上时 openPluginSettings 会静默什么都不做。 */}
          <button type="button" className="lc-pi-row lc-pi-row-btn group/pi" onClick={() => { openPluginSettings() }}>
            <div className="lc-pi-label"><IconSettings size={12} className="lc-pi-labelicon" />{t('plugin.settings')}</div>
            <div className="lc-pi-value group-hover/pi:underline" title={t('plugin.settingsOpen')}>{t('plugin.settingsOpen')}</div>
          </button>
        </div>
      </div>
    )
  }
}
