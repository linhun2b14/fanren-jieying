'use strict';
// 极简 Chrome DevTools Protocol 客户端：用无头 Edge 真实渲染页面并抓截图/报错。
// 只用 Node 内置能力（child_process + 全局 WebSocket），零依赖。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.handlers.forEach((h) => h(msg));
      }
    });
  }
  on(fn) { this.handlers.push(fn); }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
}

async function launch(opts) {
  const o = opts || {};
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fanren-edge-'));
  const port = o.port || 9333;
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--window-size=' + (o.width || 1280) + ',' + (o.height || 900),
    'about:blank',
  ];
  const child = spawn(EDGE, args, { stdio: 'ignore', detached: false });
  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (r.ok) { ver = await r.json(); break; }
    } catch {}
  }
  if (!ver) { try { child.kill(); } catch {} throw new Error('无头 Edge 启动失败（调试端口未就绪）'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  return {
    cdp, child, profile, version: ver.Browser,
    async close() {
      try { ws.close(); } catch {}
      try { child.kill(); } catch {}
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
}

/** 新开一个标签页并 attach，返回 { sessionId, send, evaluate, screenshot, ... } */
async function newPage(browser, url) {
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => browser.cdp.send(m, p, sessionId);

  const consoleErrors = [];
  const pageErrors = [];
  browser.cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push('[log] ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  // 原生 confirm/alert：**自动接受**（否则 `window.confirm` 会把 Runtime.evaluate 挂住到超时）。
  // 编辑器的"删除此卡 / 放弃改动"这类操作会弹 confirm，浏览器自测必须能点过去。
  browser.cdp.on((msg) => {
    if (msg.sessionId !== sessionId || msg.method !== 'Page.javascriptDialogOpening') return;
    browser.cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  if (url) {
    await send('Page.navigate', { url });
    await waitLoad(browser, sessionId);
  }

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('页面内异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async function screenshot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async function setViewport(w, h, mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  }

  return { targetId, sessionId, send, evaluate, screenshot, consoleErrors, pageErrors, setViewport };
}

function waitLoad(browser, sessionId) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { off(); resolve(); }, 15000);
    const off = (() => {
      const h = (msg) => {
        if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
          clearTimeout(t); off(); resolve();
        }
      };
      browser.cdp.on(h);
      return () => { const i = browser.cdp.handlers.indexOf(h); if (i >= 0) browser.cdp.handlers.splice(i, 1); };
    })();
  });
}

module.exports = { launch, newPage, sleep, EDGE };
