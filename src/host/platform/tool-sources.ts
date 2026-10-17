/**
 * Static attribution remedies: what a bare tool name can tell us about its owning plugin.
 *
 * A durable `request/header` event records each tool as a plain schema (name, description,
 * parameters) — the plugin that registered it is simply not in the log. Two cheap remedies live
 * here; the third (live capture) needs the runtime and lives in `./attribution.ts`. Third-party
 * names deliberately stay unattributed: guessing produces a wrong label, which is worse than an
 * empty one.
 */

/** Prefix `dsh-mcp-client` puts on proxied tool names; the raw MCP name follows `<server>__`. */
export const MCP_PREFIX = 'mcp__'

/**
 * Recover the MCP server label from a proxied name. The naming is
 * `mcp__<server>__<rawName>`, so the server is the slice after the prefix and before the *last*
 * `__` (a raw name may itself contain `__`).
 */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const cut = name.lastIndexOf('__')
  if (cut < MCP_PREFIX.length) return undefined
  const server = name.slice(MCP_PREFIX.length, cut)
  return server.length > 0 ? server : undefined
}

/** The `mcp:<server>` display label of a proxied tool; `undefined` when the name is not MCP. */
export function mcpSourceOf(name: string): string | undefined {
  const server = mcpServerOf(name)
  return server !== undefined ? `mcp:${server}` : undefined
}

/**
 * First-party tools pinned to the package that ships them, one entry per model-facing name on
 * the supported baselines. Packages mounted under several names in different combinations
 * (the bash/pwsh variants, the `subagent_fork` alias) all map to their primary name.
 */
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

/** The pinned package of a first-party tool; third-party names stay unattributed. */
export function pinnedSourceOf(name: string): string | undefined {
  return FIRST_PARTY_SOURCES[name]
}
