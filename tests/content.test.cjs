const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchBrowser, until } = require('./browser.cjs');

test('bilingual rendering in a real Chromium browser', { timeout: 60000 }, async t => {
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const source = await fs.readFile(path.join(__dirname, '..', 'content.js'), 'utf8');
  const css = await fs.readFile(path.join(__dirname, '..', 'content.css'), 'utf8');
  await browser.evaluate(`
    document.documentElement.lang = 'en';
    document.head.innerHTML = ${JSON.stringify('<style>body{font:18px/1.8 sans-serif;margin:20px}' + css + '</style>')};
    document.body.innerHTML = '<h1>Welcome to this page.</h1><p id="paragraph">Read <a id="link" href="#test">this example</a> with care.</p><div id="loose">Loose English introduction.<p>Nested paragraph text.</p>Loose English conclusion.</div><p lang="zh-CN">这是一段中文，不应翻译。</p><p lang="fr">Bonjour le monde.</p><pre id="code">const hello = "Hello world";</pre><input id="input" value="Do not change my input."><div id="edit" contenteditable="true">Do not change editable text.</div><p id="hidden" hidden>Hidden English text.</p><p id="excluded" translate="no">Excluded English text.</p><div id="dynamic"></div>';
    globalThis.originalHTML = document.body.innerHTML;
    globalThis.originalLink = document.querySelector('#link');
    globalThis.clicks = 0;
    originalLink.addEventListener('click', event => { event.preventDefault(); clicks++; });
    globalThis.messageListeners = [];
    globalThis.requests = [];
    globalThis.hold = false;
    globalThis.held = [];
    globalThis.failText = '';
    globalThis.chrome = { runtime: {
      onMessage: { addListener: listener => messageListeners.push(listener) },
      sendMessage: async message => {
        requests.push(message.text);
        if (hold) await new Promise(resolve => held.push(resolve));
        if (message.text === failText) return {ok:false,error:'模拟 Google 连接失败'};
        return {ok:true,translation:'中文译文：' + message.text};
      }
    }};
    globalThis.command = (type, extra = {}) => new Promise(resolve => messageListeners[0]({type:'BILINGUAL_' + type, ...extra}, {}, resolve));
  `);
  await browser.evaluate(source);

  await t.test('paragraphs are translated once, Chinese is above unchanged English, and links keep their listeners', async () => {
    await browser.evaluate(`command('START', {observeDynamic:true})`);
    await until(browser, `document.querySelector('#paragraph > [data-bilingual-owned]')`);
    const state = await browser.evaluate(`(() => {
      const paragraph = document.querySelector('#paragraph');
      const marker = paragraph.firstElementChild;
      const original = [...paragraph.childNodes].filter(node => node !== marker).map(node => node.textContent).join('');
      const translationRect = marker.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(paragraph.lastChild);
      originalLink.click();
      return { original, sameLink:originalLink === document.querySelector('#link'), clicks,
        translated:marker.textContent, lang:marker.lang,
        display:getComputedStyle(marker).display, above:translationRect.bottom <= range.getBoundingClientRect().top + 2,
        requests:requests.filter(text => text === 'Read this example with care.').length };
    })()`);
    assert.equal(state.original, 'Read this example with care.');
    assert.equal(state.sameLink, true);
    assert.equal(state.clicks, 1);
    assert.equal(state.lang, 'zh-CN');
    assert.equal(state.display, 'block');
    assert.equal(state.above, true);
    assert.equal(state.requests, 1);
    assert.match(state.translated, /^中文译文/);
  });

  await t.test('code, input, editable, hidden, Chinese, excluded and explicitly French text are skipped', async () => {
    const skipped = await browser.evaluate(`requests.filter(text => /const hello|Do not change|Hidden English|Excluded English|Bonjour|这是一段/.test(text))`);
    assert.deepEqual(skipped, []);
    assert.equal(await browser.evaluate(`document.querySelector('#input').value`), 'Do not change my input.');
  });

  await t.test('dynamic additions and same-element text updates are translated', async () => {
    await browser.evaluate(`document.querySelector('#dynamic').innerHTML = '<p id="added">A freshly loaded sentence.</p>'`);
    await until(browser, `document.querySelector('#added > [data-bilingual-owned]')`);
    await browser.evaluate(`document.querySelector('#added').lastChild.nodeValue = 'An updated sentence on the same page.'`);
    await until(browser, `document.querySelector('#added > [data-bilingual-owned]')?.textContent.includes('An updated sentence')`);
    assert.equal(await browser.evaluate(`document.querySelectorAll('#added > [data-bilingual-owned]').length`), 1);
  });

  await t.test('switching a translated block to editable removes its translation', async () => {
    await browser.evaluate(`document.querySelector('#added').contentEditable = 'true'`);
    await until(browser, `!document.querySelector('#added > [data-bilingual-owned]')`);
    assert.equal(await browser.evaluate(`document.querySelector('#added').textContent`), 'An updated sentence on the same page.');
  });

  await t.test('website removal of a translation is repaired', async () => {
    await browser.evaluate(`document.querySelector('#paragraph > [data-bilingual-owned]').remove()`);
    await until(browser, `document.querySelector('#paragraph > [data-bilingual-owned]')`);
  });

  await t.test('dynamic scanning can be disabled and re-enabled', async () => {
    await browser.evaluate(`command('SETTINGS', {observeDynamic:false})`);
    await browser.evaluate(`document.querySelector('#dynamic').insertAdjacentHTML('beforeend', '<p id="paused">A paragraph added while paused.</p>')`);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await browser.evaluate(`!!document.querySelector('#paused > [data-bilingual-owned]')`), false);
    await browser.evaluate(`command('SETTINGS', {observeDynamic:true})`);
    await until(browser, `document.querySelector('#paused > [data-bilingual-owned]')`);
  });

  await t.test('failed paragraphs are retried without duplicating successful translations', async () => {
    await browser.evaluate(`failText='A sentence that should fail once.'; document.querySelector('#dynamic').insertAdjacentHTML('beforeend', '<p id="failure">A sentence that should fail once.</p>')`);
    await until(browser, `command('STATUS').then(status => status.failed === 1)`);
    await browser.evaluate(`failText=''; command('START', {observeDynamic:true})`);
    await until(browser, `document.querySelector('#failure > [data-bilingual-owned]')`);
    assert.equal(await browser.evaluate(`document.querySelectorAll('#paragraph > [data-bilingual-owned]').length`), 1);
  });

  await t.test('restoring removes all generated markup and retains original node identity', async () => {
    await browser.evaluate(`document.querySelector('#dynamic').innerHTML=''; command('RESTORE')`);
    const state = await browser.evaluate(`({sameHTML:document.body.innerHTML === originalHTML,sameLink:document.querySelector('#link') === originalLink,markers:document.querySelectorAll('[data-bilingual-owned],[data-bilingual-unit]').length})`);
    assert.equal(state.sameHTML, true);
    assert.equal(state.sameLink, true);
    assert.equal(state.markers, 0);
  });

  await t.test('late responses after restore never add Chinese back to the page', async () => {
    await browser.evaluate(`hold=true; command('START')`);
    await until(browser, `held.length > 0`);
    await browser.evaluate(`command('RESTORE'); hold=false; held.splice(0).forEach(resolve=>resolve())`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await browser.evaluate(`document.body.innerHTML === originalHTML`), true);
    assert.equal(await browser.evaluate(`command('STATUS').then(status => status.enabled)`), false);
  });

  await t.test('off-screen paragraphs wait for scrolling', async () => {
    await browser.evaluate(`document.querySelector('#dynamic').innerHTML='<div style="height:4000px" translate="no"></div><p id="far">This paragraph is far below the viewport.</p>'; command('START')`);
    await until(browser, `document.querySelector('#paragraph > [data-bilingual-owned]')`);
    assert.equal(await browser.evaluate(`!!document.querySelector('#far > [data-bilingual-owned]')`), false);
    await browser.evaluate(`document.querySelector('#far').scrollIntoView()`);
    await until(browser, `document.querySelector('#far > [data-bilingual-owned]')`);
  });
});
