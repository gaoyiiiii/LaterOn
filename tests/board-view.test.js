// 把真实的 library.js 放进假 DOM 里跑，检查「图板」视图与全屏侧栏：
//  1) 全部项目默认就是图板视图（一个类目一张图板，等待整理不占块）
//  2) 封面是该类目里几篇收藏拼出来的：有封面的优先，最多 3 张
//  3) 没写过简介时自动生成一句概览；写过就用写的那句
//  4) 点图板进入该类目看卡片列表；侧栏的项目列表任何时候都列着（不用先钻进去）
//  5) 顶部「未读 / 已读」筛选照样影响图板上的篇数
//  6) 不再有手动「卡片/图板」切换；全部项目恒为图板，等待整理/项目恒为卡片
// 用 jsdom 而不是真浏览器，只是为了让这个检查能在命令行里快速反复跑。
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");

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
const item = (id, extra) => ({
  id, title: `标题 ${id}`, description: "摘要", image: "", favicon: "",
  source: "未知", url: `https://example.com/${id}`, savedAt: now, read: false, ...extra
});
const store = {
  laterOnItems: [
    item("w1", { image: "https://example.com/1.jpg", source: "少数派", projectId: "work" }),
    item("w2", { image: "https://example.com/2.jpg", source: "少数派", projectId: "work", savedAt: now - 3600000 }),
    item("w3", { image: "https://example.com/3.jpg", source: "知乎", projectId: "work", savedAt: now - 7200000 }),
    item("w4", { source: "知乎", projectId: "work", savedAt: now - 10800000, read: true }),
    item("r1", { source: "豆瓣", projectId: "read" }),
    item("u1", { image: "https://example.com/5.jpg", source: "B站", projectId: null })
  ],
  laterOnProjects: [
    { id: "work", name: "工作", createdAt: 1 },
    { id: "read", name: "阅读", createdAt: 2 },
    { id: "empty", name: "空抽屉", createdAt: 3 }   // 一篇收藏都没有 → 不该出现在图板上
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
    query: () => Promise.resolve([{ id: 1, windowId: 1 }]),
    create: () => Promise.resolve({ id: 2 })
  },
  runtime: { getURL: (p) => `chrome-extension://lateron/${p}`, onMessage: { addListener() {} } }
};

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 5) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

// jsdom 不解码图片、也没有 canvas：给「上传封面」造一套替身，
// 这样项目封面这条链路也能在没有浏览器的环境里跑通。
const FAKE_COVER = "data:image/jpeg;base64,BOARDCOVER";
Object.defineProperty(window.HTMLImageElement.prototype, "src", {
  configurable: true,
  get() { return this.getAttribute("src") || ""; },
  set(value) {
    this.setAttribute("src", value);
    this.__w = 1600;
    this.__h = 900;
    // 压缩是先 new Image() 载入再画到 canvas 上，所以这里要像真浏览器那样
    // 在下一个 tick 里回一个 load 事件，否则 Promise 永远不会 resolve。
    const self = this;
    window.setTimeout(() => { if (typeof self.onload === "function") self.onload(); }, 0);
  }
});
Object.defineProperty(window.HTMLImageElement.prototype, "naturalWidth", {
  configurable: true, get() { return this.__w || 0; }
});
Object.defineProperty(window.HTMLImageElement.prototype, "naturalHeight", {
  configurable: true, get() { return this.__h || 0; }
});
window.HTMLCanvasElement.prototype.getContext = function () {
  return { fillStyle: "", fillRect() {}, drawImage() {} };
};
window.HTMLCanvasElement.prototype.toDataURL = function () { return FAKE_COVER; };

// 模拟用户在文件选择框里选一张图（和 cover-upload 测试同一套做法）。
async function pickCoverFile(file) {
  click(dialog().querySelector(".lod-cover-btn"));
  await tick(10);
  const input = dialog().querySelector('.lod-cover input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change"));
  await tick(60);
}

window.eval(dialogSource);
window.eval(librarySource);

const boardGrid = () => document.querySelector("#boardGrid");
const cardGrid = () => document.querySelector("#cardGrid");
const boardCards = () => [...document.querySelectorAll(".board-card")];
const boardOf = (id) => boardCards().find((card) => card.dataset.project === id);
const dialog = () => document.querySelector(".lod-root:not([hidden])");
const text = (el, selector) => el?.querySelector(selector)?.textContent || "";

(async () => {
  await tick(30);

  console.log("── 全部项目默认就是图板视图 ──");
  check("打开就是图板视图（全部项目 = 图板）", !boardGrid().hidden && cardGrid().hidden);
  check("已经没有手动切换的视图按钮", !document.querySelector("#viewSwitch") && !document.querySelector(".view-btn"));
  check("排序下拉在图板视图下收起（顺序对图板没意义）", document.querySelector("#sortSelect").hidden);
  // 项目列表常显：在全部项目里也要能直接看到并点进任意项目，不用先钻进去。
  // 顺带静态锁住 HTML 里那份 markup：别再给它挂 hidden 变成「默认收起」。
  check("默认（全部项目）下项目列表就显示着", document.querySelector(".projects-section").hidden === false && !!document.querySelector('#projectList .project-row[data-id="work"]'));
  check("HTML 里 .projects-section 没有挂着 hidden", /class="projects-section"(?![^>]*\shidden)/.test(html));

  console.log("\n── 一个类目一张图板 ──");
  check("两个项目 = 2 张图板", boardCards().length === 2, boardCards().map((c) => c.dataset.project).join(","));
  check("一篇收藏都没有的项目不显示图板", !boardOf("empty"), boardCards().map((c) => c.dataset.project).join(","));
  check("图板上写着类目名", text(boardOf("work"), ".board-name") === "工作", text(boardOf("work"), ".board-name"));
  check("「等待整理」不再单独占一块图板", !boardOf("unfiled"));
  // 等待整理那 1 篇不进任何图板；全部项目统计只描述项目图板本身。
  check("顶部计数改成按类目算且不混入等待整理", /2 个类目 · 共 5 篇收藏 · 4 篇没看完/.test(document.querySelector("#countText").textContent) && !document.querySelector("#countText").textContent.includes("等待整理"), document.querySelector("#countText").textContent);
  // 侧栏：全屏页面里「等待整理」要钉在最上面，而且有内容时整块高亮
  const inbox = document.querySelector(".inbox-card");
  check("侧栏有「等待整理」这块，而且钉在最上面", !!inbox && document.querySelector(".project-sidebar").firstElementChild === inbox);
  check("点它进的是等待整理范围", inbox.dataset.project === "unfiled");
  check("有等待整理的收藏时整块高亮", inbox.classList.contains("has-items"));
  check("提示写明还有几篇没归位", inbox.querySelector(".inbox-hint").textContent === "1 篇还没归到项目", inbox.querySelector(".inbox-hint").textContent);
  check("篇数写在右侧的圆形角标里", inbox.querySelector("#unfiledCount").textContent === "1", inbox.querySelector("#unfiledCount").textContent);
  const topNavs = [...document.querySelectorAll(".project-sidebar > .project-nav")];
  check("侧栏顶层只有「等待整理 + 全部项目」两项（平级）", topNavs.length === 2 && topNavs[0].dataset.project === "unfiled" && topNavs[1].dataset.project === "all", topNavs.map((n) => n.dataset.project).join(","));

  console.log("\n── 组合封面 ──");
  const workCover = boardOf("work").querySelector(".board-cover");
  check("工作类目有 3 篇带封面 → 拼 3 格", workCover.querySelectorAll(".board-cell").length === 3 && workCover.dataset.count === "3", workCover.dataset.count);
  const workImages = [...workCover.querySelectorAll(".board-img")].map((img) => img.getAttribute("src"));
  check("用的确实是该项目里的封面", workImages.every((src) => /1\.jpg|2\.jpg|3\.jpg/.test(src)), workImages.join(" "));
  const readCover = boardOf("read").querySelector(".board-cover");
  check("阅读类目没有带封面的 → 只拼 1 格", readCover.dataset.count === "1");
  check("没封面时是一块干净的空白底，不塞图标", readCover.querySelectorAll("img").length === 0);

  console.log("\n── 类目简介 ──");
  const workNote = boardOf("work").querySelector(".board-note");
  check("没写过简介时自动生成一句概览", /主要来自 少数派/.test(workNote.textContent), workNote.textContent);
  check("自动生成的简介标成 is-auto（显示更淡）", workNote.classList.contains("is-auto"));
  check("篇数写在最下面", text(boardOf("work"), ".board-meta") === "4 篇 · 3 篇没看完", text(boardOf("work"), ".board-meta"));
  check("读完了的类目写「都读完了」", text(boardOf("read"), ".board-meta") === "1 篇 · 1 篇没看完", text(boardOf("read"), ".board-meta"));

  console.log("\n── 自己写一句简介 ──");
  click(boardOf("work").querySelector(".board-edit"));
  await tick(30);
  check("弹出了编辑项目的弹窗", !!dialog() && /编辑「工作」/.test(dialog().querySelector(".lod-title").textContent), dialog()?.querySelector(".lod-title")?.textContent);
  const field = dialog().querySelector('[data-field="note"]');
  check("弹窗里有一个简介输入框", !!field);
  check("弹窗里也能改项目名称", !!dialog().querySelector('[data-field="name"]'));
  check("弹窗里也能改封面", dialog().querySelector(".lod-cover")?.hidden === false);
  // 项目没设过自定义封面时，弹窗里要显示「这个项目现在真正在用的那张」
  // （项目里第一篇的封面，也就是侧栏缩略图显示的那张），而不是「无封面」。
  const coverPreview = dialog().querySelector(".lod-cover-preview img");
  check("封面默认显示项目在用的那张，而不是「无封面」",
    coverPreview?.getAttribute("src") === "https://example.com/1.jpg", coverPreview?.getAttribute("src"));
  check("并说明这张是按项目内容自动取的", /自动取的/.test(dialog().querySelector(".lod-cover-note").textContent),
    dialog().querySelector(".lod-cover-note").textContent);
  check("自动取的封面不给「移除」（移了还是它，按钮会骗人）",
    dialog().querySelectorAll(".lod-cover-btn")[1].disabled === true);
  field.value = "工作相关的长文和工具";
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
  click(dialog().querySelector(".lod-ok"));
  await tick(320);   // 弹窗有一段关闭动画，等它真正 resolve
  check("简介写进了存储", store.laterOnProjects.find((p) => p.id === "work").note === "工作相关的长文和工具", JSON.stringify(store.laterOnProjects[0].note));
  check("只改简介时不会把自动封面「固化」成项目自己的封面",
    !store.laterOnProjects.find((p) => p.id === "work").cover, String(store.laterOnProjects.find((p) => p.id === "work").cover));
  const savedNote = boardOf("work").querySelector(".board-note");
  check("图板上显示的是自己写的那句", savedNote.textContent === "工作相关的长文和工具", savedNote.textContent);
  check("手写简介不再标成自动生成", !savedNote.classList.contains("is-auto"));

  console.log("\n── 给项目换一张自己的封面 ──");
  click(boardOf("work").querySelector(".board-edit"));
  await tick(30);
  const boardFile = new window.File([new Uint8Array([1, 2, 3])], "mine.png", { type: "image/png" });
  await pickCoverFile(boardFile);
  check("上传后预览是自己的那张", dialog().querySelector(".lod-cover-preview img")?.getAttribute("src") === FAKE_COVER);
  check("有了自定义封面，「移除封面」就可点了", dialog().querySelectorAll(".lod-cover-btn")[1].disabled === false);
  click(dialog().querySelector(".lod-ok"));
  await tick(320);
  const workProject = () => store.laterOnProjects.find((p) => p.id === "work");
  check("封面写进了项目", workProject().cover === FAKE_COVER, String(workProject().cover).slice(0, 40));
  const customCover = boardOf("work").querySelector(".board-cover");
  check("图板整块铺满这张封面（不再拼多篇）", customCover.dataset.count === "1" &&
    customCover.querySelector(".board-img")?.getAttribute("src") === FAKE_COVER, customCover.dataset.count);

  // 再打开一次：这次显示的是「自己的封面」，所以「移除封面」可点。
  click(boardOf("work").querySelector(".board-edit"));
  await tick(30);
  check("再打开时预览显示的是自定义封面",
    dialog().querySelector(".lod-cover-preview img")?.getAttribute("src") === FAKE_COVER);
  check("自定义封面可以移除", dialog().querySelectorAll(".lod-cover-btn")[1].disabled === false);
  click(dialog().querySelectorAll(".lod-cover-btn")[1]);
  await tick(20);
  click(dialog().querySelector(".lod-ok"));
  await tick(320);
  check("移除封面后项目里不再留着它", !workProject().cover, String(workProject().cover));
  check("图板退回「按内容拼封面」", boardOf("work").querySelector(".board-cover").dataset.count === "3",
    boardOf("work").querySelector(".board-cover").dataset.count);

  console.log("\n── 点图板进类目 ──");
  click(boardOf("work"));
  await tick(30);
  check("切到了「工作」项目", store.laterOnActiveProject === "work", store.laterOnActiveProject);
  check("进类目后回到卡片视图", cardGrid().hidden === false && boardGrid().hidden);
  check("卡片只剩这个类目里的 4 篇", cardGrid().querySelectorAll(".card").length === 4, String(cardGrid().querySelectorAll(".card").length));
  check("钻进项目后，项目列表照样显示", document.querySelector(".projects-section").hidden === false);
  check("列表里有这个项目", !!document.querySelector('#projectList .project-row[data-id="work"]'));

  console.log("\n── 回到全部项目还是图板 ──");
  click(document.querySelector('.project-nav[data-project="all"]'));
  await tick(30);
  check("又是图板视图", !boardGrid().hidden && cardGrid().hidden);
  check("回到全部项目后，项目列表仍然显示", document.querySelector(".projects-section").hidden === false);

  console.log("\n── 顶部筛选照样生效 ──");
  click(document.querySelector('.nav-item[data-filter="done"]'));
  await tick(30);
  check("只看已读时，工作类目只剩 1 篇", text(boardOf("work"), ".board-meta") === "1 篇 · 都读完了", text(boardOf("work"), ".board-meta"));
  check("当前筛选下没有内容的类目也不显示", !boardOf("read"));
  click(document.querySelector('.nav-item[data-filter="all"]'));
  await tick(30);
  check("切回全部又恢复 4 篇", text(boardOf("work"), ".board-meta") === "4 篇 · 3 篇没看完");

  console.log("\n── 点左上角品牌标识 = 回全屏首页 ──");
  // 先把页面弄「脏」：钻进某个项目 + 筛选拨到「未读」+ 搜索框里留个字。
  click(document.querySelector('#projectList .project-nav[data-project="read"]'));
  await tick(30);
  click(document.querySelector('.nav-item[data-filter="unread"]'));
  await tick(30);
  const searchBox = document.querySelector("#searchInput");
  searchBox.value = "zzz查不到的东西";
  searchBox.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(160);
  check("（准备）已经钻进了「阅读」这个项目", store.laterOnActiveProject === "read", String(store.laterOnActiveProject));
  check("（准备）筛选在「未读」、搜索框里有字", store.laterOnFilter === "unread" && searchBox.value === "zzz查不到的东西");

  // jsdom 不实现 window.scrollTo（会往 virtualConsole 里塞「Not implemented」错误，
  // 而本文件末尾断言「整个过程没有未捕获的错误」），所以这里换个替身，顺便记下滚动请求。
  const scrollCalls = [];
  window.scrollTo = (options) => scrollCalls.push(options);

  const brand = document.querySelector("#homeBrand");
  check("左上角的品牌标识是个可点的链接", brand?.tagName === "A" && brand.getAttribute("aria-label") === "LaterOn 首页", brand?.outerHTML?.slice(0, 50));
  click(brand);
  await tick(60);
  check("回到「全部项目」", store.laterOnActiveProject === "all", String(store.laterOnActiveProject));
  check("视图跟着变回图板", !boardGrid().hidden && cardGrid().hidden);
  check("筛选复到「全部」", store.laterOnFilter === "all", String(store.laterOnFilter));
  check("搜索词被清空", searchBox.value === "");
  check("搜索没有残留（图板上又看得见类目了）", boardGrid().querySelectorAll(".board-card").length > 0,
    String(boardGrid().querySelectorAll(".board-card").length));
  check("侧栏里「全部项目」亮着选中态", document.querySelector('.project-nav[data-project="all"]').classList.contains("active"));
  check("滚回了页面顶部", scrollCalls.length === 1 && scrollCalls[0].top === 0, JSON.stringify(scrollCalls));

  // 反向验证用：把 library.js 里 goHome() 的清搜索那一行删掉，上面「搜索词被清空」必须变红。
  check("goHome 里确实清了搜索词", /if \(searchInput\.value\) searchInput\.value = "";/.test(librarySource));

  console.log("\n── 页面错误 ──");
  check("整个过程没有出现未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures ? `\n有 ${failures} 项失败` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
