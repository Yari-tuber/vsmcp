/** 复制给网页版 ChatGPT 的几段提示词（不依赖固定域名） */

/** 「复制使用提示词」：贴进 ChatGPT 对话开头，告诉它怎么用这套工具（原 网页版使用提示词.txt） */
export const USAGE_PROMPT = `请用我连接的 VSMCP（VS Code）工具完成接下来的任务。

先调用 workspace_overview，确认当前项目和根路径（workspacePath），不要沿用上个项目的路径。

浏览目录用 list_directory，按文件名查找用 find_files，跨文件搜内容用 search_text；读多个文件优先用 read_files。这几个增强工具都要传刚刚确认的 workspacePath。

查 Git 用 git_inspect（status、diff、staged、log）。read_files 读的是已保存到磁盘的内容，未保存的编辑用 read_file。

修改前先读相关文件，需要时用 show_diff 展示差异；修改后用 get_diagnostics 检查编辑器诊断，用 run_terminal_command 运行项目实际的测试。长时间运行的服务用 spawn_terminal、read_terminal 和 kill_terminal 管理。

只根据工具实际返回判断完成情况。遇到「工作区已切换」就重新调用 workspace_overview；遇到 ChatGPT 会话报 FORBIDDEN 就如实告诉我，不要把它当成项目代码的问题。`

/** 「复制 GPT 验证提示词」：切换项目后让 ChatGPT 先确认自己连的是哪个项目 */
export const VERIFY_PROMPT =
  '请通过 VSMCP 调用 workspace_overview，告诉我当前工作区的名字和完整路径，确认后再读取文件。不要沿用上个项目的路径。'

/** 「复制关键提示词」（上游功能）：外网地址 + 一句使用指令，发给能自己加连接器的智能体 */
export function keyPrompt(mcpUrl: string): string {
  return `${mcpUrl}\n\n请你连接使用这个 MCP，了解里面可以用的工具，然后接下来所有对话都使用 MCP 里面的工具完成。开始前先调用 workspace_overview 确认当前项目。`
}
