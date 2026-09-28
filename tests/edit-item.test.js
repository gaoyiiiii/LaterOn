// 自己动手改标题 / 摘要 —— 这个功能横跨三处，所以分三段验证：
//   ① 带输入框的弹窗（dialog.js 新增的 prompt）：能不能填、能不能取消、回车的行为
//   ② 后台重复收藏时的合并逻辑：用户亲手改过的内容不能被自动抓取的结果顶掉
//   ③ 收藏库页面上的完整链路：点编辑 → 改 → 保存 → 卡片立刻变样 → 写进库
// 运行：NODE_PATH=<jsdom 路径> node tests/edit-item.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const BACKGROUND = read("background.js");
const I18N_SOURCE = read("i18n.js");
const DIALOG_SOURCE = read("dialog.js");
const DIALOG_CSS = read("dialog.css");
const LIBRARY_SOURCE = read("library.js");
const LIBRARY_HTML = read("library.html");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

// ═══════════════════════════════════════════════════════════
// ① 带输入框的弹窗
// ═══════════════════════════════════════════════════════════
async function partDialog() {
  console.log("\n── ① 输入弹窗（ LaterOnDialog.prompt ）──");
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${DIALOG_CSS}</style></head><body></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "chrome-extension://lateron/library.html" }
  );
  const { window } = dom;
  const { document } = window;
  window.eval(I18N_SOURCE);
  window.eval(DIALOG_SOURCE);

  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const press = (el, key, extra = {}) =>
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const visible = () => document.querySelector(".lod-root:not([hidden])");
  const field = (name) => visible()?.querySelector(`[data-field="${name}"]`);

  check("导出了 prompt 方法", typeof window.LaterOnDialog?.prompt === "function");

  let result;
  window.LaterOnDialog.prompt({
    title: "编辑标题和摘要",
    fields: [
      { name: "title", label: "标题", value: "原标题" },
      { name: "description", label: "摘要", value: "原摘要", multiline: true }
    ],
    confirmText: "保存"
  }).then((value) => { result = value; });
  await tick();

  check("弹窗显示出来了", !!visible());
  check("标题正确", visible().querySelector(".lod-title").textContent === "编辑标题和摘要");
  check("确认按钮写「保存」", visible().querySelector(".lod-ok").textContent === "保存");
  check("表单弹窗不再显示底部快捷键提示", visible().querySelector(".lod-hint").hidden === true);
  check("标题用单行输入框", field("title")?.tagName === "INPUT" && field("title").value === "原标题");
  check("摘要用多行输入框", field("description")?.tagName === "TEXTAREA" && field("description").value === "原摘要");
  check("标签也显示出来了", [...visible().querySelectorAll(".lod-field-label")].map((el) => el.textContent).join("/") === "标题/摘要");
  check("光标自动落进第一个输入框", document.activeElement === field("title"));

  // 多行框里按回车应该是换行，而不是直接保存。
  field("description").focus();
  press(field("description"), "Enter");
  await tick();
  check("在摘要里按回车不会提交", result === undefined && !!visible());

  // 改成新标题新摘要，回车保存。
  field("title").value = "我改好的标题";
  field("description").value = "我改好的摘要";
  field("description").focus();
  press(field("description"), "Enter", { metaKey: true });
  await tick(300);
  check("⌘ + 回车 → 保存成功", result?.ok === true, JSON.stringify(result));
  check("拿得到用户填的新内容", result?.values?.title === "我改好的标题" && result?.values?.description === "我改好的摘要");

  // 点取消 / Esc 都不能改东西。
  let cancelled;
  window.LaterOnDialog.prompt({ title: "改一改", fields: [{ name: "title", label: "标题", value: "别动我" }] })
    .then((value) => { cancelled = value; });
  await tick();
  field("title").value = "改坏了";
  click(visible().querySelector(".lod-cancel"));
  await tick(300);
  check("点取消 → ok=false", cancelled?.ok === false && cancelled.values === null, JSON.stringify(cancelled));

  let escaped;
  window.LaterOnDialog.prompt({ title: "再试一次", fields: [{ name: "title", label: "标题", value: "原文案" }] })
    .then((value) => { escaped = value; });
  await tick();
  press(visible(), "Escape");
  await tick(300);
  check("按 Esc → ok=false", escaped?.ok === false, JSON.stringify(escaped));

  // 普通 confirm 不受影响，返回值还是布尔。
  let plain;
  window.LaterOnDialog.confirm({ title: "还是布尔吗？" }).then((value) => { plain = value; });
  await tick();
  press(visible(), "Enter");
  await tick(300);
  check("普通确认框照旧返回 true（没被表单改造带偏）", plain === true, String(plain));

  const used = new Set();
  for (const matched of DIALOG_SOURCE.matchAll(/class="([^"]+)"/g)) matched[1].split(/\s+/).forEach((name) => used.add(name));
  for (const matched of DIALOG_SOURCE.matchAll(/classList\.(?:add|remove)\("([^"]+)"\)/g)) used.add(matched[1]);
  const missingCss = [...used].filter((name) => name.startsWith("lod-") && !DIALOG_CSS.includes(`.${name}`));
  check("新增的输入框类名都在 CSS 里有样式", missingCss.length === 0, missingCss.join(", "));
}

// ═══════════════════════════════════════════════════════════
// ② 后台合并：别覆盖用户手写的标题 / 摘要
// ═══════════════════════════════════════════════════════════
function partMerge() {
  console.log("\n── ② 重复收藏时保护用户改写的内容 ──");
  const grab = (name) => {
    const matched = new RegExp(`^function ${name}\\([^)]*\\)[\\s\\S]*?^}`, "m").exec(BACKGROUND);
    if (!matched) throw new Error(`没找到函数 ${name}`);
    return matched[0];
  };
  const context = vm.createContext({ URL, console });
  vm.runInContext(
    ["isPlaceholderText", "titleHasSiteNoise", "isIconLikeImage", "mergeDuplicateMetadata"].map(grab).join("\n\n"),
    context
  );
  const merge = vm.runInContext("mergeDuplicateMetadata", context);
  check("取到了后台真实的合并函数", typeof merge === "function");

  const YT = "https://www.youtube.com/watch?v=abc123";
  const NORMAL = "https://example.com/post/1";

  // 没改过的：YouTube 仍然会被刷新（这是修错误信息的老办法，不能弄丢）。
  const freshYt = { url: YT, title: "YouTube", description: "首页宣传语", image: "", source: "youtube.com" };
  const ytChange = merge(freshYt, { url: YT, title: "正确的视频标题", description: "正确的简介", source: "youtube.com" });
  check("YouTube 未改动过时照旧会被刷新", ytChange === true && freshYt.title === "正确的视频标题");

  // 改过标题的：哪怕 YouTube 也不许覆盖。
  const editedTitle = { url: YT, title: "我亲手写的标题", titleEdited: true, description: "简介", image: "", source: "youtube.com" };
  const keep = merge(editedTitle, { url: YT, title: "自动抓来的标题", description: "自动抓来的简介", source: "youtube.com" });
  check("标题改过 → 不被覆盖", editedTitle.title === "我亲手写的标题", editedTitle.title);
  check("只锁标题时，摘要仍可以补", keep === true && editedTitle.description === "自动抓来的简介", editedTitle.description);

  // 摘要也改过：同样锁住。
  const editedDesc = { url: NORMAL, title: "原标题", description: "我亲手写的摘要", descriptionEdited: true, image: "", source: "example.com" };
  const kept2 = merge(editedDesc, { url: NORMAL, title: "原标题", description: "自动抓来的摘要", source: "example.com" });
  check("摘要改过 → 不被覆盖", editedDesc.description === "我亲手写的摘要", editedDesc.description);
  check("两边都没变 → 返回没改动", kept2 === false);

  // 没改过的普通站点：老行为保持不变（缺了才补）。
  const untouched = { url: NORMAL, title: "好标题", description: "暂无摘要", image: "", source: "example.com" };
  const filled = merge(untouched, { url: NORMAL, title: "好标题", description: "补到的摘要", source: "example.com" });
  check("未改过且缺摘要 → 照样自动补上", filled === true && untouched.description === "补到的摘要");

  const goodExisting = { url: NORMAL, title: "已有的好标题", description: "已有的好摘要", image: "", source: "example.com" };
  const leftAlone = merge(goodExisting, { url: NORMAL, title: "已有的好标题", description: "另一段摘要", source: "example.com" });
  check("未改过且信息完整 → 保持原样", leftAlone === false && goodExisting.description === "已有的好摘要");

  // 封面不受这两个标记影响（用户没要求锁封面）。
  const iconCover = { url: NORMAL, title: "标题", description: "摘要", image: "https://example.com/favicon.ico", titleEdited: true, descriptionEdited: true, source: "example.com" };
  merge(iconCover, { url: NORMAL, title: "标题2", description: "摘要2", image: "https://example.com/big.jpg", source: "example.com" });
  check("封面照旧能修复（和这次改动无关的能力没丢）", iconCover.image === "https://example.com/big.jpg");
}

// ═══════════════════════════════════════════════════════════
// ③ 收藏库页面上的完整链路
// ═══════════════════════════════════════════════════════════
async function partLibrary() {
  console.log("\n── ③ 在收藏库页面上真的改一篇 ──");
  const ITEMS = [
    {
      id: "item-1",
      title: "自动抓来的标题 - 知乎",
      description: "暂无摘要",
      image: "",
      favicon: "",
      source: "zhihu.com",
      projectId: null,
      url: "https://zhihu.com/p/1",
      savedAt: Date.now() - 1000,
      read: false
    },
    {
      id: "item-2",
      title: "另一篇",
      description: "另一篇的摘要",
      image: "",
      favicon: "",
      source: "example.com",
      projectId: null,
      url: "https://example.com/p/2",
      savedAt: Date.now() - 2000,
      read: false
    }
  ];
  const PROJECTS = [];
  const store = {
    laterOnItems: JSON.parse(JSON.stringify(ITEMS)),
    laterOnProjects: PROJECTS,
    laterOnActiveProject: "unfiled",
    laterOnSettings: {}
  };

  const dom = new JSDOM(LIBRARY_HTML, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/library.html"
  });
  const { window } = dom;
  const { document } = window;

  const listeners = [];
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
      onChanged: { addListener: (fn) => listeners.push(fn) }
    },
    tabs: {
      query: async () => [{ id: 7, windowId: 3 }],
      getCurrent: async () => ({ id: 7, windowId: 3 }),
      update: async () => ({}),
      create: async () => ({})
    },
    runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async () => ({}), close: async () => ({}) }
  };

  window.eval(I18N_SOURCE);
  window.eval(DIALOG_SOURCE);
  window.eval(LIBRARY_SOURCE);

  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const press = (el, key, extra = {}) =>
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const visible = () => document.querySelector(".lod-root:not([hidden])");
  const card = (id) => document.querySelector(`.card[data-id="${id}"]`);
  const titleOf = (id) => card(id)?.querySelector(".title-link h2")?.textContent;
  const descOf = (id) => card(id)?.querySelector(".description")?.textContent;

  await tick();
  click(document.querySelector('.project-nav[data-project="unfiled"]'));
  await tick();
  check("卡片渲染出来了", document.querySelectorAll(".card").length === 2, `${document.querySelectorAll(".card").length} 张`);
  check("卡片右上角有铅笔按钮", !!card("item-1")?.querySelector(".edit"));
  check("铅笔没被封面链接包住（点它不会顺带打开网页）", !card("item-1")?.querySelector(".cover-link .edit"));

  // 点编辑 → 弹窗出现，带着现在的值（摘要是占位的「暂无摘要」，显示成空才合理）。
  click(card("item-1").querySelector(".edit"));
  await tick();
  check("点编辑弹出输入框", !!visible());
  check("标题初值正确", visible().querySelector('[data-field="title"]')?.value === "自动抓来的标题 - 知乎");
  check("「暂无摘要」显示成空，方便直接补写", visible().querySelector('[data-field="description"]')?.value === "");
  check("提示这是一篇没摘要的收藏", /没抓到摘要/.test(visible().querySelector(".lod-message").textContent));

  // 改完保存。
  visible().querySelector('[data-field="title"]').value = "我重写的标题";
  visible().querySelector('[data-field="description"]').value = "我补的摘要";
  click(visible().querySelector(".lod-ok"));
  await tick(300);

  const saved = store.laterOnItems.find((entry) => entry.id === "item-1");
  check("新标题写进了收藏库", saved?.title === "我重写的标题", saved?.title);
  check("新摘要写进了收藏库", saved?.description === "我补的摘要", saved?.description);
  check("标题标记为「用户改过」", saved?.titleEdited === true, String(saved?.titleEdited));
  check("摘要标记为「用户改过」", saved?.descriptionEdited === true, String(saved?.descriptionEdited));
  check("卡片上的标题立刻变了", titleOf("item-1") === "我重写的标题", titleOf("item-1"));
  check("卡片上的摘要立刻变了", descOf("item-1") === "我补的摘要", descOf("item-1"));
  check("其它收藏没被波及", titleOf("item-2") === "另一篇");

  // 摘要清空 → 回落到「暂无摘要」，而不是把卡片摘要弄没。
  click(card("item-1").querySelector(".edit"));
  await tick();
  visible().querySelector('[data-field="description"]').value = "   ";
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  const cleared = store.laterOnItems.find((entry) => entry.id === "item-1");
  check("摘要清空后回落到「暂无摘要」", cleared?.description === "暂无摘要", cleared?.description);
  check("清空时也标记为「用户改过」（以后不会被自动填充顶掉）", cleared?.descriptionEdited === true);

  // Esc 取消：什么都不该改。
  const before = JSON.stringify(store.laterOnItems);
  click(card("item-1").querySelector(".edit"));
  await tick();
  visible().querySelector('[data-field="title"]').value = "误触改成这样";
  press(visible(), "Escape");
  await tick(300);
  check("按 Esc 取消时不会写库", JSON.stringify(store.laterOnItems) === before);
  check("卡片也保持原样", titleOf("item-1") === "我重写的标题", titleOf("item-1"));

  // 没有改动就保存：不该产生无谓的写库。
  const beforeNoop = JSON.stringify(store.laterOnItems);
  click(card("item-1").querySelector(".edit"));
  await tick();
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("没改任何字就保存 → 不写库", JSON.stringify(store.laterOnItems) === beforeNoop);
  check("会提示「没有改动」", /没有改动/.test(document.querySelector("#toast").textContent), document.querySelector("#toast").textContent);

  // 别处的改动（比如后台重新抓了一次）也要能同步到已有卡片上。
  const storageChanged = listeners.find((fn) => typeof fn === "function");
  const nextItems = store.laterOnItems.map((entry) => entry.id === "item-2" ? { ...entry, title: "后台更新后的标题", description: "后台更新后的摘要" } : entry);
  store.laterOnItems = nextItems;
  storageChanged({ laterOnItems: { newValue: nextItems } }, "local");
  await tick();
  check("外部改动也能同步到卡片标题（不再是一张死卡）", titleOf("item-2") === "后台更新后的标题", titleOf("item-2"));
  check("摘要同步也是好的", descOf("item-2") === "后台更新后的摘要", descOf("item-2"));
}

// ═══════════════════════════════════════════════════════════
// ④ 静态检查：入口是不是都接上了
// ═══════════════════════════════════════════════════════════
function partWiring() {
  console.log("\n── ④ 各个入口是否都接上了 ──");
  const libraryHtml = read("library.html");
  const sidepanelHtml = read("sidepanel.html");
  const sidepanelJs = read("sidepanel.js");

  const libraryCss = read("library.css");
  check("收藏库卡片模板里有编辑按钮", /class="edit"/.test(libraryHtml));
  check("侧边栏卡片模板里有编辑按钮", /class="edit"/.test(sidepanelHtml));
  check("铅笔浮在右上角（鼠标移到卡片上才出现）", /\.card:hover \.edit/.test(libraryCss) && /\.item:hover \.edit/.test(read("sidepanel.css")));
  check("收藏库：点编辑按钮会打开弹窗", /\.edit\"\)\)\s+editItem\(/.test(LIBRARY_SOURCE));
  check("侧边栏：点编辑按钮会打开弹窗", /\.edit\"\)\)\s+editItem\(/.test(sidepanelJs));
  check("收藏库引入了弹窗组件（否则弹不出来）", /dialog\.js/.test(libraryHtml));
  check("侧边栏按需加载弹窗组件", /script\.src = "dialog\.js"/.test(sidepanelJs));
  check("两处都同步卡片标题 / 摘要", /setText\(card\.querySelector\("\.title-link h2"\)/.test(LIBRARY_SOURCE) && /setText\(article\.querySelector\("h2"\)/.test(sidepanelJs));
  check("编辑后立刻重画卡片（不等存储广播）", /await updateItem\(item\.id, patch\);\s*\n\s*\/\/.+\n\s*render\(\);/.test(LIBRARY_SOURCE) && /render\(\);\s*\n}/.test(sidepanelJs));
}

(async () => {
  await partDialog();
  partMerge();
  await partLibrary();
  partWiring();
  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
