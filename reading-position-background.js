// 已收藏网页的“上次滚动位置”：只保存 scrollY，不记录百分比、时间或阅读统计。
// 单独放在按需模块里，避免继续膨胀主 service worker。
(function () {
  const ITEMS_KEY = "laterOnItems";
  const POSITIONS_KEY = "laterOnReadingPositions";
  const SETTINGS_KEY = "laterOnSettings";
  const normalizeUrl = globalThis.LaterOnUrl.normalize;
  let writeQueue = Promise.resolve();

  const isWebUrl = (url) => /^https?:\/\//i.test(String(url || ""));

  async function setupTab(tabId, suppliedTab) {
    try {
      const tab = suppliedTab?.id === tabId ? suppliedTab : await chrome.tabs.get(tabId);
      if (!tab?.id || !isWebUrl(tab.url)) return false;
      const stored = await chrome.storage.local.get([ITEMS_KEY, POSITIONS_KEY, SETTINGS_KEY]);
      const item = (stored[ITEMS_KEY] || []).find((entry) => normalizeUrl(entry.url) === normalizeUrl(tab.url));
      if (!item) {
        await chrome.tabs.sendMessage(tab.id, { type: "LATERON_READING_POSITION_INIT", itemId: null }).catch(() => {});
        return false;
      }

      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-reading-position.js"] });
      await chrome.tabs.sendMessage(tab.id, {
        type: "LATERON_READING_POSITION_INIT",
        itemId: item.id,
        y: Math.max(0, Number(stored[POSITIONS_KEY]?.[item.id]) || 0),
        language: stored[SETTINGS_KEY]?.language === "en" ? "en" : "zh-CN"
      });
      return true;
    } catch {
      // 标签可能已关闭、正在跳转，或属于浏览器保护页面；都不影响正常浏览。
      return false;
    }
  }

  async function setupActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await setupTab(tab.id, tab);
  }

  function savePosition(itemId, rawY) {
    const y = Math.max(0, Math.round(Number(rawY) || 0));
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const stored = await chrome.storage.local.get([ITEMS_KEY, POSITIONS_KEY]);
      if (!(stored[ITEMS_KEY] || []).some((item) => item.id === itemId)) return false;
      const positions = { ...(stored[POSITIONS_KEY] || {}) };
      if (Math.abs(Number(positions[itemId] || 0) - y) < 8) return true;
      positions[itemId] = y;
      await chrome.storage.local.set({ [POSITIONS_KEY]: positions });
      return true;
    });
    return writeQueue;
  }

  async function cleanOrphanedPositions(items) {
    const known = new Set((items || []).map((item) => item.id));
    const stored = await chrome.storage.local.get(POSITIONS_KEY);
    const positions = stored[POSITIONS_KEY] || {};
    const next = Object.fromEntries(Object.entries(positions).filter(([id]) => known.has(id)));
    if (Object.keys(next).length !== Object.keys(positions).length) {
      await chrome.storage.local.set({ [POSITIONS_KEY]: next });
    }
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" || typeof changeInfo.url === "string") {
      setupTab(tabId, tab).catch(() => {});
    }
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => setupTab(tabId).catch(() => {}));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[ITEMS_KEY]) {
      cleanOrphanedPositions(changes[ITEMS_KEY].newValue || []).catch(() => {});
      setupActiveTab().catch(() => {});
    }
    if (changes[SETTINGS_KEY]) setupActiveTab().catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SAVE_READING_POSITION" || !message.itemId) return;
    savePosition(message.itemId, message.y)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  });
})();
