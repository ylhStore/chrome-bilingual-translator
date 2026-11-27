const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { launchBrowser, until } = require('./browser.cjs');

test('popup actions, settings and error feedback work in Chromium', { timeout: 30000 }, async t => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.calls = [];
    globalThis.settings = {observeDynamic:true};
    globalThis.state = {enabled:false,translated:0,pending:0,translating:0,failed:0,error:''};
    globalThis.chrome = {
      tabs:{query:async()=>[{id:42,url:'https://example.com/'}]},
      storage:{local:{get:async()=>settings,set:async value=>Object.assign(settings,value)}},
      runtime:{sendMessage:async message=>{
        calls.push(message);
        if(message.action==='start') state={...state,enabled:true,translated:5};
        if(message.action==='restore') state={...state,enabled:false,translated:0};
        if(message.action==='settings') state.observeDynamic=message.observeDynamic;
        return {ok:true,status:state};
      }}
    };
  ` });
  await browser.send('Page.navigate', { url: pathToFileURL(path.resolve(__dirname, '..', 'popup.html')).href });
  await until(browser, `document.querySelector('#translate') && !document.querySelector('#translate').disabled`);
  assert.equal(await browser.evaluate(`document.querySelector('#restore').disabled`), true);
  await browser.evaluate(`document.querySelector('#translate').click()`);
  await until(browser, `document.querySelector('#status-detail').textContent.includes('已翻译 5 段')`);
  assert.equal(await browser.evaluate(`document.querySelector('#restore').disabled`), false);
  await browser.evaluate(`document.querySelector('#dynamic').click()`);
  await until(browser, `settings.observeDynamic===false && calls.some(message=>message.action==='settings' && message.observeDynamic===false)`);
  await browser.evaluate(`document.querySelector('#restore').click()`);
  await until(browser, `document.querySelector('#status-title').textContent==='准备好阅读这篇网页'`);
  await browser.evaluate(`state={...state,enabled:true,failed:1,error:'无法连接 Google 翻译'}; refresh()`);
  assert.equal(await browser.evaluate(`document.querySelector('#error').hidden`), false);
  assert.equal(await browser.evaluate(`document.querySelector('#translate').textContent`), '重试失败内容');
  assert.equal(await browser.evaluate(`document.querySelector('#error').textContent`), '无法连接 Google 翻译');
});
