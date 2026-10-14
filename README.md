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
- **统计页**（左侧栏）：**全部会话**的 Token 汇总（计费 Token 按平台四桶拆分、上下文组成圆环、
  7 日 Token 用量图、活跃度热力图、技能加载、会话卡片）与**费用汇总**（每个平台一张卡，
  卡内含逐模型消费与调用次数）；
- **`/context` 命令**与 `Ctrl/⌘` 弹窗；
- **每会话的 Token 卡**（含子 Agent 折叠）与**平台消费汇总**（每平台一张卡，卡内含逐模型明细）。

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
- **峰谷按模型判定，不按 provider 路由**：官方表收录的模型，无论请求走自家路由还是第三方代理
  （workbuddy、镜像站等），都按上面的北京时段分桶——否则代理路由下的 DeepSeek 用量会被整套
  记进「峰」桶却又不翻倍，峰谷既分错、峰时还少收一半。未收录的模型一律记「峰」桶且不翻倍。
- 峰谷判定在**宿主**完成（`src/host/foldMetering.ts` 的 `isPeakAt`），所以落库的桶
  携带的就是**当时实际适用的费率**；节假日真的会记进谷价桶。

### ② 输入框下方的常驻读数（`src/client/components/composerDock.tsx`）

上游没有这个入口。收起时只占一行：**本会话费用 · 余额 · 当前峰/谷**；
尺寸与配色**逐项对齐官方同排读数胶囊**（`StatsPills.module.css` 的 `.pill`，也就是
旁边那个「48.6M tok · 缓存命中 97%」）：同一个 12px 字号
（`calc(var(--dsh-content-font-size-secondary, 13px) - 1px)`）、同一个 20px
行高、同一个 `padding: 1px 8px`，盒子因此同为 22px 高；圆角同为整胶囊
（`999px` + `corner-shape: round`），图标同样钉在 14×14；基色同为 `label-tertiary`、
悬浮同为 `label-secondary`、分隔符用官方的 `separator-primary`，且都不加粗。
并排看不会一高一矮、一圆一方，也不会像外来控件。**只有峰/谷保留语义红绿**——那是这一行唯一要传达的信息。
峰谷本身是**实时算出来的**，不是写死的标签：徽标后面跟着**距离下一次翻转的倒计时**，
每秒走一格（`usePricingPeriod` 的一秒节拍，时段没变的帧不重渲染）；悬停与展开卡里还写全
**峰时是哪几段**（`09:00–12:00、14:00–18:00`，由 `PEAK_WINDOWS` 派生，改表即改文案）。
周末与法定节假日全天谷时，此时不报一个会让人误以为「今天还有峰时」的倒计时，
而是直接说明原因。
**状态栏放不下完整读数时自动改用图标**：整句「6 小时 38 分 后进入峰时」
换成**时钟图标 + 紧凑读数**（`6h38m`，悬停仍给出整句），费用、余额与峰/谷徽标照常保留。
判据是「**留给本行的空间**」与「完整内容需要的宽度」之比，不是拿一个写死的断点比这一行的总宽：
官方那一行里还有用量读数与上下文环，它们先占掉一截，所以**总宽够、留给本行的却可能不够**
（线上正是如此：行宽约 860px，官方两块占掉约 260px，留给本行的约 570px，而整句需要约 600px）。
可用宽度由「父级内容宽 − 兄弟条目宽 − 间隔」算出，需要的宽度由一句**始终渲染但移出可视区**
的量宽探针给出——两者都与当前渲染的是整句还是紧凑形态无关，因此不会自激
（切紧凑 → 变窄 → 又判定够宽 → 切回去）。官方 `StatsPills` 依据的是同一个量
（`min-width:0` + `text-overflow:ellipsis`，按实际可用宽度收缩）。
点一下展开详情卡。展开卡里嵌的**就是汇总统计页的那两张卡**——
**Token 统计**与**费用统计**——外加当前时段的官方价目表：同一份数据、同一种排版，
输入框下方与统计页读到的因此永远是同一回事（余额由费用卡自己那一行承担，不再重复一处）。
卡片用 `position: fixed` 并实测触发按钮位置，避开输入框自身的
`overflow` 裁剪，同时 **portal 到 `document.body`**：官方的两个浮层（`ContextMeter` 的
`.panel`、stat-dialog）都是 `createPortal` 到 body 的，而输入区所在的 `.composerSeat`
是 `position: sticky` 且带 `z-index: 7`——留在里面的话，`z-index: 1100` 只在那个层叠
上下文内排序，仍可能被根级元素压住。外观**对齐官方 stat-dialog**（`stat-dialog.module.css`
的 `.panel`，即点状态栏那枚读数胶囊浮出来的「Token 用量」面板）：同一层
`--dsw-specific-menu`、同一个 `--dsw-radius-lg` 圆角、同一道发丝描边 + `--dsw-elevation-prominent`
阴影、同一个 `z-index: 1100`、同一个 `padding: 16px` 与 12px/18px 正文；标题行也照官方
`.title` + `.titleRule` 那套——标题 `label-primary`/500 字重、两端对齐、下方 8px 留白，
再压一道 0.5px 发丝线、线后 10px。
**宽度与高度有意不同**：官方那块只列 5 行 token 明细，本卡要装两张统计卡加一张价目表。
宽度取 `min(440px, 100vw − 24px)`（440px 与官方面板的上限同值）：卡内几乎每个块都是
百分比宽度（`.lc-dock-cards > .lc-card` 的 `width:100%`、表格、`.lc-sl` 的 auto-fill 网格），
而百分比子项不贡献内在宽度，所以**不能**按内容定宽——那会一路塌到 264px 下限，把整张卡
压扁（图例折成两行、价目表模型名被截断）。440px 也是实测「7 行图例与 4 列价目表都不折行、
模型名不截断」的最小宽度。窄视口夹进 `100vw − 24px`，上限 560px，
既不会裁掉右列数值，也不会出现左右滚动条；卡内三块都显式声明 `box-sizing: border-box`，
宽度因此逐块对齐（基础 `.lc-card` 的 `border-box` 只声明在 `.lc-root` 之下，浮层里没有那个祖先）。
上方空间不足时自动翻到下方。峰谷徽标随本机时钟自动翻转。

余额由**两个来源**提供，按顺序尝试：① DSH 自身的账号登录（`deepseekAccount` 服务，**不需要 API key**
—— 桌面端登录账号就用这个）；② API-key 提供方（没有账号服务时）。读数先画上次记住的数字，再按
**60 秒**周期自动校正（这个数字随每次计费请求变化，长期挂载只读一次会显示过期值）。

### ③ 每个入口各答一件事

| 入口 | 回答的问题 |
|---|---|
| **左侧栏「统计」页** | **全部会话**的汇总——Token 与费用两段分开 |
| **会话内「上下文」标签页** | **只讲上下文与 Token**——页面上不出现任何金额 |
| **右侧栏「本会话汇总」面板** | 本会话汇总，分两段：**Token 汇总**（按上下文类别拆）与**各平台的消费** |
| **输入框下方读数** | 此刻在用的那个平台的消费与余额 |

**Token 与费用严格分栏**：对话区那一页只讲上下文与 Token，页面上**不出现任何金额**
（Agent 网络节点卡也只报 token 量）；费用住右侧栏「本会话汇总」面板的费用段与左侧统计页的费用段。
两侧都不把 token 数与金额并排放进同一个字符串——量纲不同，放在一起会让人以为可以互相换算。
计费 Token 卡按平台**实际计费的四个桶**统计，全部是 provider 上报的**精确值**（不是估算）：

| 桶 | 含义 |
|---|---|
| 缓存输入 | `cacheReadTokens`：命中缓存的那部分输入 |
| 未缓存输入 | `inputTokens`（含缓存写入）：按未命中价计费 |
| 输出 | `outputTokens`：已含思考 token |

### ④ 平台消费汇总（`src/client/components/statsPlatforms.tsx`）

一个会话可能同时用到多个平台，而**各平台的账单单位不同**：DeepSeek 官方按人民币
token 计价（含峰谷），积分制平台按次扣积分，第三方平台按美元。因此：

- **每个平台一张卡**，各自带自己的账单币种与剩余额度，**绝不相加**——
  把两种货币加成一个数字没有意义；
- 卡内是**逐模型明细**（模型 → 消费 · 调用次数），与环图同源：另起一张表只会把
  卡上已有的数字再抄一遍；
- **定不出价的模型显式标注「未配置费率」**，绝不显示 ¥0——这两者含义完全不同。
- **币种按平台自己的账单来**：DeepSeek 显示 ¥、第三方显示 $、积分平台显示积分，
  不随界面语言切换。这与上游「按界面语言换算到单一货币」的做法相反，是有意的。

官方峰谷拆分（费用统计卡）只对有官方用量的会话出现，且只算当前在用的那个平台；
它同样住在费用那一段，不在上下文卡片里。

三处的费率与峰谷判定共用 `client/cost.ts` 的同一个入口
（`estimateSessionCostByBucket`），所以平台卡、卡内逐模型明细与输入框下方的读数
之间**不会互相漂移**。

## 与上游的关系

| 本仓库 | 上游 |
|---|---|
| 官方人民币价目表 + 峰谷 + 法定节假日 | models.dev 美元簿 + 固定 `PEAK_FACTOR = 2`，无节假日表 |
| 输入框下方常驻读数 | 无 |
| 平台消费汇总：每个平台一张卡，卡内含逐模型明细，各按自己的账单币种 | 按界面语言换算到单一货币、平台行不摊开明细 |
| Token 与费用分栏（上下文页只讲上下文与 Token） | 费用卡与 Token 卡混排在同一个头部 |
| `host/config.ts` 新增 `holidays` 字段 | 无 |
| `contextTimeline` stateVersion 29、`contextActivity` 6 | 27 / 4 |

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

> **不要在 `package.json` 里加 `prepare`/`postinstall` 之类的生命周期脚本。**
> `lib/` 是入库的产物，安装时无需构建；而 pnpm 从 git 拉依赖时会执行这些脚本，
> 一旦存在就会被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拦下——消费端只能把
> 带 commit SHA 的包名加进 `allowBuilds`，等于每推一次改一次白名单。
> 构建请走显式的 `pnpm run build`。

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

- **2269 个测试通过**，**逐文件 100% 覆盖率**是仓库门槛；
- 其中 2000+ 个是上游原样的测试；另有 8 个上游 spec 只改了**被新功能有意改变**的断言
  （官方价目表取代 models.dev 价、节假日不再按峰价、槽位从 5 个变 6 个、stateVersion 27→29 / 4→6），
  没有放宽任何断言语义；
- `tests/compat/bundle.spec.ts` 直接加载**构建产物** `lib/client.js`，验证交接协议、
  CSS 通道与槽位注册，所以跑之前要先 `pnpm run build`；
- 本仓库新增的 spec：`tests/shared/officialRates.spec.ts`（价表 / 峰谷边界 / 节假日 / 回退）、
  `tests/client/components/composerDock.spec.ts`（常驻读数与展开卡）、
  `tests/client/components/statsCost.spec.ts`（费用统计卡：分桶 / 峰谷 / 余额 / 空状态）。

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
