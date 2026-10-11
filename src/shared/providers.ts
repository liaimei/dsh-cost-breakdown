/** dsh 请求信封与 models.dev 注册表之间的 provider id 接缝，client/cost.ts（价格表分支）
 * 与 host/fold.ts（峰谷时段拆分）
 * 都要读它；未映射的 dsh 路由键原样透传。 */

const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  // dsh 的两条原生 DeepSeek 路由共用一个注册表厂商和一份按时段计价的价目表，因此
  // `deepseek-account` 也必须能解析，否则 fold 的峰谷拆分拿不到价。
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

/** dsh 路由键背后的 models.dev 注册表厂商；未映射的键原样透传，
 * 新加入的 dsh provider 因此按自身名字计价，而不是被直接丢掉。 */
export function modelsDevProviderOf(dshProviderId: string): string {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

/** 该 dsh 路由是否按 DeepSeek 自家价目表和峰谷时段计费，
 * 而不是走第三方注册表价目表。 */
export function isDeepSeekProvider(dshProviderId: string): boolean {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}
