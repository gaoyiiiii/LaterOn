// DOM 冒烟测试：把真实的「网页内选项目浮层」放进一个假 DOM 里跑一遍，
// 确认它真的渲染出来、内容正确、交互（选择 / 新建 / 取消 / 键盘）都对。
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SOURCE = path.resolve(__dirname, "..", "content-folder-picker.js");
const src = fs.readFileSync(SOURCE, "utf8");

// 真实浮层 UI 抽到了 picker-ui.js 的 openFolderPicker（和全屏卡片上那个浮层同一份）。
const UI_SOURCE = path.resolve(__dirname, "..", "picker-ui.js");
const uiSrc = fs.readFileSync(UI_SOURCE, "utf8");

// 从 content-folder-picker.js 里取出真实的浮层入口函数源码（预览和测试都用这一份，避免脱节）。
const matched = /^function showFolderPickerOverlay\([^)]*\)[\s\S]*?^\}/m.exec(src);
if (!matched) throw new Error("没有在 content-folder-picker.js 里找到 showFolderPickerOverlay");
const fnSource = matched[0];

const dom = new JSDOM("<!doctype html><html><body><h1>某个网页</h1><p>正文</p></body></html>", {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "https://example.com/article"
});
const { window } = dom;
const { document } = window;

const sent = [];
window.chrome = {
  runtime: {
    sendMessage(message) {
      sent.push(message);
      if (message?.type === "CREATE_PROJECT") {
        return Promise.resolve({ ok: true, project: { id: "new-folder-1", name: message.name, createdAt: Date.now() } });
      }
      if (message?.type === "CONFIRM_BATCH_SAVE") return Promise.resolve({ ok: true, tabCount: 12 });
      if (message?.type === "CANCEL_BATCH_SAVE") return Promise.resolve({ ok: true, cancelled: true });
      return Promise.resolve({ ok: true });
    }
  }
};

// 直接在 jsdom 自己的 realm 里执行，document / window / Element 才是同一套对象。
// Node 新版 vm 把 Window 当 sandbox 时不再可靠地暴露 document，测试会在应用代码运行前误报。
// 先加载共享 UI（openFolderPicker），再加载调用它的薄封装。
window.eval(uiSrc);
window.eval(`window.__overlay = ${fnSource};`);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 0) => new Promise((resolve) => window.setTimeout(resolve, ms));

const FOLDERS = [
  { id: "", name: "待整理", count: 3 },
  { id: "work", name: "工作", count: 18 },
  { id: "design", name: "设计灵感", count: 7 }
];
const PAGES = [
  { title: "文章一", url: "https://a.com/1" },
  { title: "文章二", url: "https://b.com/2" }
];

(async () => {
  console.log("── 渲染 ──");
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });

  const host = document.getElementById("lateron-folder-picker");
  check("浮层挂进了页面（没有新开窗口）", !!host);
  check("浮层用 Shadow DOM 隔离页面样式", !!host?.shadowRoot);
  check("带上了极高层级，不会被网页内容盖住", /2147483600/.test(host.shadowRoot.querySelector("style").textContent));

  const shadow = host.shadowRoot;
  const q = (selector) => shadow.querySelector(selector);
  const rows = [...shadow.querySelectorAll(".lon-folder")];
  check("列出了全部项目（含待整理）", rows.length === 3, rows.map((r) => r.querySelector(".lon-folder-name").textContent).join(" / "));
  check("每行显示各自已收藏数量", rows[0].querySelector(".lon-folder-count").textContent === "3" && rows[1].querySelector(".lon-folder-count").textContent === "18");
  check("默认选中传入的项目", rows[1].classList.contains("is-selected") && rows[1].getAttribute("aria-checked") === "true");
  check("确认按钮写明了要存进的项目", q(".lon-primary").textContent === "收藏到「工作」", q(".lon-primary").textContent);
  check("页面清单按顺序列出、并标注数量", shadow.querySelectorAll(".lon-page-list li").length === 2 && /将要收藏的 2 个页面/.test(q(".lon-pages-label").textContent));
  check("标题与说明文案都在", q(".lon-title").textContent === "收藏到哪个项目？" && /共 2 个标签页/.test(q(".lon-summary").textContent));
  check("浅色主题下没有打深色标记", !q(".lon-root").hasAttribute("data-dark"));
  check("列出了取消按钮", q(".lon-ghost").textContent === "取消");

  console.log("\n── 样式表自检（CSS 是写在 JS 字符串里的，最容易出低级错误）──");
  const css = shadow.querySelector("style").textContent;
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  check("花括号配对", open === close, `${open} 组 ${close} 个闭合`);
  check("没有残留的模板占位符", !css.includes("${") && !css.includes("undefined"), "");
  const missingSemicolon = css
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(--)?[a-zA-Z-]+\s*:/.test(line) && !line.includes(";") && !line.endsWith("{") && !line.endsWith(","));
  check("没有漏写分号的声明（漏一条会让后面的样式整段失效）", missingSemicolon.length === 0, missingSemicolon.join(" | "));
  check("关键设计要素齐了（渐变按钮 / 大圆角 / 遮罩 / 深色模式）",
    /linear-gradient\(140deg, #ff7a52, #ff4f2e\)/.test(css) && /border-radius: 22px/.test(css) && /\.lon-backdrop/.test(css) && /\[data-dark="1"\]/.test(css));

  console.log("\n── 交互：切换项目 ──");
  rows[2].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("点一行就切换选中", shadow.querySelectorAll(".lon-folder")[2].classList.contains("is-selected"));
  check("确认按钮跟着更新", q(".lon-primary").textContent === "收藏到「设计灵感」", q(".lon-primary").textContent);

  console.log("\n── 交互：写了新项目名 → 回车一步新建并收藏 ──");
  const shadowNow = () => document.getElementById("lateron-folder-picker").shadowRoot;
  const typeNew = (shadowRoot, name) => {
    const field = shadowRoot.querySelector(".lon-new-input");
    field.value = name;
    field.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
    return field;
  };

  const newField = typeNew(shadow, "  临时收藏  ");
  check("按钮实时变成「新建「临时收藏」并收藏」", q(".lon-primary").textContent === "新建「临时收藏」并收藏", q(".lon-primary").textContent);
  check("不再需要单独的「新建」按钮", !q(".lon-new-btn"));

  newField.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
  await tick(20);
  const createMsg = sent.find((m) => m.type === "CREATE_PROJECT");
  const confirms = sent.filter((m) => m.type === "CONFIRM_BATCH_SAVE");
  check("回车先把项目建出来", createMsg?.name === "临时收藏", JSON.stringify(createMsg));
  check("接着就收藏到刚建的项目里（不用再点一次收藏）", confirms.at(-1)?.projectId === "new-folder-1", JSON.stringify(confirms.at(-1)));
  await tick(300);
  check("一步完成后浮层自动退场", !document.getElementById("lateron-folder-picker"));

  console.log("\n── 交互：点「收藏」按钮 = 同样一步完成 ──");
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  typeNew(shadowNow(), "灵感库");
  check("按钮提示跟着输入框走", shadowNow().querySelector(".lon-primary").textContent === "新建「灵感库」并收藏", shadowNow().querySelector(".lon-primary").textContent);
  shadowNow().querySelector(".lon-primary").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(20);
  const created2 = sent.filter((m) => m.type === "CREATE_PROJECT").at(-1);
  check("点收藏按钮也会先建项目", created2?.name === "灵感库", JSON.stringify(created2));
  check("并收藏到新建的项目里", sent.filter((m) => m.type === "CONFIRM_BATCH_SAVE").at(-1)?.projectId === "new-folder-1");
  await tick(300);

  console.log("\n── 交互：改选项目会丢掉没提交的新名字 ──");
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  const pickShadow = shadowNow();
  typeNew(pickShadow, "临时想法");
  pickShadow.querySelectorAll(".lon-folder")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check("点了项目就清空输入框", pickShadow.querySelector(".lon-new-input").value === "");
  check("按钮回到「收藏到「工作」」", pickShadow.querySelector(".lon-primary").textContent === "收藏到「工作」", pickShadow.querySelector(".lon-primary").textContent);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  console.log("\n── 交互：键盘 ──");
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await tick(10);
  const confirmMsg = sent.filter((m) => m.type === "CONFIRM_BATCH_SAVE").at(-1);
  check("没写新名字时，回车 = 按选中的项目收藏", confirmMsg?.projectId === "work", JSON.stringify(confirmMsg));
  await tick(300);
  check("确认后浮层自动退场", !document.getElementById("lateron-folder-picker"));

  console.log("\n── 播放守卫：浮层开着时不让网页的视频被空格按停 ──");
  const video = document.createElement("video");
  document.body.append(video);
  // jsdom 不会真的播放，这里手动假装「正在播放」。
  Object.defineProperty(video, "paused", { get: () => false, configurable: true });
  let resumeCount = 0;
  video.play = () => { resumeCount += 1; return Promise.resolve(); };

  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  video.dispatchEvent(new window.Event("pause"));
  await tick(10);
  check("浮层开着时被意外暂停的视频会立刻恢复", resumeCount === 1, `恢复了 ${resumeCount} 次`);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);
  video.dispatchEvent(new window.Event("pause"));
  check("浮层关掉后就不再替网页恢复播放", resumeCount === 1, `恢复了 ${resumeCount} 次`);
  video.remove();

  console.log("\n── 键盘只归浮层，不漏给网页（空格暂停视频的冲突）──");
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  const gateInput = document.getElementById("lateron-folder-picker").shadowRoot.querySelector(".lon-new-input");
  const pageSeen = [];
  const pageListener = (event) => pageSeen.push(event.key);
  document.addEventListener("keydown", pageListener);
  document.addEventListener("keyup", pageListener);

  gateInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true, cancelable: true }));
  gateInput.dispatchEvent(new window.KeyboardEvent("keyup", { key: " ", bubbles: true, composed: true, cancelable: true }));
  check("起名时按空格，网页听不到（视频不会被暂停）", !pageSeen.includes(" "), JSON.stringify(pageSeen));

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  check("浮层开着、焦点不在输入框时空格也听不到", !pageSeen.includes(" "), JSON.stringify(pageSeen));

  const cancelsBeforeGate = sent.filter((m) => m.type === "CANCEL_BATCH_SAVE").length;
  gateInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  await tick(300);
  check("焦点在输入框里按 Esc 也能退出浮层", !document.getElementById("lateron-folder-picker"));
  check("Esc 确实发出了取消请求", sent.filter((m) => m.type === "CANCEL_BATCH_SAVE").length === cancelsBeforeGate + 1);

  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  check("浮层关闭后不再拦键盘（网页恢复正常收按键）", pageSeen.includes(" "), JSON.stringify(pageSeen));
  document.removeEventListener("keydown", pageListener);
  document.removeEventListener("keyup", pageListener);

  console.log("\n── 交互：Esc 取消 ──");
  window.__overlay({ theme: "dark", selected: "", folders: FOLDERS, pages: PAGES });
  const host2 = document.getElementById("lateron-folder-picker");
  check("深色主题下打了深色标记", host2.shadowRoot.querySelector(".lon-root").getAttribute("data-dark") === "1");
  check("未选中时默认落到「待整理」", host2.shadowRoot.querySelector(".lon-primary").textContent === "收藏到「待整理」", host2.shadowRoot.querySelector(".lon-primary").textContent);
  const cancelBefore = sent.filter((m) => m.type === "CANCEL_BATCH_SAVE").length;
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);
  check("Esc 发出了取消请求", sent.filter((m) => m.type === "CANCEL_BATCH_SAVE").length === cancelBefore + 1);
  check("Esc 之后浮层被移除", !document.getElementById("lateron-folder-picker"));

  console.log("\n── 重复触发 ──");
  window.__overlay({ theme: "light", selected: "", folders: FOLDERS, pages: PAGES });
  window.__overlay({ theme: "light", selected: "", folders: FOLDERS, pages: PAGES });
  check("重复触发只会留一个浮层（不会叠起来）", document.querySelectorAll("#lateron-folder-picker").length === 1, `${document.querySelectorAll("#lateron-folder-picker").length} 个`);

  console.log("\n── 摘要文案：这批里有没有已经收藏过的 ──");
  // 先把上一个浮层正常关掉（用 Esc，这样键盘监听也会一起摘掉），再分别弹两种情况的浮层。
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);
  check("（准备）上一步的浮层已关掉", !document.getElementById("lateron-folder-picker"));

  const openLayer = (extra) => {
    window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES, ...extra });
    return document.querySelector("#lateron-folder-picker").shadowRoot.querySelector(".lon-summary").textContent;
  };

  const sumWithSaved = openLayer({ savedCount: 2 });
  check("知道有几篇已收藏过时，会说明「一并移进所选项目」", /其中 2 个已经收藏过/.test(sumWithSaved) && /移进你选的项目/.test(sumWithSaved), sumWithSaved);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  const sumPlain = openLayer({});
  check("没有已收藏的页面时，用普通说法", /选好项目后就会开始逐个收藏/.test(sumPlain), sumPlain);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  console.log("\n── 只收一篇时：文案与页面清单 ──");
  // 设置里打开「收藏单篇前先选项目」后，浮层也会被单篇收藏复用，这时不该再说「共 1 个标签页」。
  const openSingle = (extra) => {
    window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: [{ title: "文章一", url: "https://a.com/1" }], ...extra });
    return document.querySelector("#lateron-folder-picker").shadowRoot;
  };

  const singleShadow = openSingle({});
  check("标题改成「把这篇收藏到哪个项目？」", singleShadow.querySelector(".lon-title").textContent === "把这篇收藏到哪个项目？", singleShadow.querySelector(".lon-title").textContent);
  check("说明文案不再提「标签页」", /选好项目后就会收藏这一篇/.test(singleShadow.querySelector(".lon-summary").textContent), singleShadow.querySelector(".lon-summary").textContent);
  check("页面清单被收起（就是眼前这个网页，不必再列一遍）", singleShadow.querySelector(".lon-pages").hidden === true);
  check("项目列表和确认按钮照常可用", singleShadow.querySelectorAll(".lon-folder").length === 3 && singleShadow.querySelector(".lon-primary").textContent === "收藏到「工作」", singleShadow.querySelector(".lon-primary").textContent);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  const singleSaved = openSingle({ savedCount: 1 });
  check("这一篇已收藏过时，会说明确认后搬进所选项目", /这篇已经收藏过/.test(singleSaved.querySelector(".lon-summary").textContent), singleSaved.querySelector(".lon-summary").textContent);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  console.log("\n── 品牌标识只出现在整屏弹窗里 ──");
  // 整屏弹窗（网页里 Alt+1 收藏）：用户得先知道这是谁弹的窗，所以顶部保留「↗ LaterOn」。
  window.__overlay({ theme: "light", selected: "work", folders: FOLDERS, pages: PAGES });
  const modalShadow = document.getElementById("lateron-folder-picker").shadowRoot;
  const modalBrand = modalShadow.querySelector(".lon-brand");
  check("整屏收藏弹窗保留「↗ LaterOn」品牌标识", !!modalBrand && /LaterOn/.test(modalBrand.textContent), modalBrand?.textContent);
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick(300);

  // 贴按钮的浮层（全屏收藏库卡片上点「所属项目」）：同一个组件，区别只在传了 anchor。
  // 这时不该再显示品牌标识——人本来就在收藏库里，顶部重复一遍只会把项目列表往下挤。
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const popover = window.openFolderPicker({ anchor, theme: "light", selected: "work", folders: FOLDERS });
  const popShadow = document.getElementById("lateron-folder-picker").shadowRoot;
  check("浮层认得出自己是「贴按钮」那一档", popShadow.querySelector(".lon-root").classList.contains("lon-popover"));
  check("浮层里没有品牌标识（图标和 LaterOn 字样都不出现）",
    !popShadow.querySelector(".lon-brand") && !/LaterOn/.test(popShadow.querySelector(".lon-panel").innerHTML),
    popShadow.querySelector(".lon-panel").innerHTML.slice(0, 80));
  check("浮层的标题还在（不然不知道这个浮层是干嘛的）",
    popShadow.querySelector(".lon-title").textContent === "把这篇放到哪个项目？",
    popShadow.querySelector(".lon-title").textContent);
  check("浮层的项目列表与按钮照常可用",
    popShadow.querySelectorAll(".lon-folder").length === 3 &&
    popShadow.querySelector(".lon-primary").textContent === "移动到「工作」",
    popShadow.querySelector(".lon-primary").textContent);
  popover.close();
  await tick(300);
  anchor.remove();

  // 静态锁：品牌标识是在构造时按「整屏 / 浮层」分支渲染的（不是靠 CSS 藏起来），
  // 而且浮层要把标题的上边距收掉——那是当初用来跟品牌行拉开距离的。
  check("品牌标识按「整屏 / 浮层」分支渲染",
    /isPopover\s*\?\s*""\s*:\s*`<div class="lon-brand"/.test(uiSrc));
  const popTitleRule = /^\s*\.lon-root\.lon-popover \.lon-title\s*\{[^}]*\}/m.exec(uiSrc)?.[0] || "";
  check("浮层里标题的上边距被收掉（不留一段空白）", /margin-top:\s*0/.test(popTitleRule), popTitleRule);

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
