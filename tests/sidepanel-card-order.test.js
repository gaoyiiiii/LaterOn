// 侧栏卡片拖拽排序：验证整卡可拖、按钮不误触发拖动、排序与全屏共享，
// 并且第一次拖动会自动切换到「自定义顺序」。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
const source = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
const i18n = fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8");
const tabNavigation = fs.readFileSync(path.join(ROOT, "tab-navigation.js"), "utf8");
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/sidepanel.html",
  virtualConsole
});
const { window } = dom;
const { document } = window;
window.scrollTo = () => {};

const now = Date.now();
const store = {
  laterOnItems: [
    { id: "a", title: "A", description: "A", favicon: "", source: "a.com", projectId: null, url: "https://a.com", savedAt: now - 1000, status: "unread" },
    { id: "b", title: "B", description: "B", favicon: "", source: "b.com", projectId: null, url: "https://b.com", savedAt: now - 2000, status: "unread" },
    { id: "c", title: "C", description: "C", favicon: "", source: "c.com", projectId: null, url: "https://c.com", savedAt: now - 3000, status: "unread" },
    { id: "d", title: "D", description: "D", favicon: "", source: "d.com", projectId: null, url: "https://d.com", savedAt: now - 4000, status: "done" }
  ],
  laterOnProjects: [],
  laterOnActiveProject: "unfiled",
  laterOnSettings: { defaultSort: "newest" }
};
const listeners = [];
window.chrome = {
  storage: {
    local: {
      get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Promise.resolve(Object.fromEntries(names.filter((key) => key in store).map((key) => [key, store[key]])));
      },
      set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        window.setTimeout(() => listeners.forEach((listener) => listener(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(listener) { listeners.push(listener); } }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "https://current.com" }]),
    create: () => Promise.resolve({ id: 2, windowId: 7 }),
    update: () => Promise.resolve(),
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  runtime: {
    getURL: (file) => `chrome-extension://lateron/${file}`,
    sendMessage: () => Promise.resolve({ ok: false }),
    onMessage: { addListener() {} }
  }
};

const tick = (ms = 30) => new Promise((resolve) => window.setTimeout(resolve, ms));
const ids = () => [...document.querySelectorAll("#items .item")].map((item) => item.dataset.id);
function dragEvent(type, target, { x = 10, y = 10 } = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  event.dataTransfer = { effectAllowed: "", dropEffect: "", setData() {}, setDragImage() {} };
  target.dispatchEvent(event);
  return event;
}

window.eval(i18n);
window.eval(tabNavigation);
window.eval(source);

(async () => {
  await tick(70);
  const cards = [...document.querySelectorAll("#items .item")];
  assert.deepStrictEqual(ids(), ["a", "b", "c"]);
  assert(cards.every((card) => card.draggable), "每张侧栏卡片都应可拖动");

  cards.forEach((card, index) => {
    card.getBoundingClientRect = () => ({ left: 0, right: 300, top: index * 110, bottom: index * 110 + 100, width: 300, height: 100 });
  });
  const buttonDrag = dragEvent("dragstart", cards[0].querySelector(".read-toggle"));
  assert(buttonDrag.defaultPrevented, "从卡片按钮开始拖动时应保留按钮交互");

  dragEvent("dragstart", cards[2], { x: 20, y: 230 });
  dragEvent("dragover", document.querySelector("#items"), { x: 20, y: 10 });
  dragEvent("drop", document.querySelector("#items"), { x: 20, y: 10 });
  await tick(80);

  assert.strictEqual([...store.laterOnOrder.unfiled].join(","), "c,a,b,d", "筛选掉的已读卡片也应保留在完整顺序中");
  assert.strictEqual(store.laterOnSettings.defaultSort, "custom");
  assert.deepStrictEqual(ids(), ["c", "a", "b"]);
  assert(!document.querySelector("#items").classList.contains("is-reordering"));
  assert.strictEqual(document.querySelectorAll(".card-drag-preview").length, 0);
  assert.deepStrictEqual(errors, []);
  console.log("PASS 侧栏卡片可上下拖拽并与全屏共享自定义顺序");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
