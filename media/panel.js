// VSMCP 侧栏面板渲染。只认 postMessage 进来的数据：
//   { type: 'state', state: PanelState }   —— 状态（格式见 src/ui/panelState.ts）
//   { type: 'toast', text }                —— 底部提示
//   { type: 'theme', vars, className }     —— 只给 panel-demo.html 用：在浏览器里模拟 VS Code 主题
// 按钮点了以后发回给扩展：{ type: 'run', command } / { type: 'copy', what } / { type: 'lock', key } / { type: 'ackUrl' }
;(function () {
  'use strict'
  var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null
  var app = document.getElementById('app')
  var toastEl = document.getElementById('toast')
  var current = null
  var lastSig = ''
  var toastTimer = 0

  // ---------- 图标（线框，跟随文字颜色） ----------
  var P = {
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
    power: '<path d="M12 3v8"/><path d="M6.4 7.2a8 8 0 1 0 11.2 0"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    follow: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15"/><path d="M4 20v-5h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.01"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12.2L20 3.5M16.5 7l2.5 2.5M14 9.5l2 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    log: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14h4"/>',
    shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
    hub: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="20" r="2"/><path d="M7 6.5l3 3.5M17 6.5l-3 3.5M12 15v3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
  }
  function icon(name, size) {
    var s = size || 15
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>'
  }
  var LOGO = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6l5 12 5-12"/><path d="M15.5 13.5a2.5 2.5 0 1 0 3.5-2.3"/><circle cx="18" cy="8" r="1.4" fill="currentColor" stroke="none"/></svg>'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // ---------- 和扩展通信 ----------
  function send(msg) {
    if (vscode) vscode.postMessage(msg)
    else {
      // 单独在浏览器里打开（panel-demo.html）：把操作告诉外层页面
      try { window.parent.postMessage({ type: 'vsmcp-demo-action', msg: msg }, '*') } catch (e) { /* 忽略 */ }
      if (msg.type === 'copy') showToast('已复制（演示）')
    }
  }

  function showToast(text) {
    toastEl.innerHTML = icon('check', 13) + '<span>' + esc(text) + '</span>'
    toastEl.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastEl.classList.remove('show') }, 1800)
  }

  // ---------- 小工具 ----------
  function rel(until) {
    var s = Math.round((until - Date.now()) / 1000)
    if (!isFinite(s)) return ''
    if (s <= 0) return '马上'
    if (s < 60) return s + ' 秒后'
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒后'
  }
  function ago(at) {
    var s = Math.round((Date.now() - at) / 1000)
    if (s < 60) return '刚刚'
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
    return Math.floor(s / 3600) + ' 小时前'
  }
  function initial(name) {
    var c = String(name || '?').trim().charAt(0)
    return c ? c.toUpperCase() : '?'
  }
  function btn(cls, label, attrs, ic) {
    return '<button class="btn ' + cls + '" ' + attrs + '>' + (ic ? icon(ic, 14) : '') + '<span>' + label + '</span></button>'
  }

  // ---------- 各块 ----------
  function healthChip(d) {
    var map = {
      ok: ['tone-ok', '一切正常'],
      info: ['tone-info', '正在检查'],
      warning: ['tone-warn', '需要留意'],
      error: ['tone-err', '需要处理'],
    }
    var m = map[d.level] || map.info
    if (d.code === 'tunnel_off') m = ['tone-off', '外网未开']
    var pulse = d.code === 'tunnel_starting' || d.code === 'checking_public' ? ' pulse' : ''
    return '<span class="chip ' + m[0] + pulse + '" title="' + esc(d.message) + '"><span class="dot"></span>' + m[1] + '</span>'
  }

  function kindLabel(t) {
    if (t.kind === 'token') return '固定域名 · 令牌隧道'
    if (t.kind === 'named') return '固定域名 · 命名隧道'
    if (t.kind === 'localtunnel') return 'loca.lt' + (t.fixed ? ' · 固定子域名' : '')
    return 'Cloudflare 临时地址'
  }

  function heroCard(s) {
    var t = s.tunnel
    var phase = t.wanted ? t.phase : 'off'
    var h = '<section class="card hero">'
    h += '<div class="card-head"><span class="card-title">ChatGPT 连接地址</span><span class="spacer"></span><span class="tag' + (phase === 'connected' ? ' accent' : '') + '">' + esc(kindLabel(t)) + '</span></div>'

    var tone = { off: 'tone-off', starting: 'tone-info', connected: 'tone-ok', disconnected: 'tone-warn', error: 'tone-err' }[phase] || 'tone-off'
    var title, sub
    if (phase === 'off') { title = '外网没开'; sub = '开启后把地址填进 ChatGPT 的「添加自定义 MCP 服务器」' }
    else if (phase === 'starting') { title = '正在建立隧道…'; sub = '一般 10–30 秒，地址出来就能复制' }
    else if (phase === 'connected') { title = '外网已开启'; sub = t.connections != null ? t.connections + ' 条边缘连接' + (t.startedAt ? ' · ' + ago(t.startedAt) + '开启' : '') : (t.startedAt ? ago(t.startedAt) + '开启' : '可以在 ChatGPT 里用了') }
    else if (phase === 'disconnected') { title = '外网暂时断开'; sub = t.nextRetryAt ? '自动重建：<span data-until="' + t.nextRetryAt + '">' + rel(t.nextRetryAt) + '</span>' : '正在等待恢复' }
    else { title = '外网开不起来'; sub = t.lastError || '未知错误' }
    var stateIcon = phase === 'starting' ? '<span class="spinner"></span>' : icon(phase === 'error' ? 'alert' : 'globe', 18)
    h += '<div class="state-line ' + tone + '"><div class="state-icon">' + stateIcon + '</div><div class="state-text"><b>' + title + '</b><span>' + (phase === 'error' ? esc(sub) : sub) + '</span></div></div>'

    if (t.url && phase !== 'off') {
      h += '<div class="url"><code title="' + esc(t.url) + '">' + esc(t.url) + '</code><button data-copy="publicUrl" title="复制 ChatGPT 连接地址">' + icon('copy', 14) + '复制</button></div>'
    }
    if (t.urlChanged && t.url) {
      h += '<div class="note tone-warn">' + icon('alert', 14) + '<div class="grow">地址变了：ChatGPT 里的连接器要改成上面这个新地址。<br><button class="link" data-act="ackUrl">知道了</button></div></div>'
    }

    h += '<div class="btns">'
    if (phase === 'off') h += btn('primary block', '开启外网', 'data-cmd="vsmcp.startTunnel"', 'power')
    else if (phase === 'starting') h += btn('ghost', '取消', 'data-cmd="vsmcp.stopTunnel"', 'x')
    else if (phase === 'connected') h += btn('secondary', '复制使用提示词', 'data-copy="usage"', 'chat') + btn('ghost', '关闭外网', 'data-cmd="vsmcp.stopTunnel"', 'power')
    else if (phase === 'disconnected') h += btn('primary', '恢复连接', 'data-cmd="vsmcp.recover"', 'restart') + btn('ghost', '关闭外网', 'data-cmd="vsmcp.stopTunnel"', 'power')
    else {
      if (t.errorCode === 'cloudflared_missing') h += btn('primary', '安装 cloudflared', 'data-cmd="vsmcp.installCloudflared"', 'download')
      else h += btn('primary', '恢复连接', 'data-cmd="vsmcp.recover"', 'restart')
      h += btn('ghost', '关闭外网', 'data-cmd="vsmcp.stopTunnel"', 'power')
    }
    h += '</div>'

    if (s.hub.status === 'other' && t.wanted) {
      h += '<div class="hint">' + icon('hub', 13) + '<span>隧道由「' + esc(s.hub.name || '另一个窗口') + '」窗口负责（Hub）；它关了别的窗口会自动接手。</span></div>'
    }
    h += '<div class="hint">' + icon('key', 13) + '<span>外网地址就是钥匙，别外传；用完点「关闭外网」。' + (t.kind === 'quick' ? '临时地址每次开都会变。' : '') + (s.auth.enabled ? '已开启 Bearer 鉴权。' : '') + '</span></div>'
    return h + '</section>'
  }

  function targetCard(s) {
    var r = s.route
    var tgt = r.target
    var h = '<section class="card">'
    h += '<div class="card-head"><span class="card-title">AI 现在操作的项目</span><span class="spacer"></span><span class="tag">' + (r.mode === 'manual' ? '已锁定' : '自动跟随') + '</span></div>'
    if (tgt) {
      h += '<div class="target"><div class="avatar">' + esc(initial(tgt.name)) + '</div><div class="info"><span class="name">' + esc(tgt.name) + '</span><span class="path" title="' + esc(tgt.path) + '">' + esc(tgt.path) + '</span></div></div>'
    } else {
      h += '<div class="target"><div class="avatar off">?</div><div class="info"><span class="name muted">没有目标</span><span class="path">' + esc(r.desiredName ? '想用：' + r.desiredName : '—') + '</span></div></div>'
      h += '<div class="note tone-warn">' + icon('alert', 14) + '<div class="grow">' + esc(r.reason || '还没选给 AI 的项目') + '</div></div>'
    }
    var autoOn = r.mode === 'auto'
    var lockOn = r.mode === 'manual' && tgt && tgt.isSelf
    var lockDisabled = !s.self.hasFolders
    h += '<div class="seg" role="group" aria-label="路由方式">'
    h += '<button class="' + (autoOn ? 'on' : '') + '" data-cmd="vsmcp.autoFollow" title="跟着你最后点过的 VS Code 窗口走">' + icon('follow', 13) + '自动跟随</button>'
    h += '<button class="' + (lockOn ? 'on' : '') + '" data-cmd="vsmcp.lockCurrent"' + (lockDisabled ? ' disabled title="本窗口没有打开项目文件夹"' : ' title="锁定本窗口的项目，切换窗口也不变"') + '>' + icon('lock', 13) + '锁定本窗口项目</button>'
    h += '</div>'
    h += '<div class="hint">' + icon('info', 13) + '<span>' + (r.mode === 'manual'
      ? '已锁定：切换窗口也不会变。正在执行的任务做完再换项目。'
      : '跟着你最后点过的 VS Code 窗口走；长任务建议锁定。') + '</span></div>'
    return h + '</section>'
  }

  function projectsCard(s) {
    var list = s.projects || []
    var h = '<section class="card">'
    h += '<div class="card-head"><span class="card-title">打开的项目</span><span class="spacer"></span><span class="tag">' + list.length + ' 个窗口</span></div>'
    if (!list.length) {
      h += '<div class="empty">还没有打开项目的 VS Code 窗口</div>'
    } else {
      h += '<div class="list">'
      list.forEach(function (p) {
        var badges = ''
        if (p.isTarget) badges += '<span class="badge tone-ok">AI 在用</span>'
        if (p.duplicate) badges += '<span class="badge tone-warn">重复</span>'
        if (p.isSelf) badges += '<span class="badge tone-info">本窗口</span>'
        if (p.isHub) badges += '<span class="badge">Hub</span>'
        var title = p.path + (p.extraRoots ? '（另有 ' + p.extraRoots + ' 个根目录）' : '') + ' · 端口 ' + p.port
        h += '<button class="row' + (p.isTarget ? ' current' : '') + '" data-lock="' + esc(p.key) + '" title="' + esc(title) + '">'
        h += '<span class="ico">' + icon('folder', 15) + '</span>'
        h += '<span class="meta"><b>' + esc(p.name) + '</b><span>' + esc(p.path) + '</span></span>'
        h += '<span class="badges' + (p.isTarget && s.route.mode === 'manual' ? '' : ' hide-on-hover') + '">' + badges + '</span>'
        if (!(p.isTarget && s.route.mode === 'manual')) h += '<span class="lock-hint">' + icon('lock', 12) + '</span>'
        h += '</button>'
      })
      h += '</div>'
      h += '<div class="hint">' + icon('info', 13) + '<span>点一下就锁定那个项目给 AI。目标关掉时会停下来报错，不会改投别的项目。</span></div>'
    }
    return h + '</section>'
  }

  function healthCard(s) {
    var d = s.diagnosis
    var L = d.layers
    function node(label, st) {
      return '<div class="node st-' + esc(st) + '"><span class="ring"><i></i></span><b>' + label + '</b></div>'
    }
    var h = '<section class="card">'
    h += '<div class="card-head"><span class="card-title">连接自检</span><span class="spacer"></span>' + healthChip(d) + '</div>'
    h += '<div class="chain">' + node('项目', L.workspace) + node('Hub', L.hub) + node('隧道', L.tunnel) + node('公网', L.public) + '</div>'
    h += '<div><div class="diag-msg">' + esc(d.message) + '</div><div class="diag-act">' + esc(d.action) + '</div></div>'
    var kv = []
    kv.push('<span>Hub <b>' + (s.hub.status === 'self' ? '本窗口' : s.hub.status === 'other' ? esc(s.hub.name || '其他窗口') : s.hub.status === 'foreign' ? '端口被占用' : '选举中') + '</b></span>')
    if (s.tunnel.wanted && s.tunnel.restarts) kv.push('<span>已重建 <b>' + s.tunnel.restarts + '</b> 次</span>')
    if (s.tunnel.wanted && s.tunnel.nextRetryAt && s.tunnel.phase !== 'connected') kv.push('<span>下次重试 <b data-until="' + s.tunnel.nextRetryAt + '">' + rel(s.tunnel.nextRetryAt) + '</b></span>')
    if (s.tunnel.probe) kv.push('<span>公网自检 <b>' + (s.tunnel.probe.ok ? '通过' : '失败') + '</b> · ' + ago(s.tunnel.probe.at) + '</span>')
    h += '<div class="kv">' + kv.join('') + '</div>'
    h += '<div class="btns">' + btn('secondary', '恢复连接', 'data-cmd="vsmcp.recover"', 'restart') + btn('ghost', '诊断', 'data-cmd="vsmcp.diagnose"', 'pulse') + btn('ghost', '日志', 'data-cmd="vsmcp.showLogs"', 'log') + '</div>'
    return h + '</section>'
  }

  function actionsCard(s) {
    function mini(label, attrs, ic, disabled) {
      return '<button class="mini" ' + attrs + (disabled ? ' disabled' : '') + '>' + icon(ic, 15) + '<span>' + label + '</span></button>'
    }
    var h = '<section class="card">'
    h += '<div class="card-head"><span class="card-title">提示词与工具</span></div>'
    h += '<div class="grid">'
    h += mini('复制使用提示词', 'data-copy="usage"', 'chat')
    h += mini('复制验证提示词', 'data-copy="verify"', 'shield')
    h += mini('复制本机地址', 'data-copy="localUrl"', 'laptop')
    h += mini('复制关键提示词', 'data-copy="key"', 'copy', !s.tunnel.url)
    h += mini(s.tokenSet ? '隧道令牌（已设）' : '隧道令牌', 'data-cmd="vsmcp.setTunnelToken"', 'key')
    h += mini('设置', 'data-cmd="vsmcp.openSettings"', 'gear')
    h += '</div>'
    return h + '</section>'
  }

  function render(s) {
    current = s
    var h = ''
    h += '<header class="top"><div class="logo">' + LOGO + '</div><div class="brand"><b>VSMCP</b><span>网页版 ChatGPT ⇄ 本机 VS Code</span></div><span class="spacer"></span>' + healthChip(s.diagnosis) + '</header>'
    h += heroCard(s)
    h += targetCard(s)
    h += projectsCard(s)
    h += healthCard(s)
    h += actionsCard(s)
    h += '<footer class="foot">v' + esc(s.version) + ' · Hub <span class="mono">' + esc(s.local.hubUrl.replace(/^http:\/\//, '').replace(/\/mcp$/, '')) + '</span>' +
      (s.self.port ? ' · 本窗口 <span class="mono">:' + s.self.port + '</span>' : ' · 本窗口服务未运行') +
      ' · 搜索 ' + (s.search === 'ripgrep' ? 'ripgrep' : '逐文件扫描') + '</footer>'
    app.innerHTML = h
    if (!vscode) {
      // 演示页：把内容高度告诉外层，让侧栏刚好装下（截图不出滚动条）
      try { window.parent.postMessage({ type: 'vsmcp-demo-height', height: app.getBoundingClientRect().bottom + window.scrollY + 28 }, '*') } catch (e) { /* 忽略 */ }
    }
  }

  // ---------- 事件 ----------
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-cmd],[data-copy],[data-lock],[data-act]') : null
    if (!el || el.disabled) return
    if (el.dataset.cmd) send({ type: 'run', command: el.dataset.cmd })
    else if (el.dataset.copy) send({ type: 'copy', what: el.dataset.copy })
    else if (el.dataset.lock) send({ type: 'lock', key: el.dataset.lock })
    else if (el.dataset.act === 'ackUrl') send({ type: 'ackUrl' })
  })

  window.addEventListener('message', function (e) {
    var m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'state' && m.state) {
      // 状态没变就不重画，免得打断鼠标悬停和键盘焦点
      var sig = JSON.stringify(m.state, function (k, v) { return k === 'now' ? undefined : v })
      if (sig === lastSig) return
      lastSig = sig
      render(m.state)
    }
    else if (m.type === 'toast') showToast(m.text || '')
    else if (m.type === 'theme') {
      var root = document.documentElement
      Object.keys(m.vars || {}).forEach(function (k) { root.style.setProperty(k, m.vars[k]) })
      document.body.className = m.className || ''
    }
  })

  // 倒计时每秒刷新，不用整页重画
  setInterval(function () {
    var els = document.querySelectorAll('[data-until]')
    for (var i = 0; i < els.length; i++) els[i].textContent = rel(Number(els[i].getAttribute('data-until')))
  }, 1000)

  if (vscode) vscode.postMessage({ type: 'ready' })
  else {
    try { window.parent.postMessage({ type: 'vsmcp-demo-ready' }, '*') } catch (e) { /* 忽略 */ }
  }
  window.__vsmcpRender = render
  window.__vsmcpState = function () { return current }
})()
