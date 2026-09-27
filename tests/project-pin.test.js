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
    { id: "i1", title: "文章一", description: "一", image: "", favicon: "", source: "a.com", projectId: "p3", url: "https://a.com/1", savedAt: now, read: false },
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
window.eval(librarySource);

(async () => {
  await tick(20);

  console.log("── 初始状态 ──");
  check("侧栏按存储顺序列出三个项目", domOrder().join(",") === "p1,p2,p3", domOrder().join(","));
  check("没有项目被置顶，也就没有分隔线", !document.querySelector(".project-pin-sep"));
  check("没有项目带图钉角标", !document.querySelector(".project-pin-badge"));

  console.log("\n── 置顶再取消：项目回到原来的位置 ──");
  await openMenu("p2");
  click(menuItem("置顶项目"));
  await tick(20);
  check("置顶后提到最前面", storeOrder().join(",") === "p2,p1,p3", storeOrder().join(","));
  await openMenu("p2");
  click(menuItem("取消置顶"));
  await tick(20);
  check("取消后回到原来的第 2 个（不是留在最上面）", storeOrder().join(",") === "p1,p2,p3", storeOrder().join(","));
  check("置顶用的临时标记也一并清掉了", store.laterOnProjects.find((p) => p.id === "p2")?.pinFrom === undefined, JSON.stringify(store.laterOnProjects.find((p) => p.id === "p2")));

  console.log("\n── 置顶「稍后细读」（原本最后一个）──");
  await openMenu("p3");
  check("菜单第一项是「置顶项目」", menuItems()[0]?.textContent === "置顶项目", menuItems().map((i) => i.textContent).join(" / "));
  click(menuItem("置顶项目"));
  await tick(20);
  check("存储里标记了 pinned", pinnedIds().join(",") === "p3", pinnedIds().join(","));
  check("真的排到了最前面", storeOrder().join(",") === "p3,p1,p2", storeOrder().join(","));
  check("侧栏立刻重排", domOrder().join(",") === "p3,p1,p2", domOrder().join(","));
  check("给了「已置顶」的提示", /已把「稍后细读」置顶/.test(toastText()), toastText());
  check("置顶的行有图钉角标", !!rowOf("p3")?.querySelector(".project-pin-badge"));
  check("其它行没有角标", !rowOf("p1")?.querySelector(".project-pin-badge"));
  check("置顶区下面有一条分隔线", !!document.querySelector(".project-pin-sep"));
  check("分隔线就在置顶那一组的后面", document.querySelector("#projectList").children[1]?.classList.contains("project-pin-sep"),
    [...document.querySelector("#projectList").children].map((c) => c.className).join(" | "));
  check("悬停提示里说明了它已置顶", /已置顶/.test(rowOf("p3").querySelector(".project-name").title), rowOf("p3").querySelector(".project-name").title);
  await openMenu("p3");
  check("同一个菜单这时显示「取消置顶」", menuItems()[0]?.textContent === "取消置顶", menuItems().map((i) => i.textContent).join(" / "));

  console.log("\n── 再置顶一个：后置顶的排在后面 ──");
  await openMenu("p1");
  click(menuItem("置顶项目"));
  await tick(20);
  check("顺序变成 稍后细读 → 工作 → 设计灵感", storeOrder().join(",") === "p3,p1,p2", storeOrder().join(","));
  check("两个都标记为置顶", pinnedIds().join(",") === "p3,p1", pinnedIds().join(","));
  const divider = document.querySelector(".project-pin-sep");
  check("分隔线跑到第二个置顶项的后面", [...document.querySelector("#projectList").children].indexOf(divider) === 2,
    String([...document.querySelector("#projectList").children].indexOf(divider)));

  console.log("\n── 取消置顶「稍后细读」──");
  await openMenu("p3");
  click(menuItem("取消置顶"));
  await tick(20);
  check("存储里的置顶标记去掉了", pinnedIds().join(",") === "p1", pinnedIds().join(","));
  check("它回到原来的位置（排在还置顶的「工作」后面）", storeOrder().join(",") === "p1,p2,p3", storeOrder().join(","));
  check("侧栏跟着变", domOrder().join(",") === "p1,p2,p3", domOrder().join(","));
  check("图钉角标消失", !rowOf("p3")?.querySelector(".project-pin-badge"));
  check("给了「已取消置顶」的提示", /已取消置顶「稍后细读」/.test(toastText()), toastText());
  check("还剩一个置顶项，分隔线仍在", !!document.querySelector(".project-pin-sep"));

  console.log("\n── 取消最后一个置顶项：分隔线也该收掉 ──");
  await openMenu("p1");
  click(menuItem("取消置顶"));
  await tick(20);
  check("没有任何项目被置顶", pinnedIds().length === 0, pinnedIds().join(","));
  check("分隔线跟着消失", !document.querySelector(".project-pin-sep"));
  check("一个角标都不剩", !document.querySelector(".project-pin-badge"));
  check("它一定排在普通列表里（不可能还躲在置顶区）", storeOrder().join(",") === "p1,p2,p3", storeOrder().join(","));

  console.log("\n── 拖拽排序只在自己那一区里生效 ──");
  // 先置顶「设计灵感」，然后在正常情况下拖另外两个
  await openMenu("p2");
  click(menuItem("置顶项目"));
  await tick(20);
  check("「设计灵感」已置顶", storeOrder().join(",") === "p2,p1,p3", storeOrder().join(","));

  const list = document.querySelector("#projectList");
  // ① 普通项目拖到最前面：跨不过置顶那一行，只能成为「普通区第一」
  const dt1 = folderTransfer("p3");
  const p3Row = rowOf("p3");
  dragEvent(p3Row, "dragstart", dt1, { clientX: 20, clientY: midOf(2) });
  dragEvent(list, "dragover", dt1, { clientY: topOf(0) + 4 }); // 第一行（置顶的那行）的上半
  check("指示线没有落在置顶区里（不给「能拖进去」的错觉）", [...list.children].indexOf(document.querySelector(".folder-drop-line")) >= 1,
    String([...list.children].indexOf(document.querySelector(".folder-drop-line"))));
  dragEvent(list, "drop", dt1);
  await tick(20);
  check("普通项目没有被拖进置顶区", pinnedIds().join(",") === "p2", pinnedIds().join(","));
  check("它成了普通区的第一个", storeOrder().join(",") === "p2,p3,p1", storeOrder().join(","));
  dragEvent(p3Row, "dragend", dt1);

  // ② 唯一的置顶项目拖不到下面去（要取消置顶请去菜单）
  const dt2 = folderTransfer("p2");
  const p2Row = rowOf("p2");
  dragEvent(p2Row, "dragstart", dt2, { clientX: 20, clientY: midOf(0) });
  dragEvent(list, "dragover", dt2, { clientY: topOf(2) + ROW_HEIGHT + 30 }); // 所有行的下面
  dragEvent(list, "drop", dt2);
  await tick(20);
  check("置顶项目没被拖出置顶区", storeOrder().join(",") === "p2,p3,p1", storeOrder().join(","));
  check("它仍然是置顶的", pinnedIds().join(",") === "p2", pinnedIds().join(","));
  dragEvent(p2Row, "dragend", dt2);

  // ③ 两个置顶项目之间可以互换位置（区内排序照旧）
  await openMenu("p1");
  click(menuItem("置顶项目"));
  await tick(20);
  check("再置顶「工作」后排在两个置顶的中间位置", storeOrder().join(",") === "p2,p1,p3", storeOrder().join(","));
  const dt3 = folderTransfer("p1");
  const p1Row = rowOf("p1");
  dragEvent(p1Row, "dragstart", dt3, { clientX: 20, clientY: midOf(1) });
  dragEvent(list, "dragover", dt3, { clientY: topOf(0) + 4 }); // 拖到置顶区最前
  dragEvent(list, "drop", dt3);
  await tick(20);
  check("置顶区内可以换顺序", storeOrder().join(",") === "p1,p2,p3", storeOrder().join(","));
  check("两个都还置顶着", pinnedIds().join(",") === "p1,p2", pinnedIds().join(","));
  dragEvent(p1Row, "dragend", dt3);

  console.log("\n── 位置没变时不写库 ──");
  const writesBefore = projectsWrites.length;
  const pinsBefore = store.laterOnProjects.map((project) => String(project.pinned)).join(",");
  const dt4 = folderTransfer("p3");
  const p3Row2 = rowOf("p3");
  dragEvent(p3Row2, "dragstart", dt4, { clientX: 20, clientY: midOf(2) });
  dragEvent(list, "dragover", dt4, { clientY: topOf(2) + 4 }); // 仍指向自己所在的位置
  dragEvent(list, "drop", dt4);
  await tick(20);
  check("原地放下不写存储", projectsWrites.length === writesBefore, `写了 ${projectsWrites.length - writesBefore} 次`);
  check("拖拽不会改动任何项目的置顶状态", store.laterOnProjects.map((project) => String(project.pinned)).join(",") === pinsBefore, pinsBefore);
  dragEvent(p3Row2, "dragend", dt4);

  console.log("\n── 别处把存储写成了「置顶不在最前面」──");
  // 「显示顺序 = 存储顺序」是这个功能的地基：读取时先把置顶的提到前面，
  // 否则拖拽算出来的下标就会和屏幕上的行错位。
  store.laterOnProjects = [
    { id: "p1", name: "工作" },
    { id: "p2", name: "设计灵感", pinned: true },
    { id: "p3", name: "稍后细读" }
  ];
  changeListeners.forEach((fn) => fn({ laterOnProjects: { oldValue: [], newValue: store.laterOnProjects } }, "local"));
  await tick(20);
  check("读回来时置顶的项目被提到最前面", domOrder().join(",") === "p2,p1,p3", domOrder().join(","));
  check("图钉角标跟着出现在正确的那一行", !!rowOf("p2")?.querySelector(".project-pin-badge") && !rowOf("p1")?.querySelector(".project-pin-badge"));

  console.log("\n── 图钉角标的视觉规矩（静态锁，jsdom 看不出排版）──");
  const ruleOf = (selector) => new RegExp(`^${selector}[^{]*\\{[^}]*\\}`, "m").exec(libraryCss)?.[0] || "";
  const badgeRule = ruleOf("\\.project-pin-badge");
  const thumbRule = ruleOf("\\.project-thumb");
  const sepRule = ruleOf("\\.project-pin-sep");
  check("缩略图自己声明了定位（否则角标会飘到列表外）", /position:\s*relative/.test(thumbRule), thumbRule.slice(0, 80));
  check("角标是绝对定位、贴在右下角", /position:\s*absolute/.test(badgeRule) && /right:\s*-?\d+px/.test(badgeRule) && /bottom:\s*-?\d+px/.test(badgeRule), badgeRule);
  const badgeSize = Number(/width:\s*(\d+)px/.exec(badgeRule)?.[1] || 0);
  check("角标够小（36px 的缩略图不能被它糊住）", badgeSize > 0 && badgeSize <= 18, `${badgeSize}px`);
  check("分隔线是一条细线且左右留了边距", /height:\s*1px/.test(sepRule) && /margin:.{0,40}12px/.test(sepRule), sepRule);

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现任何未捕获的错误", errors.length === 0, errors.join(" | "));
  check("全程没有调用浏览器自带的弹窗", nativeDialogs.length === 0, nativeDialogs.join(" | "));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
