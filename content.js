(() => {
  if (globalThis.__bilingualTranslatorInstalled) return;
  globalThis.__bilingualTranslatorInstalled = true;

  const OWN = '[data-bilingual-owned]';
  const SKIP = 'script,style,noscript,textarea,input,select,option,pre,code,kbd,samp,svg,math,canvas,video,audio,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[translate="no"],.notranslate,[hidden],[inert]';
  const BLOCK = /^(block|flow-root|list-item|table-cell|table-caption)$/;
  const COMPLEX_LAYOUT = /^(flex|inline-flex|grid|inline-grid|table|inline-table)$/;
  const records = new Set();
  const byElement = new WeakMap();
  const waiting = [];
  let enabled = false;
  let observeDynamic = true;
  let generation = 0;
  let running = 0;
  let observer = null;
  let intersection = null;
  let scanTimer = null;
  let lastError = '';

  function readableText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(`${SKIP},${OWN}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const pieces = [];
    while (walker.nextNode()) pieces.push(walker.currentNode.nodeValue);
    return pieces.join('').replace(/\s+/g, ' ').trim();
  }

  function isEnglish(text) {
    const latin = text.match(/[a-z]/gi)?.length || 0;
    const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length || 0;
    return latin >= 2 && latin >= cjk * 2 && /[a-z]{2}/i.test(text) && !/^(https?:\/\/|www\.|\S+@\S+\.\S+$)/i.test(text);
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none' && element.getClientRects().length > 0;
  }

  function allowedLanguage(element) {
    // An English passage on a Chinese-language page should still be translated.
    const local = element.closest('[lang]');
    return !local || local === document.documentElement || /^(en|zh)(-|$)/i.test(local.lang);
  }

  function findContainer(textNode) {
    let element = textNode.parentElement;
    let inline = element;
    while (element && element !== document.body && element !== document.documentElement) {
      const display = getComputedStyle(element).display;
      if (BLOCK.test(display)) return element;
      if (COMPLEX_LAYOUT.test(display)) return inline !== element ? inline : null;
      inline = element;
      element = element.parentElement;
    }
    return null;
  }

  function hasNestedBlocks(element) {
    return [...element.querySelectorAll('*')].some(child => {
      if (child.closest(`${SKIP},${OWN}`)) return false;
      const display = getComputedStyle(child).display;
      return BLOCK.test(display) || COMPLEX_LAYOUT.test(display) || child.tagName === 'BR';
    });
  }

  function makeRecord(element, fallback = false) {
    if (byElement.has(element)) return true;
    const text = readableText(element);
    if (!isEnglish(text) || text.length > 12000) return false;
    const record = { element, text, fallback, marker: null, state: 'pending', generation, queued: false };
    records.add(record);
    byElement.set(element, record);
    intersection.observe(element);
    return true;
  }

  function scan() {
    if (!enabled || !document.body) return;
    // Snapshot nodes before inserting wrappers, so traversal never walks its own additions.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentElement || node.parentElement.closest(`${SKIP},${OWN}`)) return NodeFilter.FILTER_REJECT;
        return isEnglish(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const layoutCache = new Map();
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent || !allowedLanguage(parent) || !isVisible(parent)) continue;
      if (parent.closest('[data-bilingual-unit]')) continue;
      const candidate = findContainer(node);
      if (candidate && !candidate.closest(SKIP) && allowedLanguage(candidate)) {
        if (byElement.has(candidate)) continue;
        if (!layoutCache.has(candidate)) layoutCache.set(candidate, hasNestedBlocks(candidate));
        if (!layoutCache.get(candidate)) {
          if (makeRecord(candidate)) continue;
        }
      }
      // Loose text between block elements gets a small wrapper; the actual text node is kept.
      const wrapper = document.createElement('span');
      wrapper.setAttribute('data-bilingual-unit', '');
      node.before(wrapper);
      wrapper.append(node);
      if (!makeRecord(wrapper, true)) wrapper.replaceWith(...wrapper.childNodes);
    }
    pump();
  }

  function enqueue(record) {
    if (!enabled || !record || record.queued || record.state !== 'pending') return;
    record.queued = true;
    waiting.push(record);
    pump();
  }

  function forget(record) {
    record.marker?.remove();
    intersection?.unobserve(record.element);
    byElement.delete(record.element);
    records.delete(record);
    if (record.fallback) record.element.replaceWith(...record.element.childNodes);
  }

  function pump() {
    while (enabled && running < 3 && waiting.length) {
      const record = waiting.shift();
      record.queued = false;
      if (record.generation !== generation || !records.has(record) || !record.element.isConnected) continue;
      record.state = 'translating';
      running += 1;
      const version = generation;
      chrome.runtime.sendMessage({ type: 'BILINGUAL_TRANSLATE', text: record.text }).then(response => {
        if (!enabled || version !== generation || !records.has(record) || !record.element.isConnected) return;
        if (readableText(record.element) !== record.text) {
          forget(record);
          scheduleScan();
          return;
        }
        if (!response?.ok) throw new Error(response?.error || '翻译失败，请稍后重试。');
        const marker = document.createElement('span');
        marker.setAttribute('data-bilingual-owned', 'translation');
        marker.setAttribute('lang', 'zh-CN');
        marker.setAttribute('translate', 'no');
        marker.textContent = response.translation;
        record.element.prepend(marker);
        record.marker = marker;
        record.state = 'translated';
        intersection.unobserve(record.element);
      }).catch(error => {
        if (!enabled || version !== generation || !records.has(record)) return;
        record.state = 'failed';
        lastError = error.message || '扩展连接已断开，请刷新网页后重试。';
      }).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  function scheduleScan() {
    if (!enabled || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      for (const record of records) {
        if (!record.element.isConnected || record.element.closest(SKIP) || !allowedLanguage(record.element) || !isVisible(record.element) || readableText(record.element) !== record.text || (record.state === 'translated' && record.marker?.parentElement !== record.element)) forget(record);
      }
      scan();
    }, 250);
  }

  function connectObserver() {
    observer?.disconnect();
    if (!observeDynamic || !enabled) return;
    observer = new MutationObserver(mutations => {
      const relevant = mutations.some(mutation => {
        const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
        if (target?.closest(OWN)) return false;
        if (mutation.type !== 'childList') return true;
        const record = byElement.get(target);
        if (record?.state === 'translated' && record.marker?.parentElement !== target) return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(node => !(node.nodeType === Node.ELEMENT_NODE && (node.matches(OWN) || node.hasAttribute('data-bilingual-unit'))));
      });
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'lang', 'class', 'style', 'contenteditable', 'translate'] });
  }

  function status() {
    const counts = { translated: 0, pending: 0, translating: 0, failed: 0 };
    for (const record of records) if (record.element.isConnected) counts[record.state] += 1;
    return { enabled, observeDynamic, ...counts, error: lastError };
  }

  function start(dynamic) {
    observeDynamic = dynamic !== false;
    lastError = '';
    if (!enabled) {
      enabled = true;
      generation += 1;
      intersection = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) enqueue(byElement.get(entry.target));
      }, { rootMargin: '500px 0px' });
    }
    for (const record of records) {
      if (record.state === 'failed') {
        record.state = 'pending';
        enqueue(record);
      }
    }
    connectObserver();
    scan();
    return status();
  }

  function restore() {
    enabled = false;
    generation += 1;
    observer?.disconnect();
    intersection?.disconnect();
    clearTimeout(scanTimer);
    scanTimer = null;
    waiting.length = 0;
    for (const record of [...records]) forget(record);
    lastError = '';
    return status();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'BILINGUAL_STATUS') sendResponse(status());
    else if (message?.type === 'BILINGUAL_START') sendResponse(start(message.observeDynamic));
    else if (message?.type === 'BILINGUAL_RESTORE') sendResponse(restore());
    else if (message?.type === 'BILINGUAL_SETTINGS') {
      observeDynamic = message.observeDynamic !== false;
      connectObserver();
      if (observeDynamic) scheduleScan();
      sendResponse(status());
    }
  });
})();
