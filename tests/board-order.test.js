// 图板拖拽排序 —— 和「拖卡片换阅读顺序」同一套逻辑，这里验证：
//   ① 拖动中不动 DOM，只靠 transform 让位；原位留虚线框，被拖的那块藏起来（不留重影）
//   ② 松手后顺序写回：项目顺序进 PROJECTS_KEY（侧栏项目列表同步跟着变）
//   ③ 重新打开还在那个顺序；取消（dragend 没 drop）什么都不改；
//      从改简介的铅笔上按下不会触发拖拽
// 注：图板上只有项目，「等待整理」不占一块，所以顺序就是项目的顺序。
// 运行：NODE_PATH=<jsdom 路径> node tests/board-order.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
const css = fs.readFileSync(`${ROOT}/library.css`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

const now = Date.now();
const item = (id, extra) => ({
  id, title: `标题 ${id}`, description: "摘要", image: "", favicon: "",
  source: "未知", url: `https://example.com/${id}`, savedAt: now, status: "unread", ...extra
});

function makeStore() {
  return {
    laterOnItems: [
      item("w1", { projectId: "work" }),
      item("r1", { projectId: "read" }),
      item("m1", { projectId: "movie" }),
      item("u1", { projectId: null })
    ],
    laterOnProjects: [
      { id: "work", name: "工作", createdAt: 1 },
      { id: "read", name: "阅读", createdAt: 2 },
      { id: "movie", name: "观影", createdAt: 3 }
    ],
    laterOnActiveProject: "all",
    laterOnSettings: { libraryView: "boards" },
    laterOnOrder: { all: ["w1", "r1", "m1", "u1"] }
  };
}

async function boot(store) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/library.html"
  });
  const { window } = dom;
  const { document } = window;
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) out[key] = JSON.parse(JSON.stringify(store[key] ?? null));
          return out;
        },
        set: async (patch) => {
          for (const [key, value] of Object.entries(patch)) store[key] = JSON.parse(JSON.stringify(value));
        }
      },
      onChanged: { addListener() {} }
    },
    tabs: { query: async () => [{ id: 7, windowId: 3 }], create: async () => ({}) },
    runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async () => ({}), close: async () => ({}) }
  };
  window.eval(dialogSource);
  window.eval(librarySource);
  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  await tick();
  const board = document.querySelector("#boardGrid");
  board.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 });
  // 全部项目默认就是图板视图，无需手动切换（点击项目图板即进入卡片列表）。
  await tick(30);
  return { window, document, board, store, tick };
}

// jsdom 没有排版，给每块图板铺一个假位置：一行三块，每块 260×300。
function layout(cards) {
  cards.forEach((card, index) => {
    const left = (index % 3) * 280;
    const top = Math.floor(index / 3) * 320;
    card.getBoundingClientRect = () => ({
      left, top, right: left + 260, bottom: top + 300, width: 260, height: 300, x: left, y: top
    });
  });
}

const boardIds = (board) => [...board.querySelectorAll(".board-card")].map((card) => card.dataset.project);
const boardOf = (board, id) => board.querySelector(`.board-card[data-project="${id}"]`);

// 按住某一块图板开始拖（还没松手）。index 是「要插到不含它自己的第几块前面」。
async function startDrag(app, fromId, index) {
  const cards = [...app.board.querySelectorAll(".board-card")];
  layout(cards);
  const source = cards.find((card) => card.dataset.project === fromId);
  const others = cards.filter((card) => card.dataset.project !== fromId);

  const dragstart = new app.window.Event("dragstart", { bubbles: true, cancelable: true });
  dragstart.dataTransfer = { effectAllowed: "", setData() {}, setDragImage() {} };
  dragstart.clientX = 10;
  dragstart.clientY = 10;
  source.dispatchEvent(dragstart);
  await app.tick(20);

  const target = others[index];
  const rect = target
    ? target.getBoundingClientRect()
    : others[others.length - 1].getBoundingClientRect();
  // 落在左半边 = 插到它前面；没指定目标时落在最后一块的右半边 = 排到最后。
  const point = target
    ? { x: rect.left + 10, y: rect.top + 10 }
    : { x: rect.right - 10, y: rect.top + 10 };
  const dragover = new app.window.Event("dragover", { bubbles: true, cancelable: true });
  dragover.dataTransfer = {};
  dragover.clientX = point.x;
  dragover.clientY = point.y;
  (target || others[others.length - 1]).dispatchEvent(dragover);
  await app.tick(20);
  return { source, point, cards };
}

async function dropDrag(app, point) {
  const drop = new app.window.Event("drop", { bubbles: true, cancelable: true });
  drop.dataTransfer = {};
  drop.clientX = point.x;
  drop.clientY = point.y;
  app.board.dispatchEvent(drop);
  await app.tick(60);
}

(async () => {
  console.log("\n── ① 拖动中：DOM 不动，只让位 ──");
  const store = makeStore();
  const app = await boot(store);
  // 4 篇收藏里 u1 没归项目（等待整理），图板上不占一块 → 3 个项目 3 块图板
  check("三块图板：工作 / 阅读 / 观影（等待整理不占块）", boardIds(app.board).join(",") === "work,read,movie", boardIds(app.board).join(","));

  const dragging = await startDrag(app, "movie", 0);
  check("被拖的那块加上了 .dragging", boardOf(app.board, "movie").classList.contains("dragging"));
  check("原位留了虚线框（绝对定位，不占格子）", !!app.board.querySelector(".drag-home-frame"));
  check("拖动期间 DOM 顺序没变", boardIds(app.board).join(",") === "work,read,movie", boardIds(app.board).join(","));
  const shifts = [...app.board.querySelectorAll(".board-card")]
    .map((card) => `${card.dataset.project}:${card.style.transform}`).join(" | ");
  check("其它图板让开一格", boardOf(app.board, "work").style.transform === "translate(280px, 0px)", shifts);
  check("被拖的那块滑到落点", boardOf(app.board, "movie").style.transform === "translate(-560px, 0px)", shifts);

  console.log("\n── ② 松手：顺序写进存储，侧栏同步 ──");
  await dropDrag(app, dragging.point);
  check("图板的顺序变了", boardIds(app.board).join(",") === "movie,work,read", boardIds(app.board).join(","));
  check("项目顺序写进了 PROJECTS_KEY", store.laterOnProjects.map((p) => p.id).join(",") === "movie,work,read", store.laterOnProjects.map((p) => p.id).join(","));
  const sidebar = [...app.document.querySelectorAll("#projectList .project-row")].map((row) => row.dataset.id).join(",");
  check("侧栏项目列表跟着换了顺序", sidebar === "movie,work,read", sidebar);
  check("收藏本身的阅读顺序没被碰", store.laterOnOrder.all.join(",") === "w1,r1,m1,u1", String(store.laterOnOrder.all));

  console.log("\n── ③ 重新打开还在那个顺序 ──");
  const reopened = await boot(store);
  check("按存下来的顺序渲染", boardIds(reopened.board).join(",") === "movie,work,read", boardIds(reopened.board).join(","));

  console.log("\n── ④ 取消拖拽什么都不改 ──");
  const before = store.laterOnProjects.map((p) => p.id).join(",");
  const cancelled = await startDrag(reopened, "movie", 2);
  const dragend = new reopened.window.Event("dragend", { bubbles: true, cancelable: true });
  cancelled.source.dispatchEvent(dragend);
  await reopened.tick(20);
  check("顺序没变", store.laterOnProjects.map((p) => p.id).join(",") === before, store.laterOnProjects.map((p) => p.id).join(","));
  check("让位的位移全部清掉", [...reopened.board.querySelectorAll(".board-card")].every((card) => !card.style.transform));
  check("退出了排序状态", !reopened.board.classList.contains("is-reordering"));
  check("虚线框收掉了", !reopened.board.querySelector(".drag-home-frame"));

  console.log("\n── ⑤ 从改简介的铅笔上按下不会拖起来 ──");
  const pencil = boardOf(reopened.board, "work").querySelector(".board-edit");
  const onPencil = new reopened.window.Event("dragstart", { bubbles: true, cancelable: true });
  onPencil.dataTransfer = { effectAllowed: "", setData() {}, setDragImage() {} };
  pencil.dispatchEvent(onPencil);
  await reopened.tick(20);
  check("按在铅笔上 → 拖拽被拦下", onPencil.defaultPrevented);
  check("没有进入拖动状态", !reopened.board.classList.contains("is-reordering"));

  console.log("\n── ⑥ 样式上不留重影（静态断言）──");
  check(
    "被拖的那块是「藏内容」而不是「压半透明」",
    /\.board-card\.dragging > \* \{ visibility: hidden; \}/.test(css) && !/\.board-card\.dragging \{[^}]*opacity/.test(css)
  );
  check("图板容器是定位参照（虚线框要定位）", /\.board-grid \{[^}]*position: relative/.test(css));
  check("拖动中掐断入场动画（否则会盖掉行内 transform）", /\.board-grid\.is-reordering \.board-card \{[^}]*animation: none/.test(css));

  console.log(failures ? `\n有 ${failures} 项失败` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
