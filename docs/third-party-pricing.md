# 第三方平台计价规范

本文规定插件如何为**非 DeepSeek 官方**的 provider（如 `workbuddy`）统计费用，
以及如何把这些费用归属到**具体模型**。它从现有代码的实测行为出发，
只描述已经能工作的机制与需要补齐的缺口，不发明新协议。

## 0. 实现状态（2026-11）

| 规范条目 | 状态 |
|---|---|
| 3.1 计价优先级（官方表 → 用户费率 → 中转站公开价目 → 注册表 → 唯一候选） | 已实现（`client/data/cost.ts`、`relayPrices.ts`） |
| 3.2 第三方费率表的数据形状与逐条校验 | 已实现（`client/data/thirdPartyRates.ts`；宿主 schema 的 `thirdPartyRates`） |
| 3.2 费率表**设置页编辑器** | **未实现**：目前只能在 profile 的 `cordis.patch.yml` 里手写（键为扁平的 `<provider>:<model>`） |
| 3.2 从账本实测 provider 生成下拉 | 未实现（依赖上一项） |
| 3.3 `credits` 不参与金额计算 | 已实现（`credits` 只用于界面提示，从不进入 `estimateByBucket`） |
| 3.3 `free: true` 计 ¥0 | **未实现**：`free` 标记目前不进入计价，仍按「未配置费率」处理 |
| 3.4 峰谷只属于官方表模型 | 已实现（`core/providers.ts` 的 `pricedByPeriod`） |
| 3.5 按 provider → model 展开与显式「未配置费率」 | 已实现（费用卡与统计页） |

> 订阅套餐（GLM / MiniMax / Kimi / 阿里云 / 小米）属于「按量计费之外」的第三种记账模型，
> 见 `src/core/plans.ts` 与 README；它们不套用本文的 token 单价链。

## 1. 现状：数据从哪来

| 环节 | 事实 |
|---|---|
| 账本键 | `SessionCostUsage[provider][model][period][bucket]`，provider 是 **DSH 请求信封里的路由 id** |
| 实测键 | 真实会话里出现 `workbuddy` 与 `workbuddy-ai` 两个 provider，各自只有一个模型 `deepseek-v4.1-flash` |
| 单价来源 | 客户端价目册：官方 `@opencode-ai/models` → models.dev 注册表（3823 个模型） |
| 官方价目表 | `src/core/clock.ts`（价目表与峰谷日历同处一个模块），只收录 DeepSeek，含峰谷时段 |

**账本本身已经按「provider × model」记账**，所以「统计到具体模型」这一半是现成的；
缺的是**给第三方 provider 的模型定出单价**。

## 2. 核心难点：注册表里没有「workbuddy」

`workbuddy` 不在 models.dev 中。它的模型要么同名于别家厂商，要么根本未收录：

| workbuddy 模型 id | 注册表收录 | 提供该模型的厂商数 |
|---|---|---|
| `deepseek-v4.1-flash` | ✓ | 21 |
| `deepseek-v4-pro` | ✓ | 28 |
| `glm-5.3` / `glm-5.3-flash` | ✓ | 31 / 27 |
| `kimi-k3` / `kimi-k2.6` | ✓ | 31 / 23 |
| `minimax-m3` / `minimax-m2.7` | ✓ | 14 / 9 |
| `step-5-preview` | ✓ | 6 |
| `hy3` / `hy4-preview` | ✓ | 7 / 6 |
| `space-bunny` | ✓ | 1 |
| **`hy3-x`** | ✗ | 0 |
| **`kimi-k2.8-preview`** | ✗ | 0 |
| **`kimi-k2.7`** | ✗ | 0 |

19 个模型里 **15 个同名于注册表、4 个完全缺失**。

问题在于同名 ≠ 同价。同一个 `glm-5.3` 在注册表里被 31 家标注，
费率从 `0/0`（免费套餐）到 `1.4/4.4`（zai 官方）不等。现有的
`resolveCandidates`（`src/client/data/cost.ts`）只在候选**唯一**时才敢计价，
否则返回 `null`——这是对的（宁可显示破折号，也不猜错价），
但结果是**第三方模型的费用基本全都统计不出来**。

## 3. 规范

### 3.1 计价优先级（唯一权威链）

按顺序取第一个命中项，任何一步命中即**终止**：

1. **官方价目表**（`officialRateOf`）—— 按 **model id** 匹配，与 provider 无关。
   `deepseek-v4.1-flash` 走 workbuddy 时也按官方价目表计价，因为它就是同一个模型。
2. **用户配置的第三方费率**（新增，见 3.2）—— 按 `provider` 精确匹配。
3. **注册表直连** —— `modelsDevProviderOf(provider)` 能在注册表里找到同名厂商时，
   只信该厂商的分支；其未知模型按 `null`（不可定价），不回退到别家。
4. **注册表按模型回退** —— 仅当候选**唯一**时才采用（现状行为，保持不变）。
5. 都不命中 → `null`，界面显示破折号。**绝不猜测。**

> 关键：第 2 步必须是**按 provider 精确匹配**，不能按模型名模糊匹配。
> 「用哪个第三方」是用户的部署事实，插件无从推断，只能由用户声明。

### 3.2 第三方费率配置

费率表是宿主行 `config` 里的一个字段（`thirdPartyRates`），由浏览器半区逐条重校验；
**设置页编辑器尚未实现**，目前通过编辑 profile 的 `cordis.patch.yml` 写入。键的写死格式：

```
<provider>:<model>  →  { input, output, cacheRead, cacheWrite }   // 每 100 万 token，美元
```

```yaml
- id: cost-breakdown
  name: dsh-cost-breakdown
  config:
    thirdPartyRates:
      'workbuddy-ai:glm-5.3': { input: 0.5, output: 2, cacheRead: 0.1 }
```

约束：

- `provider` 必须与账本里的键**逐字相同**（实测是 `workbuddy` / `workbuddy-ai`，
  不是 `dsh-workbuddy-connect`）。界面应列出账本里**实际出现过**的 provider 供选择，
  而不是让用户手打——手打最容易错成包名。
- `model` 同样逐字匹配，忽略大小写。
- 四个费率都必须是非负数；`cacheRead`/`cacheWrite` 缺省时回退到 `input`，
  这与 `pricesBookOf` 的既有规则一致（`rateOf(cost.cache_read) ?? miss`）。
- 未配置的 `<provider>:<model>` 走 3.1 的第 3–5 步。
- 配置**优先于**注册表：用户知道自己的套餐，插件不知道。

### 3.3 workbuddy 目录里的 `credits` 不参与计价

`~/.dsh/.workbuddy-catalog.json` 提供 19 个模型的元数据，`billing` 字段形如：

```json
{ "credits": "x0.29 credits", "badges": ["夜间免费"], "free": false }
```

**它是相对倍率，不是 token 单价**——没有基准单位就换算不出金额。
因此规范明确：`credits` 只用于**界面提示**（如「限时免费」「夜间折扣」），
**绝不参与金额计算**。`free: true` 的模型（`hy3`、`step-5-preview`）可按 ¥0 计价，
这是唯一能从该文件推出的计价结论。

### 3.4 峰谷时段只属于 DeepSeek

`pricedByOfficialPeriod(provider, model)` 的现有语义保持不变：只要 **model**
收录于官方价目表，就按其峰谷分桶并翻倍（无论走哪条路由）。
第三方专有模型（`glm-*`、`kimi-*`、`minimax-*`）全部记在 `peak` 桶且**不翻倍**。

### 3.5 界面呈现

费用卡与统计页必须能回答「钱花在哪个平台的哪个模型上」：

- 按 **provider** 分组，组内按 **model** 展开：`workbuddy / deepseek-v4.1-flash`。
- 不可定价的条目**显式标注**（如「未配置费率」），而不是静默显示 ¥0——
  这两者含义完全不同（§「写死数据」那条要求同样适用于此）。
- 官方价目表收录的模型与第三方配置的费率，用同一种视觉，用户不需要知道钱是从哪张表查出来的。

## 4. 落地清单

| # | 改动 | 文件 |
|---|---|---|
| 1 | 第三方费率表的类型与校验（不可信 wire 输入，逐字段重校验） | 已完成：`src/client/data/thirdPartyRates.ts` + `src/host/settings.ts` |
| 2 | 把费率表接进 `priceFaceOf` 的第 2 步 | 已完成：`src/client/data/cost.ts` |
| 3 | 设置项：按账本实测的 provider 列出可配模型 | **未完成**：`src/client/ui/settings.tsx`、`src/client/shell/preferences.ts` |
| 4 | 费用卡按 provider → model 展开 | 已完成：`src/client/ui/dock/blocks.tsx` + `src/client/ui/insights/spend.tsx` |
| 5 | 测试：同名不同价必须不猜；配置命中；`credits` 不参与计算；`free: true` 计 ¥0 | 部分完成：前三项有测试，`free: true` 未实现 |

## 5. 不做的事

- **不**把 `credits` 猜成单价。
- **不**把未知 provider 的模型模糊匹配到随便哪家厂商的费率。
- **不**为第三方发明第二套峰谷规则。
- **不**在插件里内置任何具体平台的费率——那是用户的部署事实，不是插件的事实。
