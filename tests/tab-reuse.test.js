const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const urlSource = fs.readFileSync(path.join(ROOT, "url-utils.js"), "utf8");
const navigationSource = fs.readFileSync(path.join(ROOT, "tab-navigation.js"), "utf8");
const librarySource = fs.readFileSync(path.join(ROOT, "library.js"), "utf8");
const sidepanelSource = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");

const tabs = [
  { id: 1, windowId: 10, active: true, url: "chrome-extension://lateron/library.html" },
  { id: 2, windowId: 20, active: false, url: "https://www.example.com/article/?utm_source=mail&a=1#part-3" },
  { id: 3, windowId: 30, active: true, pendingUrl: "https://other.test/reading" }
];
const tabUpdates = [];
const windowUpdates = [];
const context = vm.createContext({
  URL,
  globalThis: {},
  chrome: {
    tabs: {
      query: async () => tabs,
      update: async (id, patch) => { tabUpdates.push({ id, patch }); return { id, ...patch }; }
    },
    windows: {
      update: async (id, patch) => { windowUpdates.push({ id, patch }); return { id, ...patch }; }
    }
  }
});
context.globalThis = context;
vm.runInContext(urlSource, context, { filename: "url-utils.js" });
vm.runInContext(navigationSource, context, { filename: "tab-navigation.js" });

(async () => {
  const match = await context.LaterOnTabs.findOpen("https://example.com/article?a=1");
  assert.strictEqual(match?.id, 2, "应忽略 www、追踪参数、末尾斜杠和页内锚点");

  await context.LaterOnTabs.activate(match);
  assert.strictEqual(JSON.stringify(tabUpdates.at(-1)), JSON.stringify({ id: 2, patch: { active: true } }));
  assert.strictEqual(JSON.stringify(windowUpdates.at(-1)), JSON.stringify({ id: 20, patch: { focused: true } }));

  const pendingMatch = await context.LaterOnTabs.findOpen("https://other.test/reading#resume");
  assert.strictEqual(pendingMatch?.id, 3, "尚在加载的标签页也应复用");

  const excluded = await context.LaterOnTabs.findOpen("https://example.com/article?a=1", { excludeTabId: 2 });
  assert.strictEqual(excluded, null, "全屏收藏库可排除自身标签页");

  assert.match(librarySource, /LaterOnTabs\.findOpen\(target, \{ excludeTabId: libraryTabId \}\)/);
  assert.match(sidepanelSource, /LaterOnTabs\.findOpen\(target\)/);
  console.log("PASS 已打开页面会被复用并聚焦其窗口");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
