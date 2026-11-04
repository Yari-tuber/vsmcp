# 给 AI agent 的安装说明（AGENTS.md）

> 用户把这个仓库交给你（Claude Code、Codex、Cursor 等能操作电脑的 AI），让你「帮我装好 VSMCP」。照下面一步步做，每一步做完确认结果再往下走；做不到的步骤如实告诉用户，让他手动点。

## 目标

装好 VSMCP 插件 → 开启外网 → 把 ChatGPT 连接地址（`https://…/mcp`）告诉用户 → 教他在 ChatGPT 里添加自定义 MCP 服务器。

## 0. 先问清楚

- 用户用的是 VS Code（不是 Cursor / VSCodium 之类的分支）？分支的话把下面的 `code` 换成对应命令行（`cursor`、`codium`），globalStorage 目录也跟着换。
- 系统：Windows / macOS / Linux。

## 1. 检查环境

```bash
code --version            # 要 1.93 以上；没有 code 命令：VS Code 里 Ctrl+Shift+P →「Shell Command: Install 'code' command in PATH」（Windows 安装时一般已经加好）
code --list-extensions    # 看有没有冲突的插件
```

如果列表里有 `jhamama.vscode-mcp-api`（VS Code MCP 桥接）或其他会占用 3333–3340 端口的 MCP 桥接插件，**先问用户**能不能卸载，同意了再：

```bash
code --uninstall-extension jhamama.vscode-mcp-api
```

## 2. 下载并安装插件

到 https://github.com/Yari-tuber/vsmcp/releases/latest 下载最新的 `vsmcp-x.y.z.vsix`（有 `gh` 就用 `gh release download -R Yari-tuber/vsmcp -p "*.vsix"`），然后：

```bash
code --install-extension vsmcp-x.y.z.vsix --force
```

也可以从源码打包：`git clone https://github.com/Yari-tuber/vsmcp && cd vsmcp && npm ci && npm run package`，生成的 vsix 在仓库根目录。

## 3. 装 cloudflared（外网隧道要用）

```bash
cloudflared --version     # 已经有就跳过
# Windows
winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
# macOS
brew install cloudflared
# Linux：按 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 装
```

## 4. 让用户重载 VS Code、开启外网

你一般点不了 VS Code 的界面，请用户做：

1. VS Code 里 Ctrl+Shift+P（macOS ⌘⇧P）→「Developer: Reload Window / 开发人员: 重新加载窗口」。
2. 左边活动栏点 **VSMCP** 图标 → 点 **开启外网**，等状态变成「外网已开启」。

想让它以后每次打开 VS Code 都自动开外网：**先征得用户同意**，再在用户设置 `settings.json` 里加 `"vsmcp.autoStartTunnel": true`。

## 5. 验证并拿到地址

```bash
curl http://127.0.0.1:3340/health
```

返回 `"status":"ok"` 和当前项目名就说明本机 Hub 正常。没打开任何项目会是 `no_workspace`：让用户在 VS Code 里打开一个文件夹。

外网地址写在插件的共享目录 `tunnel.json` 的 `url` 字段：

| 系统 | 路径 |
|---|---|
| Windows | `%APPDATA%\Code\User\globalStorage\yari.vsmcp\tunnel.json` |
| macOS | `~/Library/Application Support/Code/User/globalStorage/yari.vsmcp/tunnel.json` |
| Linux | `~/.config/Code/User/globalStorage/yari.vsmcp/tunnel.json` |

读到 `url` 后，可以用它验证外网：`curl <url 去掉末尾 /mcp>/health`。也可以让用户在控制台点「复制 ChatGPT 连接地址」。

## 6. 教用户在 ChatGPT 里添加

把下面这段原样发给用户（`<地址>` 换成上一步拿到的）：

1. 打开网页版 ChatGPT → 左边栏「插件」→ 右上角「添加」→「添加自定义 MCP 服务器」。
2. 名称写 `VSMCP`；连接选「服务器 URL」，填 `<地址>`；身份验证选「无身份验证 / No authentication」。
3. 勾「我已了解，并希望继续」→「创建为插件」。
4. 新开对话，输入框打 `@` 选中 VSMCP，先说：「先调用 workspace_overview，告诉我现在打开的是哪个项目。」

如果用户界面里没有「添加自定义 MCP 服务器」，说明他的 ChatGPT 账号还没开放这个功能，如实告诉他。

## 7. 提醒用户（一定要说）

- 外网地址就是钥匙，VSMCP 默认不设密码：别把地址发给别人，用完在控制台点「关闭外网」。
- 临时隧道每次开地址都会变，变了要回 ChatGPT 插件详情里更新。

## 不要做

- 不要把隧道令牌、地址写进仓库或聊天记录以外的公开地方；令牌用控制台「设置隧道令牌」存。
- 没经用户同意，不要卸载他的其他插件、不要改他的 VS Code 设置。
- 不要替用户在 ChatGPT 网页上点按钮或填表（让他自己来）。
