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
- DSH：desktop / web profile；客户端半区依赖 sidebarRightTabs 与
  conversation.composer.dock 槽位，缺少右侧栏时仍渲染输入框下方的读数
- Node：^22.19.0 || >=24.0.0
- 平台：macOS / Windows / Linux（纯 JS，无原生依赖）
- 零运行时依赖；仓库自带编译产物，安装时无需构建

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

权限：只读会话日志；余额优先走内置 deepseekAccount（不接触令牌）；外部网络仅
api.deepseek.com；无本地存储、无遥测、无写操作。

验证：79 个单元测试 + e2e（断言 GUI 实际下发的产物）+ live 真实路由，全绿。

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
npm login
npm publish          # prepack runs `npm run build`; the build is reproducible
```

`lib/` is committed on purpose: a `github:` install runs no build step, and the
browser half is served straight from `lib/client.js`.

## Release checklist

```bash
npm run build      # tsc, both halves
npm run typecheck  # strict, both halves
npm test           # 79 unit tests
npm run test:e2e   # asserts the artifact the running GUI actually serves
npm run test:live  # the two host routes over the real trust fence
npm run test:accept
```

`test:e2e`, `test:live` and `test:accept` require a **running DSH** with this
plugin enabled. A change to the host half (its package identity, `main`, routes,
or `cordis.patch.yml`) needs a **DSH restart**: DSH caches host modules by URL
and the profile's HMR config does not watch module files, so the running process
keeps serving the code it loaded at startup. Client-half changes only need a
page refresh.
