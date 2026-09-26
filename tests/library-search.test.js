// 右上角搜索框：永远是「全局搜索」——在全部收藏里找，不受当前所在项目 / 视图限制。
// 覆盖：
//  1) 在某个项目里搜索，能搜到别的项目里的文章（以前只会在这个项目里找，等于白搜）
//  2) 在「全部项目」（图板视图）里搜索，直接铺出命中的文章卡片，而不是去筛类目
//  3) 顶部计数写明是在「全部收藏」里找的、命中几篇
//  4) 「未读 / 已读」那一档仍然生效
//  5) 清空搜索后回到原来的视图（图板 / 项目卡片）
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

// ── 假数据：三篇带「深度」的文章散在三个不同的归属里（项目 / 另一个项目 / 待整理），
//    外加一篇已读的，用来验证「未读 / 已读」筛选还照常起作用。 ──
const now = Date.now();
const item = (id, extra) => ({
  id, title: `标题 ${id}`, description: "摘要", image: "", favicon: "",
  source: "未知", url: `https://example.com/${id}`, savedAt: now, read: false, ...extra
});
const store = {
  laterOnItems: [
    item("a1", { title: "Alpha 深度工作法", projectId: "work" }),
    item("a2", { title: "Beta 不相干", projectId: "work", savedAt: now - 1000 }),
    item("b1", { title: "Gamma 深度工作笔记", projectId: "read", savedAt: now - 2000 }),
    item("u1", { title: "Delta 有深度的思考", projectId: null, savedAt: now - 3000 }),
    item("d1", { title: "Epsilon 深度已完成", projectId: "read", savedAt: now - 4000, status: "done", read: true })
  ],
  laterOnProjects: [
    { id: "work", name: "工作", createdAt: 1 },
    { id: "read", name: "阅读", createdAt: 2 }
  ],
  laterOnActiveProject: "all",
  laterOnSettings: {},
  laterOnFilter: "all"
};

const changeListeners = [];
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
    getCurrent: () => Promise.resolve({ id: 1, windowId: 7, active: true }),
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true }]),
    update: () => Promise.resolve({ id: 1 }),
    create: () => Promise.resolve({ id: 9 })
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  sidePanel: { open: () => Promise.resolve() },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: () => Promise.resolve({ ready: true }),
    onMessage: { addListener() {} }
  }
};

if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", { configurable: true, value: { randomUUID: () => `fake-${Math.random().toString(36).slice(2)}` } });
}
// jsdom 不实现 window.scrollTo，会往 virtualConsole 里塞「Not implemented」错误。
window.scrollTo = () => {};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

const searchBox = () => document.querySelector("#searchInput");
const cardIds = () => [...document.querySelectorAll("#cardGrid .card")].map((card) => card.dataset.id).sort();
const boardIds = () => [...document.querySelectorAll("#boardGrid .board-card")].map((card) => card.dataset.project).sort();
const countText = () => document.querySelector("#countText").textContent;

// 输入搜索词：走真实路径（input 事件 + 120ms 防抖）。
async function search(word) {
  searchBox().value = word;
  searchBox().dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(180);
}

(async () => {
  window.eval(librarySource);
  await tick(60);

  console.log("── 起点：在「全部项目」图板视图里 ──");
  check("默认是图板视图，两个类目", boardIds().join(",") === "read,work", boardIds().join(","));
  check("顶部计数是图板的说法", /2 个类目 · 共 4 篇收藏 · 3 篇还没读完 · 1 篇待整理/.test(countText()), countText());

  console.log("\n── 在「全部项目」里搜索：直接铺文章卡片，不筛类目 ──");
  await search("深度");
  check("视图从图板切成卡片列表", document.querySelector("#boardGrid").hidden === true && document.querySelector("#cardGrid").hidden === false);
  check("命中全部含「深度」的文章（跨项目，4 篇）", cardIds().join(",") === "a1,b1,d1,u1", cardIds().join(","));
  check("计数写明是在全部收藏里找的", /在全部收藏里找到 4 篇 · 3 篇还没读完/.test(countText()), countText());
  check("排序下拉在搜索时可用（卡片视图）", document.querySelector("#sortSelect").hidden === false);

  console.log("\n── 「未读 / 已读」那一档仍然生效 ──");
  click(document.querySelector('.nav-item[data-filter="done"]'));
  await tick(30);
  check("只看已读时，命中里只剩那篇已完成的", cardIds().join(",") === "d1", cardIds().join(","));
  check("计数跟着变", /在全部收藏里找到 1 篇 · 0 篇还没读完/.test(countText()), countText());
  click(document.querySelector('.nav-item[data-filter="all"]'));
  await tick(30);

  console.log("\n── 清空搜索：回到图板 ──");
  await search("");
  check("又是图板视图", boardIds().join(",") === "read,work" && document.querySelector("#boardGrid").hidden === false);
  check("计数回到图板说法", /2 个类目 · 共 4 篇收藏 · 3 篇还没读完 · 1 篇待整理/.test(countText()), countText());

  console.log("\n── 钻进「阅读」项目里搜索：照样能搜到别的项目 / 待整理里的文章 ──");
  click(document.querySelector('#projectList .project-nav[data-project="read"]'));
  await tick(30);
  check("（准备）人在「阅读」里，只看得见这个项目的 2 篇", cardIds().join(",") === "b1,d1", cardIds().join(","));
  await search("深度");
  check("搜到了「工作」项目和「待整理」里的文章（以前搜不到）", cardIds().join(",") === "a1,b1,d1,u1", cardIds().join(","));
  check("顶栏会写明这是全局结果", /在全部收藏里找到 4 篇/.test(countText()), countText());
  check("侧栏仍然高亮着「阅读」（搜索不会把人从项目里踢出去）",
    document.querySelector('#projectList .project-nav[data-project="read"]').classList.contains("active"));

  console.log("\n── 清空搜索：回到刚才那个项目（不是跳回全部） ──");
  await search("");
  check("回到「阅读」项目的卡片列表", cardIds().join(",") === "b1,d1", cardIds().join(","));
  check("计数回到项目的说法", /2 篇收藏 · 1 篇还没读完/.test(countText()), countText());
  check("侧栏还在「阅读」上", store.laterOnActiveProject === "read", String(store.laterOnActiveProject));

  console.log("\n── 在「待整理」里搜索也一样 ──");
  click(document.querySelector('.project-nav[data-project="unfiled"]'));
  await tick(30);
  check("（准备）待整理里只有 1 篇", cardIds().join(",") === "u1", cardIds().join(","));
  await search("深度");
  check("同样搜出全部 4 篇", cardIds().join(",") === "a1,b1,d1,u1", cardIds().join(","));
  await search("");
  check("清空后回到待整理", cardIds().join(",") === "u1", cardIds().join(","));

  console.log("\n── 搜不到东西时 ──");
  await search("这个词肯定没有");
  check("卡片列表空，但没有把图板/项目结构弄乱", cardIds().length === 0);
  check("空状态提示还在（告诉你可以换关键词或切筛选）",
    document.querySelector("#emptyState").hidden === false && /没有找到匹配的收藏/.test(document.querySelector("#emptyState h2").textContent));
  check("计数如实报 0 篇", /在全部收藏里找到 0 篇/.test(countText()), countText());
  await search("");

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures ? `\n有 ${failures} 项失败` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
