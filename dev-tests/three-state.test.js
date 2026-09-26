// 三档阅读状态（未读 / 在读 / 已读）的核心行为测试。用 jsdom 加载真实的
// library.html + library.js，覆盖：
//  1) 旧收藏只有 read 布尔、没有 status：打开后自动归到「未读 / 已读」
//  2) 标记按钮（卡片底部的「标为已读 / 标为未读」）由用户手动点：点一下 = 标已读，再点 = 标未读
//  3) 「在读」的文章点标记按钮直接进入「已读」（点过没读完 ≠ 已读，只有手动标才算）
//  4) 筛选只有三个按钮：未读 / 已读 / 全部；其中「未读」= 还没读完（未读 + 在读）
// 不依赖真浏览器，命令行里即可反复跑。
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

const now = Date.now();
// 四篇：unread / reading / done 直接用 status，外加一篇只有旧的 read:true（测兼容）。
const store = {
  laterOnItems: [
    { id: "a", title: "A 未读", description: "da", image: "", favicon: "", source: "a.com", projectId: null, url: "https://a.com", savedAt: now, status: "unread" },
    { id: "b", title: "B 在读", description: "db", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com", savedAt: now, status: "reading" },
    { id: "c", title: "C 已读", description: "dc", image: "", favicon: "", source: "c.com", projectId: null, url: "https://c.com", savedAt: now, status: "done" },
    { id: "d", title: "D 旧数据", description: "dd", image: "", favicon: "", source: "d.com", projectId: null, url: "https://d.com", savedAt: now, read: true }
  ],
  laterOnProjects: [],
  laterOnActiveProject: "unfiled",
  laterOnSettings: {}
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
    sendMessage: () => Promise.resolve({ ready: true })
  }
};

if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", { configurable: true, value: { randomUUID: () => `fake-${Math.random().toString(36).slice(2)}` } });
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const cardOf = (id) => document.querySelector(`.card[data-id="${id}"]`);
const itemOf = (id) => store.laterOnItems.find((item) => item.id === id);
const toggleOf = (id) => cardOf(id)?.querySelector(".read-toggle");
const navOf = (filter) => document.querySelector(`.nav-item[data-filter="${filter}"]`);
const visibleCards = () => [...document.querySelectorAll("#cardGrid .card")];
const ids = () => visibleCards().map((c) => c.dataset.id);

window.eval(librarySource);

(async () => {
  await tick(40);

  console.log("── 第 1 步：旧数据兼容 + 三档初始状态 ──");
  check("未读卡片：既不是已读也不是在读", !cardOf("a").classList.contains("is-read") && !cardOf("a").classList.contains("is-reading"));
  check("在读卡片：带 is-reading", cardOf("b").classList.contains("is-reading") && !cardOf("b").classList.contains("is-read"));
  check("已读卡片：带 is-read", cardOf("c").classList.contains("is-read"));
  check("旧 read:true 数据：自动归为已读（is-read）", cardOf("d").classList.contains("is-read"));
  check("标记按钮文字：未读显示「标为已读」", toggleOf("a").textContent.trim() === "标为已读", JSON.stringify(toggleOf("a").textContent));
  check("标记按钮文字：已读显示「标为未读」", toggleOf("c").textContent.trim() === "标为未读", JSON.stringify(toggleOf("c").textContent));

  console.log("\n── 第 2 步：筛选只有三个按钮，且「未读」包含「在读」──");
  const filterOrder = [...document.querySelectorAll(".nav-item")].map((button) => button.textContent.trim()).join(" / ");
  check("筛选顺序是未读 / 已读 / 全部", filterOrder === "未读 / 已读 / 全部", filterOrder);
  click(navOf("all")); await tick(10);
  check("全部：四张都在", visibleCards().length === 4, `可见 ${ids()}`);
  click(navOf("unread")); await tick(10);
  check("未读：a（未读）+ b（在读）= 两张（点过没读完仍算未读）", visibleCards().length === 2 && ids().sort().join() === "a,b", `可见 ${ids()}`);
  click(navOf("done")); await tick(10);
  check("已读：c、d 两张", visibleCards().length === 2 && ids().sort().join() === "c,d", `可见 ${ids()}`);
  click(navOf("all")); await tick(10);

  console.log("\n── 第 3 步：手动点标记按钮 = 标已读，再点 = 标未读 ──");
  click(toggleOf("a")); await tick(20);
  check("未读 → 点一下 → 已读", itemOf("a").status === "done" && cardOf("a").classList.contains("is-read"), `status=${itemOf("a").status}`);
  check("标已读后 read 字段同步为 true（兼容旧字段）", itemOf("a").read === true);
  check("按钮文字翻成「标为未读」", toggleOf("a").textContent.trim() === "标为未读");
  click(toggleOf("a")); await tick(20);
  check("再点一下 → 回到未读", itemOf("a").status === "unread" && !cardOf("a").classList.contains("is-read"), `status=${itemOf("a").status}`);
  check("回到未读后 read 字段同步为 false", itemOf("a").read === false);

  console.log("\n── 第 4 步：在读的文章点标记 → 直接进已读，并从未读里挪走 ──");
  check("开始前 B 是在读", itemOf("b").status === "reading");
  click(toggleOf("b")); await tick(20);
  check("在读 → 手动标记 → 已读", itemOf("b").status === "done" && cardOf("b").classList.contains("is-read") && !cardOf("b").classList.contains("is-reading"), `status=${itemOf("b").status}`);
  click(navOf("unread")); await tick(10);
  check("标完后未读里只剩 a（B 已被挪到已读）", visibleCards().length === 1 && ids().join() === "a", `可见 ${ids()}`);
  click(navOf("done")); await tick(10);
  check("已读里现在有 b、c、d 三张", visibleCards().length === 3 && ids().sort().join() === "b,c,d", `可见 ${ids()}`);
  click(navOf("all")); await tick(10);

  console.log("\n── 第 5 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
