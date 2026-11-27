const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { launchBrowser } = require('./browser.cjs');

test('Chrome accepts the unpacked extension and starts its service worker', { timeout: 30000 }, async t => {
  const browser = await launchBrowser({ extensionDebugging: true });
  t.after(() => browser.close());
  let result;
  try {
    result = await browser.browserSend('Extensions.loadUnpacked', { path: path.resolve(__dirname, '..') });
  } catch (error) {
    if (/wasn't found|Method not found|not supported/i.test(error.message)) {
      t.skip('This Chromium version does not support CDP extension loading.');
      return;
    }
    throw error;
  }
  assert.match(result.id, /^[a-p]{32}$/);
  let worker;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { targetInfos } = await browser.browserSend('Target.getTargets');
    worker = targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${result.id}/background.js`);
    if (worker) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(worker, 'The background service worker must start successfully.');
  const { sessionId } = await browser.browserSend('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  let value;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await browser.browserSend('Runtime.evaluate', {
      expression: 'typeof chrome !== "undefined" && chrome.runtime?.getManifest ? ({version:chrome.runtime.getManifest().version, handlers:chrome.runtime.onMessage.hasListeners(), commands:chrome.commands.onCommand.hasListeners()}) : null',
      returnByValue: true
    }, sessionId);
    value = status.result.value;
    if (value?.handlers && value?.commands) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(value, { version: '1.0.0', handlers: true, commands: true });
});
