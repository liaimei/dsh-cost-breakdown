# dsh-cost-breakdown

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/liaimei/dsh-cost-breakdown)

> **一句话价值**：装上它，DSH 输入框下方和右侧栏会常驻一份**费用账单** ——
> 本会话花了多少、账户余额还剩多少、现在按峰价还是谷价计费，
> 以及这笔钱**由哪几部分构成**（峰/谷拆分、本会话/衍生会话拆分、缓存命中/未命中/输出三个 token 桶）。

## 两个入口

**① 输入框下方的常驻读数** —— 收起时只占一行，点一下展开详情卡：

![收起状态的常驻读数](docs/assets/dock-collapsed.png)

展开后（余额与时段是紧凑行，下面三块是带标题的卡片）：

![输入框下方的读数与展开卡](docs/assets/dock-expanded.png)

**② 右侧栏「用量与费用」标签页** —— 同样的数据，适合长期开着看：

![右侧栏面板](docs/assets/panel-dark.png)

浅色主题同样跟随 DSH 的令牌，不是另写一套：

![浅色主题](docs/assets/panel-light.png)

> 以上四张图由 `npm run shots` 从插件**真实的组件与真实 CSS** 渲染而成，不是手绘稿：
> 脚本加载 `lib/client.js`、套用 DSH 的真实主题令牌后截图，所以图里就是实际会渲染出的东西。

峰谷用**峰 / 谷**两个字，配色固定：**峰=红**（贵的那段）、**谷=绿**。
徽标、圆环图例、费用构成里的堆叠条三处用的是同一套颜色，不会互相矛盾。

详情里的**账号余额**三行也做了配色区分：**总额=黄**、**赠送=蓝**、**充值=紫**。

**距离切换到峰/谷的倒计时是实时的**：它由一个按会话共享的 1 秒 ticker 驱动，
到点（窗口真的翻转）会顺手重读一次状态，于是徽标和价目表跟着切过去 —— 没有写死任何时间。

展开后的详情里，余额与时段是**紧凑行**，下面三块是**带标题的卡片** ——
标题栏带主题色淡染，卡片内容**始终展开**（没有折叠）：

| 卡片 | 标题栏 | 内容 |
|---|---|---|
| Token 统计 | 缓存命中 99.5% | 圆环 + 三个桶的图例 |
| 费用构成 | ¥12.82 | 峰谷堆叠条 + 本会话/衍生会话堆叠条 |
| 价目表 · 谷 | 元 / 百万 tokens | 当前时段价格表 |

**两个入口的颜色一致**：余额（总额黄 / 赠送蓝 / 充值紫）、倒计时（峰红 / 谷绿）、
价目表的三个费率列（缓存命中绿 / 未缓存输入琥珀 / 输出蓝）在侧边栏面板与输入框下方的读数里
用的是同一套色阶，不会一处有颜色、另一处是灰字。表格的数值与表头**右对齐到同一条边**。

三张卡片如下：

| 卡片 | 色条 | 内容 |
|---|---|---|
| 账号余额 | 黄 | 总额在标题，赠送（蓝）/ 充值（紫）各一块色块 |
| 当前计费时段 | 峰红 / 谷绿（随状态变） | 当前时段徽标 + **实时倒计时色块** |
| Token 统计 | 绿 | 语义色圆环 + 图例占比 + 缓存命中率 |
| 费用构成 | 蓝 | 两条堆叠条：峰谷拆分、本会话 / 衍生会话 |
| 价目表 | 青 | 只列当前生效时段的价格，标题写明峰/谷 |

> 不展示逐条请求明细：卡片只回答「花了多少、花在哪」，逐请求流水请用 DSH 自带的用量视图。

配色与自带「上下文洞察」看板**同一套视觉语言**：

- **Token 统计**：语义色圆环（缓存命中 / 未缓存输入 / 输出）+ 图例占比 + 缓存命中率；
- **费用构成**：两条堆叠条 —— 峰谷拆分（峰红 / 谷绿）、本会话 / 衍生会话拆分；
- 账号余额（充值 / 赠金分列）；
- 当前峰谷时段、**实时倒计时**、价目表（**只列出当前生效时段那一套价格**，标题会写明是「峰」还是「谷」）。

配色直接用 DSH 自己的语义色阶（`--color-green/amber/blue/violet/orange/teal-500`），
和旁边那块看板的圆环是同一组颜色，明暗主题都跟随。圆环几何也照搬：`viewBox 0 0 42 42`
配 `r = 15.9155`，使周长正好等于 100，于是 dash 长度可以直接当百分比读。

卡片外观**直接复用 DSH 自己的菜单表面 token**（`--dsw-specific-menu` 底色 +
`--dsw-menu-backdrop-filter` 背景模糊 + `--dsw-elevation-prominent` 阴影 +
`--dsw-radius-lg` 圆角），和自带的「Token 用量」浮层是同一套视觉，明暗主题都跟随。
浮层用 `position:fixed` 并实测触发按钮位置：默认向上展开，上方空间不足时自动翻到下方。

**② 右侧栏「用量与费用」标签页** —— 同样的数据，适合长期开着看。

两个入口读写**同一个按会话粒度的 store**：不会出现两处数字不一致，也不会因为开了两个界面就把
昂贵的会话费用计算跑两遍。

## 数据来源

| 数据 | 来源 |
|---|---|
| 余额 | 优先走 DSH 内置的 `deepseekAccount` 服务（账号登录态，插件不接触任何令牌）；未登录时回退到 `DEEPSEEK_API_KEY` 直连 `api.deepseek.com/user/balance` |
| 用量 | DSH 会话日志里 `assistant/message` 事件自带的 `usage`（`inputTokens` / `cacheReadTokens` / `outputTokens`），经 `ctx.sessionQuery.observeSession` 取得 |
| 价格 | 插件内置的官方价目表（源码 `src/pricing.mts`，产物 `lib/pricing.mjs`），因为 **DSH 本身不包含任何计价模型** |
| 时段 | 北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰（法定节假日除外），其余为空闲；空闲价为高峰价的一半 |

## 计价口径（重要）

DSH 记录的 `inputTokens` 是**缓存未命中**的输入，`cacheReadTokens` 才是**缓存命中**的输入，
`totalTokens` 是三者之和。实测一条真实记录：

```
{inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672}
      192 +        12672       +        238      = 13102
```

若把 `inputTokens` 当成整个 prompt，就会把已缓存的 12672 tokens 按未命中价计费，
费用会被高估**一个数量级**。本插件按三个桶分别计价。

费用为**估算值**，按 DSH 记录的 token 用量与官方价目表计算；实际扣费以平台账单为准。
未收录的模型会计入请求数但**不计费**，并在界面标注，绝不会被当成免费。

### 衍生会话只计一次（避免重复计费）

fork / 摘要重建出来的会话是**带种子的**（`isSeeded` / `inheritedEventCount`）：
它的日志开头是**祖先事件的一份拷贝**，而那些请求在祖先会话里**已经计过费**。
若把祖先与派生会话的日志直接相加，同一笔钱会被算两次。

因此本插件只统计每个会话**自己拥有**的事件（跳过 `inheritedEventCount` 前缀；
日志没报该计数时退回到 `session/end-seed { inherited: true }` 标记处）。
被跳过的数量会在返回值里以 `inheritedEventsSkipped` 报出。

## 为什么是它：三个不重复计费的细节

同类用量插件很多，本插件把工夫花在**「算对」**而不是「算多」上：

| 细节 | 不处理会怎样 | 本插件怎么做 |
|---|---|---|
| **衍生会话去重** | fork / 摘要重建的会话日志开头是祖先事件的**拷贝**，直接相加会把同一笔钱算两次 | 只统计每个会话**自己拥有**的事件（跳过 `inheritedEventCount` 前缀，退回 `session/end-seed` 标记），跳过量以 `inheritedEventsSkipped` 报出 |
| **token 三桶计价** | DSH 的 `inputTokens` 只是**缓存未命中**输入；当成整个 prompt 会把已缓存部分按未命中价计费，费用**高估约一个数量级** | 按 cacheRead / input / output 三桶分别套价 |
| **节假日安全回退** | 配置给不出合法日期时若当成「没有节假日」，每个节假日都会按**高峰价**计费（静默翻倍） | 退回内置节假日表，绝不静默改口径 |

## 安装

从市场或命令行安装（发布 profile 用 `web`）：

```bash
dsh plugin --profile web add dsh-cost-breakdown
```

或直接从 GitHub 源安装（仓库已带编译产物，安装时**不需要任何构建**）：

```bash
dsh plugin --profile web add github:liaimei/dsh-cost-breakdown
```

装完**重启** `dsh web`，然后：

- **输入框下方**会出现常驻读数（收起时是一个费用数字，点一下展开详情卡）；
- **右侧栏顶部标签条**会出现「用量与费用」，适合长期开着看。

> **桌面端注意**：DSH 桌面 App 读的是 `desktop` profile，而 `dsh plugin` CLI 按设计拒绝操作它。
> 桌面端请直接使用内置的 `plugin_manager` 工具安装本目录。

### 开发本仓库

```bash
npm install
npm run build      # 源码是 src/*.ts，产物是 lib/；两个半区都由 tsc 编译
```

已安装到 `desktop` profile（`dsh.profile.bundles` 末行）并软链到本目录，因此
**改完源码跑一次 `npm run build`，再刷新页面即可生效**（产物按 mtime 重新读取）。

### 生效范围（实测）

| 半区 | 改源码后 | 说明 |
|---|---|---|
| `src/client.ts` → `lib/client.js` | `npm run build` ＋ 刷新页面 | 宿主按 mtime 重读产物，`rev` 会变（本次迁移实测 `20684e0e9ae4` → `c7c2f67cba66`） |
| `src/index.ts` / `src/pricing.mts` → `lib/index.js` / `lib/pricing.mjs` | `npm run build` ＋ **重启 DSH** | 宿主半区不热生效 |
| `package.json` 的 `main` / `exports` | 指向的仍是 `lib/`，无需改动 | 插件契约不变 |

宿主半区为什么不能热生效：该 profile 的 HMR 配置为 `root: []`，不监听模块文件；
而 Node 的 ESM 缓存以 **URL** 为键，规格符不变就永远命中旧模块。实测下面几条路都**无效**：

- 在插件管理里关闭再启用该 bundle（返回 `"application":"applied"`，但代码未换）
- 重新执行 `install_bundle`（返回 `ambiguous-install` / 无变化）
- 改动并保存 profile 补丁，触发配置 reconcile
- 在 profile 补丁里把该行改成带版本号的相对规格符（`.../lib/index.js?v=N`）

> ⚠️ 因此：改了 `lib/index.js` 就必须重启 DSH。运行中的宿主半区仍是启动时那份代码 ——
> 用下面的自检确认，别把「接口没换」误当成「代码写错了」。

### 自检

```
# 宿主半区：路由已注册（带会话 cookie 时返回 200 JSON）
curl -s -X POST http://127.0.0.1:19387/api/dsh-cost-breakdown/status \
  -H "cookie: <你的会话 cookie>" -H 'content-type: application/json' -d '{}'
# 期望：{"ok":true,"value":{"balance":{...},"period":{...},"prices":[...]}}

# 客户端半区：产物已由宿主提供
curl -s "http://127.0.0.1:19387/plugins/??dsh-cost-breakdown/client.js" | head -3
# 期望：window.__ModuleLoader__.load({ id: 'dsh-cost-breakdown', ...
```

裸 `curl` 会返回 401 `unauthorized` —— 那是 DSH 的浏览器信任栅栏，不是接口坏了。

## 源码与构建

**源码是 TypeScript（`src/`），产物是 `lib/`。** 两个半区都由 `tsc` 编译，
没有打包器 —— 因为两个入口的形状本来就不同：

| 源文件 | 产物 | 为什么这样编译 |
|---|---|---|
| `src/index.ts` | `lib/index.js` | 宿主半区是普通 ESM，`main` 直接指向产物；Node 按 URL 缓存，改完要重启 DSH |
| `src/pricing.mts` | `lib/pricing.mjs` | `.mts` 后缀让 `tsc` 在 `NodeNext` 下按 ESM 发射，且扩展名与 import 规格符一致 |
| `src/client.ts` | `lib/client.js` | 浏览器半区**本身就是那个文件**：源码里已经写着 `window.__ModuleLoader__.load({ id, factory })`，没有 import 图，所以不打包、不转换模块格式 |

```bash
npm run build      # tsc -p tsconfig.json && tsc -p tsconfig.client.json
npm run typecheck  # 同一套配置，--noEmit
```

浏览器半区用**独立**的 `tsconfig.client.json`，有三个关键设置，缺一不可：

- `"module": "ESNext"` —— 保持脚本形态，不注入 CommonJS 互操作；
- `"alwaysStrict": false` —— 产物是被当作脚本 eval 的，不能多出顶层 `'use strict'`；
- `"types": []` —— 不引 `@types/node`：浏览器半区必须拿到 DOM 的 `setTimeout`
  （返回 `number`），否则 `clearInterval` 的类型就对不上。

`removeComments: false` 让 `//#region` 分节注释原样保留 —— 单元测试会断言
这些标记各出现一次，用来防止函数被重复定义。

> 之所以不用 esbuild 打包浏览器半区：esbuild 会重新引号化字符串
> （`'峰'` → `"\u5CF0"`）并丢掉 `//#region` 标记，而那正是客户端单元测试
> 与样式断言所依赖的文本。`tsc` 按原样发射，产物的 CSS 与逐节点渲染快照
> 都能和迁移前的产物**逐字节一致**。

## 验证

```bash
npm run typecheck # 两个半区严格模式零错误
npm test          # 79 个单元测试：定价、峰谷边界、token 桶、会话折叠、配置校验、
                  #              路由契约、面板渲染与降级、lease 释放
npm run test:e2e  # 用 GUI 实际提供的客户端产物跑完整链路：
                  #   pipeline    余额/时段/价目表/会话费用 逐项断言渲染结果
                  #   peak        高峰分支（价目表切到 0.04/2/8 与 0.3/9/27）
                  #   lineage     真实磁盘上的父子会话：子会话被发现且只计自己那份
npm run test:live # 打真实 GUI 的两个路由（脚本自己从凭据记录签发会话 cookie）
npm run test:accept # 逐条核对全部交付要求（余额/峰谷/会话消费/两个界面入口/测试）
npm run verify    # 以上全部
```

`test:accept` 是**验收脚本**：它对着正在运行的 GUI 逐条检查目标里的每一项要求，
并把单元测试结果一并汇报，所以一条命令就能回答"做完了没有"。

`test:live` 与 `test:e2e` 都会**连到正在运行的 DSH**（默认 `http://127.0.0.1:19387`，
可用 `DSH_WEB_URL` 覆盖）。`test:e2e` 从 boot graph 里发现当前 `rev` 再取产物，
所以它断言的是**浏览器真正拿到的那个文件**，不是磁盘上的源码。

> 重启 DSH 之前，`test:live` 会**故意失败**并指出「stale host half」——
> 那是宿主半区还没换成新代码，不是测试写错了。


## 使用

会话打开后，右侧栏顶部标签条会出现「用量与费用」（也可从右侧栏的引导页进入）。
面板打开时读取一次余额 + 本会话费用；之后**每 60 秒只刷新余额**（顺手点「刷新」则两者都重读）。
之所以不连会话费用一起轮询：算一个会话的费用要回放它整份事件日志，逐分钟重放代价太高。

## 已知边界

- **法定节假日表**：内置 2026 年安排。国务院每年公布新安排后，可通过插件配置
  `holidays: ['2026-10-01', ...]`（`YYYY-MM-DD`，北京时间）覆盖，或更新 `src/pricing.mts`
  里的 `DEFAULT_HOLIDAYS`。**配置里给不出任何一个合法日期时会退回内置表**，而不是当成"没有节假日" ——
  后者会把每个节假日按**高峰价**计费（实测同一天费用会翻倍），而且完全看不出来。
- **衍生会话扇出上限**：一次最多统计 400 个衍生会话，超出会在界面标注「统计已截断」。
- **未落盘的会话**：读取依赖 DSH 的会话查询服务；日志不可达的会话会计入 `missing` 而不报错。
- **读取走公开观测 API**：用的是 `ctx.sessionQuery.observeSession(...)`（拿到的 lease 用完即释放），
  **不是** `Session.snapshotEvents()` —— 后者在 DSH 里已标注 deprecated 且「禁止新调用」，
  而且会绕开查询服务的 live 优先解析与缓存下限。
- **仅计量 DSH 内的请求**：直接调用 API 或使用其它客户端的消耗不在统计内。

## 权限与外部服务

装之前你应该知道它碰什么：

| 项 | 说明 |
|---|---|
| **读会话日志** | 通过 `ctx.sessionQuery.observeSession(...)` 只读观测本机会话事件，用于统计 token 用量；lease 用完即释放 |
| **读账户余额** | 优先调用 DSH 内置的 `deepseekAccount` 服务（**插件不接触任何令牌**）；未登录时才回退到 `DEEPSEEK_API_KEY` 直连 `api.deepseek.com/user/balance` |
| **外部网络** | 仅两条：账户余额查询走 `api.deepseek.com`（官方域）；其余全部本地计算，**不上报任何数据** |
| **本地存储** | 无。不写任何文件、不建数据库、不留缓存 |
| **遥测** | 无。不含任何分析/统计上报 |
| **写操作** | 无。插件只读，不修改你的会话、配置或代码 |

会话费用全部在本机由 DSH 记录的 token 用量 × 内置官方价目表算出，**费用为估算值，实际扣费以平台账单为准**。

## 许可

[MIT](LICENSE) © 2026 liaimei
