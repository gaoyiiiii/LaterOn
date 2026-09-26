// Lightweight bilingual UI layer. Chinese remains the default for existing users;
// changing the language is stored with the other LaterOn preferences and picked up
// by every extension page on its next render.
(function () {
  const KEY = "laterOnSettings";
  const dictionaries = {
    "zh-CN": {
      unread: "未读", read: "已读", all: "全部", allProjects: "全部内容", inbox: "等待整理",
      noInbox: "还没有要整理的", projects: "项目", settings: "设置", search: "搜索收藏",
      select: "选择", create: "创建", projectName: "项目名称", sortNewest: "最新收藏", sortOldest: "最早收藏",
      sortSource: "按来源", sortCustom: "自定义顺序", selectCount: "已选 {count} 篇", selectAll: "全选",
      deselectAll: "取消全选", markDone: "标完成", markUnread: "标未读", moveTo: "移动到…", delete: "删除", done: "完成",
      notFinished: "没看完", boardCount: "{groups} 个类目 · 共 {total} 篇收藏 · {unfinished} 篇没看完",
      searchCount: "在全部收藏里找到 {count} 篇 · {unfinished} 篇没看完", scopedCount: "{count} 篇收藏 · {unfinished} 篇没看完",
      noMatches: "没有找到匹配的收藏", noMatchesHint: "换个关键词，或切换顶部的阅读状态筛选。",
      quiet: "这里还很安静", quietHint: "打开一个想稍后阅读的网页，点击浏览器工具栏中的 LaterOn 图标即可收藏。",
      noBoard: "没有匹配的类目", noBoardHint: "换个关键词，或切换顶部的阅读状态筛选。",
      readButton: "标为已读", unreadButton: "标为未读", noDescription: "暂无摘要", newProject: "新项目",
      language: "语言", chinese: "中文", english: "English", appearance: "外观", collection: "收藏",
      startup: "启动", shortcuts: "快捷键", data: "数据", languageHint: "选择 LaterOn 的界面语言",
      titleSettings: "外观、快捷键、数据与启动方式", back: "返回收藏", theme: "主题", light: "浅色", dark: "深色", system: "跟随系统",
      defaultSort: "默认排序", defaultSortHint: "打开收藏库时的默认排列方式", autoMark: "打开后自动标记为在读",
      askSingle: "收藏当前网页前，先选项目", askBatch: "收藏所有标签前，先选项目", autoClean: "已读收藏自动清除",
      export: "导出收藏", import: "导入收藏", wipe: "清空所有收藏", saveCurrent: "收藏", currentPage: "当前页面",
    },
    en: {
      unread: "Unread", read: "Read", all: "All", allProjects: "All content", inbox: "Inbox",
      noInbox: "Nothing to sort", projects: "Projects", settings: "Settings", search: "Search saves",
      select: "Select", create: "Create", projectName: "Project name", sortNewest: "Newest", sortOldest: "Oldest",
      sortSource: "By source", sortCustom: "Custom order", selectCount: "{count} selected", selectAll: "Select all",
      deselectAll: "Deselect all", markDone: "Mark read", markUnread: "Mark unread", moveTo: "Move to…", delete: "Delete", done: "Done",
      notFinished: "unfinished", boardCount: "{groups} boards · {total} saves · {unfinished} unfinished",
      searchCount: "{count} saves found · {unfinished} unfinished", scopedCount: "{count} saves · {unfinished} unfinished",
      noMatches: "No matching saves", noMatchesHint: "Try another keyword or switch the reading filter above.",
      quiet: "It’s quiet here", quietHint: "Open a page you want to read later, then click the LaterOn toolbar icon to save it.",
      noBoard: "No matching boards", noBoardHint: "Try another keyword or switch the reading filter above.",
      readButton: "Mark read", unreadButton: "Mark unread", noDescription: "No summary", newProject: "New project",
      language: "Language", chinese: "中文", english: "English", appearance: "Appearance", collection: "Collection",
      startup: "Startup", shortcuts: "Shortcuts", data: "Data", languageHint: "Choose LaterOn’s interface language",
      titleSettings: "Appearance, shortcuts, data and startup", back: "Back to saves", theme: "Theme", light: "Light", dark: "Dark", system: "System",
      defaultSort: "Default sort", defaultSortHint: "How the library is ordered when opened", autoMark: "Mark as reading when opened",
      askSingle: "Choose a project before saving the current page", askBatch: "Choose a project before saving all tabs", autoClean: "Automatically remove read saves",
      export: "Export saves", import: "Import saves", wipe: "Clear all saves", saveCurrent: "Save", currentPage: "Current page",
    }
  };
  let language = "zh-CN";
  function format(value, vars) { return String(value).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? `{${k}}`); }
  function t(key, vars) { return format((dictionaries[language] || dictionaries["zh-CN"])[key] || dictionaries["zh-CN"][key] || key, vars); }
  async function getLanguage() {
    try { const result = await chrome.storage.local.get(KEY); language = result[KEY]?.language === "en" ? "en" : "zh-CN"; } catch {}
    return language;
  }
  async function setLanguage(next) {
    language = next === "en" ? "en" : "zh-CN";
    try {
      const result = await chrome.storage.local.get(KEY);
      await chrome.storage.local.set({ [KEY]: { ...(result[KEY] || {}), language } });
    } catch {}
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    applyStatic();
    window.dispatchEvent(new CustomEvent("lateron-language-change", { detail: language }));
    return language;
  }
  function applyStatic() {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel)); });
  }
  getLanguage().then(applyStatic);
  window.LaterOnI18n = { t, getLanguage, setLanguage, applyStatic, dictionaries };
})();
