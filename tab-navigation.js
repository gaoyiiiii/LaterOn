// Shared tab reuse for LaterOn's fullscreen library and side panel.
// A normal click returns to an already-open page (even in another window)
// instead of quietly creating a duplicate tab.
(function () {
  function comparable(url) {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return "";
      return globalThis.LaterOnUrl?.normalize
        ? globalThis.LaterOnUrl.normalize(parsed.href)
        : (parsed.hash = "", parsed.href);
    } catch {
      return "";
    }
  }

  async function findOpen(target, options = {}) {
    const expected = comparable(target);
    if (!expected) return null;
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const matches = tabs.filter((tab) => tab.id !== options.excludeTabId
      && comparable(tab.url || tab.pendingUrl) === expected);
    return matches.find((tab) => tab.active) || matches[0] || null;
  }

  async function activate(tab) {
    if (!tab?.id) return false;
    await chrome.tabs.update(tab.id, { active: true }).catch(() => null);
    if (tab.windowId != null && typeof chrome.windows?.update === "function") {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => null);
    }
    return true;
  }

  globalThis.LaterOnTabs = { comparable, findOpen, activate };
})();
