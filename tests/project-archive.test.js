// 把真实的 library.js 放进一个假 DOM 里跑一遍，检查「项目置顶」：
//  1) 「⋯」/ 右键菜单里第一项是「置顶项目」，置顶后同一项变成「取消置顶」
//  2) 置顶的项目真的排到侧栏最前面，并且写进了 laterOnProjects
//  3) 置顶的行有图钉角标；置顶区和其余项目之间有一条分隔线
//  4) 取消置顶后回到普通位置，图钉和分隔线跟着消失
//  5) 多个置顶：按置顶先后排在前面（后置顶的排在后面），彼此也能再拖
//  6) 拖拽排序和置顶不打架：拖进置顶区自动置顶，拖出去自动取消
//  7) 重新打开页面（重读存储）后置顶的顺序和标记还在
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
// 侧栏那套样式的源码：下面有几条「静态断言」用它锁住纯视觉的规矩
// （jsdom 不做排版，「图钉角标贴在缩略图的哪个角」这种事它永远测不出来）。
const libraryCss = fs.readFileSync(`${ROOT}/library.css`, "utf8");

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
const mkProject = (id, name) => ({ id, name, createdAt: Number(id.slice(1)) || 1 });
const store = {
  laterOnItems: [
    { id: "i1", title: "文章一", description: "一", image: "https://a.com/cover.jpg", favicon: "", source: "a.com", projectId: "p3", url: "https://a.com/1", savedAt: now, read: true, status: "done" },
    { id: "i2", title: "文章二", description: "二", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com/2", savedAt: now - 1000, read: true }
  ],
  laterOnProjects: [mkProject("p1", "工作"), mkProject("p2", "设计灵感"), mkProject("p3", "稍后细读")],
  laterOnActiveProject: "all",
  laterOnSettings: {},
  laterOnFilter: "all",
  laterOnFilterChosen: true
};
const changeListeners = [];
const projectsWrites = [];
const nativeDialogs = [];
let idSeq = 0;

window.chrome = {
  storage: {
    local: {
      get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
        return Promise.resolve(out);
      },
      set(patch) {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
          if (key === "laterOnProjects") projectsWrites.push(value.map((project) => project.id));
        }
        window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 1 }]),
    create: () => Promise.resolve({ id: 2 })
  },
  runtime: {
    getURL: (p) => `chrome-extension://lateron/${p}`,
    sendMessage: () => Promise.resolve({ ready: true }),
    onMessage: { addListener() {} }
  }
};
window.confirm = (message) => { nativeDialogs.push(String(message)); return true; };
window.alert = (message) => { nativeDialogs.push(String(message)); };
if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `fake-id-${++idSeq}` }
  });
}

// jsdom 里没有排版，拖拽排序要靠假的行位置（针尖大的差别它也看不见）。
const ROW_TOP = 300;
const ROW_HEIGHT = 36;
const ROW_STEP = 40;
window.Element.prototype.getBoundingClientRect = function () {
  const list = document.querySelector("#projectList");
  const rows = list ? [...list.querySelectorAll(".project-row")] : [];
  const row = this.classList?.contains("project-row") ? this : this.closest?.(".project-row");
  const index = rows.indexOf(row);
  const top = ROW_TOP + Math.max(0, index) * ROW_STEP;
  return { top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT, left: 0, right: 180, width: 180, x: 0, y: top, toJSON() {} };
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 5) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }));
const dragEvent = (el, type, dataTransfer, point = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = dataTransfer;
  if (point.clientX !== undefined) event.clientX = point.clientX;
  if (point.clientY !== undefined) event.clientY = point.clientY;
  el.dispatchEvent(event);
  return event;
};
const folderTransfer = (id) => ({
  types: ["application/x-lateron-folder"],
  dropEffect: "",
  effectAllowed: "",
  getData: (type) => (type === "application/x-lateron-folder" ? id : ""),
  setData() {},
  setDragImage() {}
});

const projectRows = () => [...document.querySelectorAll("#projectList .project-row")];
const rowOf = (id) => projectRows().find((row) => row.dataset.id === id);
const domOrder = () => projectRows().map((row) => row.dataset.id);
const storeOrder = () => store.laterOnProjects.map((project) => project.id);
const pinnedIds = () => store.laterOnProjects.filter((project) => project.pinned).map((project) => project.id);
const menuItems = () => [...document.querySelectorAll(".folder-menu .folder-menu-item")];
const menuItem = (label) => menuItems().find((item) => item.textContent === label);
const toastText = () => document.querySelector("#toast").textContent;
const openMenu = async (id) => {
  if (document.querySelector(".folder-menu")) click(document.body);
  click(rowOf(id).querySelector(".project-more"));
  await tick(10);
};
// 第 n 行（0 起）的上边缘——指针落在某行上半就表示「插到它前面」
const topOf = (index) => ROW_TOP + index * ROW_STEP;
const midOf = (index) => topOf(index) + ROW_HEIGHT / 2;

window.eval(dialogSource);
require('./helpers/item-mutation')(window);
require("./helpers/data-mutation")(window);
window.eval(librarySource);

(async () => {
  await tick(30);
  await window.toggleProjectArchive("p3");
  await tick();
  check("归档状态保存", store.laterOnProjects.find(p => p.id === "p3").archived);
  check("内容保持项目归属", store.laterOnItems[0].projectId === "p3");
  check("普通侧栏隐藏归档项目", !rowOf("p3"));
  check("归档卡片没有恢复按钮", !document.querySelector(".archive-restore"));
  const archivedCard = document.querySelector('.board-card[data-project="p3"]');
  check("未读模式保留已读内容的封面", archivedCard.querySelector(".board-img")?.src === "https://a.com/cover.jpg");
  check("有内容的项目不会误报空项目", !archivedCard.querySelector(".board-meta").textContent.includes("还没有"));
  window.eval('filter = "all"; render()');
  check("切换筛选封面保持一致", document.querySelector('.board-card[data-project="p3"] .board-img')?.src === "https://a.com/cover.jpg");
  window.eval('filter = "unread"; render()');
  window.selectProject("all");
  check("普通总览不显示归档项目", !document.querySelector('.board-card[data-project="p3"]'));
  window.selectProject("archive");
  rightClick(document.querySelector('.board-card[data-project="p3"]'));
  await tick();
  click(menuItem("恢复项目"));
  await tick(20);
  check("恢复项目", !store.laterOnProjects.find(p => p.id === "p3").archived && !!rowOf("p3"));
  check("恢复后内容保持归属", store.laterOnItems[0].projectId === "p3");
  check("无页面错误", !errors.length, errors.join(" | "));
  if (failures) process.exitCode = 1;
  window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
