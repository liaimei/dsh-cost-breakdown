# Publishing & marketplace submission

Maintainer notes for getting this plugin listed on
[dsh-plugin.org](https://dsh-plugin.org) and on npm.

The repository is already live: **https://github.com/liaimei/dsh-cost-breakdown**
(public, `dsh-plugin` topic applied).

## How listing works

The marketplace is not an upload target — it **crawls GitHub**. A repository is
discovered once it:

1. is **public**;
2. carries the GitHub topic **`dsh-plugin`**;
3. has a README containing an install command of the form
   `dsh plugin --profile web add <package>`;
4. exports an `apply(ctx)` module, per the DSH plugin spec.

All four hold here. Entries are regenerated from repository metadata and refresh
automatically as the repo updates; there is no need to resubmit after edits.
Newly discovered plugins start as `unconfirmed` and become `verified` after human
review.

## Submission Issue (optional, speeds up review)

Use the template at https://dsh-plugin.org/zh/submit, or open an Issue at
https://github.com/dshplugin/dsh-plugin-hub/issues/new with:

**Title**

```
[插件提交] liaimei/dsh-cost-breakdown — DSH 会话费用账单：余额 + 峰谷计价 + 消耗构成，双入口常驻
```

**Body**

```markdown
### 仓库地址
https://github.com/liaimei/dsh-cost-breakdown

### 一句话价值
装上后 DSH 输入框下方和右侧栏会常驻一份「费用账单」：本会话花了多少、账户余额还剩多少、
现在按峰价还是谷价计费，以及这笔钱由哪几部分构成（峰/谷拆分、本会话/衍生会话拆分、
缓存命中/未命中/输出三个 token 桶）。

### 能力分类
界面与体验

### 安装命令
dsh plugin --profile web add github:liaimei/dsh-cost-breakdown

### 兼容与运行要求
- DSH：desktop / web profile（已在 0.2.2-rc.1 上验证；兼容矩阵声明自 0.1.7-rc.2）；客户端半区依赖
  sidebarRightTabs 与 conversation.composer.dock 槽位，缺少右侧栏时仍渲染输入框下方的读数
- Node：^22.19.0 || >=24.0.0
- 平台：macOS / Windows / Linux（纯 JS，无原生依赖）
- 运行时依赖仅 `zod@4.4.3`（宿主半区校验）；仓库自带编译产物，安装时无需构建

### 许可证
Apache-2.0（fork 自 Apache-2.0 的 dsh-context，归属与改动见 NOTICE / FORK.md）

### 截图 / 演示
`docs/assets/` 下的图片是**重构前**旧界面的截图，仅作历史留存，与当前界面不一致。

### 补充说明
**三个「算对」而不是「算多」的设计**（与同类插件的差异点）：

1. 衍生会话去重 — fork/摘要重建的会话日志开头是祖先事件的拷贝，直接相加会把同一笔钱
   算两次。本插件只统计每个会话自己拥有的事件（跳过 inheritedEventCount 前缀，
   退回 session/end-seed 标记），跳过量以 inheritedEventsSkipped 报出。
2. token 三桶计价 — DSH 的 inputTokens 只是缓存未命中输入。若把它当成整个 prompt，
   会把已缓存部分按未命中价计费，费用高估约一个数量级。本插件按 cacheRead / input /
   output 三桶分别套价。
3. 节假日安全回退 — 配置给不出合法日期时退回内置节假日表，而不是当成「没有节假日」；
   后者会让每个节假日按高峰价计费（静默翻倍）。

权限：只读会话日志；余额优先走内置 deepseekAccount（不接触令牌）；外部网络为
api.deepseek.com、models.dev 价目表、中转站公开价目与订阅平台用量接口；只把上次余额写进
localStorage；无遥测。

验证：`pnpm run typecheck`（源码与测试两套 tsconfig）+ `pnpm test`（vitest，34 个套件、363 个用例，
其中 bundle 套件直接加载 `lib/` 产物断言三个投影、七条路由与客户端槽位注册）。

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
```

## Publishing to npm

The name `dsh-cost-breakdown` was verified free on all three axes (npm registry,
GitHub repository search, marketplace catalog).

```bash
pnpm run verify      # typecheck + build + test
npm login
npm publish          # no prepack hook: run the build explicitly first
```

`lib/` is committed on purpose: a `github:` install runs no build step, and the
browser half is served straight from `lib/client.js`.

## Release checklist

```bash
pnpm run typecheck   # two configs: src (tsconfig.json) and tests (tsconfig.tests.json)
pnpm run build       # tsdown -> lib/index.js + lib/client.js
pnpm test            # vitest: core / wire / host / client / bundle
pnpm run verify      # typecheck + build + test, in one command
```

`bundle` 套件直接加载 `lib/` 里的构建产物，所以改完源码必须先 `pnpm run build` 再跑测试。
没有 e2e / live 脚本：真机验证需要一台**运行中的 DSH** 与该插件已启用，那属于人工步骤。
宿主半区的改动（包身份、`main`、路由、`cordis.patch.yml`）需要**重启 DSH**：DSH 按 URL
缓存宿主模块，profile 的 HMR 不监听模块文件，运行中的进程会继续用它启动时加载的代码。
客户端半区的改动只需要刷新页面。
