// 地址栏搜索 + 工具栏收藏状态：用真实 background.js 验证用户可见行为。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? `  → ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const store = {
  laterOnItems: [
    { id: "n1", title: "Neuroimaging basics", description: "Brain scanning guide", source: "science.test", projectId: "study", url: "https://science.test/neuro", savedAt: 30 },
    { id: "d1", title: "Design systems", description: "Components and tokens", source: "design.test", projectId: null, url: "https://design.test/system", savedAt: 20 },
    { id: "n2", title: "Older neuroscience note", description: "Neuro note", source: "notes.test", projectId: null, url: "https://notes.test/neuro", savedAt: 10 }
  ],
  laterOnProjects: [{ id: "study", name: "学习" }],
  laterOnSettings: { language: "zh-CN" },
  laterOnRecentItems: ["n1", "d1"]
};
let activeTab = { id: 1, active: true, windowId: 1, url: "https://science.test/neuro" };
const tabListeners = {};
const omniboxListeners = {};
const badges = [];
const titles = [];
const updated = [];
const created = [];
let defaultSuggestion = "";

const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: store[keys] };
        const result = {};
        for (const key of (Array.isArray(keys) ? keys : Object.keys(store))) result[key] = store[key];
        return result;
      },
      async set(patch) { Object.assign(store, patch); },
      async remove(key) { delete store[key]; }
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener() {} }
  },
  tabs: {
    query: async () => [activeTab],
    get: async () => activeTab,
    update: async (...args) => { const info = args.length === 1 ? args[0] : args[1]; updated.push(info); return { ...activeTab, ...info }; },
    create: async (info) => { created.push(info); return { id: 2, ...info }; },
    onUpdated: { addListener(fn) { tabListeners.updated = fn; } },
    onRemoved: { addListener(fn) { tabListeners.removed = fn; } },
    onActivated: { addListener(fn) { tabListeners.activated = fn; } }
  },
  action: {
    setBadgeText: async ({ text }) => { badges.push(text); },
    setBadgeBackgroundColor: async () => {},
    setTitle: async ({ title }) => { titles.push(title); }
  },
  omnibox: {
    setDefaultSuggestion: async ({ description }) => { defaultSuggestion = description; },
    onInputStarted: { addListener(fn) { omniboxListeners.started = fn; } },
    onInputChanged: { addListener(fn) { omniboxListeners.changed = fn; } },
    onInputEntered: { addListener(fn) { omniboxListeners.entered = fn; } }
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  contextMenus: { removeAll(cb) { cb?.(); }, create() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  runtime: {
    lastError: null,
    getURL: (file) => `chrome-extension://lateron/${file}`,
    sendMessage: async () => ({}),
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} }
  },
  scripting: { insertCSS: async () => {}, executeScript: async () => [] },
  windows: { update: async () => {}, create: async () => ({}) },
  sidePanel: { setPanelBehavior: async () => true }
};

const sandbox = {
  chrome, LaterOnUrl: {
    normalize(value) {
      try { const url = new URL(value); url.hash = ""; return url.href.replace(/\/$/, ""); }
      catch { return String(value || ""); }
    }
  },
  importScripts() {}, URL, console, Date, Promise, JSON, Set, Map, RegExp, Object, Array, Math,
  String, Number, Boolean, Error, setTimeout, clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "background.js" });

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  check("manifest 注册了 lo 地址栏关键词", manifest.omnibox?.keyword === "lo", manifest.omnibox?.keyword);
  check("不再为已移除的标签组功能申请权限", !manifest.permissions.includes("tabGroups"));

  await tick();
  check("升级后清理已撤下的最近记录", store.laterOnRecentItems === undefined);
  check("工具栏品牌图标不显示常驻收藏角标", badges.at(-1) === "" && !badges.includes("✓"), badges.join(" → "));
  check("工具栏悬浮说明保持默认入口文案", titles.at(-1) === "打开 LaterOn 侧栏", titles.at(-1));

  let suggestions = [];
  omniboxListeners.changed("neuro", (items) => { suggestions = items; });
  await tick();
  check("地址栏会搜索标题和摘要并返回建议", suggestions.length === 2, suggestions.map((item) => item.description).join(" | "));
  check("标题更匹配的文章排在前面", suggestions[0]?.content === "https://science.test/neuro", suggestions[0]?.content);
  check("默认项说明是在 LaterOn 内搜索", /LaterOn/.test(defaultSuggestion) && /neuro/.test(defaultSuggestion), defaultSuggestion);

  omniboxListeners.entered(suggestions[0].content, "currentTab");
  await tick();
  check("选择建议直接打开对应文章", updated.at(-1)?.url === "https://science.test/neuro", updated.at(-1)?.url);
  check("同时把它记作当前正在读", store.laterOnCurrentItem === "n1", store.laterOnCurrentItem);

  omniboxListeners.entered("design system", "newForegroundTab");
  await tick();
  const searchUrl = new URL(created.at(-1)?.url || "https://invalid/");
  check("直接回车打开带搜索词的收藏库", searchUrl.pathname.endsWith("/library.html") && searchUrl.searchParams.get("q") === "design system", searchUrl.href);
  check("新前台标签遵循地址栏打开方式", created.at(-1)?.active === true, JSON.stringify(created.at(-1)));

  check("切换标签页不再注册收藏状态监听", typeof tabListeners.activated === "undefined");

  console.log(failures ? `\n❌ 有 ${failures} 项失败` : "\n🎉 全部通过");
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
