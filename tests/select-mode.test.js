// 多选（批量操作）的行为测试
// 重点盯两处用户能直接感知的坑：
//   ① 点卡片左上角的圆点，要真的勾上（圆点是 label 包着隐藏勾选框，容易被处理两次而互相抵消）
//   ② 多选时点卡片只是勾选，不能顺手把文章打开（标题和封面都是真链接）
// 运行：NODE_PATH=<jsdom 路径> node tests/select-mode.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const LIBRARY_HTML = read("library.html");
const LIBRARY_SOURCE = read("library.js");
const I18N_SOURCE = read("i18n.js");
const DIALOG_SOURCE = read("dialog.js");
const PICKER_SOURCE = read("picker-ui.js");
const TAB_NAVIGATION_SOURCE = read("tab-navigation.js");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

const ITEMS = ["a", "b", "c"].map((key, index) => ({
  id: `item-${key}`,
  title: `第 ${index + 1} 篇的标题`,
  description: "一段摘要",
  image: "",
  favicon: "",
  source: "example.com",
  projectId: null,
  url: `https://example.com/${key}`,
  savedAt: Date.now() - index * 1000,
  read: false
}));

(async () => {
  const store = {
    laterOnItems: JSON.parse(JSON.stringify(ITEMS)),
    laterOnProjects: [
      { id: "work", name: "工作", createdAt: 1 },
      { id: "study", name: "学习", createdAt: 2 }
    ],
    laterOnActiveProject: "unfiled",
    laterOnSettings: {}
  };

  const dom = new JSDOM(LIBRARY_HTML, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/library.html?from=sidepanel&project=unfiled&filter=unread"
  });
  const { window } = dom;
  const { document } = window;

  // 记录「打开文章」这类副作用：多选时不该出现它们的身影。
  const navigations = [];
  const createdWindows = [];
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
      onChanged: { addListener: () => {} }
    },
    tabs: {
      query: async (filter = {}) => filter.windowId === 8
        ? [{ id: 80, windowId: 8 }, { id: 81, windowId: 8 }]
        : [{ id: 7, windowId: 3 }],
      getCurrent: async () => ({ id: 7, windowId: 3 }),
      update: async (id, info) => { navigations.push(`update:${info?.url}`); return {}; },
      create: async (info) => { navigations.push(`create:${info?.url}`); return {}; }
    },
    runtime: {
      getURL: (file) => `chrome-extension://lateron/${file}`,
      sendMessage: async (message) => (message?.type === "PING_SIDEPANEL" ? { ready: true } : { ok: true }),
      onMessage: { addListener: () => {} }
    },
    windows: {
      getCurrent: async () => ({ id: 3 }),
      create: async (options) => {
        createdWindows.push(options);
        return { id: 8, tabs: options.url.map((_url, index) => ({ id: 80 + index, windowId: 8 })) };
      }
    },
    sidePanel: { open: async () => ({}), close: async () => ({}) }
  };

  window.eval(I18N_SOURCE);
  window.eval(DIALOG_SOURCE);
  window.eval(PICKER_SOURCE);
  window.eval(TAB_NAVIGATION_SOURCE);
  window.eval(LIBRARY_SOURCE);

  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const click = (el) => {
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };
  const grid = document.querySelector("#cardGrid");
  const cardOf = (id) => grid.querySelector(`.card[data-id="${id}"]`);
  const isSelected = (id) => cardOf(id)?.classList.contains("selected");
  const badgeOf = (id) => cardOf(id).querySelector(".select-badge");
  const checkBoxOf = (id) => cardOf(id).querySelector(".select-check");
  const bulkCount = () => document.querySelector("#bulkCount").textContent;

  await tick();
  check("三张卡片都渲染出来了", grid.querySelectorAll(".card").length === 3, `${grid.querySelectorAll(".card").length} 张`);

  console.log("\n── 进入多选模式 ──");
  click(document.querySelector("#selectMode"));
  await tick();
  check("网格进入多选状态", grid.classList.contains("selecting"));
  check("勾选圆点显示出来了", !!badgeOf("item-a"));
  check("批量操作栏出现", document.querySelector("#bulkBar").classList.contains("is-open"));
  check("计数从 0 开始", bulkCount() === "已选 0 篇", bulkCount());

  console.log("\n── 点左上角圆点：勾上 / 再点取消 ──");
  click(badgeOf("item-a"));
  await tick();
  check("点圆点就勾上了", isSelected("item-a") === true);
  check("勾选框本身也是勾上的（视觉与状态一致）", checkBoxOf("item-a").checked === true);
  check("计数跟着变", bulkCount() === "已选 1 篇", bulkCount());

  click(badgeOf("item-a"));
  await tick();
  check("再点一下就取消勾选", isSelected("item-a") === false);
  check("勾选框也同步取消", checkBoxOf("item-a").checked === false);
  check("计数回到 0", bulkCount() === "已选 0 篇", bulkCount());

  console.log("\n── 点卡片本身：只勾选，不许打开文章 ──");
  const beforeNavigations = navigations.length;
  const titleEvent = click(cardOf("item-a").querySelector(".title-link h2"));
  await tick(60);
  check("点标题可以勾上这张卡", isSelected("item-a") === true);
  check("但默认跳转被拦下了", titleEvent.defaultPrevented === true);
  check("没有被新标签页打开", navigations.length === beforeNavigations, navigations.join(" | "));

  const coverEvent = click(cardOf("item-b").querySelector(".cover-logo") || cardOf("item-b").querySelector(".cover-link"));
  await tick(60);
  check("点封面也是勾上而不是打开", isSelected("item-b") === true && coverEvent.defaultPrevented === true);
  check("依然没有任何跳转", navigations.length === beforeNavigations, navigations.join(" | "));
  check("两篇都算进去了", bulkCount() === "已选 2 篇", bulkCount());

  console.log("\n── 把选中的文章直接在新窗口打开 ──");
  click(document.querySelector("#bulkOpenWindow"));
  await tick(80);
  check("只创建一个新窗口，并按页面顺序放入两篇", createdWindows.length === 1
    && JSON.stringify(createdWindows[0].url) === JSON.stringify(["https://example.com/a", "https://example.com/b"]), JSON.stringify(createdWindows));
  check("没有创建浏览器标签组", typeof window.chrome.tabs.group === "undefined" && typeof window.chrome.tabGroups === "undefined");
  check("打开后自动退出多选", !grid.classList.contains("selecting") && !document.querySelector("#bulkBar").classList.contains("is-open"));

  console.log("\n── 全选 / 取消全选 ──");
  click(document.querySelector("#selectMode"));
  click(document.querySelector("#bulkSelectAll"));
  await tick();
  check("全选后三张都勾上", ["a", "b", "c"].every((key) => isSelected(`item-${key}`)), bulkCount());
  check("按钮变成「取消全选」", document.querySelector("#bulkSelectAll").textContent === "取消全选");
  click(document.querySelector("#bulkSelectAll"));
  await tick();
  check("取消全选后都不勾了", ["a", "b", "c"].every((key) => !isSelected(`item-${key}`)), bulkCount());

  console.log("\n── 批量移动：复用单篇文章的项目选择浮层 ──");
  click(cardOf("item-a"));
  click(cardOf("item-b"));
  await tick();
  check("移动前选中了两篇", bulkCount() === "已选 2 篇", bulkCount());
  click(document.querySelector("#bulkProject"));
  await tick();
  const pickerHost = document.querySelector("#lateron-folder-picker");
  const pickerShadow = pickerHost?.shadowRoot;
  check("点击移动到后打开共享项目浮层", !!pickerShadow?.querySelector(".lon-root.lon-popover"));
  check("标题写明本次移动两篇", pickerShadow?.querySelector(".lon-title")?.textContent === "把选中的 2 篇放到哪个项目？", pickerShadow?.querySelector(".lon-title")?.textContent);
  check("浮层显示等待整理和项目列表", pickerShadow?.querySelectorAll(".lon-folder").length === 3, `${pickerShadow?.querySelectorAll(".lon-folder").length} 行`);
  check("每行包含缩略图与数量", !!pickerShadow?.querySelector(".lon-folder-icon") && !!pickerShadow?.querySelector(".lon-folder-count"));
  const workRow = [...pickerShadow.querySelectorAll(".lon-folder")]
    .find((row) => row.querySelector(".lon-folder-name")?.textContent === "工作");
  click(workRow);
  click(pickerShadow.querySelector(".lon-primary"));
  await tick(80);
  check("两篇都移动到所选项目", store.laterOnItems.filter((item) => ["item-a", "item-b"].includes(item.id)).every((item) => item.projectId === "work"), JSON.stringify(store.laterOnItems.map((item) => [item.id, item.projectId])));
  check("移动后自动退出多选", !grid.classList.contains("selecting") && !document.querySelector("#bulkBar").classList.contains("is-open"));
  check("给出批量移动完成提示", /已将 2 篇移到「工作」/.test(document.querySelector("#toast").textContent), document.querySelector("#toast").textContent);

  console.log("\n── 退出多选后，点文章要能正常打开 ──");
  check("退出了多选状态", !grid.classList.contains("selecting"));
  check("勾选圆点收起来了（网格上不再有 .selecting）", document.querySelector("#bulkBar").classList.contains("is-open") === false);

  const openEvent = click(cardOf("item-c").querySelector(".title-link h2"));
  await tick(120);
  check("正常模式下点标题不会去勾选它", isSelected("item-c") === false);
  check("文章确实被打开了", navigations.length === beforeNavigations + 1, `${navigations.length - beforeNavigations} 次跳转`);

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
