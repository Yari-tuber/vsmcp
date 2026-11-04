import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { VsCodeBridge } from '../bridge/VsCodeBridge.js'
import type { TerminalManager } from '../terminal/TerminalManager.js'
import type { WorkspaceTools } from './workspaceTools.js'
import { TOOL_META } from './catalog.js'
import type { Settings } from '../config/Settings.js'
import { log } from '../utils/logger.js'

function symbolKindName(kind: number): string {
  const kinds = ['File','Module','Namespace','Package','Class','Method','Property','Field','Constructor',
    'Enum','Interface','Function','Variable','Constant','String','Number','Boolean','Array','Object',
    'Key','Null','EnumMember','Struct','Event','Operator','TypeParameter']
  return kinds[kind] ?? 'Unknown'
}

function serializeSymbols(symbols: Array<{ name: string; kind: number; range: { start: { line: number; character: number }; end: { line: number; character: number } }; detail?: string; children?: Array<unknown> }>): unknown {
  return symbols.map(s => ({
    name: s.name,
    kind: symbolKindName(s.kind),
    startLine: s.range.start.line,
    endLine: s.range.end.line,
    detail: s.detail ?? null,
    children: s.children ? serializeSymbols(s.children as Parameters<typeof serializeSymbols>[0]) : [],
  }))
}

// Wrap a tool handler with logging
function logged<T, R>(toolName: string, handler: (args: T) => Promise<R>): (args: T) => Promise<R> {
  return async (args: T) => {
    log.debug('工具', `${toolName} 被调用`, args)
    try {
      const result = await handler(args)
      log.debug('工具', `${toolName} 执行完成`)
      return result
    } catch (err) {
      log.error('工具', `${toolName} 执行失败`, (err as Error).message)
      throw err
    }
  }
}

export function registerTools(server: McpServer, bridge: VsCodeBridge, settings: Settings, terminalManager: TerminalManager, workspaceTools: WorkspaceTools): void {
  log.debug('工具', '正在注册工具')

  /** 统一注册：标题和 annotations（只读 / 破坏性）都从 catalog.ts 的 TOOL_META 取 */
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: ToolCallback<S>): void {
    const meta = TOOL_META[name]
    if (!meta) throw new Error(`工具 ${name} 没有登记 annotations`)
    server.registerTool(name, { title: meta.title, description, inputSchema: shape, annotations: meta.annotations }, handler)
  }

  // --- Active File ---
  tool('get_active_file', '获取 VS Code 中当前活动/打开的文件', {}, async () => {
    const snap = bridge.getActiveFileSnapshot()
    return { content: [{ type: 'text', text: JSON.stringify(snap) }] }
  })

  // --- Selection ---
  tool('get_selection', '获取当前文本选区和光标位置', {}, async () => {
    const snap = bridge.getSelectionSnapshot()
    return { content: [{ type: 'text', text: JSON.stringify(snap) }] }
  })

  // --- Open Tabs ---
  tool('get_open_tabs', '获取 VS Code 中当前打开的所有文件标签页', {}, async () => {
    const tabs = bridge.getOpenTabs()
    return { content: [{ type: 'text', text: JSON.stringify(tabs) }] }
  })

  // --- Diagnostics ---
  tool(
    'get_diagnostics',
    '获取 VS Code 语言服务器提供的 LSP 诊断信息（错误、警告、提示）',
    {
      filePath: z.string().optional().describe('指定文件的绝对路径，不传则返回所有打开的文件'),
      severity: z.enum(['error', 'warning', 'information', 'hint']).optional().describe('按最低严重级别过滤'),
    },
    async ({ filePath, severity }) => {
      let diags = await bridge.getDiagnostics(filePath)
      if (severity) {
        const levels = ['hint', 'information', 'warning', 'error']
        const minLevel = levels.indexOf(severity)
        diags = diags.filter(d => levels.indexOf(d.severity) >= minLevel)
      }
      return { content: [{ type: 'text', text: JSON.stringify(diags) }] }
    }
  )

  // --- Show Diff ---
  tool(
    'show_diff',
    '在应用文件更改之前，先在 VS Code 中展示可视化差异。不会写入文件。',
    {
      filePath: z.string().describe('要对比的文件的绝对路径'),
      newContent: z.string().describe('要在差异视图中展示的新内容'),
      title: z.string().optional().describe('差异编辑器标签页的标题'),
    },
    async ({ filePath, newContent, title }) => {
      await bridge.showDiff(filePath, newContent, title)
      return { content: [{ type: 'text', text: JSON.stringify({ shown: true, filePath }) }] }
    }
  )

  // --- Read File ---
  tool(
    'read_file',
    '读取文件内容',
    {
      filePath: z.string().describe('文件的绝对路径'),
      startLine: z.number().int().min(0).optional().describe('起始行（从 0 开始，含）'),
      endLine: z.number().int().min(0).optional().describe('结束行（从 0 开始，含）'),
    },
    async ({ filePath, startLine, endLine }) => {
      const result = await bridge.readFile(filePath, startLine, endLine)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Write File ---
  tool(
    'write_file',
    '向文件写入内容。与 VS Code 撤销历史集成。',
    {
      filePath: z.string().describe('文件的绝对路径'),
      content: z.string().describe('要写入的完整内容'),
      createIfMissing: z.boolean().optional().default(true).describe('文件不存在时创建该文件'),
    },
    async ({ filePath, content, createIfMissing }) => {
      const result = await bridge.writeFile(filePath, content, createIfMissing)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Create File ---
  tool(
    'create_file',
    '创建新文件',
    {
      filePath: z.string().describe('新文件的绝对路径'),
      content: z.string().optional().default('').describe('初始内容'),
    },
    async ({ filePath, content }) => {
      await bridge.createFile(filePath, content)
      return { content: [{ type: 'text', text: JSON.stringify({ created: true, filePath }) }] }
    }
  )

  // --- Delete File ---
  tool(
    'delete_file',
    '删除文件',
    {
      filePath: z.string().describe('要删除的文件的绝对路径'),
      useTrash: z.boolean().optional().default(true).describe('移入回收站而不是永久删除'),
    },
    async ({ filePath, useTrash }) => {
      await bridge.deleteFile(filePath, useTrash)
      return { content: [{ type: 'text', text: JSON.stringify({ deleted: true, filePath }) }] }
    }
  )

  // --- Open File ---
  tool(
    'open_file',
    '在 VS Code 编辑器中打开文件',
    {
      filePath: z.string().describe('文件的绝对路径'),
      line: z.number().int().min(0).optional().describe('要跳转到的行（从 0 开始）'),
      character: z.number().int().min(0).optional().describe('字符位置'),
      preview: z.boolean().optional().default(false).describe('是否以预览模式打开'),
    },
    async ({ filePath, line, character, preview }) => {
      await bridge.openFile(filePath, line, character, preview)
      return { content: [{ type: 'text', text: JSON.stringify({ opened: true, filePath }) }] }
    }
  )

  // --- Close File ---
  tool(
    'close_file',
    '关闭 VS Code 中的文件标签页',
    {
      filePath: z.string().describe('要关闭的文件的绝对路径'),
    },
    async ({ filePath }) => {
      const result = await bridge.closeFile(filePath)
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, filePath }) }] }
    }
  )

  // --- Run Terminal Command ---
  tool(
    'run_terminal_command',
    '运行 shell 命令并捕获其输出。适合构建、测试、lint 这类会结束的命令；开发服务器等长期进程请用 spawn_terminal。',
    {
      command: z.string().describe('要运行的 shell 命令'),
      cwd: z.string().optional().describe('工作目录（默认为工作区根目录）'),
      timeoutMs: z.number().int().min(1000).max(3_600_000).optional().describe('超时时间（毫秒，默认取设置 vsmcp.commandTimeoutMs，2 分钟；最长 1 小时）'),
    },
    async ({ command, cwd, timeoutMs }) => {
      const strategy = settings.get<string>('terminalStrategy') ?? 'childProcess'
      const result = await bridge.runCommand(command, cwd, timeoutMs ?? settings.commandTimeoutMs, strategy)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // --- Find References ---
  tool(
    'find_references',
    '使用 LSP 查找指定位置处符号的所有引用',
    {
      filePath: z.string().describe('文件的绝对路径'),
      line: z.number().int().min(0).describe('行号（从 0 开始）'),
      character: z.number().int().min(0).describe('字符位置（从 0 开始）'),
      includeDeclaration: z.boolean().optional().default(true),
    },
    async ({ filePath, line, character, includeDeclaration }) => {
      const refs = await bridge.getReferences(filePath, line, character, includeDeclaration)
      const serialized = (refs ?? []).map(r => ({
        filePath: r.uri.fsPath,
        startLine: r.range.start.line,
        startChar: r.range.start.character,
        endLine: r.range.end.line,
        endChar: r.range.end.character,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Go To Definition ---
  tool(
    'go_to_definition',
    '使用 LSP 获取指定位置处符号的定义位置',
    {
      filePath: z.string().describe('文件的绝对路径'),
      line: z.number().int().min(0).describe('行号（从 0 开始）'),
      character: z.number().int().min(0).describe('字符位置（从 0 开始）'),
    },
    async ({ filePath, line, character }) => {
      const defs = await bridge.getDefinition(filePath, line, character)
      const serialized = (defs ?? []).map(d => {
        if ('uri' in d) {
          return { filePath: d.uri.fsPath, startLine: d.range.start.line, startChar: d.range.start.character, endLine: d.range.end.line, endChar: d.range.end.character }
        }
        return { filePath: d.targetUri.fsPath, startLine: d.targetRange.start.line, startChar: d.targetRange.start.character, endLine: d.targetRange.end.line, endChar: d.targetRange.end.character }
      })
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Get Hover ---
  tool(
    'get_hover',
    '获取指定位置处符号的悬停信息（类型信息、文档）',
    {
      filePath: z.string().describe('文件的绝对路径'),
      line: z.number().int().min(0).describe('行号（从 0 开始）'),
      character: z.number().int().min(0).describe('字符位置（从 0 开始）'),
    },
    async ({ filePath, line, character }) => {
      const hovers = await bridge.getHover(filePath, line, character)
      const contents = (hovers ?? []).flatMap(h => {
        const c = h.contents
        if (Array.isArray(c)) {
          return c.map(item => (typeof item === 'string' ? item : (item as { value: string }).value))
        }
        return [typeof c === 'string' ? c : (c as { value: string }).value]
      })
      return { content: [{ type: 'text', text: JSON.stringify({ contents }) }] }
    }
  )

  // --- Get Document Symbols ---
  tool(
    'get_document_symbols',
    '获取文件中的所有符号（函数、类、变量等）',
    {
      filePath: z.string().describe('文件的绝对路径'),
    },
    async ({ filePath }) => {
      const symbols = await bridge.getDocumentSymbols(filePath)
      const serialized = serializeSymbols((symbols ?? []) as Parameters<typeof serializeSymbols>[0])
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Search Workspace Symbols ---
  tool(
    'search_workspace_symbols',
    '在整个工作区中搜索符号',
    {
      query: z.string().describe('要搜索的符号名称'),
    },
    async ({ query }) => {
      const symbols = await bridge.getWorkspaceSymbols(query)
      const serialized = (symbols ?? []).map(s => ({
        name: s.name,
        kind: symbolKindName(s.kind),
        filePath: s.location.uri.fsPath,
        startLine: s.location.range.start.line,
        containerName: s.containerName ?? null,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Get Code Actions ---
  tool(
    'get_code_actions',
    '获取文件中指定范围内可用的代码操作（快速修复、重构）',
    {
      filePath: z.string().describe('文件的绝对路径'),
      startLine: z.number().int().min(0),
      startChar: z.number().int().min(0),
      endLine: z.number().int().min(0),
      endChar: z.number().int().min(0),
    },
    async ({ filePath, startLine, startChar, endLine, endChar }) => {
      const actions = await bridge.getCodeActions(filePath, startLine, startChar, endLine, endChar)
      type AnyAction = { title: string; kind?: { value: string }; isPreferred?: boolean }
      const serialized = (actions ?? []).map((a, i) => {
        const action = a as AnyAction
        return {
          index: i,
          title: action.title,
          kind: action.kind?.value ?? null,
          isPreferred: action.isPreferred ?? false,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(serialized) }] }
    }
  )

  // --- Apply Code Action ---
  tool(
    'apply_code_action',
    '按索引应用代码操作（索引来自 get_code_actions 的结果）',
    {
      filePath: z.string().describe('文件的绝对路径'),
      startLine: z.number().int().min(0),
      startChar: z.number().int().min(0),
      endLine: z.number().int().min(0),
      endChar: z.number().int().min(0),
      actionIndex: z.number().int().min(0).describe('get_code_actions 结果中的索引'),
    },
    async ({ filePath, startLine, startChar, endLine, endChar, actionIndex }) => {
      const actions = await bridge.getCodeActions(filePath, startLine, startChar, endLine, endChar)
      const action = (actions ?? [])[actionIndex]
      if (!action) throw new Error(`索引 ${actionIndex} 处不存在代码操作`)

      let applied = false
      if ('edit' in action && action.edit) {
        await import('vscode').then(vscode => vscode.workspace.applyEdit(action.edit!))
        applied = true
      } else if ('command' in action && action.command) {
        const cmd = typeof action.command === 'string' ? action.command : action.command.command
        await import('vscode').then(vscode => vscode.commands.executeCommand(cmd))
        applied = true
      }

      return { content: [{ type: 'text', text: JSON.stringify({ applied, title: 'title' in action ? action.title : '' }) }] }
    }
  )

  // --- Rename Symbol ---
  tool(
    'rename_symbol',
    '重命名符号及其在整个工作区中的所有引用',
    {
      filePath: z.string().describe('文件的绝对路径'),
      line: z.number().int().min(0).describe('行号（从 0 开始）'),
      character: z.number().int().min(0).describe('字符位置（从 0 开始）'),
      newName: z.string().describe('符号的新名称'),
    },
    async ({ filePath, line, character, newName }) => {
      const edit = await bridge.getRenameEdits(filePath, line, character, newName)
      if (!edit) throw new Error('该位置不支持重命名')
      const vscode = await import('vscode')
      await vscode.workspace.applyEdit(edit)
      const filesChanged = new Set(edit.entries().map(([uri]) => uri.fsPath)).size
      const editsApplied = edit.entries().reduce((sum, [, edits]) => sum + edits.length, 0)
      return { content: [{ type: 'text', text: JSON.stringify({ filesChanged, editsApplied }) }] }
    }
  )

  // --- Workspace Info ---
  tool('get_workspace_info', '获取当前 VS Code 工作区的信息', {}, async () => {
    const info = bridge.getWorkspaceInfo()
    return { content: [{ type: 'text', text: JSON.stringify(info) }] }
  })

  // --- Execute VS Code Command ---
  tool(
    'execute_vscode_command',
    '执行任意 VS Code 命令。设置 vsmcp.allowedCommands 留空 = 不限制；填了就只允许列表里的命令。',
    {
      command: z.string().describe('要执行的 VS Code 命令 ID'),
      args: z.array(z.unknown()).optional().default([]).describe('传递给命令的参数'),
    },
    async ({ command, args }) => {
      const allowedCommands = settings.get<Array<string>>('allowedCommands') ?? []
      const result = await bridge.executeCommand(command, args as Array<unknown>, allowedCommands)
      return { content: [{ type: 'text', text: JSON.stringify({ result }) }] }
    }
  )

  // --- Managed Terminals (long-running processes) ---

  tool(
    'spawn_terminal',
    '在 VS Code 终端中启动一个长时间运行的进程（开发服务器、watch 模式等）并捕获输出。短命令请改用 run_terminal_command。',
    {
      name: z.string().describe('终端的显示名称（如 "dev-server"、"tests-watch"）'),
      command: z.string().optional().describe('启动后立即运行的命令（如 "npm run dev"）。不传则只打开一个 shell。'),
      cwd: z.string().optional().describe('工作目录（默认为工作区根目录）'),
    },
    logged('spawn_terminal', async ({ name, command, cwd }) => {
      const result = terminalManager.spawn(name, command, cwd)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  )

  tool(
    'list_terminals',
    '列出所有托管终端及其状态（存活/已退出、日志大小）',
    {},
    logged('list_terminals', async () => {
      const terminals = terminalManager.list()
      return { content: [{ type: 'text', text: JSON.stringify(terminals) }] }
    })
  )

  tool(
    'read_terminal',
    '读取托管终端的最近输出。返回输出缓冲区的末尾内容。',
    {
      id: z.string().describe('终端 ID（来自 spawn_terminal 或 list_terminals）'),
      lines: z.number().int().min(1).optional().describe('从末尾返回的行数（默认：返回全部缓冲输出）'),
    },
    logged('read_terminal', async ({ id, lines }) => {
      const result = terminalManager.readOutput(id, lines)
      if (!result) throw new Error(`终端 '${id}' 不存在`)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })
  )

  tool(
    'write_terminal',
    '向托管终端发送输入/文本（例如回答提示、发送命令）',
    {
      id: z.string().describe('终端 ID'),
      input: z.string().describe('发送到终端标准输入的文本'),
      addNewline: z.boolean().optional().default(true).describe('输入后是否追加换行（默认：true）。交互式提示需要进程直接读取输入时请设为 false。'),
    },
    logged('write_terminal', async ({ id, input, addNewline }) => {
      const ok = terminalManager.write(id, input, addNewline)
      if (!ok) throw new Error(`终端 '${id}' 不存在或已退出`)
      return { content: [{ type: 'text', text: JSON.stringify({ sent: true }) }] }
    })
  )

  tool(
    'kill_terminal',
    '终止托管终端及其进程',
    {
      id: z.string().describe('终端 ID'),
    },
    logged('kill_terminal', async ({ id }) => {
      const ok = terminalManager.kill(id)
      if (!ok) throw new Error(`终端 '${id}' 不存在`)
      return { content: [{ type: 'text', text: JSON.stringify({ killed: true }) }] }
    })
  )

  // --- 增强工具（原 workspace-tools.js）：只读、跳过依赖和凭据、真实路径防越界、校验 workspacePath ---

  const runWorkspaceTool = (name: string) => async (args: Record<string, unknown>) => {
    try {
      const result = await workspaceTools.dispatch(name, args)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
    }
  }
  const workspacePath = z.string().describe('先从 workspace_overview 拿到的工作区根路径（workspacePath）。切换项目后旧路径会被拒绝。')

  tool(
    'workspace_overview',
    '一次拿到当前工作区路径、顶层目录、Git 摘要和工具用法。开始任务或切换项目后请先调用它。',
    {},
    runWorkspaceTool('workspace_overview'),
  )

  tool(
    'list_directory',
    '浏览当前工作区的目录树；默认跳过依赖、构建产物、隐藏目录和常见凭据文件。',
    {
      workspacePath,
      directory: z.string().optional().describe('相对工作区根目录的子目录，默认根目录'),
      depth: z.number().int().min(1).max(4).optional().describe('展开层数，默认 2'),
      limit: z.number().int().min(1).max(500).optional().describe('最多返回多少项，默认 200'),
    },
    runWorkspaceTool('list_directory'),
  )

  tool(
    'find_files',
    '按 glob 查找工作区文件，例如 **/*.py 或 **/package.json。遵守 .gitignore，最多返回 500 条。',
    {
      workspacePath,
      glob: z.string().describe('glob 模式，例如 **/*.ts'),
      limit: z.number().int().min(1).max(500).optional().describe('最多返回多少条，默认 200'),
    },
    runWorkspaceTool('find_files'),
  )

  tool(
    'search_text',
    '跨文件搜索项目文本，返回相对路径、从 1 开始的行号和匹配行。默认按字面搜索、不分大小写，可指定 glob、大小写和正则。',
    {
      workspacePath,
      query: z.string().describe('单行搜索词'),
      glob: z.string().optional().describe('只搜匹配这个 glob 的文件，例如 **/*.ts'),
      regex: z.boolean().optional().describe('按正则搜索'),
      caseSensitive: z.boolean().optional().describe('区分大小写'),
      limit: z.number().int().min(1).max(200).optional().describe('最多返回多少条，默认 80'),
    },
    runWorkspaceTool('search_text'),
  )

  tool(
    'read_files',
    '一次读最多 10 个磁盘上的文本文件，可指定行范围；返回行号、修改时间和截断信息。读的是已保存的内容，未保存的编辑请用 read_file。',
    {
      workspacePath,
      files: z
        .array(
          z.object({
            path: z.string().describe('相对工作区根目录的路径'),
            startLine: z.number().int().min(1).optional().describe('起始行（从 1 开始）'),
            endLine: z.number().int().min(1).optional().describe('结束行（含）'),
          }),
        )
        .min(1)
        .max(10),
    },
    runWorkspaceTool('read_files'),
  )

  tool(
    'git_inspect',
    '只读查看当前项目的 Git 状态、未暂存差异、已暂存差异或最近提交。不会提交、切分支、拉取或推送。',
    {
      workspacePath,
      view: z.enum(['status', 'diff', 'staged', 'log']).describe('status / diff / staged / log'),
      file: z.string().optional().describe('只看这个文件（相对路径）'),
      limit: z.number().int().min(1).max(30).optional().describe('log 显示多少条，默认 10'),
    },
    runWorkspaceTool('git_inspect'),
  )
}
