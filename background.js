/* Google requests run here because content scripts follow the website's CORS rules. */
const MAX_CONCURRENT = 3;
const MAX_TEXT_LENGTH = 12000;
const CHUNK_LENGTH = 1500;
const CACHE_LIMIT = 800;
const cache = new Map();
const queue = [];
const inFlight = new Map();
let activeRequests = 0;

function splitText(text, limit = CHUNK_LENGTH) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    const section = rest.slice(0, limit);
    const boundary = Math.max(section.lastIndexOf('. '), section.lastIndexOf('? '), section.lastIndexOf('! '), section.lastIndexOf('; '), section.lastIndexOf(' '));
    let end = boundary > limit / 2 ? boundary + 1 : limit;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end -= 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function translateChunk(text) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.search = new URLSearchParams({ client: 'gtx', sl: 'en', tl: 'zh-CN', dt: 't', q: text });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url.href, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) {
        if (response.status === 429) throw new Error('Google 请求过于频繁，请稍后重试。');
        throw new Error(`Google 翻译服务返回错误（${response.status}）。`);
      }
      const data = await response.json();
      if (!Array.isArray(data?.[0])) throw new Error('Google 翻译返回了无法识别的内容。');
      const translated = data[0].map(part => typeof part?.[0] === 'string' ? part[0] : '').join('').trim();
      if (!translated) throw new Error('Google 翻译暂未返回译文，请稍后重试。');
      return translated;
    } catch (error) {
      if (attempt === 1 || /429|频繁|返回错误|无法识别/.test(error.message)) {
        if (error.name === 'AbortError') throw new Error('连接 Google 翻译超时，请检查网络后重试。');
        if (error instanceof TypeError) throw new Error('无法连接 Google 翻译，请确认当前网络可以访问 translate.googleapis.com。');
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }
}

async function translateText(text) {
  const parts = [];
  for (const chunk of splitText(text)) parts.push(await translateChunk(chunk));
  return parts.join('');
}

function drainQueue() {
  while (activeRequests < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    activeRequests += 1;
    translateText(job.text).then(result => {
      cache.set(job.text, result);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      job.resolve(result);
    }, job.reject).finally(() => {
      inFlight.delete(job.text);
      activeRequests -= 1;
      drainQueue();
    });
  }
}

function requestTranslation(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    return Promise.reject(new Error('待翻译内容为空或过长。'));
  }
  if (cache.has(text)) return Promise.resolve(cache.get(text));
  if (inFlight.has(text)) return inFlight.get(text);
  const promise = new Promise((resolve, reject) => queue.push({ text, resolve, reject }));
  inFlight.set(text, promise);
  drainQueue();
  return promise;
}

async function ensureContentScript(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'BILINGUAL_STATUS' });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'BILINGUAL_STATUS' });
  }
}

function pageError(error) {
  if (/Cannot access|Missing host permission|extensions gallery|chrome:\/\/|edge:\/\//i.test(error.message)) {
    return '此页面不允许扩展运行，请打开普通的 http 或 https 网页后再试。';
  }
  return error.message || '无法连接网页，请刷新页面后重试。';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'BILINGUAL_TRANSLATE' && sender.tab) {
    requestTranslation(message.text).then(
      translation => sendResponse({ ok: true, translation }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
  if (message?.type === 'BILINGUAL_PAGE' && !sender.tab) {
    (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('请打开普通的 http 或 https 网页后使用翻译。');
      const status = await ensureContentScript(tab.id);
      if (message.action === 'status') return status;
      if (!['start', 'restore', 'settings'].includes(message.action)) throw new Error('未知的页面操作。');
      return chrome.tabs.sendMessage(tab.id, {
        type: `BILINGUAL_${message.action.toUpperCase()}`,
        observeDynamic: message.observeDynamic
      });
    })().then(
      status => sendResponse({ ok: true, status }),
      error => sendResponse({ ok: false, error: pageError(error) })
    );
    return true;
  }
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-translation') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) return;
    const status = await ensureContentScript(tab.id);
    const settings = await chrome.storage.local.get({ observeDynamic: true });
    await chrome.tabs.sendMessage(tab.id, {
      type: status.enabled ? 'BILINGUAL_RESTORE' : 'BILINGUAL_START',
      observeDynamic: settings.observeDynamic
    });
  } catch (error) {
    console.warn('网页翻译：', pageError(error));
  }
});
