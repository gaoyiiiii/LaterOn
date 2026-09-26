// 侧边栏（sidepanel）的三档阅读状态行为测试。用 jsdom 加载真实的
// sidepanel.html + sidepanel.js，覆盖：
//  1) 旧 read 布尔自动归到「未读 / 已读」
//  2) 左下角「标为已读 / 标为未读」按钮由用户手动点：点一下 = 标已读（is-on），再点 = 标未读
//     （和全屏界面同款文字按钮，文字跟着状态翻）
//  3) 点开未读文章自动标记为「在读」而非「已读」
//  4) 筛选只有三个按钮：未读 / 已读 / 全部；「未读」= 还没读完（未读 + 在读）
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
const store = {
  laterOnItems: [
    { id: "a", title: "A 未读", description: "da", image: "", favicon: "", source: "a.com", projectId: null, url: "https://a.com", savedAt: now, status: "unread" },
    { id: "b", title: "B 在读", description: "db", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com", savedAt: now, status: "reading" },
    { id: "c", title: "C 已读", description: "dc", image: "", favicon: "", source: "c.com", projectId: null, url: "https://c.com", savedAt: now, read: true },
    { id: "d", title: "D 旧数据", description: "dd", image: "", favicon: "", source: "d.com", projectId: null, url: "https://d.com", savedAt: now, read: true }
  ],
  laterOnProjects: [],
  laterOnActiveProject: "all",
  laterOnSettings: {}
};

const changeListeners = [];
const updatedTabs = [];
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
    query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "https://current.com" }]),
    update: (id, options) => { updatedTabs.push({ id, ...options }); return Promise.resolve({ id }); },
    onActivated: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: () => Promise.resolve({ ok: false }),
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
const itemOf = (id) => document.querySelector(`.item[data-id="${id}"]`);
const storeItem = (id) => store.laterOnItems.find((item) => item.id === id);
const toggleOf = (id) => itemOf(id)?.querySelector(".read-toggle");
const navOf = (filter) => document.querySelector(`.filter[data-filter="${filter}"]`);
const visibleItems = () => [...document.querySelectorAll("#items .item")];
const ids = () => visibleItems().map((i) => i.dataset.id);

window.eval(sidepanelSource);

(async () => {
  await tick(50);

  check("首次打开默认高亮「未读」", document.querySelector(".filter.active")?.dataset.filter === "unread");
  check("首次只显示未读与在读", ids().sort().join() === "a,b", `可见 ${ids()}`);
  click(navOf("all"));
  await tick(10);

  console.log("── 第 1 步：旧数据兼容 + 三档初始状态 ──");
  check("未读卡片：无 is-read / is-reading", !itemOf("a").classList.contains("is-read") && !itemOf("a").classList.contains("is-reading"));
  check("在读卡片：带 is-reading", itemOf("b").classList.contains("is-reading") && !itemOf("b").classList.contains("is-read"));
  check("已读卡片：带 is-read 且标记按钮为已读态", itemOf("c").classList.contains("is-read") && toggleOf("c").classList.contains("is-on"));
  check("旧 read:true 数据：自动归为已读 + 标记按钮为已读态", itemOf("d").classList.contains("is-read") && toggleOf("d").classList.contains("is-on"));
  // 侧栏的标记按钮和全屏界面是同一颗「文字胶囊」按钮（不是圆圈图标），文字必须跟着状态翻。
  check("标记按钮文字：未读显示「标为已读」", toggleOf("a").textContent.trim() === "标为已读", JSON.stringify(toggleOf("a").textContent));
  check("标记按钮文字：已读显示「标为未读」", toggleOf("c").textContent.trim() === "标为未读", JSON.stringify(toggleOf("c").textContent));

  console.log("\n── 第 2 步：筛选只有三个按钮，且「未读」包含「在读」──");
  const filterOrder = [...document.querySelectorAll(".filter")].map((button) => button.textContent.trim()).join(" / ");
  check("筛选顺序是未读 / 已读 / 全部", filterOrder === "未读 / 已读 / 全部", filterOrder);
  click(navOf("all")); await tick(10);
  check("全部：四张都在", visibleItems().length === 4, `可见 ${ids()}`);
  click(navOf("unread")); await tick(10);
  check("未读：a（未读）+ b（在读）= 两张", visibleItems().length === 2 && ids().sort().join() === "a,b", `可见 ${ids()}`);
  click(navOf("done")); await tick(10);
  check("已读：c、d 两张", visibleItems().length === 2 && ids().sort().join() === "c,d", `可见 ${ids()}`);
  click(navOf("all")); await tick(10);

  console.log("\n── 第 3 步：手动点标记按钮 = 标已读，再点 = 标未读 ──");
  click(toggleOf("a")); await tick(20);
  check("未读 → 点一下 → 已读 + 按钮切到已读态", storeItem("a").status === "done" && itemOf("a").classList.contains("is-read") && toggleOf("a").classList.contains("is-on"), `status=${storeItem("a").status}`);
  check("标已读后 read 字段同步为 true", storeItem("a").read === true);
  check("标已读后按钮文字翻成「标为未读」", toggleOf("a").textContent.trim() === "标为未读", JSON.stringify(toggleOf("a").textContent));
  click(toggleOf("a")); await tick(20);
  check("再点一下 → 回到未读 + 按钮切回未读态", storeItem("a").status === "unread" && !itemOf("a").classList.contains("is-read") && !toggleOf("a").classList.contains("is-on"), `status=${storeItem("a").status}`);
  check("回到未读后按钮文字翻回「标为已读」", toggleOf("a").textContent.trim() === "标为已读", JSON.stringify(toggleOf("a").textContent));

  console.log("\n── 第 4 步：点开未读文章 → 自动标为「在读」（不是已读）──");
  click(itemOf("a").querySelector(".open-item"));
  await tick(20);
  check("a 被自动标记为在读", storeItem("a").status === "reading", `status=${storeItem("a").status}`);
  check("当前标签页被导航到原文", updatedTabs.some((t) => t.url === "https://a.com"));

  console.log("\n── 第 5 步：点开后仍留在「未读」里（没读完就不算已读）──");
  // 此刻：a=reading（第4步）, b=reading, c=done, d=done
  click(navOf("unread")); await tick(10);
  check("未读：a、b 两张（点开过也还在未读里）", visibleItems().length === 2 && ids().sort().join() === "a,b", `可见 ${ids()}`);
  click(navOf("done")); await tick(10);
  check("已读：c、d 两张（不受点开影响）", visibleItems().length === 2 && ids().sort().join() === "c,d", `可见 ${ids()}`);
  click(navOf("all")); await tick(10);

  console.log("\n── 第 6 步：侧栏模式不给「待整理」筛选项 ──");
  // 这 4 篇全是 projectId: null（都没归项目），但侧栏不管整理这件事——
  // 「待整理」只在全屏页面的左侧栏最上面，那边才负责催人归位。
  const filterNames = [...document.querySelectorAll("#projectFilters .project-filter .project-name")].map((el) => el.textContent);
  check("筛选项里没有「待整理」", !filterNames.includes("待整理"), filterNames.join(" / "));
  check("「全部项目」还在，且没归项目的收藏照样看得见", filterNames[0] === "全部项目" && visibleItems().length === 4, `${filterNames.join("/")} · 可见 ${visibleItems().length}`);
  // 万一首选项里存着 unfiled（老用户切过），这里也要当成「全部项目」，否则一个按钮都不高亮。
  // 这条只能静态断言：本测试是单实例 jsdom，没法干净地重新初始化。
  check("normalizeProject 不再把 unfiled 当合法范围（会退回全部项目）",
    !/projectId === "all" \|\| projectId === "unfiled"/.test(sidepanelSource), "normalizeProject 里仍保留 unfiled");

  console.log("\n── 第 7 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
