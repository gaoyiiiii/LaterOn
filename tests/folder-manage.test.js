// 把真实的 library.js 放进一个假 DOM 里跑一遍，检查「项目」的管理交互：
//  1) 图板墙末尾的虚线加号打开新建项目弹窗
//  2) 新建成功后自动进入项目，侧栏项目列表随之出现
//  3) 重名不重复创建
//  4) 双击改名 / 回车保存 / Esc 取消 / 点到别处自动保存 / 重名被拒绝
//  5) 右键与「⋯」都能打开菜单，点别处或 Esc 关闭
//  6) 删除项目：取消不删；确认后里面的收藏移到等待整理、当前项目切回全部
//  7) 拖拽收藏到项目仍然有效（监听挂在整行上）
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const i18nSource = fs.readFileSync(`${ROOT}/i18n.js`, "utf8");
// 确认框现在走自定义弹窗，所以把 dialog.js 也一起加载进来跑真实的组件。
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
// 侧栏那套样式的源码：下面有几条「静态断言」用它锁住纯视觉的规矩
// （jsdom 不做排版，「文字贴在缩略图上」这种问题它永远测不出来）。
const libraryCss = fs.readFileSync(`${ROOT}/library.css`, "utf8");

// 页面里任何未捕获的错误都记下来，最后统一断言（防止出现「改了没生效」这类静默失败）。
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

// ── 假的 chrome API ─────────────────────────────────────────
const now = Date.now();
const store = {
  laterOnItems: [
    { id: "i1", title: "文章一", description: "摘要一", image: "", favicon: "", source: "a.com", projectId: "work", url: "https://a.com/1", savedAt: now, read: false },
    { id: "i2", title: "文章二", description: "摘要二", image: "", favicon: "", source: "b.com", projectId: null, url: "https://b.com/2", savedAt: now - 1000, read: true },
    { id: "i3", title: "文章三", description: "摘要三", image: "", favicon: "", source: "c.com", projectId: "work", url: "https://c.com/3", savedAt: now - 2000, read: false }
  ],
  // 「工作」带一个封面：用来验证侧栏项目行左侧显示的是缩略图（图板风格），不是文件夹图标。
  laterOnProjects: [{ id: "work", name: "工作", createdAt: 1, cover: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }],
  laterOnActiveProject: "all",
  laterOnSettings: {},
  laterOnFilter: "all",
  laterOnFilterChosen: true,
};
const changeListeners = [];
const createdTabs = [];
// 记录「有没有用上浏览器自带弹窗」：现在所有确认/提示都该走自定义弹窗，这里用来兜底。
const nativeDialogs = [];
let idSeq = 0;

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
        // 真实 Chrome 在这里会触发 onChanged；页面靠它刷新，测试也照做。
        window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, windowId: 1 }]),
    create: (options) => { createdTabs.push(options); return Promise.resolve({ id: 2 }); }
  },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: () => Promise.resolve({ ready: true }),
    onMessage: { addListener() {} }
  }
};
window.confirm = (message) => { nativeDialogs.push(String(message)); return true; };
window.alert = (message) => { nativeDialogs.push(String(message)); };
if (typeof window.crypto?.randomUUID !== "function") {
  Object.defineProperty(window, "crypto", {
    configurable: true,
    value: { randomUUID: () => `fake-id-${++idSeq}` }
  });
}

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 5) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const dblclick = (el) => el.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
const pointerdown = (el) => el.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
const pressKey = (el, key) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }));
const dragEvent = (el, type, dataTransfer) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.dataTransfer = dataTransfer;
  el.dispatchEvent(event);
};

window.eval(i18nSource);
window.eval(dialogSource);
window.eval(librarySource);

const projectRows = () => [...document.querySelectorAll("#projectList .project-row")];
const rowOf = (id) => projectRows().find((row) => row.dataset.id === id);
const folderByName = (name) => store.laterOnProjects.find((project) => project.name === name);
const menuItems = () => [...document.querySelectorAll(".folder-menu .folder-menu-item")];
// 按名字找菜单项：菜单项会随功能增加，写死下标（menuItems()[1]）会一加功能就错位。
const menuItem = (label) => menuItems().find((item) => item.textContent === label);
const toastText = () => document.querySelector("#toast").textContent;
const cardFolderOptions = () => [...document.querySelectorAll(".card .project-select")]
  .flatMap((select) => [...select.options].map((option) => option.textContent));

(async () => {
  await tick(20);
  console.log("── 初始状态 ──");
  check("侧栏列出了已有项目", projectRows().length === 1, projectRows().map((r) => r.dataset.id).join(", "));
  // 左侧改成项目缩略图（和「选项目」浮层同一套外观）：有封面就显示封面图，没有就首字色块占位。
  check("行里左侧是封面缩略图", !!rowOf("work")?.querySelector(".project-thumb img"), rowOf("work")?.querySelector(".project-thumb")?.innerHTML);
  check("不再用文件夹图标", !rowOf("work")?.querySelector(".folder-icon"));
  check("行里显示名字与数量", rowOf("work")?.querySelector(".project-name").textContent === "工作" && rowOf("work")?.querySelector("strong").textContent === "2");
  check("行里带「⋯」更多按钮", !!rowOf("work")?.querySelector(".project-more"));

  console.log("\n── 新建项目：图板末尾虚线加号 ──");
  const createBoard = document.querySelector(".board-create");
  check("全部项目图板末尾有新建入口", !!createBoard && createBoard === document.querySelector("#boardGrid").lastElementChild);
  click(createBoard);
  await tick();
  const nameInput = document.querySelector('.lod-root:not([hidden]) [data-field="name"]');
  check("点虚线加号打开应用内弹窗", !!nameInput);
  nameInput.value = "  设计灵感  ";
  click(document.querySelector(".lod-root:not([hidden]) .lod-ok"));
  await tick(300);
  const design = folderByName("设计灵感");
  check("项目真的写进了存储，且名称去了空格", !!design, JSON.stringify(store.laterOnProjects.map((p) => p.name)));
  check("侧栏里多出这一行", projectRows().length === 2);
  // 新项目还没有任何封面：缩略图位置退回「项目名首字 + 暖色底」的占位块，不是空白。
  check("没有封面的项目用首字占位缩略图", rowOf(design?.id)?.querySelector(".project-thumb .project-ph")?.textContent === "设", rowOf(design?.id)?.querySelector(".project-thumb")?.innerHTML);
  check("新建后自动跳到该项目", store.laterOnActiveProject === design?.id && rowOf(design?.id)?.querySelector(".project-nav").classList.contains("active"));
  check("给了「已新建」的提示", /已新建项目/.test(toastText()), toastText());
  // 回到「等待整理」——新项目是空的，只有切到卡片视图（等待整理 / 某个项目）下拉里才看得到。
  click(document.querySelector('.project-nav[data-project="unfiled"]'));
  await tick(10);
  check("收藏卡片上的「所属项目」下拉里也能选到新项目", cardFolderOptions().includes("设计灵感"), cardFolderOptions().join("/"));

  console.log("\n── 新建重名项目 ──");
  click(document.querySelector('.project-nav[data-project="all"]'));
  await tick(10);
  click(document.querySelector(".board-create"));
  await tick();
  const duplicateNameInput = document.querySelector('.lod-root:not([hidden]) [data-field="name"]');
  duplicateNameInput.value = "工作";
  click(document.querySelector(".lod-root:not([hidden]) .lod-ok"));
  await tick(300);
  check("重名不会再建一个", store.laterOnProjects.filter((p) => p.name === "工作").length === 1);
  check("给出同名提示并跳到已有的那个", /已有同名项目/.test(toastText()) && store.laterOnActiveProject === "work", toastText());

  console.log("\n── 就地改名 ──");
  dblclick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  const renameInput = document.querySelector(".project-rename");
  check("双击项目出现改名输入框", !!renameInput);
  check("输入框里是当前名字", renameInput?.value === "工作", renameInput?.value);
  check("输入框自动获得焦点", document.activeElement === renameInput);
  renameInput.value = "工作资料";
  pressKey(renameInput, "Enter");
  await tick(10);
  check("回车保存新名字", folderByName("工作资料")?.id === "work", JSON.stringify(store.laterOnProjects.map((p) => p.name)));
  check("侧栏文字同步更新", rowOf("work")?.querySelector(".project-name").textContent === "工作资料");
  check("改名结束后输入框消失", !document.querySelector(".project-rename"));
  check("给了「已重命名」的提示", /已重命名/.test(toastText()), toastText());
  check("卡片下拉里的名字也跟着更新", cardFolderOptions().includes("工作资料") && !cardFolderOptions().includes("工作"), cardFolderOptions().join("/"));

  console.log("\n── 改名：Esc 取消 ──");
  dblclick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  const escInput = document.querySelector(".project-rename");
  escInput.value = "这个名字不要";
  pressKey(escInput, "Escape");
  await tick(10);
  check("Esc 取消，名字保持不变", store.laterOnProjects.find((p) => p.id === "work").name === "工作资料");
  check("Esc 后输入框消失", !document.querySelector(".project-rename"));

  console.log("\n── 改名：点到别处自动保存 ──");
  dblclick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  const blurInput = document.querySelector(".project-rename");
  blurInput.value = "工作与灵感";
  pointerdown(document.querySelector("main"));
  blurInput.blur();
  await tick(10);
  check("点到别处会把新名字存下来", store.laterOnProjects.find((p) => p.id === "work").name === "工作与灵感");

  console.log("\n── 改名：重名被拒绝 ──");
  dblclick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  const dupInput = document.querySelector(".project-rename");
  dupInput.value = "设计灵感";
  dupInput.blur();
  await tick(10);
  check("重名不会被改写", store.laterOnProjects.find((p) => p.id === "work").name === "工作与灵感");
  check("给出同名提示", /已有同名项目/.test(toastText()), toastText());

  console.log("\n── 右键菜单 ──");
  rightClick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  check("右键弹出菜单", !!document.querySelector(".folder-menu"));
  check("菜单里是「置顶项目 / 重命名 / 编辑简介 / 删除项目」", menuItems().map((item) => item.textContent).join(" / ") === "置顶项目 / 重命名 / 编辑简介 / 删除项目", menuItems().map((i) => i.textContent).join(" / "));
  check("菜单顶部标着项目名", document.querySelector(".folder-menu-title")?.textContent === "工作与灵感");
  pointerdown(document.body);
  await tick(10);
  check("点别处菜单自动关闭", !document.querySelector(".folder-menu"));

  click(rowOf("work").querySelector(".project-more"));
  await tick(10);
  check("点「⋯」也能打开同一个菜单", !!document.querySelector(".folder-menu"));
  pressKey(document, "Escape");
  await tick(10);
  check("Esc 关闭菜单", !document.querySelector(".folder-menu"));

  console.log("\n── 删除项目 ──");
  click(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  check("先选中这个项目", store.laterOnActiveProject === "work", store.laterOnActiveProject);

  const dialog = () => document.querySelector(".lod-root:not([hidden])");
  const dialogText = (selector) => dialog()?.querySelector(selector)?.textContent || "";

  // ① 弹出的是自定义弹窗，点「取消」不删除
  rightClick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  click(menuItem("删除项目"));
  await tick(20);
  check("删除前弹出了自定义弹窗（不再是浏览器自带）", !!dialog());
  check("弹窗是危险操作的红色主题", dialog()?.dataset.tone === "danger", dialog()?.dataset.tone);
  check("弹窗标题写明是哪个项目", /删除项目「工作与灵感」/.test(dialogText(".lod-title")), dialogText(".lod-title"));
  check("弹窗写清会影响几篇网页", /2 篇网页会移到/.test(dialogText(".lod-message")), dialogText(".lod-message"));
  check("确认按钮写明动作", dialogText(".lod-ok") === "删除项目", dialogText(".lod-ok"));
  click(dialog().querySelector(".lod-cancel"));
  await tick(300);
  check("点「取消」不会删除", !!folderByName("工作与灵感"));
  check("取消后弹窗收起来了", !dialog());

  // ② 按 Esc 同样取消
  rightClick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  click(menuItem("删除项目"));
  await tick(20);
  pressKey(dialog(), "Escape");
  await tick(300);
  check("按 Esc 也不会删除", !!folderByName("工作与灵感"));

  // ③ 点确认按钮才真的删除
  rightClick(rowOf("work").querySelector(".project-nav"));
  await tick(10);
  click(menuItem("删除项目"));
  await tick(20);
  click(dialog().querySelector(".lod-ok"));
  await tick(300);
  check("确认后项目被删除", !store.laterOnProjects.some((p) => p.id === "work"));
  check("收藏一篇都没丢", store.laterOnItems.length === 3, `${store.laterOnItems.length} 条`);
  check("里面的收藏被移到「等待整理」", store.laterOnItems.every((item) => item.projectId !== "work"), store.laterOnItems.map((i) => i.projectId).join(","));
  check("删除后自动切回「全部收藏」", store.laterOnActiveProject === "all", store.laterOnActiveProject);
  check("侧栏里已经没有这一行", !projectRows().some((row) => row.dataset.id === "work"));
  check("「等待整理」计数同步更新", document.querySelector("#unfiledCount").textContent === "3", document.querySelector("#unfiledCount").textContent);
  check("删除后菜单关闭", !document.querySelector(".folder-menu"));

  console.log("\n── 拖拽收藏到项目（监听已挪到整行）──");
  const dataTransfer = { dropEffect: "", getData: () => "i2", setData() {} };
  const designRow = rowOf(design.id);
  dragEvent(designRow, "dragover", dataTransfer);
  check("拖到整行上会高亮", designRow.classList.contains("drop-target"));
  dragEvent(designRow, "drop", dataTransfer);
  await tick(20);
  check("放下后收藏进入该项目", store.laterOnItems.find((item) => item.id === "i2")?.projectId === design.id, String(store.laterOnItems.find((item) => item.id === "i2")?.projectId));
  check("高亮已经清掉", !designRow.classList.contains("drop-target"));

  console.log("\n── 项目行的视觉规矩（静态锁，jsdom 看不出排版）──");
  // 项目行左侧是「实心缩略图」而不是线框图标：图标时代它自带一圈留白，
  // 换成缩略图后如果不显式给列间距，文字会直接贴在图上——这只有肉眼看得见。
  // ⚠️ 一律用「行首的裸选择器」去抓基础规则（^ + m）：文件里还有
  // `.folder-drag-preview .project-more`、`.project-nav.active .project-thumb` 这类
  // 带前缀的变体，不锚行首就会抓到那个没有 width/right 的版本，断言静默失效。
  const ruleOf = (selector) =>
    new RegExp(`^${selector}[^{]*\\{[^}]*\\}`, "m").exec(libraryCss)?.[0] || "";
  const navBase = ruleOf("\\.project-nav");
  const colGap = Number(/column-gap:\s*(\d+)px/.exec(navBase)?.[1] || 0);
  const firstCol = Number(/grid-template-columns:\s*(\d+)px/.exec(navBase)?.[1] || 0);
  const thumbW = Number(/width:\s*(\d+)px/.exec(ruleOf("\\.project-thumb"))?.[1] || 0);
  const thumbImg = ruleOf("\\.project-thumb\\s+img");
  const phRule = ruleOf("\\.project-ph");
  check("项目行声明了列间距（否则文字会贴着缩略图）", colGap >= 6, `column-gap=${colGap}px`);
  check("缩略图宽度和栅格第一列一致（对不齐就会挤出格子）", firstCol > 0 && firstCol === thumbW, `列=${firstCol}px 缩略图=${thumbW}px`);
  check("缩略图是圆角方块、图片裁切填充", /border-radius/.test(ruleOf("\\.project-thumb")) && /object-fit:\s*cover/.test(thumbImg));
  check("没有封面时用首字占位块（居中 + 暖色底，不是空白）", /place-items:\s*center/.test(phRule) && /linear-gradient/.test(phRule));
  // 右侧「⋯」是绝对定位的，项目行为它留了 padding-right：留的位子必须够，否则会压住篇数小圆标。
  const padRight = Number(/padding-right:\s*(\d+)px/.exec(ruleOf("\\.project-row\\s+\\.project-nav"))?.[1] || 0);
  const moreRule = ruleOf("\\.project-more");
  const moreRight = Number(/right:\s*(\d+)px/.exec(moreRule)?.[1] || 0);
  const moreW = Number(/width:\s*(\d+)px/.exec(moreRule)?.[1] || 0);
  check("「⋯」占的横向空间没超出给它的留白（不会压住篇数）", padRight > 0 && moreRight + moreW <= padRight, `留白=${padRight}px ⋯=${moreRight}+${moreW}=${moreRight + moreW}px`);
  const createRule = ruleOf("\\.board-create");
  check("新建项目图板使用虚线边框", /border:[^;]*dashed/.test(createRule), createRule);
  check("新建项目图板与普通封面使用相同宽高比", /aspect-ratio:\s*1\.42/.test(createRule), createRule);
  const nestedSection = ruleOf("\\.projects-section\\.is-visible");
  const nestedNav = ruleOf("\\.projects-section\\s+\\.project-nav");
  const nestedFirstCol = Number(/grid-template-columns:\s*(\d+)px/.exec(nestedNav)?.[1] || 0);
  check("项目列表整体右缩，明确从属于全部项目", /margin:[^;]*0 0 (?:2[4-9]|[3-9]\d)px/.test(nestedSection), nestedSection);
  check("子级列表不画树状竖线", !/\.projects-section\.is-visible::before/.test(libraryCss));
  check("子级项目缩略图小于顶层入口", nestedFirstCol > 0 && nestedFirstCol < firstCol, "顶层=" + firstCol + "px 子级=" + nestedFirstCol + "px");

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现任何未捕获的错误", errors.length === 0, errors.join(" | "));
  check("全程没有调用浏览器自带的弹窗", nativeDialogs.length === 0, nativeDialogs.join(" | "));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
