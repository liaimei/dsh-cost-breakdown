/**
 * Context 浏览器工具 schema 行的「工具 → 插件」归因。
 *
 * 持久 `request/header` 事件把每个工具都记成普通的 `ToolSchema`（只有
 * `name`/`description`/`parameters`），注册它的插件不在日志里。三条补救来源：
 * 外部生产者在原始 header 条目上带的 `plugin` 字段（由 headers.ts 透传）、
 * `dsh-mcp-client` 的命名语法，以及随包一方工具的固定「名称 → 包」映射。
 * 第三方工具宁可保持未归因，也不去猜。
 */

/** `dsh-mcp-client` 代理名称的前缀；原始 MCP 工具名接在 `<server>__` 之后。 */
export const MCP_PREFIX = 'mcp__'

/** 从代理工具名还原 MCP server 标签：`dsh-mcp-client` 的命名是
 * `mcp__<server>__<rawName>`，因此 server 是前缀之后、最后一个 `__` 之前的那段文本。 */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const cut = name.lastIndexOf('__')
  if (cut < MCP_PREFIX.length) return undefined
  const server = name.slice(MCP_PREFIX.length, cut)
  return server.length > 0 ? server : undefined
}

/** 代理工具对应的 `mcp:<server>` 展示标签；名称不符合 MCP 语法时返回 undefined。 */
export function mcpSourceOf(name: string): string | undefined {
  const server = mcpServerOf(name)
  return server !== undefined ? `mcp:${server}` : undefined
}

/** 随包一方工具名对应的固定包；第三方名称返回 undefined，
 * 未知名称因此保持未归因，而不是被乱猜。 */
export function pinnedSourceOf(name: string): string | undefined {
  return FIRST_PARTY_SOURCES[name]
}

/** 固定的一方「工具 → 包」映射：受支持的 dsh 基线（tests/baselines.ts）上，随包工具包每个
 * 面向模型的名字各一条。同一包在不同组合下以不同名字挂载的（bash/pwsh 变体、`subagent_fork`
 * 别名），统一映射到主名。 */
export const FIRST_PARTY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  read: '@deepseek-ai/dsh-tool-fs',
  write: '@deepseek-ai/dsh-tool-fs',
  edit: '@deepseek-ai/dsh-tool-fs',
  read_image: '@deepseek-ai/dsh-tool-fs',
  glob: '@deepseek-ai/dsh-tool-fs-search',
  grep: '@deepseek-ai/dsh-tool-fs-search',
  str_replace_editor: '@deepseek-ai/dsh-tool-str-replace-editor',
  bash: '@deepseek-ai/dsh-tool-bash',
  pwsh: '@deepseek-ai/dsh-tool-pwsh',
  web_search: '@deepseek-ai/dsh-tool-web',
  web_fetch: '@deepseek-ai/dsh-tool-web',
  job_output: '@deepseek-ai/dsh-tool-jobs',
  job_list: '@deepseek-ai/dsh-tool-jobs',
  job_kill: '@deepseek-ai/dsh-tool-jobs',
  ask_user_question: '@deepseek-ai/dsh-tool-ask-user',
  plan: '@deepseek-ai/dsh-plan-mode',
  exit_plan_mode: '@deepseek-ai/dsh-plan-mode',
  skill: '@deepseek-ai/dsh-tool-skill',
  todo_write: '@deepseek-ai/dsh-tool-todo',
  subagent: '@deepseek-ai/dsh-tool-subagent',
  subagent_fork: '@deepseek-ai/dsh-tool-subagent',
  send_message: '@deepseek-ai/dsh-tool-subagent-control',
  interrupt_agent: '@deepseek-ai/dsh-tool-subagent-control',
  list_agents: '@deepseek-ai/dsh-tool-subagent-control',
  ralph: '@deepseek-ai/dsh-tool-ralph',
  workflow: '@deepseek-ai/dsh-tool-workflow',
  run_code: '@deepseek-ai/dsh-tools',
  schedule_create: '@deepseek-ai/dsh-schedule',
  schedule_list: '@deepseek-ai/dsh-schedule',
  schedule_delete: '@deepseek-ai/dsh-schedule',
  create_goal: '@deepseek-ai/dsh-tool-goal',
  get_goal: '@deepseek-ai/dsh-tool-goal',
  update_goal: '@deepseek-ai/dsh-tool-goal',
  lsp: '@deepseek-ai/dsh-tool-lsp',
})
