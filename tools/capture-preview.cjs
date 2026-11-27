// Manual preview capture: translates the included demo via the real extension worker.
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launchBrowser, until } = require('../tests/browser.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  const browser = await launchBrowser({ extensionDebugging: true });
  try {
    const { id } = await browser.browserSend('Extensions.loadUnpacked', { path: root });
    let worker;
    for (let attempt = 0; attempt < 60 && !worker; attempt += 1) {
      worker = (await browser.browserSend('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${id}/background.js`);
      if (!worker) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!worker) throw new Error('Extension worker did not start.');
    const { sessionId } = await browser.browserSend('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    await browser.send('Page.navigate', { url: pathToFileURL(path.join(root, 'demo.html')).href });
    await until(browser, `document.querySelector('#intro') && document.readyState==='complete'`);
    await browser.evaluate(`
      globalThis.translationListeners=[];
      globalThis.previewRequests=[];
      globalThis.translations={};
      globalThis.chrome={runtime:{
        onMessage:{addListener:listener=>translationListeners.push(listener)},
        sendMessage:async message=>{previewRequests.push(message.text);return {ok:true,translation:translations[message.text] || '准备翻译'};}
      }};
      globalThis.previewCommand=type=>new Promise(resolve=>translationListeners[0]({type:'BILINGUAL_'+type},{},resolve));
    `);
    await browser.evaluate(await fs.readFile(path.join(root, 'content.js'), 'utf8'));
    const css = await fs.readFile(path.join(root, 'content.css'), 'utf8');
    await browser.evaluate(`const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);previewCommand('START')`);
    await until(browser, `previewRequests.length > 4 && document.querySelector('#intro > [data-bilingual-owned]')`);
    const texts = await browser.evaluate(`Array.from(new Set(previewRequests))`);
    const translated = await browser.browserSend('Runtime.evaluate', {
      expression: `Promise.all(${JSON.stringify(texts)}.map(async text=>[text,await requestTranslation(text)]))`,
      awaitPromise: true, returnByValue: true
    }, sessionId);
    if (translated.exceptionDetails) throw new Error(translated.exceptionDetails.exception?.description || 'Google translation failed.');
    await browser.evaluate(`previewCommand('RESTORE'); translations=Object.fromEntries(${JSON.stringify(translated.result.value)}); previewCommand('START')`);
    await until(browser, `document.querySelector('#intro > [data-bilingual-owned]')?.textContent !== '准备翻译'`);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await fs.writeFile(path.join(root, 'preview.png'), Buffer.from(data, 'base64'));
    console.log(`Captured bilingual demo with ${texts.length} real Google translations.`);

    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      globalThis.chrome={tabs:{query:async()=>[{id:42,url:'https://example.com/'}]},storage:{local:{get:async()=>({observeDynamic:true}),set:async()=>{}}},runtime:{sendMessage:async()=>({ok:true,status:{enabled:false,translated:0,pending:0,translating:0,failed:0,error:''}})}};
    ` });
    await browser.send('Page.navigate', { url: pathToFileURL(path.join(root, 'popup.html')).href });
    await until(browser, `document.querySelector('#status-title')?.textContent==='准备好阅读这篇网页'`);
    const height = await browser.evaluate(`document.body.scrollHeight`);
    const popup = await browser.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 360, height, scale: 1 } });
    await fs.writeFile(path.join(root, 'popup-preview.png'), Buffer.from(popup.data, 'base64'));
    console.log('Captured popup preview.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
