// 侧边栏的搜索框：和全屏页同一个规矩——永远是「全局搜索」。
// 侧栏上面有一排项目筛选，但搜索框里有字时不再受它限制：在「工作」里搜一个只存在于
// 「阅读」里的标题，也要找得到（否则用户会以为这篇收藏丢了）。
// 覆盖：
//  1) 只筛项目时，列表只显示这个项目的收藏（原行为不变）
//  2) 搜索时跨项目命中，不受当前项目筛选限制
//  3) 「未读 / 已读」那一档仍然生效
//  4) 清空搜索后回到当前项目的列表
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8");
const sidepanelSource = fs.readFileSync(`${ROOT}/sidepanel.js`, "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
virtualConsole.on("error", (message) => errors.push(String(message)));

const dom = new JSDOM(html, {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/sidepanel.html",
  virtualConsole
});
const { window } = dom;
const { document } = window;

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
  laterOnActiveProject: "work",
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
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

const ids = () => [...document.querySelectorAll("#items .item")].map((el) => el.dataset.id).sort();
const countText = () => document.querySelector("#itemCount").textContent;
const navOf = (filter) => document.querySelector(`.filter[data-filter="${filter}"]`);

// 输入搜索词：走真实路径（input 事件 + 120ms 防抖）。
async function search(word) {
  document.querySelector("#searchInput").value = word;
  document.querySelector("#searchInput").dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(180);
}

window.eval(sidepanelSource);

(async () => {
  await tick(60);

  console.log("── 起点：侧栏被筛到「工作」项目 ──");
  check("只显示「工作」里的 2 篇", ids().join(",") === "a1,a2", ids().join(","));
  check("篇数计数是 2 篇", countText() === "2 篇", countText());

  console.log("\n── 搜索：跨项目命中 ──");
  await search("深度");
  check("搜到了别的项目 / 未归项目里的文章（不再被项目筛选挡住）", ids().join(",") === "a1,b1,d1,u1", ids().join(","));
  check("篇数跟着更新", countText() === "4 篇", countText());

  console.log("\n── 「未读 / 已读」那一档仍然生效 ──");
  click(navOf("done"));
  await tick(20);
  check("只看已读时，命中里只剩那篇已完成的", ids().join(",") === "d1", ids().join(","));
  click(navOf("all"));
  await tick(20);
  check("切回全部又恢复 4 篇", ids().join(",") === "a1,b1,d1,u1", ids().join(","));

  console.log("\n── 清空搜索：回到「工作」项目 ──");
  await search("");
  check("回到这个项目的 2 篇", ids().join(",") === "a1,a2", ids().join(","));
  check("篇数回到 2 篇", countText() === "2 篇", countText());

  console.log("\n── 搜不到东西时 ──");
  await search("这个词肯定没有");
  check("列表空", ids().length === 0, ids().join(","));
  check("篇数如实报 0 篇", countText() === "0 篇", countText());
  await search("");

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures ? `\n有 ${failures} 项失败` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
