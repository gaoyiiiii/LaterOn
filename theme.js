// 共享模块：自动应用主题，并提供设置的读写与跨页面监听。
// 被 library / settings 两个页面在 <head> 早期引入。
(function () {
  const KEY = "laterOnSettings";
  const DEFAULTS = {
    theme: "light",            // light | dark | system
    defaultSort: "newest",     // newest | oldest | source
    autoMarkRead: true,
    askFolderOnBatch: true,    // 一键收藏所有标签前，先弹窗选项目
    askFolderOnSingle: false,  // 收藏当前这一篇前，是否先弹窗选项目（默认关；主动打开才先选项目）
    askFolderOnSingleOptIn: false, // 迁移标记：旧版默认 true 不算用户主动开启
    autoCleanDays: 30          // 标为已读后多少天自动清除（30–180 天）
    ,language: "zh-CN"         // zh-CN | en
  };

  function resolveTheme(theme) {
    if (theme === "system") {
      const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      return prefersDark ? "dark" : "light";
    }
    return theme === "dark" ? "dark" : "light";
  }

  function applyTheme(rawTheme) {
    document.documentElement.dataset.theme = resolveTheme(rawTheme || "light");
  }

  async function get() {
    const result = await chrome.storage.local.get(KEY);
    const stored = result[KEY] || {};
    const merged = { ...DEFAULTS, ...stored };
    if (stored.askFolderOnSingleOptIn !== true) merged.askFolderOnSingle = false;
    return merged;
  }

  function set(patch) {
    return get().then((current) =>
      chrome.storage.local.set({
        [KEY]: {
          ...current,
          ...patch,
          ...(Object.prototype.hasOwnProperty.call(patch, "askFolderOnSingle") ? { askFolderOnSingleOptIn: true } : {})
        }
      })
    );
  }

  function watch(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[KEY]) {
        callback({ ...DEFAULTS, ...(changes[KEY].newValue || {}) }, changes[KEY].oldValue);
      }
    });
  }

  // 进入页面即应用主题（本地存储很快，仅极轻微闪烁）。
  get().then((settings) => applyTheme(settings.theme));
  watch((settings) => applyTheme(settings.theme));
  if (window.matchMedia) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => get().then((s) => { if (s.theme === "system") applyTheme("system"); });
    if (media.addEventListener) media.addEventListener("change", onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  window.LaterOnSettings = { KEY, DEFAULTS, get, set, watch, applyTheme };
})();
