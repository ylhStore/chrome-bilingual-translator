const translateButton = document.querySelector('#translate');
const restoreButton = document.querySelector('#restore');
const dynamicInput = document.querySelector('#dynamic');
const errorElement = document.querySelector('#error');
let tabId;
let busy = false;
let available = false;
let refreshTimer;

function showError(message = '') {
  errorElement.textContent = message;
  errorElement.hidden = !message;
}

function render(status) {
  const { enabled, translated, translating, pending, failed, error } = status;
  document.querySelector('#status-dot').className = `dot${failed ? ' failed' : enabled ? ' active' : ''}`;
  document.querySelector('#status-title').textContent = enabled ? (translating ? '正在翻译网页…' : failed ? '部分内容翻译失败' : '双语阅读已开启') : '准备好阅读这篇网页';
  document.querySelector('#status-detail').textContent = enabled
    ? `已翻译 ${translated} 段${translating ? ` · 翻译中 ${translating} 段` : ''}${pending ? ` · 待滚动 ${pending} 段` : ''}${failed ? ` · 失败 ${failed} 段` : ''}${!translated && !pending && !translating && !failed ? ' · 暂未找到可翻译的英文' : ''}`
    : '中文显示在上方，英文原文保留在下方';
  translateButton.textContent = failed ? '重试失败内容' : enabled ? '继续扫描网页' : '翻译此网页';
  translateButton.disabled = busy || !available;
  restoreButton.disabled = busy || !available || !enabled;
  showError(error);
}

async function page(action) {
  const response = await chrome.runtime.sendMessage({ type: 'BILINGUAL_PAGE', tabId, action, observeDynamic: dynamicInput.checked });
  if (!response?.ok) throw new Error(response?.error || '无法连接网页，请刷新后重试。');
  return response.status;
}

async function operate(action) {
  if (busy || !available) return;
  busy = true;
  translateButton.disabled = true;
  restoreButton.disabled = true;
  clearTimeout(refreshTimer);
  try {
    const status = await page(action);
    busy = false;
    render(status);
  } catch (error) {
    busy = false;
    translateButton.disabled = !available;
    restoreButton.disabled = !available;
    showError(error.message);
  } finally {
    refreshTimer = setTimeout(refresh, 900);
  }
}

async function refresh() {
  if (busy || !available) return;
  try {
    render(await page('status'));
    refreshTimer = setTimeout(refresh, 900);
  } catch (error) {
    available = false;
    translateButton.disabled = true;
    restoreButton.disabled = true;
    showError(error.message);
  }
}

translateButton.addEventListener('click', () => operate('start'));
restoreButton.addEventListener('click', () => operate('restore'));
dynamicInput.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ observeDynamic: dynamicInput.checked });
    await operate('settings');
  } catch (error) {
    showError(error.message);
  }
});

(async () => {
  try {
    const settings = await chrome.storage.local.get({ observeDynamic: true });
    dynamicInput.checked = settings.observeDynamic;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    if (!tabId || !/^https?:\/\//i.test(tab.url || '')) throw new Error('请打开普通的 http 或 https 网页后使用翻译。');
    const status = await page('status');
    available = true;
    render(status);
    refreshTimer = setTimeout(refresh, 900);
  } catch (error) {
    document.querySelector('#status-title').textContent = '当前页面暂不可翻译';
    document.querySelector('#status-detail').textContent = '支持普通网页中的英文文本';
    showError(error.message);
  }
})();
