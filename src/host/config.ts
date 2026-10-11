/**
 * dsh-cost-breakdown 条目配置：
 * `dsh-cost-breakdown` loader 行的 `config:` 块，外加以用户为单位的展示偏好。
 *
 * schema 用 schemastery，
 * 好让两个消费方都接受：cordis 在 `apply` 之前通过 Standard Schema 接口校验条目配置，harness 的 Config 表单生成也用同一份 schema 推出 Plugins 页的实时表单——命名空间即条目 id，
 * 只有 `.volatile()` 字段会被提供并允许编辑。
 * 受约束的编辑重挂载条目（fold 在 apply 时读取它们）；
 * 偏好类编辑只提交 volatile 部分，从不重挂载。
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_HOLIDAYS, holidaysFrom } from '../shared/officialRates'
import type { PluginSettings } from '../shared/types'

/** 随包提供的 fold 上限与基线节假日表；每个字段都可在条目级别覆盖。 */
export const DEFAULT_BOUNDS = {
  maxRequestSteps: 1500,
  /** 保留的最新整 turn 窗口；裁剪以整 turn 为单位，绝不切在 turn 中间。 */
  maxKeptTurns: 300,
  maxEvents: 400,
  /** 仅作为病态 session 的兜底：每次推送都会带走整个值（每节点约 150B）。 */
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  /** 中国法定节假日（北京日期），全天按谷时计费；见 shared/officialRates.ts。 */
  holidays: [...DEFAULT_HOLIDAYS] as string[],
}

/** 解析后的 fold 上限；由 {@link DEFAULT_BOUNDS} 推导，两者不会各自漂移。 */
export type FoldBounds = typeof DEFAULT_BOUNDS

/** 单个条目的原始配置：任意 fold 上限加任意展示偏好，全部可选，其余由 schema 补齐。
 * 消费方一律通过 {@link resolveBounds} 解析上限，绝不逐字段取。 */
export type Config = Partial<FoldBounds> & Partial<PluginSettings>

/** harness 的 schemastery 提供 `.volatile()` 时把字段标记为可实时编辑；没有该修饰符时
 * 就是普通字段，于是一份 schema 能服务闸门放行的每个 harness。 */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

/** 条目配置 schema：fold 上限加上易变的展示偏好。它同时是 plugins 页面表单的来源，
 * 在这里加一个字段就能编辑，无需额外接线。 */
export const Config = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
  // 用 loose，手写或过期的值会退化成内置表，而不是让条目加载失败。
  holidays: z.array(z.string()).default([...DEFAULT_HOLIDAYS] as string[]).loose(),
  // 用 loose：过期的持久化值退化成默认值，而不是让条目加载失败。
  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTrendMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'latest', 'path']).default('count').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
})

/** 套用全部默认值后的条目配置；只在 `apply` 时调用一次，因此之后的配置编辑
 * 要等 loader 重挂载才生效。 */
export function resolveBounds(config: Config | undefined): FoldBounds {
  // 每个默认值都由 schema 补齐；易变的偏好字段不属于 fold 数据。
  const resolved = Config(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
    // 不可用的表回落到内置表：若当作「没有节假日」，
    // 每个节假日都会按峰时价计费，悄悄让那些日子翻倍。
    holidays: holidaysFrom(resolved.holidays) ?? [...DEFAULT_HOLIDAYS],
  }
}
