// 全屏收藏库里点一篇收藏：应该切换成「原文 + 侧栏」的阅读状态，
// 而不是单纯在新标签页里打开链接、把全屏收藏库留在原地。
// 覆盖：
//  1) 点标题 / 封面 → 先开侧栏，再把收藏库自己这个标签页导航到原文；不新开标签页
//  2) 「打开后自动标记为在读」打开时，未读条目会被标记为在读（而非直接已读）
//  3) 按住 ⌘/Ctrl 点击 → 保留浏览器默认行为（新标签页打开），收藏库不动
//  4) 侧栏打不开时兜底：在新标签页打开原文，不让这次点击落空
//  5) 窗口 id 过期（收藏库被拖到别的窗口）时能自动重试成功
//  6) 非 http/https 的网址（如 javascript:）直接拒绝，不做任何跳转
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
virtualConsole.on("error", (message) => errors.push(String(message)));

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/library.html",
  virtualConsole
});
const { window } = dom;
const { document } = window;

// ── 假的 chrome API ─────────────────────────────────────────
const now = Date.now();
const store = {
  laterOnItems: [
    { id: "i1", title: "文章一", description: "摘要一", image: "", favicon: "", source: "a.com", projectId: "work", url: "https://a.com/1", savedAt: now, read: false },
    { id: "i2", title: "文章二", description: "摘要二", image: "", favicon: "", source: "b.com", projectId: "work", url: "https://b.com/2", savedAt: now - 1000, read: true },
    { id: "i3", title: "文章三", description: "摘要三", image: "", favicon: "", source: "c.com", projectId: "work", url: "https://c.com/3", savedAt: now - 2000, read: false },
    { id: "i4", title: "坏链接", description: "摘要四", image: "", favicon: "", source: "d.com", projectId: "work", url: "javascript:alert(1)", savedAt: now - 3000, read: false }
  ],
  laterOnProjects: [{ id: "work", name: "工作", createdAt: 1 }],
  laterOnActiveProject: "work",
  laterOnSettings: {},
  laterOnFilter: "all",
  laterOnFilterChosen: true,
};

const changeListeners = [];
const openedPanels = [];
const updatedTabs = [];
const createdTabs = [];
const pingCalls = [];
let panelFailuresLeft = 0;   // 让接下来 N 次 sidePanel.open 失败（模拟手势被拒 / 窗口 id 过期）
let idSeq = 0;

window.chrome = {
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
    // 收藏库自己那个标签页：id=1，所在窗口 windowId=7。
    getCurrent: () => Promise.resolve({ id: 1, windowId: 7, active: true }),
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true }]),
    update: (id, options) => { updatedTabs.push({ id, ...options }); return Promise.resolve({ id }); },
    create: (options) => { createdTabs.push(options); return Promise.resolve({ id: 9 }); }
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  sidePanel: {
    open(options) {
      openedPanels.push(options);
      if (panelFailuresLeft > 0) { panelFailuresLeft -= 1; return Promise.reject(new Error("sidePanel blocked")); }
      return Promise.resolve();
    }
  },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: (message) => { pingCalls.push(message); return Promise.resolve({ ready: true }); },
    onMessage: { addListener() {} }
  }
};

if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `fake-id-${++idSeq}` }
  });
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 12) => new Promise((resolve) => window.setTimeout(resolve, ms));
const clickCapture = (el, init = {}) => {
  const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
};
const linkOf = (id) => document.querySelector(`.card[data-id="${id}"] .title-link`);
const coverOf = (id) => document.querySelector(`.card[data-id="${id}"] .cover-link`);
const itemOf = (id) => store.laterOnItems.find((item) => item.id === id);
const toastText = () => document.querySelector("#toast").textContent;
const resetLogs = () => {
  openedPanels.length = 0;
  updatedTabs.length = 0;
  createdTabs.length = 0;
  pingCalls.length = 0;
};

window.eval(librarySource);

(async () => {
  await tick(40);   // 等 init() 把卡片渲染出来

  console.log("── 第 1 步：点标题链接 → 切侧栏 + 当前标签页跳转 ──");
  resetLogs();
  const event1 = clickCapture(linkOf("i1"));
  await tick(40);
  check("拦住了链接的默认跳转（改由我们接管）", event1.defaultPrevented === true);
  check("打开了侧栏", openedPanels.length === 1, `调用了 ${openedPanels.length} 次`);
  check("侧栏开在收藏库所在的窗口", openedPanels[0]?.windowId === 7, JSON.stringify(openedPanels[0]));
  check("把收藏库这个标签页导航到了原文", updatedTabs.length === 1 && updatedTabs[0].id === 1 && updatedTabs[0].url === "https://a.com/1", JSON.stringify(updatedTabs[0]));
  check("没有多开一个新标签页", createdTabs.length === 0, `新开 ${createdTabs.length} 个`);
  check("未读的那篇被自动标记为在读", itemOf("i1").status === "reading", `status=${itemOf("i1").status}`);
  check("跳转前先和侧栏握了手（PING）", pingCalls.some((m) => m.type === "PING_SIDEPANEL" && m.windowId === 7), JSON.stringify(pingCalls));

  console.log("\n── 第 2 步：点封面图 → 同样的行为 ──");
  resetLogs();
  const event2 = clickCapture(coverOf("i3"));
  await tick(40);
  check("封面点击也走同一套逻辑", event2.defaultPrevented === true && openedPanels.length === 1 && updatedTabs[0]?.url === "https://c.com/3", `update=${JSON.stringify(updatedTabs[0])}`);
  check("未读的那篇被自动标记为在读", itemOf("i3").status === "reading", `status=${itemOf("i3").status}`);

  console.log("\n── 第 3 步：按住 ⌘/Ctrl 点击 → 保留浏览器默认行为 ──");
  resetLogs();
  const before3 = itemOf("i1").status;
  const event3 = clickCapture(linkOf("i1"), { metaKey: true });
  const ctrl3 = clickCapture(linkOf("i1"), { ctrlKey: true });
  await tick(40);
  check("没有拦截默认行为（浏览器会自己开新标签页）", event3.defaultPrevented === false && ctrl3.defaultPrevented === false);
  check("没有打开侧栏", openedPanels.length === 0, `调用了 ${openedPanels.length} 次`);
  check("收藏库没有跳走", updatedTabs.length === 0 && createdTabs.length === 0);
  check("没有改动收藏状态", itemOf("i1").status === before3);

  console.log("\n── 第 4 步：侧栏打不开 → 兜底在新标签页打开 ──");
  resetLogs();
  panelFailuresLeft = 3;   // 首次 + 重试都失败
  clickCapture(linkOf("i2"));
  await tick(40);
  check("尝试打开侧栏但被拒", openedPanels.length >= 1, `调用了 ${openedPanels.length} 次`);
  check("兜底在新标签页里打开了原文", createdTabs.length === 1 && createdTabs[0].url === "https://b.com/2", JSON.stringify(createdTabs[0]));
  check("收藏库没有跳走（原文已在另一个标签打开）", updatedTabs.length === 0, JSON.stringify(updatedTabs));
  check("给了用户提示", /侧栏打开失败/.test(toastText()), toastText());

  console.log("\n── 第 5 步：窗口 id 过期（收藏库被拖到别的窗口）→ 自动重试 ──");
  resetLogs();
  panelFailuresLeft = 1;   // 用缓存的窗口 id 失败一次，重试应当成功
  clickCapture(linkOf("i2"));
  await tick(60);
  check("重试后成功打开了侧栏", openedPanels.length === 2, `调用了 ${openedPanels.length} 次`);
  check("确实走的是「失败一次 → 再试一次」", panelFailuresLeft === 0);
  check("没有误开新标签页", createdTabs.length === 0);
  check("重试成功后正常跳转", updatedTabs.length === 1 && updatedTabs[0].url === "https://b.com/2", JSON.stringify(updatedTabs[0]));

  console.log("\n── 第 6 步：非 http/https 的网址 → 直接拒绝 ──");
  resetLogs();
  clickCapture(linkOf("i4"));
  await tick(40);
  check("没有打开侧栏", openedPanels.length === 0);
  check("没有跳转，也没有开新标签页", updatedTabs.length === 0 && createdTabs.length === 0);
  check("给了用户提示", /网址打不开/.test(toastText()), toastText());

  console.log("\n── 第 7 步：当前正在读的文章会被高亮并跨视图同步 ──");
  // 前面的第 4/5 步点开的是 i2，所以收尾时共享标记应是 i2。
  check("点开某篇后共享标记已写入（这里停在 i2）", store.laterOnCurrentItem === "i2", store.laterOnCurrentItem);
  check("当前高亮的卡片就是 i2", document.querySelector('.card[data-id="i2"]').classList.contains("is-current"));
  check("其它卡片没有高亮", !document.querySelector('.card[data-id="i1"]').classList.contains("is-current"));
  // 模拟在侧栏（或任意一处）切换了当前文章：全屏这边应跟着重新高亮。
  await window.chrome.storage.local.set({ laterOnCurrentItem: "i1" });
  await tick(20);
  check("切到 i1 后，i1 立刻高亮", document.querySelector('.card[data-id="i1"]').classList.contains("is-current"));
  check("原来的 i2 高亮被取消", !document.querySelector('.card[data-id="i2"]').classList.contains("is-current"));

  console.log("\n── 第 8 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
