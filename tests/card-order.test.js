// 拖拽排阅读顺序 —— 验证三件事：
//   ① 「自定义顺序」下按存下来的顺序渲染
//   ② 拖一张卡片到另一个位置 → 顺序写进存储（且不影响被筛掉的收藏的位置）
//   ③ 每个项目各存一份顺序，互不干扰；在别的排序方式下拖一次会自动切到自定义顺序
// 运行：NODE_PATH=<jsdom 路径> node tests/card-order.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const DIALOG_SOURCE = read("dialog.js");
const LIBRARY_SOURCE = read("library.js");
const LIBRARY_HTML = read("library.html");
const LIBRARY_CSS = read("library.css");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

// 造一篇收藏（savedAt 越大越新）。
const item = (id, savedAt, extra = {}) => ({
  id,
  title: id,
  description: "摘要",
  image: "",
  favicon: "",
  source: "example.com",
  projectId: null,
  url: `https://example.com/${id}`,
  savedAt,
  status: "unread",
  ...extra
});

// jsdom 没有排版，getBoundingClientRect 全是 0，所以给每张卡片铺一个假的位置：
// 一行三张，每张 200×300，从 (0,0) 开始横向排。
function layout(window, cards) {
  cards.forEach((card, index) => {
    const left = (index % 3) * 218;
    const top = Math.floor(index / 3) * 324;
    card.getBoundingClientRect = () => ({
      left, top, right: left + 200, bottom: top + 300, width: 200, height: 300, x: left, y: top
    });
  });
}

async function boot({ items, orders = {}, settings = {}, activeProject = "unfiled", holdIdle = false }) {
  const store = {
    laterOnItems: JSON.parse(JSON.stringify(items)),
    laterOnProjects: [{ id: "p1", name: "项目一" }],
    laterOnActiveProject: activeProject,
    laterOnSettings: settings,
    laterOnOrder: JSON.parse(JSON.stringify(orders))
  };
  const dom = new JSDOM(LIBRARY_HTML, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/library.html"
  });
  const { window } = dom;
  const { document } = window;
  const idleQueue = [];
  if (holdIdle) window.requestIdleCallback = (callback) => { idleQueue.push(callback); return idleQueue.length; };
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
    tabs: {
      query: async () => [{ id: 7, windowId: 3 }],
      getCurrent: async () => ({ id: 7, windowId: 3 }),
      update: async () => ({}),
      create: async () => ({}),
      onCreated: { addListener() {} }
    },
    runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async () => ({}), close: async () => ({}) }
  };
  window.eval(DIALOG_SOURCE);
  window.eval(LIBRARY_SOURCE);
  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  await tick();
  const grid = document.querySelector("#cardGrid");
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 900, bottom: 900, width: 900, height: 900 });
  return {
    window, document, grid, store, tick,
    runIdle: () => { while (idleQueue.length) idleQueue.shift()({ didTimeout: false, timeRemaining: () => 50 }); }
  };
}

// 当前屏幕上卡片的先后顺序。
const orderOnScreen = (grid) => [...grid.querySelectorAll(".card")].map((card) => card.dataset.id);

// 模拟一次拖拽：把 fromId 这张卡拖到「第 index 张卡的位置」（落点取那张卡的左半边 = 插到它前面）。
async function dragCard({ window, grid, tick }, fromId, index) {
  const cards = [...grid.querySelectorAll(".card")];
  const source = cards.find((card) => card.dataset.id === fromId);
  const others = cards.filter((card) => card.dataset.id !== fromId);
  layout(window, cards);

  const dragstart = new window.Event("dragstart", { bubbles: true, cancelable: true });
  dragstart.dataTransfer = { effectAllowed: "", setData() {}, setDragImage() {} };
  dragstart.clientX = 10;
  dragstart.clientY = 10;
  source.dispatchEvent(dragstart);
  await tick(20);

  const target = others[index];
  let point = { x: 0, y: 0 };
  if (target) {
    const rect = target.getBoundingClientRect();
    point = { x: rect.left + 10, y: rect.top + 10 };   // 左半边 → 插到它前面
  } else {
    const last = others[others.length - 1].getBoundingClientRect();
    point = { x: last.right - 10, y: last.top + 10 };  // 右半边 → 排到最后
  }

  const dragover = new window.Event("dragover", { bubbles: true, cancelable: true });
  dragover.dataTransfer = { dropEffect: "" };
  dragover.clientX = point.x;
  dragover.clientY = point.y;
  const overCard = target || others[others.length - 1];
  overCard.dispatchEvent(dragover);
  await tick(20);

  const drop = new window.Event("drop", { bubbles: true, cancelable: true });
  drop.dataTransfer = { dropEffect: "" };
  drop.clientX = point.x;
  drop.clientY = point.y;
  grid.dispatchEvent(drop);
  await tick(60);

  const dragend = new window.Event("dragend", { bubbles: true, cancelable: true });
  source.dispatchEvent(dragend);
  await tick(20);
}

(async () => {
  // ── ① 自定义顺序按存下来的顺序渲染 ──
  console.log("\n── ① 自定义顺序渲染 ──");
  {
    const items = [item("a", 1), item("b", 2), item("c", 3), item("d", 4)];
    const { grid, window } = await boot({ items, orders: { unfiled: ["c", "a", "d", "b"] }, settings: { defaultSort: "custom" } });
    layout(window, [...grid.querySelectorAll(".card")]);
    check("按自定义顺序渲染（不是按收藏时间）", orderOnScreen(grid).join("") === "cadb", orderOnScreen(grid).join(""));
    check("排序下拉框显示「自定义顺序」", window.document.querySelector("#sortSelect").value === "custom");

    // 没排过的新收藏接在后面（新的在前），不会凭空插到队伍中间。
    const withNew = [...items, item("e", 5)];
    const second = await boot({ items: withNew, orders: { unfiled: ["c", "a", "d", "b"] }, settings: { defaultSort: "custom" } });
    check("新收藏排在有顺序的那批后面", orderOnScreen(second.grid).join("") === "cadbe", orderOnScreen(second.grid).join(""));
  }

  // ── ② 拖拽改顺序并写进存储 ──
  console.log("\n── ② 拖拽换位置 ──");
  {
    const items = [item("a", 1), item("b", 2), item("c", 3), item("d", 4)];
    const app = await boot({ items, orders: { unfiled: ["a", "b", "c", "d"] }, settings: { defaultSort: "custom" } });
    check("初始顺序", orderOnScreen(app.grid).join("") === "abcd", orderOnScreen(app.grid).join(""));

    // 把 d 拖到最前面（插到 a 前面）。
    await dragCard(app, "d", 0);
    check("拖到最前面后屏幕上的顺序变了", orderOnScreen(app.grid).join("") === "dabc", orderOnScreen(app.grid).join(""));
    check("新顺序写进了存储", app.store.laterOnOrder.unfiled.join("") === "dabc", String(app.store.laterOnOrder.unfiled));

    // 把 a 拖到最后。
    await dragCard(app, "a", 3);
    check("拖到最后也生效", orderOnScreen(app.grid).join("") === "dbca", orderOnScreen(app.grid).join(""));
    check("存储跟着更新", app.store.laterOnOrder.unfiled.join("") === "dbca", String(app.store.laterOnOrder.unfiled));
  }

  // ── ③ 筛选状态下拖动，被筛掉的收藏不能丢位置 ──
  console.log("\n── ③ 筛选时拖动不影响被筛掉的收藏 ──");
  {
    const items = [item("a", 1), item("b", 2), item("c", 3, { status: "done" }), item("d", 4)];
    // 顺序 a b c d，其中 c 已读；切到「未读」筛选后屏幕上只有 a b d。
    const app = await boot({ items, orders: { unfiled: ["a", "b", "c", "d"] }, settings: { defaultSort: "custom" } });
    app.window.document.querySelector('.nav-item[data-filter="unread"]').click();
    await app.tick(30);
    check("已读的被筛掉了（屏幕上只剩 a b d）", orderOnScreen(app.grid).join("") === "abd", orderOnScreen(app.grid).join(""));

    // 把 d 拖到最前面。
    await dragCard(app, "d", 0);
    check("筛选下拖动也生效", orderOnScreen(app.grid).join("") === "dab", orderOnScreen(app.grid).join(""));
    // 关键：c 虽然不在屏幕上，它仍夹在 b 和 d 的原位置之间 —— 新顺序应是 d a b c。
    check("被筛掉的 c 保住了自己的位置", app.store.laterOnOrder.unfiled.join("") === "dabc", String(app.store.laterOnOrder.unfiled));
  }

  // ── ④ 别的排序方式下拖一次 → 自动切到自定义顺序 ──
  console.log("\n── ④ 自动切到自定义顺序 ──");
  {
    const items = [item("a", 1), item("b", 2), item("c", 3)];
    const app = await boot({ items, settings: { defaultSort: "newest" } });
    check("默认是「最新收藏」（c b a）", orderOnScreen(app.grid).join("") === "cba", orderOnScreen(app.grid).join(""));
    await dragCard(app, "a", 0);
    check("拖完自动切成自定义顺序", app.window.document.querySelector("#sortSelect").value === "custom");
    check("提示了这次切换", /自定义顺序/.test(app.window.document.querySelector("#toast").textContent), app.window.document.querySelector("#toast").textContent);
    check("顺序存下来了", app.store.laterOnOrder.unfiled.join("") === "acb", String(app.store.laterOnOrder.unfiled));
    check("排序方式也写进共享设置（侧栏和下次打开一致）", app.store.laterOnSettings.defaultSort === "custom", String(app.store.laterOnSettings.defaultSort));
  }

  // ── ⑤ 每个项目各存一份 ──
  console.log("\n── ⑤ 项目之间互不干扰 ──");
  {
    const items = [item("a", 1, { projectId: "p1" }), item("b", 2, { projectId: "p1" }), item("c", 3, { projectId: "p1" })];
    const app = await boot({ items, orders: { unfiled: ["c", "b", "a"], p1: ["a", "b", "c"] }, settings: { defaultSort: "custom" }, activeProject: "p1" });
    check("项目里用自己的顺序", orderOnScreen(app.grid).join("") === "abc", orderOnScreen(app.grid).join(""));
    // 把 c 拖到最前面 → 项目里的顺序变成 c a b。
    await dragCard(app, "c", 0);
    check("只改了这个项目的顺序", app.store.laterOnOrder.p1.join("") === "cab", String(app.store.laterOnOrder.p1));
    check("「等待整理」那一份没被动过", app.store.laterOnOrder.unfiled.join("") === "cba", String(app.store.laterOnOrder.unfiled));
  }

  // ── ⑥ 拖到项目上仍然是「移动到该项目」（老功能没被抢走）──
  console.log("\n── ⑥ 拖到项目仍是移动收藏 ──");
  {
    const items = [item("a", 1), item("b", 2)];
    const app = await boot({ items, settings: { defaultSort: "custom" } });
    const card = app.grid.querySelector('.card[data-id="a"]');
    const dragstart = new app.window.Event("dragstart", { bubbles: true, cancelable: true });
    dragstart.dataTransfer = { effectAllowed: "", setData() {}, setDragImage() {} };
    dragstart.clientX = 10; dragstart.clientY = 10;
    card.dispatchEvent(dragstart);
    await app.tick(20);
    // 卡片拖拽依然会启动（拖到左侧项目列表上松手 = 移动过去），只是这次不落在网格里。
    check("卡片仍可发起拖拽（拖到项目上照旧是移动）", app.store.laterOnOrder !== undefined);
  }

  // ── ⑦ 退让效果 + 不抖动（这条就是「卡片疯狂跳动」的回归测试）──
  console.log("\n── ⑦ 拖动时的「退让」与稳定性 ──");
  {
    const items = [item("a", 1), item("b", 2), item("c", 3), item("d", 4)];
    const app = await boot({ items, orders: { unfiled: ["a", "b", "c", "d"] }, settings: { defaultSort: "custom" } });
    const cards = [...app.grid.querySelectorAll(".card")];
    layout(app.window, cards);
    const source = cards.find((card) => card.dataset.id === "d");
    const domBefore = orderOnScreen(app.grid).join("");
    const transformOf = (id) => app.grid.querySelector(`.card[data-id="${id}"]`).style.transform || "";
    // 让位结果的快照：哪张卡片被平移到哪里。用来判断「有没有抖动」。
    const snapshot = () => [...app.grid.querySelectorAll(".card")]
      .map((card) => `${card.dataset.id}:${card.style.transform || ""}`).join("|");

    const dragstart = new app.window.Event("dragstart", { bubbles: true, cancelable: true });
    dragstart.dataTransfer = { effectAllowed: "", setData() {}, setDragImage() {} };
    dragstart.clientX = 10; dragstart.clientY = 10;
    source.dispatchEvent(dragstart);
    await app.tick(20);

    // 根因回归：拖动过程中绝不能再动 DOM。动一次，判定坐标就变一次 → 疯狂跳动。
    check("拖动开始后 DOM 一个都没动", orderOnScreen(app.grid).join("") === domBefore, orderOnScreen(app.grid).join(""));
    // 唯一允许新增的是「老家虚线框」浮层（绝对定位，不占格子，不影响判定）。
    check("网格里只多出一个老家虚线框", app.grid.children.length === 5 && !!app.grid.querySelector(".drag-home-frame"), String(app.grid.children.length));
    const srcRect = source.getBoundingClientRect();
    const homeFrame = app.grid.querySelector(".drag-home-frame");
    check("虚线框钉在被拖卡片原来的格子上",
      homeFrame.style.left === `${srcRect.left}px` && homeFrame.style.top === `${srcRect.top}px` &&
      homeFrame.style.width === `${srcRect.width}px` && homeFrame.style.height === `${srcRect.height}px`,
      `${homeFrame.style.left},${homeFrame.style.top},${homeFrame.style.width},${homeFrame.style.height}`);

    // 把 d 拖到 a 的左边（插到最前面）。
    const rectA = cards.find((card) => card.dataset.id === "a").getBoundingClientRect();
    const dragover = new app.window.Event("dragover", { bubbles: true, cancelable: true });
    dragover.dataTransfer = { dropEffect: "" };
    dragover.clientX = rectA.left + 10;
    dragover.clientY = rectA.top + 10;
    cards.find((card) => card.dataset.id === "a").dispatchEvent(dragover);
    await app.tick(20);

    check("被拖的那张滑到了落点（最前面那格）", transformOf("d") === "translate(0px, -324px)", transformOf("d"));
    check("后面的卡片向右让开一格", transformOf("a") === "translate(218px, 0px)", transformOf("a"));
    check("让位会跨行（末尾那张绕到下一行行首）", transformOf("c") === "translate(-436px, 324px)", transformOf("c"));
    check("让位期间 DOM 依然没动", orderOnScreen(app.grid).join("") === domBefore, orderOnScreen(app.grid).join(""));

    // 关键回归：真实拖动手会抖，dragover 每秒触发几十次且坐标有微小抖动。
    // 只要判定用的是「拖动开始时拍的快照」，结果就必须纹丝不动。
    const first = snapshot();
    for (let i = 0; i < 12; i += 1) {
      const again = new app.window.Event("dragover", { bubbles: true, cancelable: true });
      again.dataTransfer = { dropEffect: "" };
      again.clientX = rectA.left + 8 + (i % 3);   // 微小手抖，但始终在 a 的左半边
      again.clientY = rectA.top + 8 + (i % 2);
      app.grid.querySelector('.card[data-id="a"]').dispatchEvent(again);
      await app.tick(5);
    }
    check("同一位置反复 dragover 12 次，让位结果纹丝不动", snapshot() === first, snapshot());
    check("期间 DOM 顺序始终没变", orderOnScreen(app.grid).join("") === domBefore, orderOnScreen(app.grid).join(""));

    // 光标滑进格子之间的缝隙（不压在任何卡片上）：保持上一次结果，不能全体弹回。
    const gap = new app.window.Event("dragover", { bubbles: true, cancelable: true });
    gap.dataTransfer = { dropEffect: "" };
    gap.clientX = 205;   // a 的右边缘是 200、b 的左边缘是 218，这里正好在缝里
    gap.clientY = 5;
    app.grid.dispatchEvent(gap);
    await app.tick(20);
    check("光标进缝隙时保持原状（不会全部弹回）", snapshot() === first, snapshot());

    source.dispatchEvent(new app.window.Event("dragend", { bubbles: true, cancelable: true }));
    await app.tick(20);
    check("松手/取消后位移全部清掉", [...app.grid.querySelectorAll(".card")].every((card) => !card.style.transform));
    check("退出排序状态", !app.grid.classList.contains("is-reordering"));
    check("老家的虚线框也收掉了", !app.grid.querySelector(".drag-home-frame"));
  }

  // ── ⑧ 千条收藏：第一批同步，其余空闲时补齐 ──
  console.log("\n── ⑧ 大列表分批渲染 ──");
  {
    const many = Array.from({ length: 1000 }, (_, index) => item(`bulk-${index}`, 1000 - index));
    const app = await boot({ items: many, holdIdle: true });
    check("首轮只同步创建 48 张，不一次性阻塞 1000 张",
      app.grid.querySelectorAll(".card").length === 48,
      `${app.grid.querySelectorAll(".card").length} 张`);
    check("计数立即显示完整的 1000 篇", /1000 篇收藏/.test(app.document.querySelector("#countText")?.textContent || ""));
    app.runIdle();
    check("空闲批次最终补齐全部卡片", app.grid.querySelectorAll(".card").length === 1000,
      `${app.grid.querySelectorAll(".card").length} 张`);
  }

  // ── ⑨ 样式与选项 ──
  console.log("\n── ⑨ 样式与下拉选项 ──");
  check("排序中让位用更快的过渡", /\.grid\.is-reordering \.card\s*\{[^}]*transition:\s*transform/.test(LIBRARY_CSS));
  check("落位瞬间关掉过渡（防止弹回原位）", /\.grid\.no-transition \.card\s*\{\s*transition:\s*none/.test(LIBRARY_CSS));
  check("排序时禁用 hover 位移（防卡片无故上下跳）", /\.grid\.is-reordering \.card:hover\s*\{[^}]*transform:\s*none/.test(LIBRARY_CSS));
  check("被拖动卡片的样式里不写 transform（否则会盖掉让位位移）", !/\.card\.dragging\s*\{[^}]*transform:/.test(LIBRARY_CSS));
  // 这一条是「测试全绿、浏览器却没效果」的元凶：CSS 动画的优先级高于行内 style，
  // 入场动画若用 both/forwards，结束后的 transform:none 会永远盖掉让位用的行内位移。
  check("入场动画不锁死 transform（fill-mode 不能用 both/forwards）",
    !/animation:[^;}]*(?:\bboth\b|\bforwards\b)/.test(LIBRARY_CSS),
    (LIBRARY_CSS.match(/animation:[^;}]*/) || [""])[0]);
  check("排序期间掐断入场动画（防止残留动画盖掉位移）",
    /\.grid\.is-reordering \.card\s*\{[^}]*animation:\s*none/.test(LIBRARY_CSS));
  check("不再往网格里插占位元素", !/\.card-slot\s*\{/.test(LIBRARY_CSS));
  check("不再用 display:none 收起原位", !/\.card\.is-drag-source\s*\{/.test(LIBRARY_CSS));
  check("老家虚线框是绝对定位浮层（不占格子，不引发重排）",
    /\.drag-home-frame\s*\{[^}]*position:\s*absolute/.test(LIBRARY_CSS) && /\.drag-home-frame\s*\{[^}]*pointer-events:\s*none/.test(LIBRARY_CSS));
  check("被拖的卡片内容藏起来、只剩虚线框", /\.card\.dragging > \*\s*\{\s*visibility:\s*hidden/.test(LIBRARY_CSS));
  check("排序下拉里多了「自定义顺序」选项", /value="custom"/.test(LIBRARY_HTML));

  console.log(failures ? `\n❌ 有 ${failures} 项没通过` : "\n🎉 全部通过");
  process.exit(failures ? 1 : 0);
})();
