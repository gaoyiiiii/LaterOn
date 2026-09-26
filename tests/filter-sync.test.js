// 全屏界面与侧边栏的「筛选状态」同步测试。
// 两个视图各自用一个 jsdom 实例加载真实 HTML + JS，但共用同一份 chrome.storage.local：
// 一边点「未读 / 已读」，另一边必须跟着切过去（反之亦然），并且重新打开时接着用同一档。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const libraryHtml = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const panelHtml = fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8");
const panelSource = fs.readFileSync(`${ROOT}/sidepanel.js`, "utf8");

const errors = [];
function makeVirtualConsole() {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(String(error?.message || error)));
  vc.on("error", (message) => errors.push(String(message)));
  return vc;
}

const now = Date.now();
// 两个视图共享的「存储」——这就相当于浏览器里那一份 chrome.storage.local。
const store = {
  laterOnItems: [
    { id: "a", title: "A 未读", description: "da", image: "", favicon: "", source: "a.com", projectId: null, url: "https://a.com", savedAt: now, status: "unread" },
    { id: "b", title: "B 在读", description: "db", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com", savedAt: now, status: "reading" },
    { id: "c", title: "C 已读", description: "dc", image: "", favicon: "", source: "c.com", projectId: null, url: "https://c.com", savedAt: now, status: "done" }
  ],
  laterOnProjects: [],
  laterOnActiveProject: "unfiled",
  laterOnSettings: {}
};

// 所有视图的 onChanged 回调都挂到这里，任何一边写存储，另一边都会收到通知。
const changeListeners = [];
const makeChrome = (window) => ({
  storage: {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in store) out[key] = store[key];
        return Promise.resolve(out);
      },
      set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  },
  tabs: {
    getCurrent: () => Promise.resolve({ id: 1, windowId: 7, active: true }),
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "https://current.com" }]),
    update: () => Promise.resolve({ id: 1 }),
    create: () => Promise.resolve({ id: 9 }),
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  sidePanel: { open: () => Promise.resolve() },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: () => Promise.resolve({ ok: false, ready: true }),
    onMessage: { addListener() {} }
  }
});

function ensureUuid(window) {
  if (typeof window.crypto?.randomUUID !== "function") {
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: { randomUUID: () => `fake-${Math.random().toString(36).slice(2)}` }
    });
  }
}

// 建一个视图：加载真实 HTML + 真实 JS，注入共享存储的 chrome mock。
function mount(html, source, url) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url,
    virtualConsole: makeVirtualConsole()
  });
  dom.window.chrome = makeChrome(dom.window);
  ensureUuid(dom.window);
  dom.window.eval(source);
  return dom.window;
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// 两个视图同时跑起来（模拟：全屏页和侧栏一起开着）
const libWin = mount(libraryHtml, librarySource, "chrome-extension://lateron/library.html");
const panelWin = mount(panelHtml, panelSource, "chrome-extension://lateron/sidepanel.html");

const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
const libNav = (f) => libWin.document.querySelector(`.nav-item[data-filter="${f}"]`);
const panelNav = (f) => panelWin.document.querySelector(`.filters .filter[data-filter="${f}"]`);
const libIds = () => [...libWin.document.querySelectorAll("#cardGrid .card")].map((c) => c.dataset.id).sort().join();
const panelIds = () => [...panelWin.document.querySelectorAll("#items .item")].map((i) => i.dataset.id).sort().join();
const activeLibNav = () => libWin.document.querySelector(".nav-item.active")?.dataset.filter;
const activePanelNav = () => panelWin.document.querySelector(".filters .filter.active")?.dataset.filter;

(async () => {
  await tick(80);

  console.log("── 第 1 步：首次打开还没有偏好，两个视图都默认显示「未读」──");
  check("全屏默认高亮「未读」，只显示未读与在读", activeLibNav() === "unread" && libIds() === "a,b", `高亮=${activeLibNav()} 可见=${libIds()}`);
  check("侧栏默认高亮「未读」，只显示未读与在读", activePanelNav() === "unread" && panelIds() === "a,b", `高亮=${activePanelNav()} 可见=${panelIds()}`);

  console.log("\n── 第 2 步：全屏点「未读」→ 侧栏跟着切 ──");
  // 先切走，再点回未读，验证这是一次真正的用户选择并会被持久化。
  click(libWin, libNav("all"));
  await tick(40);
  click(libWin, libNav("unread"));
  await tick(40);
  check("全屏：只剩 a、b（在读仍算未读）", libIds() === "a,b", `可见=${libIds()}`);
  check("全屏按钮高亮切到「未读」", activeLibNav() === "unread");
  check("侧栏：也只剩 a、b", panelIds() === "a,b", `可见=${panelIds()}`);
  check("侧栏按钮高亮也跟着切到「未读」", activePanelNav() === "unread", `高亮=${activePanelNav()}`);
  check("筛选已写进共享存储", store.laterOnFilter === "unread", `存储=${store.laterOnFilter}`);

  console.log("\n── 第 3 步：反过来，侧栏点「已读」→ 全屏跟着切 ──");
  click(panelWin, panelNav("done"));
  await tick(40);
  check("侧栏：只剩 c", panelIds() === "c", `可见=${panelIds()}`);
  check("侧栏按钮高亮切到「已读」", activePanelNav() === "done");
  check("全屏：也只剩 c", libIds() === "c", `可见=${libIds()}`);
  check("全屏按钮高亮也跟着切到「已读」", activeLibNav() === "done", `高亮=${activeLibNav()}`);
  check("共享存储跟着更新成 done", store.laterOnFilter === "done", `存储=${store.laterOnFilter}`);

  console.log("\n── 第 4 步：切回「全部」也是双向的 ──");
  click(libWin, libNav("all"));
  await tick(40);
  check("两边都回到「全部」，三张都在", libIds() === "a,b,c" && panelIds() === "a,b,c", `全屏=${libIds()} 侧栏=${panelIds()}`);

  console.log("\n── 第 5 步：用户选过后，重新打开侧栏 → 接着用偏好 ──");
  click(libWin, libNav("done"));
  await tick(40);
  // 关掉旧侧栏、重新开一个（模拟重新打开侧栏面板）
  panelWin.close();
  await tick(10);
  const freshPanel = mount(panelHtml, panelSource, "chrome-extension://lateron/sidepanel.html");
  await tick(80);
  const freshActive = freshPanel.document.querySelector(".filters .filter.active")?.dataset.filter;
  const freshIds = [...freshPanel.document.querySelectorAll("#items .item")].map((i) => i.dataset.id).sort().join();
  check("新开的侧栏恢复用户选择的「已读」档", freshActive === "done", `高亮=${freshActive}`);
  check("新开的侧栏只显示 c", freshIds === "c", `可见=${freshIds}`);
  freshPanel.close();

  console.log("\n── 第 6 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
