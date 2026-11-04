import * as vscode from 'vscode'

/** 所有设置都在 vsmcp.* 下（原 mcpServer.*；mcpServer.enableCloudflareTunnel 改名为 vsmcp.autoStartTunnel） */
export class Settings {
  static readonly SECTION = 'vsmcp'

  get<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration(Settings.SECTION).get<T>(key)
  }

  get port(): number {
    return this.get<number>('port') ?? 3333
  }

  get portFallback(): boolean {
    return this.get<boolean>('portFallback') ?? true
  }

  get hubPort(): number {
    return this.get<number>('hubPort') ?? 3340
  }

  get autoStartTunnel(): boolean {
    return this.get<boolean>('autoStartTunnel') ?? false
  }

  get autoRecover(): boolean {
    return this.get<boolean>('autoRecover') ?? true
  }

  get enableContextPush(): boolean {
    return this.get<boolean>('enableContextPush') ?? true
  }

  get authToken(): string {
    return this.get<string>('authToken') ?? ''
  }

  /** 隧道实现：cloudflare（cloudflared）或 localtunnel（loca.lt） */
  get tunnelProvider(): 'cloudflare' | 'localtunnel' {
    return this.get<string>('tunnelProvider') === 'localtunnel' ? 'localtunnel' : 'cloudflare'
  }

  /** localtunnel 的固定子域名（留空 = 自动生成随机子域名并保存在共享目录） */
  get tunnelSubdomain(): string {
    return this.get<string>('tunnelSubdomain') ?? ''
  }

  /** 令牌文件的路径（令牌本身存放在系统凭据库，不写入 settings.json） */
  get tunnelTokenFile(): string {
    return this.get<string>('tunnelTokenFile') ?? ''
  }

  get tunnelName(): string {
    return this.get<string>('tunnelName') ?? ''
  }

  get tunnelHostname(): string {
    return this.get<string>('tunnelHostname') ?? ''
  }

  get commandTimeoutMs(): number {
    const v = this.get<number>('commandTimeoutMs') ?? 120_000
    return Math.min(3_600_000, Math.max(1000, v))
  }

  onChange(cb: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(Settings.SECTION)) cb(e)
    })
  }
}
