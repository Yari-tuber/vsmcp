/**
 * 33 个工具的标题和 MCP annotations（27 个上游工具 + 6 个增强工具）。
 *
 * - readOnlyHint: true —— 只读，ChatGPT 对只读工具不弹确认
 * - destructiveHint: true —— delete_file / run_terminal_command / write_terminal / kill_terminal / execute_vscode_command
 * - 其余会改东西但不算破坏性的（写文件、重命名、开终端…）显式标 destructiveHint: false
 *   （MCP 规范里 readOnlyHint 为 false 时 destructiveHint 默认是 true，所以要写明）
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

export interface ToolMeta {
  title: string
  annotations: ToolAnnotations
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const

function meta(title: string, kind: typeof READ | typeof WRITE | typeof DESTRUCTIVE): ToolMeta {
  return { title, annotations: { title, ...kind } }
}

export const TOOL_META: Record<string, ToolMeta> = {
  // 上游 27 个
  get_active_file: meta('读取当前文件', READ),
  get_selection: meta('读取选区', READ),
  get_open_tabs: meta('列出打开的标签页', READ),
  get_diagnostics: meta('读取诊断信息', READ),
  show_diff: meta('展示差异（不写文件）', READ),
  read_file: meta('读取文件', READ),
  write_file: meta('写入文件', WRITE),
  create_file: meta('新建文件', WRITE),
  delete_file: meta('删除文件', DESTRUCTIVE),
  open_file: meta('在编辑器打开文件', WRITE),
  close_file: meta('关闭标签页', WRITE),
  run_terminal_command: meta('运行命令', DESTRUCTIVE),
  find_references: meta('查找引用', READ),
  go_to_definition: meta('跳到定义', READ),
  get_hover: meta('读取悬停信息', READ),
  get_document_symbols: meta('文件符号', READ),
  search_workspace_symbols: meta('搜索工作区符号', READ),
  get_code_actions: meta('列出代码操作', READ),
  apply_code_action: meta('应用代码操作', WRITE),
  rename_symbol: meta('重命名符号', WRITE),
  get_workspace_info: meta('工作区信息', READ),
  execute_vscode_command: meta('执行 VS Code 命令', DESTRUCTIVE),
  spawn_terminal: meta('启动长期进程', WRITE),
  list_terminals: meta('列出托管终端', READ),
  read_terminal: meta('读取终端输出', READ),
  write_terminal: meta('向终端输入', DESTRUCTIVE),
  kill_terminal: meta('结束终端', DESTRUCTIVE),
  // 增强 6 个（全部只读）
  workspace_overview: meta('工作区总览', READ),
  list_directory: meta('浏览目录', READ),
  find_files: meta('按 glob 找文件', READ),
  search_text: meta('全文搜索', READ),
  read_files: meta('批量读文件', READ),
  git_inspect: meta('查看 Git', READ),
}

export const UPSTREAM_TOOL_COUNT = 27
export const ENHANCED_TOOL_COUNT = 6
