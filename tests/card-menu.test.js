// 单篇收藏的右键菜单（把真实的 library.js 放进假 DOM 跑）：
//  1) 卡片上右键 → 弹出菜单，六项齐全（打开 / 标记已读 / 编辑 / 移动 / 多选 / 删除）
//  2) 点「多选」→ 进入多选模式（顶部按钮激活、底部批量条展开、这一篇已勾上）
//  3) 多选状态下再右键 → 那一项变成「取消选择」，点了就取消勾选
//  4) 点「标为已读」→ 这一篇真的变成已读
//  5) Esc / 点别处都能关掉菜单（和图板的项目菜单同一套关闭逻辑）
//  6) 菜单用的是和图板项目菜单同一个 .folder-menu 样式
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
const i18nSource = fs.readFileSync(`${ROOT}/i18n.js`, "utf8");
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

const now = Date.now();
const store = {
  laterOnItems: [
    { id: "i1", title: "文章一", description: "摘要一", image: "", favicon: "", source: "a.com", projectId: "work", url: "https://a.com/1", savedAt: now, status: "unread" },
    { id: "i2", title: "文章二", description: "摘要二", image: "", favicon: "", source: "b.com", projectId: "work", url: "https://b.com/2", savedAt: now - 1000, status: "unread" }
  ],
  laterOnProjects: [{ id: "work", name: "工作", createdAt: 1 }],
  // 具体项目里才是「卡片视图」（全部项目是图板），右键菜单挂在卡片上。
  laterOnActiveProject: "work",
  laterOnSettings: {},
  laterOnFilter: "all",
  laterOnFilterChosen: true
};
const changeListeners = [];
const createdTabs = [];
// 「打开这篇收藏」会把当前标签页导航到原文（或新开标签页），两种路径都记下来。
const openedUrls = [];

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
    query: () => Promise.resolve([{ id: 1, windowId: 1 }]),
    getCurrent: () => Promise.resolve({ id: 1, windowId: 1 }),
    create: (options) => { createdTabs.push(options); openedUrls.push(options.url); return Promise.resolve({ id: 2 }); },
    update: (id, options) => { openedUrls.push(options.url); return Promise.resolve({ id }); }
  },
  sidePanel: { open: () => Promise.resolve() },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    // 侧栏就绪探测：直接回「就绪」，免得测试里真等那 1.5 秒。
    sendMessage: () => Promise.resolve({ ready: true }),
    onMessage: { addListener() {} }
  }
};
if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", { configurable: true, value: { randomUUID: () => "fake-id" } });
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 40) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const pointerdown = (el) => el.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
const pressKey = (key) => document.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }));
const menu = () => document.querySelector(".folder-menu");
const menuLabels = () => [...document.querySelectorAll(".folder-menu-item")].map((item) => item.textContent);
const cardOf = (id) => document.querySelector(`.card[data-id="${id}"]`);
const stored = (id) => store.laterOnItems.find((item) => item.id === id);

(async () => {
  window.eval(i18nSource);
  window.eval(dialogSource);
  window.eval(librarySource);
  await tick(120);

  console.log("── 第 1 步：卡片上右键 → 弹出这一篇的菜单 ──");
  const card = cardOf("i1");
  check("卡片视图里看得到这两篇收藏", !!card && !!cardOf("i2"), `卡片数 ${document.querySelectorAll(".card").length}`);
  rightClick(card);
  await tick();
  check("右键弹出了菜单", !!menu());
  check("菜单标题是这一篇的标题", menu()?.querySelector(".folder-menu-title")?.textContent === "文章一", menu()?.querySelector(".folder-menu-title")?.textContent);
  const labels = menuLabels();
  // 「标为已读」和「移动到项目」刻意不放进来：卡片上本来就有这两个按钮。
  check("四项：打开 / 编辑 / 多选 / 删除",
    labels.join(" · ") === "打开 · 编辑标题与摘要 · 多选 · 删除", labels.join(" · "));
  check("用的是和图板项目菜单同一个 .folder-menu 样式", /^\.folder-menu\s*\{/m.test(libraryCss));

  console.log("\n── 第 2 步：点「多选」→ 进入多选模式并勾上这一篇 ──");
  const pickByLabel = (text) => [...document.querySelectorAll(".folder-menu-item")].find((item) => item.textContent === text);
  click(pickByLabel("多选"));
  await tick();
  check("菜单点了就关", !menu());
  check("卡片被勾上了", cardOf("i1")?.classList.contains("selected"));
  check("顶部「选择」按钮进入激活态", document.querySelector("#selectMode")?.classList.contains("active"));
  check("底部批量操作条展开了", document.querySelector("#bulkBar")?.classList.contains("is-open"));
  check("批量条显示已选 1 篇", document.querySelector("#bulkCount")?.textContent === "已选 1 篇", document.querySelector("#bulkCount")?.textContent);

  console.log("\n── 第 3 步：多选状态下再右键 → 那一项变成「取消选择」──");
  rightClick(cardOf("i1"));
  await tick();
  check("菜单里出现「取消选择」", menuLabels().includes("取消选择"), menuLabels().join(" · "));
  click(pickByLabel("取消选择"));
  await tick();
  check("这一篇的勾选被取消", !cardOf("i1")?.classList.contains("selected"));
  // 收尾：退出多选，别影响后面的步骤。
  click(document.querySelector("#bulkDone"));
  await tick();
  check("退出多选后卡片不再处于选中态", !document.querySelector(".grid")?.classList.contains("selecting"));

  console.log("\n── 第 4 步：点「打开」→ 这一篇真的被打开 ──");
  rightClick(cardOf("i1"));
  await tick();
  click(pickByLabel("打开"));
  await tick();
  check("当前标签页导航到原文", openedUrls.includes("https://a.com/1"), JSON.stringify(openedUrls));

  console.log("\n── 第 5 步：Esc / 点别处都能关掉菜单 ──");
  rightClick(cardOf("i2"));
  await tick();
  check("菜单先弹出来", !!menu());
  pressKey("Escape");
  await tick();
  check("Esc 关掉了菜单", !menu());
  rightClick(cardOf("i2"));
  await tick();
  pointerdown(document.body);
  await tick();
  check("点别处也关掉了菜单", !menu());

  console.log("\n── 第 6 步：全程没有未捕获的错误 ──");
  const realErrors = errors.filter((e) => !/Not implemented/.test(e));
  check("没有 jsdom 报错", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
