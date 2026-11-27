const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function worker(fetch) {
  const context = vm.createContext({
    fetch, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console,
    chrome: { runtime: { onMessage: { addListener() {} } }, commands: { onCommand: { addListener() {} } } }
  });
  vm.runInContext(source, context);
  return text => { context.input = text; return vm.runInContext('requestTranslation(input)', context); };
}

test('Google requests use English → Simplified Chinese and omit credentials; results are cached and shared', async () => {
  let calls = 0;
  const translate = worker(async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).searchParams.get('sl'), 'en');
    assert.equal(new URL(url).searchParams.get('tl'), 'zh-CN');
    assert.equal(new URL(url).searchParams.get('q'), 'Hello world.');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return { ok: true, json: async () => [[['你好，', 'Hello'], ['世界。', 'world']]] };
  });
  const results = await Promise.all([translate('Hello world.'), translate('Hello world.')]);
  assert.deepEqual(results, ['你好，世界。', '你好，世界。']);
  assert.equal(await translate('Hello world.'), '你好，世界。');
  assert.equal(calls, 1);
});

test('concurrent requests are bounded and independent paragraphs finish', async () => {
  let running = 0;
  let peak = 0;
  const translate = worker(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 15));
    running -= 1;
    return { ok: true, json: async () => [[['译文']]] };
  });
  const result = await Promise.all(Array.from({ length: 10 }, (_, i) => translate(`Paragraph number ${i}`)));
  assert.equal(result.length, 10);
  assert.equal(peak, 3);
});

test('rate limits are reported and failures do not poison the cache', async () => {
  let calls = 0;
  const translate = worker(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429 };
    return { ok: true, json: async () => [[['恢复后的译文']]] };
  });
  await assert.rejects(translate('Please retry this paragraph.'), /频繁/);
  // Let the queue release the failed in-flight entry.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await translate('Please retry this paragraph.'), '恢复后的译文');
  assert.equal(calls, 2);
});

test('long paragraphs are chunked without losing source text', async () => {
  const inputs = [];
  const translate = worker(async url => {
    const input = new URL(url).searchParams.get('q');
    inputs.push(input);
    assert.ok(input.length <= 1500);
    return { ok: true, json: async () => [[[input]]] };
  });
  const text = 'A paragraph with punctuation. '.repeat(200) + '🙂 The end.';
  await translate(text);
  assert.equal(inputs.join(''), text);
  assert.ok(inputs.length > 1);
});

test('invalid service payloads and invalid inputs never become successful translations', async () => {
  const translate = worker(async () => ({ ok: true, json: async () => ({ unexpected: true }) }));
  await assert.rejects(translate('A useful sentence.'), /无法识别/);
  await assert.rejects(translate(''), /为空或过长/);
  await assert.rejects(translate('A'.repeat(12001)), /为空或过长/);
});
