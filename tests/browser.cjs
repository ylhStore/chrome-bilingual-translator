const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function launchBrowser(options = {}) {
  const candidates = [
    process.env.BILINGUAL_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) throw new Error('找不到测试浏览器，请设置 BILINGUAL_BROWSER_PATH。');
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'bilingual-browser-'));
  const processHandle = spawn(executable, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--window-size=1200,1000',
    ...(options.extensionDebugging ? ['--enable-unsafe-extension-debugging'] : []), 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  let stderr = '';
  const pending = new Map();
  let sequence = 0;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${stderr.slice(-1200)}`)), 20000);
      processHandle.once('error', error => { clearTimeout(timer); reject(error); });
      processHandle.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited (${code}): ${stderr.slice(-1200)}`)); });
      processHandle.stderr.on('data', chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const pageSend = (method, params) => send(method, params, sessionId);
    await pageSend('Page.enable');
    await pageSend('Runtime.enable');
    const evaluate = async expression => {
      const result = await pageSend('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    return {
      evaluate,
      send: pageSend,
      browserSend: send,
      async close() {
        await send('Browser.close').catch(() => {});
        socket.close();
        for (const request of pending.values()) clearTimeout(request.timer);
        await new Promise(resolve => {
          if (processHandle.exitCode !== null) return resolve();
          const timer = setTimeout(() => { processHandle.kill(); resolve(); }, 4000);
          processHandle.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        // This path is created above using mkdtemp and belongs only to this test run.
        await fsp.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
      }
    };
  } catch (error) {
    socket?.close();
    processHandle.kill();
    throw error;
  }
}

async function until(browser, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await browser.evaluate(expression);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

module.exports = { launchBrowser, until };
