// 把真实的 library.js 放进假 DOM 里跑一遍，检查「拖拽项目排序」：
//  1) 项目行可以拖；拖动时出现指示线，被拖的行变淡、有一份跟随光标的实体影像
//  2) 拖到最前 / 中间 / 最后，放下后顺序真的变了，并且写进了 laterOnProjects
//  3) 原地放下（位置没变）不写库、不弹提示
//  4) 拖项目不会被误当成「把某篇收藏移进这个项目」（两者共用一块放下区域）
//  5) 拖收藏卡片进项目的原有能力没被破坏（回归）
//  6) 从「改名输入框 / ⋯ 按钮」上按下不会触发拖拽
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");

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
    { id: "i1", title: "文章一", description: "一", image: "", favicon: "", source: "a.com", projectId: "work", url: "https://a.com/1", savedAt: now, read: false },
    { id: "i2", title: "文章二", description: "二", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com/2", savedAt: now - 1000, read: true }
  ],
  laterOnProjects: [
    { id: "work", name: "工作", createdAt: 1 },
    { id: "design", name: "设计灵感", createdAt: 2 },
    { id: "reading", name: "稍后细读", createdAt: 3 }
  ],
  laterOnActiveProject: "all",
  laterOnSettings: {}
};
const changeListeners = [];
const nativeDialogs = [];
const projectsWrites = [];
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
    getURL: (path) => `chrome-extension://lateron/${path}`,
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

// jsdom 里所有元素都没有尺寸（getBoundingClientRect 全是 0），
// 而排序是靠「指针在行的上半还是下半」判断的，所以这里给每行造一个假的纵向位置。
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
const pointerdown = (el) => el.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
const dblclick = (el) => el.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
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
const cardTransfer = (id) => ({
  types: ["text/plain"],
  dropEffect: "",
  getData: () => id,
  setData() {},
  setDragImage() {}
});

const projectRows = () => [...document.querySelectorAll("#projectList .project-row")];
const rowOf = (id) => projectRows().find((row) => row.dataset.id === id);
const domOrder = () => projectRows().map((row) => row.dataset.id);
const storeOrder = () => store.laterOnProjects.map((project) => project.id);
const dropLine = () => document.querySelector("#projectList .folder-drop-line");
const lineAt = () => [...document.querySelector("#projectList").children].indexOf(dropLine());
const toastText = () => document.querySelector("#toast").textContent;
const itemProject = (id) => store.laterOnItems.find((item) => item.id === id)?.projectId;
// 第 n 行（0 起）的中心线，用来把指针放到「这一行的上半 / 下半」
const topOf = (index) => ROW_TOP + index * ROW_STEP;
const midOf = (index) => topOf(index) + ROW_HEIGHT / 2;

window.eval(dialogSource);
window.eval(librarySource);

(async () => {
  await tick(20);
  const list = document.querySelector("#projectList");

  console.log("── 初始状态 ──");
  check("侧栏按存储里的顺序列出项目", domOrder().join(",") === "work,design,reading", domOrder().join(","));
  check("每一行都被标记为可拖拽", projectRows().every((row) => row.draggable === true));
  check("名字的悬停提示里提到了拖动排序", /拖动/.test(rowOf("work").querySelector(".project-name").title), rowOf("work").querySelector(".project-name").title);

  console.log("\n── 拖到最前：把「设计灵感」拖到「工作」上面 ──");
  const dt1 = folderTransfer("design");
  const designRow = rowOf("design");
  dragEvent(designRow, "dragstart", dt1, { clientX: 20, clientY: midOf(1) });
  check("被拖的行进入拖拽态", designRow.classList.contains("is-dragging"));
  check("有一份跟随光标的实体影像（不是透明的行）", !!document.querySelector("body > .folder-drag-preview"));
  check("列表进入排序态", list.classList.contains("is-sorting"));

  dragEvent(list, "dragover", dt1, { clientY: topOf(0) + 4 }); // 第一行的上半 → 插到最前
  check("出现了插入位置指示线", !!dropLine());
  check("指示线落在列表最前面", lineAt() === 0, `位置 ${lineAt()}`);

  dragEvent(list, "drop", dt1);
  await tick(20);
  check("存储里的顺序真的变了", storeOrder().join(",") === "design,work,reading", storeOrder().join(","));
  check("侧栏跟着刷新成新顺序", domOrder().join(",") === "design,work,reading", domOrder().join(","));
  check("给了「移到第几个」的提示", /第 1 个/.test(toastText()), toastText());

  dragEvent(designRow, "dragend", dt1);
  check("拖拽结束后指示线消失", !dropLine());
  check("拖拽结束后影像消失", !document.querySelector(".folder-drag-preview"));
  check("拖拽结束后行不再处于拖拽态", !document.querySelector(".project-row.is-dragging"));
  check("拖拽结束后列表退出排序态", !list.classList.contains("is-sorting"));

  console.log("\n── 拖到末尾：把「设计灵感」拖到最后 ──");
  const dt2 = folderTransfer("design");
  const designRow2 = rowOf("design");
  dragEvent(designRow2, "dragstart", dt2, { clientX: 20, clientY: midOf(0) });
  dragEvent(list, "dragover", dt2, { clientY: topOf(2) + ROW_HEIGHT + 30 }); // 所有行下面
  check("指示线落到列表末尾", lineAt() === list.children.length - 1, `位置 ${lineAt()} / 共 ${list.children.length} 个孩子`);
  dragEvent(list, "drop", dt2);
  await tick(20);
  check("顺序变成 工作 → 稍后细读 → 设计灵感", storeOrder().join(",") === "work,reading,design", storeOrder().join(","));
  dragEvent(designRow2, "dragend", dt2);

  console.log("\n── 拖到中间：把「设计灵感」（最后）插到「工作」和「稍后细读」之间 ──");
  const dt3 = folderTransfer("design");
  const designRow3 = rowOf("design");
  dragEvent(designRow3, "dragstart", dt3, { clientX: 20, clientY: midOf(2) });
  dragEvent(list, "dragover", dt3, { clientY: midOf(1) - 4 }); // 第二行的上半
  dragEvent(list, "drop", dt3);
  await tick(20);
  check("顺序变成 工作 → 设计灵感 → 稍后细读", storeOrder().join(",") === "work,design,reading", storeOrder().join(","));
  dragEvent(designRow3, "dragend", dt3);

  console.log("\n── 原地放下（位置没变）──");
  const writesBefore = projectsWrites.length;
  document.querySelector("#toast").textContent = ""; // 清掉上一条提示，这样能确认「这次没弹新的」
  const dt4 = folderTransfer("design");
  const designRow4 = rowOf("design");
  dragEvent(designRow4, "dragstart", dt4, { clientX: 20, clientY: midOf(1) });
  dragEvent(list, "dragover", dt4, { clientY: topOf(1) + 4 }); // 仍指向自己所在的位置
  dragEvent(list, "drop", dt4);
  await tick(20);
  check("顺序没有变化", storeOrder().join(",") === "work,design,reading", storeOrder().join(","));
  check("位置没变时不写存储（省无谓的写库）", projectsWrites.length === writesBefore, `写库 ${projectsWrites.length - writesBefore} 次`);
  check("位置没变时不弹提示", toastText() === "", `提示内容「${toastText()}」`);
  dragEvent(designRow4, "dragend", dt4);

  console.log("\n── 没有指示线就放下（比如手滑在别处松开）──");
  document.querySelector("#toast").textContent = "";
  const dt5 = folderTransfer("work");
  const workRow = rowOf("work");
  dragEvent(workRow, "dragstart", dt5, { clientX: 20, clientY: midOf(0) });
  dragEvent(list, "drop", dt5); // 中间没有 dragover
  await tick(20);
  check("不会因为缺少指示线而报错或乱序", storeOrder().join(",") === "work,design,reading", storeOrder().join(","));
  check("也不会弹提示", toastText() === "", `提示内容「${toastText()}」`);
  dragEvent(workRow, "dragend", dt5);

  console.log("\n── 拖项目不会被当成「把收藏移进项目」──");
  const dt6 = folderTransfer("reading");
  const readingRow = rowOf("reading");
  dragEvent(readingRow, "dragstart", dt6, { clientX: 20, clientY: midOf(2) });
  dragEvent(readingRow, "dragover", dt6, { clientY: midOf(2) });
  check("行上没有出现「放入目标」的高亮", !readingRow.classList.contains("drop-target"));
  dragEvent(readingRow, "drop", dt6);
  await tick(20);
  check("收藏的归属没有被改动", itemProject("i2") === null && itemProject("i1") === "work", `${itemProject("i1")} / ${itemProject("i2")}`);
  dragEvent(readingRow, "dragend", dt6);

  console.log("\n── 回归：拖收藏卡片进项目仍然有效 ──");
  const dtCard = cardTransfer("i2");
  const workRow2 = rowOf("work");
  dragEvent(workRow2, "dragover", dtCard, { clientY: midOf(0) });
  check("卡片拖到项目行上会高亮", workRow2.classList.contains("drop-target"));
  dragEvent(workRow2, "drop", dtCard);
  await tick(20);
  check("放下后收藏进入该项目", itemProject("i2") === "work", String(itemProject("i2")));
  check("高亮已经清掉", !workRow2.classList.contains("drop-target"));

  console.log("\n── 从「⋯」按钮 / 改名输入框上按下，不该触发拖拽 ──");
  const dt7 = folderTransfer("work");
  const moreRow = rowOf("work");
  pointerdown(moreRow.querySelector(".project-more"));
  const moreEvent = dragEvent(moreRow, "dragstart", dt7, { clientX: 20, clientY: midOf(0) });
  check("从「⋯」上按下时拖拽被拦下", !moreRow.classList.contains("is-dragging") && !document.querySelector(".folder-drag-preview"));
  check("拦下时调用了 preventDefault", moreEvent.defaultPrevented);

  const nameRow = rowOf("design");
  dblclick(nameRow.querySelector(".project-nav"));
  await tick(10);
  const renameInput = document.querySelector("#projectList .project-rename");
  check("进入了改名状态", !!renameInput);
  pointerdown(renameInput);
  const renameDt = folderTransfer("design");
  dragEvent(nameRow, "dragstart", renameDt, { clientX: 20, clientY: midOf(1) });
  check("改名输入框上按下时不会拖拽", !document.querySelector(".project-row.is-dragging"));
  check("改名输入框还在（没被拖拽打断）", !!document.querySelector("#projectList .project-rename"));
  renameInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(10);

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现任何未捕获的错误", errors.length === 0, errors.join(" | "));
  check("全程没有调用浏览器自带的弹窗", nativeDialogs.length === 0, nativeDialogs.join(" | "));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
