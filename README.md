# dsh-cost-breakdown — 上下文洞察与官方人民币费用统计

DeepSeek Harness（DSH）插件：把**上下文洞察**与**按平台计费的费用统计**放在同一个插件里。
所有费用都在浏览器端按官方人民币价目表估算，**宿主只写 token 账本，不做任何货币换算**。

> **本仓库是一次完整重写。** 程序结构、模块划分与实现均为重新编写，不复用任何既有插件的代码组织；
> 行为契约（投影键、wire 字段、路由、槽位、设置命名空间）保持不变，因此可以原地替换旧版本。
> 历史与许可说明见 `NOTICE`。

## 功能

**上下文洞察（只讲 Token，不出现金额）**

- 对话区「上下文」视图：当前构成条、按步/按轮的趋势图（全量 / 增量、耗时曲线）、上下文浏览器
  （按阶段展开 system / tools / user / inject / skill / assistant / tool 七类）、上下文事件列表、
  文件活动、Agent 网络、耗时时间轴、单步请求明细；
- 右侧栏「本会话汇总」：本会话 Token 汇总 + 各平台消费；
- 左侧栏「统计」页：跨会话的 Token 汇总（计费四桶、阶段构成、7 日用量、活跃度热力图、
  技能加载、会话卡片）与**费用汇总**（每个平台一张卡，卡内含逐模型消费与调用次数）；
- `/context` 命令与弹窗，以及每轮回复后的消费读数。

**计价**

- **官方人民币价目表**：DeepSeek-V4.1-Flash `0.02 / 1 / 4`（谷，元/百万 Token，命中 / 未命中 / 输出）、
  DeepSeek-V4-Pro `0.15 / 4.5 / 13.5`；峰价为谷价两倍。
- **峰谷**：北京时间周一至周五 `09:00–12:00`、`14:00–18:00` 为峰时，其余为空闲；
  **法定节假日**与周末全天按谷价。峰谷按**模型**判定，不按路由——官方表收录的模型无论走自家路由
  还是第三方代理，都按北京时段分桶。
- **节假日回退**：配置里的 `holidays` 给不出任何合法日期时退回内置表，绝不读作「没有节假日」
  （那会把每个节假日按峰价计费、静默翻倍）。可用 `holidays: ['2026-10-01', ...]` 覆盖。
- **按平台拆分，不相加**：DeepSeek 显示 ¥、第三方显示 $、积分平台显示积分 / 剩余积分。
  定不出价的模型显式标注「未配置费率」，绝不显示 ¥0。
- **余额**：优先读 DSH 账号登录，其次 API key；读不到就不显示，不猜、不缓存过期值。

## 安装

```bash
# 从 GitHub 安装（仓库自带 lib/ 构建产物，安装时无需构建）
dsh plugin --profile <profile> add github:liaimei/dsh-cost-breakdown

# 本地开发
dsh plugin --profile <profile> add "dsh-cost-breakdown@link:/path/to/dsh-cost-breakdown"
```

> 不要在 `package.json` 里加 `prepare`/`postinstall` 生命周期脚本：`lib/` 是入库产物，
> 而 pnpm 从 git 拉依赖时会执行这些脚本，会被 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拦下。
> 构建请显式运行 `pnpm run build`。

装好后**重启 DSH**（宿主半区在启动时装配）。之后输入框下方会出现常驻费用读数，
左侧栏出现「统计」入口，对话区出现「上下文」标签页。

## 配置

设置页 → 插件 →「用量与费用」，全部设置都挂在 loader 行 id 命名空间 `cost-breakdown` 下：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxRequestSteps` / `maxKeptTurns` | 1500 / 300 | 保留的请求步数与整轮窗口（裁剪以整轮为单位） |
| `maxEvents` / `maxNodes` / `maxArchiveNodes` / `maxFileOps` | 400 / 2000 / 400 / 400 | 各集合上限 |
| `holidays` | 内置 2026 年 31 天 | 全天按谷价计费的日期（`YYYY-MM-DD`，北京时间） |
| `defaultPlacement` | `all` | 入口位置：`all` / `tab` / `sidebar` |
| `defaultGranularity` / `defaultTrendMode` / `defaultDeltaBase` | `step` / `total` / `step` | 趋势图与浏览器的默认口径 |
| `defaultToolSort` / `defaultFileSort` | `count` / `count` | 工具定义与文件活动的默认排序 |
| `insightsEntry` / `defaultDurationCurve` | `show` / `show` | 统计入口与耗时曲线的默认开关 |

## 开发

```bash
pnpm install
pnpm run build      # tsdown -> lib/index.js（宿主 ESM）+ lib/client.js（浏览器 CJS 闭包）
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest：core / wire / host / client / bundle 五个套件
```

目录结构：

| 目录 | 内容 |
|---|---|
| `src/wire/` | wire 契约：类型、zod schema、投影键增强 |
| `src/core/` | 两侧共用的纯数学：北京日历与峰谷、官方价目、token 估算、文件操作解析、ledger |
| `src/host/` | Cordis 插件：fold 引擎、三个投影单元、HTTP 通道、平台适配、设置 schema |
| `src/client/` | 浏览器半区：shell 适配、数据层、i18n、UI 面 |

- `src/host/fold/` 的 reducer 是纯函数：无变化时返回同一引用（注册表用 `Object.is` 判断是否推送），
  整条事件在 try/catch 内折叠（一条畸形事件被整体丢弃，绝不卡住推送流），state 必须是纯 JSON
  （可选字段**缺席**而不是 `undefined`）。
- 宿主投影的 `stateVersion`：`contextTimeline` 29 / `contextHeaders` 1 / `contextActivity` 6；
  宿主只在这些键的 state 形状或折叠语义变化时才抬高版本。

## 验证

```bash
pnpm run typecheck && pnpm test
```

新测试套件覆盖：核心数学（日历 / 价目 / 估算 / ledger / 日键 / 版本比较）、wire schema、
fold reducer（引用纪律、错误吞并、计量、保留上限）、三个投影单元与降级单元、浏览器数据层
（金额优先级、聚合、washer）、以及**构建产物**的可加载性（客户端闭包协议、平台模块表、
宿主 `apply()` 装配出三个投影与五条路由）。

## 数据与权限

| 项 | 说明 |
|---|---|
| 读会话日志 | 只读观测本机会话事件，用于统计 token 用量；不修改会话 |
| 读账户余额 | 账号登录优先，其次 `api.deepseek.com/user/balance`；插件不接触令牌 |
| 外部网络 | 仅 models.dev 价目表（官方表未收录的模型才需要）、余额查询、版本检查 |
| 本地存储 | 只记住上次余额（`localStorage`）；不写文件、不建数据库 |
| 遥测 | 无 |

## 许可

[Apache-2.0](LICENSE)。见 `NOTICE`：本项目最初fork自 Apache-2.0 的
[dsh-context](https://github.com/bowenliang123/dsh-context)，现已重写为独立实现。
