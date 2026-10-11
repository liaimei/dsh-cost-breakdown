# dsh-cost-breakdown — 官方人民币费用统计

> 本插件基于 [dsh-context](https://github.com/bowenliang123/dsh-context) 的源码（`main@209169d`，
> 即 v0.66.1 之后的 `main`）重构：**`src/` 是上游 dsh-context 的逐字源码**，上游 2000+ 测试原样通过；
> 本仓库在其**之上叠加**两项自己的功能 —— **官方人民币价目表（峰谷 + 法定节假日）**与
> **输入框下方的常驻费用读数**。

## 保留的上游能力

上游的**代码**逐行保留（除下文列出的接线文件）——注释与若干界面文案已按本仓库的
约定改写，但没有任何一条语句、表达式或类型被改动（改动范围见 `NOTICE`）。
因此下列上下文洞察能力全部保留：

- **上下文仪表盘**：组成（system / tools / user / assistant / tool-results）、趋势图、上下文浏览器、
  事件列表、文件活动、Agent 网络；
- **统计页**（左侧栏，即重构后的「上下文洞察」页）：跨会话 KPI 条、**计费 Token 按平台四桶拆分**、
  上下文组成圆环、7 日用量图、活跃度热力图、技能加载、会话卡片、账户余额胶囊；
- **`/context` 命令**与 `Ctrl/⌘` 弹窗；
- **每会话的 Token 卡与费用卡**（含子 Agent 折叠）。

## 本仓库叠加的功能

### ① 官方人民币价目表（`src/shared/officialRates.ts`）

上游只按 models.dev 的**美元**簿计价，并给 DeepSeek 的 `peak` 桶统一乘 `PEAK_FACTOR = 2`，
**没有节假日表**。本插件改为以**官方人民币价目表**为准：

| 模型 | 谷价（缓存命中 / 未命中 / 输出，元/百万 Token） | 峰价 |
|---|---|---|
| DeepSeek-V4.1-Flash | 0.02 / 1 / 4 | 0.04 / 2 / 8 |
| DeepSeek-V4-Pro | 0.15 / 4.5 / 13.5 | 0.3 / 9 / 27 |

- **峰谷判定**：北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰，其余为空闲；谷价恰为峰价一半。
- **法定节假日**：内置 2026 年国务院安排（31 天），节假日全天按**谷价**计费，与周末一致。
  可用宿主配置 `holidays: ['2026-10-01', ...]`（`YYYY-MM-DD`，北京时间）覆盖。
- **安全回退**：配置里给不出**任何一个**合法日期时退回内置表，而不是当成「没有节假日」——
  后者会把每个节假日按高峰价计费，静默翻倍。
- **谁贵谁便宜看官方表**：官方表收录的模型一律按官方价计（峰桶 = 谷价 × 2）；其余模型仍走上游
  models.dev 的分支与回退层级。因此 **DeepSeek 的费用即使没有加载到 models.dev 也照常显示**。
- 峰谷判定在**宿主**完成（`src/host/foldMetering.ts` 的 `isPeakAt`），所以落库的桶
  携带的就是**当时实际适用的费率**；节假日真的会记进谷价桶。

### ② 输入框下方的常驻读数（`src/client/components/composerDock.tsx`）

上游没有这个入口。收起时只占一行：**本会话费用 · 余额 · 当前峰/谷**；
点一下展开详情卡 —— Token 三桶（缓存命中 / 未命中 / 输出）拆分、峰谷费用拆分、
当前时段官方价目表。卡片用 `position: fixed` 并实测触发按钮位置，避开输入框自身的
`overflow` 裁剪；上方空间不足时自动翻到下方。峰谷徽标随本机时钟自动翻转。

余额由**两个来源**提供，按顺序尝试：① DSH 自身的账号登录（`deepseekAccount` 服务，**不需要 API key**
—— 桌面端登录账号就用这个）；② API-key 提供方（没有账号服务时）。读数先画上次记住的数字，再按
**60 秒**周期自动校正（这个数字随每次计费请求变化，长期挂载只读一次会显示过期值）。

### ③ 统计页：具体到平台的计费桶（`src/client/components/overviewBilled.tsx`）

两个入口各用其名：**左侧栏那一页**是账号级汇总，叫**统计**（英文 `Statistics`，
原「上下文洞察」）；**本会话视图**（对话区标签栏，以及右侧栏的标签、面板与入口卡片）
是同**一个组件**、同一份本会话数据，因此两处共用一个名字，叫**汇总统计**
（英文 `Summary Statistics`）——同名是有意的，否则同一份视图在两处会像两件事。
本页新增一张**计费 Token** 卡 —— 按平台
**实际计费的四个桶**统计，全部是 provider 上报的**精确值**（不是估算）：

| 桶 | 含义 |
|---|---|
| 缓存输入 | `cacheReadTokens`：命中缓存的那部分输入 |
| 未缓存输入 | `inputTokens`（含缓存写入）：按未命中价计费 |
| 输出 | `outputTokens`：已含思考 token |

卡片下方是**峰 / 谷费用拆分**，直接回答「这笔钱有多少落在峰价上」。它与同排的
**上下文组成圆环**（同样口径的 token，按 system / tools / user / assistant / tool-results 拆分）
互为补充：一个说钱花在哪段时间，一个说 token 是什么内容。

## 与上游的关系

| 本仓库 | 上游 |
|---|---|
| 官方人民币价目表 + 峰谷 + 法定节假日 | models.dev 美元簿 + 固定 `PEAK_FACTOR = 2`，无节假日表 |
| 输入框下方常驻读数 | 无 |
| `host/config.ts` 新增 `holidays` 字段 | 无 |
| `contextTimeline` stateVersion 28、`contextActivity` 5 | 27 / 4 |

详细改动清单见 `NOTICE`，fork 说明见 `FORK.md`。

## 数据来源

| 数据 | 来源 |
|---|---|
| 余额 | 上游 `host/balance.ts`：读 `settings` + `credentials` 后请求 `api.deepseek.com/user/balance`（插件不接触令牌） |
| 用量 | 会话日志里 `assistant/message` 自带的 `usage`，由宿主投影折叠为每（provider, model, 时段）的累计桶 |
| 价格 | 本插件的官方人民币价目表（`src/shared/officialRates.ts`）；官方表未收录的模型走 models.dev |
| 时段 | 北京时间周一至周五 09:00–12:00、14:00–18:00（法定节假日与周末除外）为高峰 |

## 计价口径（重要）

DSH 记录的 `inputTokens` 是**缓存未命中**的输入，`cacheReadTokens` 才是**缓存命中**的输入，
两者与 `outputTokens` 是**互不重叠**的桶。实测一条真实记录：

```
{inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672}
      192 +        12672       +        238      = 13102
```

若把 `inputTokens` 当成整个 prompt，就会把已缓存的 12672 tokens 按未命中价计费，
费用会被高估**一个数量级**。本插件按三个桶分别计价（缓存写入不单独计价，按未命中价计）。

费用为**估算值**，按 DSH 记录的 token 用量与官方价目表计算；实际扣费以平台账单为准。
官方表与 models.dev 都未收录的模型会计入请求数但**不计费**，并在界面标注，绝不会被当成免费。

### 衍生会话只计一次（避免重复计费）

这部分是上游行为，本仓库原样保留：fork / 摘要重建出来的会话是**带种子的**，
日志开头是祖先事件的一份拷贝，而那些请求在祖先会话里**已经计过费**。
宿主折叠在 `session/end-seed { inherited: true }` 标记处截断继承前缀，
因此子会话只计**自己真实发生**的调用。

## 安装

本仓库的包名是 `dsh-cost-breakdown`，与上游 `dsh-context` **不同名**，两者可以并存
（不建议同时启用：两套上下文入口会在界面上重复）。

从 GitHub 源安装（仓库自带编译产物，安装时**不需要构建**）：

```bash
dsh plugin --profile web add github:liaimei/dsh-cost-breakdown
```

从本地检出安装（开发时用，`link:` 让改完 `lib/` 刷新页面即生效）：

```bash
dsh plugin --profile web add "dsh-cost-breakdown@link:/path/to/dsh-usage-meter"
```

装完**重启 DSH**（宿主半区不热生效），然后输入框下方会出现常驻费用读数。

### 排查安装问题时注意

- **只想读状态时别用 `dsh plugin list`**：该子命令并非只读——它会触发一次 reconcile
  并落盘（实测会移除 lock 里已不再声明的依赖）。直接看
  `~/.dsh/profiles/<profile>/package.json` 与 `node_modules/` 更安全。
- **确认宿主半区确实是新的**：`POST /api/dsh-cost-breakdown/skills`（带会话 cookie）
  应返回 200；返回 404 说明跑的还是旧代码，重启 DSH 即可。
- **改路径或升级后**检查 `dsh.profile.bundles` 里 `dsh-cost-breakdown` 只出现一次，
  且 `cordis.patch.yml` 里没有指向已移除包的 `- id: <旧包名>` 死条目。

## 源码与构建

源码是 TypeScript（`src/`），产物是 `lib/`，由 **tsdown** 打包成两个入口：

| 源文件 | 产物 | 说明 |
|---|---|---|
| `src/host/index.ts` | `lib/index.js` + `lib/index.d.ts` | 宿主半区（ESM）。改完需**重启 DSH** |
| `src/client/index.ts` | `lib/client.js` | 浏览器半区（CJS，包在 `window.__ModuleLoader__.load` 里）。改完刷新页面即可 |

```bash
pnpm install
pnpm run build      # tsdown -> lib/
pnpm run typecheck  # tsc --noEmit -p tsconfig.tests.json
```

浏览器半区的依赖有**纯净性闸门**（`tsdown.config.ts`）：只有 `react` / `react-dom` /
`dsh-client-ui-primitives` 可以留成运行时 `require`，其余必须内联；新增的可内联依赖要同时
加进 `onlyBundle`。

## 验证

```bash
NODE_OPTIONS=--localstorage-file=/tmp/ls.db pnpm exec vitest run --coverage
```

- **2070 个测试通过**，**逐文件 100% 覆盖率**是仓库门槛；
- 其中 2000+ 个是上游原样的测试；另有 8 个上游 spec 只改了**被新功能有意改变**的断言
  （官方价目表取代 models.dev 价、节假日不再按峰价、槽位从 5 个变 6 个、stateVersion 27→28 / 4→5），
  没有放宽任何断言语义；
- `tests/compat/bundle.spec.ts` 直接加载**构建产物** `lib/client.js`，验证交接协议、
  CSS 通道与槽位注册，所以跑之前要先 `pnpm run build`；
- 本仓库新增的 spec：`tests/shared/officialRates.spec.ts`（价表 / 峰谷边界 / 节假日 / 回退）、
  `tests/client/components/composerDock.spec.ts`（常驻读数与展开卡）。

### 环境注意

1. **DSH 自带的 Node 跑不了 `tsdown`**：macOS 会拒绝 app 签名内 rolldown 的原生 `.node`
   （`different Team IDs`）。用普通 Node（`/opt/homebrew/bin/node`）构建，运行时不受影响。
2. **Node 26 会盖掉 jsdom 的 `localStorage`**：不给 `--localstorage-file` 时它是 `undefined`，
   会让十个客户端 spec 失败（上游同样如此）。因此命令里带
   `NODE_OPTIONS=--localstorage-file=/tmp/ls.db`。

## 已知边界

- **法定节假日表**：内置 2026 年安排。国务院每年公布新安排后，可用插件配置
  `holidays: ['2026-10-01', ...]` 覆盖，或更新 `src/shared/officialRates.ts` 里的 `DEFAULT_HOLIDAYS`。
- **官方表未收录的模型**：按 models.dev 价（若已加载）估算；两者都没有则标注不计费。
- **汇率显示**：官方价目表是人民币；英文界面按 **1 元 = 0.15 美元**换算显示。
- **仅计量 DSH 内的请求**：直接调用 API 或使用其它客户端的消耗不在统计内。

## 权限与外部服务

| 项 | 说明 |
|---|---|
| **读会话日志** | 只读观测本机会话事件，用于统计 token 用量 |
| **读账户余额** | 通过上游 `host/balance.ts` 读 `settings` + `credentials` 后请求 `api.deepseek.com`（插件不接触令牌） |
| **外部网络** | 前端 models.dev 价目表（官方表未收录的模型才需要）+ 余额查询；其余全部本地计算，**不上报任何数据** |
| **本地存储** | 只存上次记住的余额（`localStorage`）；不写文件、不建数据库 |
| **遥测** | 无 |
| **写操作** | 无。插件只读，不修改会话、配置或代码 |

## 许可

[Apache-2.0](LICENSE) © 2026 liaimei（fork 自 Apache-2.0 的 dsh-context，见 `NOTICE`）
