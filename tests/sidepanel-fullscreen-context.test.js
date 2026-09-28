// 从侧栏展开到全屏时应继承项目、筛选和当前文章；普通打开仍是「全部项目」首页。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const libraryHtml = read("library.html");
const librarySource = read("library.js");
const sidepanelSource = read("sidepanel.js");
const backgroundSource = read("background.js");

const baseStore = () => ({
  laterOnItems: [
    { id: "reading", title: "正在研究", description: "项目文章", favicon: "", source: "research.test", projectId: "p1", url: "https://research.test/a", savedAt: 3, status: "reading" },
    { id: "done", title: "已经完成", description: "已读文章", favicon: "", source: "research.test", projectId: "p1", url: "https://research.test/b", savedAt: 2, status: "done", doneAt: Date.now() },
    { id: "other", title: "其他项目", description: "另一篇", favicon: "", source: "other.test", projectId: "p2", url: "https://other.test/", savedAt: 1, status: "unread" }
  ],
  laterOnProjects: [{ id: "p1", name: "研究项目" }, { id: "p2", name: "其他项目" }],
  laterOnActiveProject: "p1",
  laterOnCurrentItem: "reading",
  laterOnFilter: "unread",
  laterOnFilterChosen: true,
  laterOnSettings: {}
});

function mount(url) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
  const dom = new JSDOM(libraryHtml, { runScripts: "outside-only", pretendToBeVisual: true, url, virtualConsole });
  const { window } = dom;
  const store = baseStore();
  const scrolled = [];
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this.dataset.id || ""); };
  window.chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((key) => key in store).map((key) => [key, store[key]]));
        },
        async set(patch) { Object.assign(store, patch); }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      query: async () => [{ id: 1, windowId: 7, active: true, url }],
      getCurrent: async () => ({ id: 1, windowId: 7 }),
      update: async () => ({}),
      create: async () => ({})
    },
    windows: { getCurrent: async () => ({ id: 7 }), create: async () => ({}) },
    runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({}), onMessage: { addListener() {} } },
    sidePanel: { open: async () => true }
  };
  window.eval(read("i18n.js"));
  window.eval(read("dialog.js"));
  window.eval(read("picker-ui.js"));
  window.eval(librarySource);
  return { dom, window, store, scrolled, errors };
}

const tick = (window, ms = 100) => new Promise((resolve) => window.setTimeout(resolve, ms));

(async () => {
  const expanded = mount("chrome-extension://lateron/library.html?from=sidepanel&project=p1&filter=unread&focus=reading");
  await tick(expanded.window);
  const { document } = expanded.window;
  assert(document.querySelector('.project-nav[data-project="p1"]')?.classList.contains("active"), "应进入侧栏当前项目");
  assert(document.querySelector('.nav-item[data-filter="unread"]')?.classList.contains("active"), "应继承侧栏筛选");
  assert(document.querySelector('.card[data-id="reading"]')?.classList.contains("is-current"), "应高亮正在阅读的文章");
  assert(!document.querySelector('.card[data-id="done"]'), "不应为了定位当前文章擅自改变筛选");
  assert(expanded.scrolled.includes("reading"), "正在阅读的卡片应滚动到可视位置");
  assert.strictEqual(document.title, "LaterOn - 研究项目");
  assert.deepStrictEqual(expanded.errors, []);
  expanded.dom.window.close();

  const direct = mount("chrome-extension://lateron/library.html");
  await tick(direct.window);
  assert(direct.window.document.querySelector('.project-nav[data-project="all"]')?.classList.contains("active"), "普通打开仍应进入全部项目首页");
  assert.strictEqual(direct.window.document.title, "LaterOn - 有价值的网页，留给 LaterOn。");
  direct.dom.window.close();

  assert.match(sidepanelSource, /type:\s*"OPEN_LIBRARY"[\s\S]*source:\s*"sidepanel"[\s\S]*projectId:\s*activeProject[\s\S]*filter[\s\S]*focusItemId:\s*currentItemId/);
  assert.match(backgroundSource, /openLibrary\(message\.context\)/);
  assert.match(backgroundSource, /target\.searchParams\.set\("from",\s*"sidepanel"\)/);
  console.log("PASS 侧栏展开全屏会同步项目、筛选和正在阅读位置，普通入口仍回首页");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
