/**
 * 侧栏 WebviewView：读 media/panel.html，换上 CSP 和资源地址；数据用 postMessage 推进去。
 */
import * as vscode from 'vscode'
import * as fs from 'fs'
import { randomBytes } from 'crypto'
import type { PanelState } from './panelState.js'
import { log } from '../utils/logger.js'

export interface PanelMessage {
  type?: string
  command?: string
  what?: string
  key?: string
}

export class PanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'vsmcp.panel'
  private view: vscode.WebviewView | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => PanelState,
    private readonly onMessage: (msg: PanelMessage) => Promise<void> | void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const media = vscode.Uri.joinPath(this.extensionUri, 'media')
    view.webview.options = { enableScripts: true, localResourceRoots: [media] }
    view.webview.html = this.html(view.webview, media)
    view.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
      if (msg?.type === 'ready') {
        log.info('面板', '侧栏面板已加载')
        this.push(true)
        return
      }
      await this.onMessage(msg)
      this.push(true)
    })
    view.onDidChangeVisibility(() => {
      if (view.visible) this.push(true)
    })
    view.onDidDispose(() => {
      this.view = undefined
    })
  }

  get visible(): boolean {
    return !!this.view?.visible
  }

  push(force = false): void {
    if (!this.view || (!force && !this.view.visible)) return
    void this.view.webview.postMessage({ type: 'state', state: this.getState() })
  }

  toast(text: string): void {
    void this.view?.webview.postMessage({ type: 'toast', text })
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64')
    let html = fs.readFileSync(vscode.Uri.joinPath(media, 'panel.html').fsPath, 'utf8')
    const csp =
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
      `style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">`
    html = html.replace('<!--VSMCP:CSP-->', csp)
    html = html.replace('href="panel.css"', `href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'))}"`)
    html = html.replace('<script src="panel.js">', `<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'))}">`)
    return html
  }
}
