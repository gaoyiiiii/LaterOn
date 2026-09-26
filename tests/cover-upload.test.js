// 自己上传封面 —— 三段验证：
//   ① 弹窗里的封面区：预览、上传（自动压缩）、移除、返回的值
//   ② 后台重复收藏时：用户自己定的封面不能被自动抓取的结果顶掉
//   ③ 收藏库页面上的完整链路：点编辑 → 换封面 / 移封面 → 卡片立刻变样 → 写进库
// 运行：NODE_PATH=<jsdom 路径> node tests/cover-upload.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const BACKGROUND = read("background.js");
const DIALOG_SOURCE = read("dialog.js");
const DIALOG_CSS = read("dialog.css");
const LIBRARY_SOURCE = read("library.js");
const LIBRARY_HTML = read("library.html");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

const FAKE_DATA_URL = "data:image/jpeg;base64,TESTCOVER";

// jsdom 不会真的解码图片、也没有 canvas 实现，这里把「图片加载 + 压缩」替身掉：
// 图片一设 src 就在下一个 tick 里报 1600×900 的尺寸（用来验证缩放规则），
// canvas 只记录画了多大、返回固定的 data URL。
function stubImagePipeline(window, { width = 1600, height = 900 } = {}) {
  const calls = { drawImage: [], toDataURL: [] };
  Object.defineProperty(window.HTMLImageElement.prototype, "src", {
    configurable: true,
    get() { return this.getAttribute("src") || ""; },
    set(value) {
      this.setAttribute("src", value);
      this.__w = width;
      this.__h = height;
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
    return {
      fillStyle: "",
      fillRect() {},
      drawImage: (...args) => calls.drawImage.push(args.slice(1))
    };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function (...args) {
    calls.toDataURL.push(args);
    return FAKE_DATA_URL;
  };
  return calls;
}

// 模拟用户在文件选择框里选了一张图。
async function pickFile(window, file, tick) {
  const root = window.document.querySelector(".lod-root:not([hidden])");
  const pickBtn = root.querySelector(".lod-cover-btn");
  pickBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(10);
  const fileInput = root.querySelector('.lod-cover input[type="file"]');
  Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
  fileInput.dispatchEvent(new window.Event("change"));
  await tick(60);
}

// ═══════════════════════════════════════════════════════════
// ① 弹窗里的封面区
// ═══════════════════════════════════════════════════════════
async function partDialog() {
  console.log("\n── ① 弹窗里的封面上传区 ──");
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${DIALOG_CSS}</style></head><body></body></html>`,
    { runScripts: "outside-only", pretendToBeVisual: true, url: "chrome-extension://lateron/library.html" }
  );
  const { window } = dom;
  const { document } = window;
  const calls = stubImagePipeline(window);
  window.eval(DIALOG_SOURCE);

  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const visible = () => document.querySelector(".lod-root:not([hidden])");

  // ── 没传 cover 配置：不显示封面区（老的调用方式不受影响）──
  let plain;
  window.LaterOnDialog.prompt({ title: "只改文字", fields: [{ name: "title", label: "标题", value: "A" }] })
    .then((value) => { plain = value; });
  await tick();
  check("不传 cover 时不显示封面区", visible().querySelector(".lod-cover").hidden === true);
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("不传 cover 时结果里也没有 cover 字段", plain?.ok === true && !("cover" in (plain.values || {})), JSON.stringify(plain));

  // ── 有封面：显示预览 ──
  let withCover;
  window.LaterOnDialog.prompt({
    title: "编辑收藏",
    fields: [{ name: "title", label: "标题", value: "A" }],
    cover: { name: "cover", label: "封面", value: "https://site.com/a.jpg" }
  }).then((value) => { withCover = value; });
  await tick();
  check("封面区显示出来了", visible().querySelector(".lod-cover").hidden === false);
  check("预览显示现有封面", visible().querySelector(".lod-cover-preview img")?.getAttribute("src") === "https://site.com/a.jpg");
  check("有封面时「移除封面」可点", visible().querySelectorAll(".lod-cover-btn")[1].disabled === false);

  // ── 原样保存：值应等于传入的旧封面（调用方据此判断「没动过」）──
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("没动封面时返回原值", withCover?.values?.cover === "https://site.com/a.jpg", withCover?.values?.cover);

  // ── 上传一张 1600×900 的图 ──
  let uploaded;
  window.LaterOnDialog.prompt({
    title: "编辑收藏",
    fields: [{ name: "title", label: "标题", value: "A" }],
    cover: { name: "cover", label: "封面", value: "" }
  }).then((value) => { uploaded = value; });
  await tick();
  check("没有封面时预览显示占位文字", /无封面/.test(visible().querySelector(".lod-cover-preview").textContent));
  check("没有封面时「移除封面」是禁用的", visible().querySelectorAll(".lod-cover-btn")[1].disabled === true);

  const file = new window.File([new Uint8Array([1, 2, 3, 4])], "cover.png", { type: "image/png" });
  await pickFile(window, file, tick);
  check("上传后预览变成新图", visible().querySelector(".lod-cover-preview img")?.getAttribute("src") === FAKE_DATA_URL);
  check("提示已就绪", /已就绪/.test(visible().querySelector(".lod-cover-note").textContent));

  // 1600×900 → 最长边压到 720，另一边按比例（405）。
  const drawn = calls.drawImage.at(-1) || [];
  check("压缩到最长边 720（1600×900 → 720×405）", drawn[0] === 0 && drawn[1] === 0 && drawn[2] === 720 && drawn[3] === 405, JSON.stringify(drawn));
  const dataUrlCall = calls.toDataURL.at(-1) || [];
  check("存成 JPEG 且带压缩质量", dataUrlCall[0] === "image/jpeg" && typeof dataUrlCall[1] === "number" && dataUrlCall[1] < 1, JSON.stringify(dataUrlCall));

  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("保存后拿得到上传的封面（data URL）", uploaded?.values?.cover === FAKE_DATA_URL, String(uploaded?.values?.cover).slice(0, 40));

  // ── 移除封面 ──
  let removed;
  window.LaterOnDialog.prompt({
    title: "编辑收藏",
    fields: [{ name: "title", label: "标题", value: "A" }],
    cover: { name: "cover", label: "封面", value: "https://site.com/a.jpg" }
  }).then((value) => { removed = value; });
  await tick();
  click(visible().querySelectorAll(".lod-cover-btn")[1]);
  await tick(20);
  check("移除后预览回到「无封面」", /无封面/.test(visible().querySelector(".lod-cover-preview").textContent));
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("移除后返回空字符串（不是旧封面）", removed?.values?.cover === "", JSON.stringify(removed?.values?.cover));

  // ── 取消时不返回任何值 ──
  let cancelled;
  window.LaterOnDialog.prompt({
    title: "编辑收藏",
    fields: [{ name: "title", label: "标题", value: "A" }],
    cover: { name: "cover", label: "封面", value: "https://site.com/a.jpg" }
  }).then((value) => { cancelled = value; });
  await tick();
  click(visible().querySelector(".lod-cancel"));
  await tick(300);
  check("取消时 values 为 null", cancelled?.ok === false && cancelled.values === null);

  // ── derived：预览里的图是「按内容自动取的」，不是用户自己的封面 ──
  // 项目图板就是这么用的（项目没设过封面时，显示集合里第一篇的封面）。
  // 这种封面照样要显示出来（不能写「无封面」），但「移除」没有意义 → 按钮先禁用。
  let derived;
  window.LaterOnDialog.prompt({
    title: "编辑项目",
    fields: [{ name: "name", label: "项目名称", value: "视频创作" }],
    cover: {
      name: "cover",
      label: "封面",
      value: "https://site.com/auto.jpg",
      derived: true,
      removedNote: "已改回自动取的封面，点「保存」生效"
    }
  }).then((value) => { derived = value; });
  await tick();
  check("derived 封面照样显示出来（不是「无封面」）",
    visible().querySelector(".lod-cover-preview img")?.getAttribute("src") === "https://site.com/auto.jpg");
  check("derived 封面不能「移除」（没有自定义封面可移除）",
    visible().querySelectorAll(".lod-cover-btn")[1].disabled === true);

  // 什么都不动就保存：返回值应等于传进去的那张，调用方据此判断「没动过」，
  // 从而不会把自动取的封面「固化」成项目自己的封面。
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("derived 封面没动过时，原样返回传进去的那张",
    derived?.values?.cover === "https://site.com/auto.jpg", derived?.values?.cover);

  // ── derived 的封面被换掉 / 清掉之后 ──
  let derived2;
  window.LaterOnDialog.prompt({
    title: "编辑项目",
    fields: [{ name: "name", label: "项目名称", value: "视频创作" }],
    cover: {
      name: "cover",
      label: "封面",
      value: "https://site.com/auto.jpg",
      derived: true,
      removedNote: "已改回自动取的封面，点「保存」生效"
    }
  }).then((value) => { derived2 = value; });
  await tick();

  // 传了自己的图之后，「移除」就该变得可点（此时有东西可移除了）。
  const derivedFile = new window.File([new Uint8Array([5, 5])], "mine.png", { type: "image/png" });
  await pickFile(window, derivedFile, tick);
  check("上传自己的图后「移除封面」变可点",
    visible().querySelectorAll(".lod-cover-btn")[1].disabled === false);

  const derivedRemove = visible().querySelectorAll(".lod-cover-btn")[1];
  click(derivedRemove);
  await tick(20);
  check("移除后预览回到「无封面」", /无封面/.test(visible().querySelector(".lod-cover-preview").textContent));
  check("移除后「移除封面」又变回禁用（回到自动取的封面）", derivedRemove.disabled === true);
  check("移除后的说明用的是调用方给的文案", /已改回自动取的封面/.test(visible().querySelector(".lod-cover-note").textContent),
    visible().querySelector(".lod-cover-note").textContent);
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("user 清掉封面后返回空字符串（和「没动过」区分得开）",
    derived2?.values?.cover === "", JSON.stringify(derived2?.values?.cover));

  const used = new Set();
  for (const matched of DIALOG_SOURCE.matchAll(/class="([^"]+)"/g)) matched[1].split(/\s+/).forEach((name) => used.add(name));
  const missingCss = [...used].filter((name) => name.startsWith("lod-") && !DIALOG_CSS.includes(`.${name}`));
  check("封面区用到的类名都在 CSS 里有样式", missingCss.length === 0, missingCss.join(", "));
}

// ═══════════════════════════════════════════════════════════
// ② 后台合并：别覆盖用户自己定的封面
// ═══════════════════════════════════════════════════════════
function partMerge() {
  console.log("\n── ② 重复收藏时保护用户自定义的封面 ──");
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

  const mine = "data:image/jpeg;base64,MINE";
  const auto = "https://example.com/new-cover.jpg";

  const locked = { url: "https://example.com/p/1", title: "标题", description: "摘要", image: mine, imageEdited: true };
  merge(locked, { url: locked.url, title: "标题", description: "摘要", image: auto });
  check("用户自定义过的封面不会被自动抓取顶掉", locked.image === mine, locked.image);

  const blank = { url: "https://example.com/p/2", title: "标题", description: "摘要", image: "" };
  merge(blank, { url: blank.url, title: "标题", description: "摘要", image: auto });
  check("没自定义过时，缺封面照样能补上", blank.image === auto, blank.image);

  const iconish = { url: "https://example.com/p/3", title: "标题", description: "摘要", image: "https://example.com/favicon.ico" };
  merge(iconish, { url: iconish.url, title: "标题", description: "摘要", image: auto });
  check("原本是站点图标的错误封面依然能被修好", iconish.image === auto, iconish.image);

  const removed = { url: "https://example.com/p/4", title: "标题", description: "摘要", image: "", imageEdited: true };
  merge(removed, { url: removed.url, title: "标题", description: "摘要", image: auto });
  check("用户主动「移除封面」后也不会被塞回来", removed.image === "", String(removed.image));
}

// ═══════════════════════════════════════════════════════════
// ③ 收藏库页面上的完整链路
// ═══════════════════════════════════════════════════════════
async function partLibrary() {
  console.log("\n── ③ 在收藏库页面上真的换一张封面 ──");
  const ITEMS = [
    {
      id: "item-1",
      title: "一篇收藏",
      description: "摘要",
      image: "https://site.com/auto.jpg",
      favicon: "",
      source: "site.com",
      projectId: null,
      url: "https://site.com/p/1",
      savedAt: Date.now() - 1000,
      status: "unread"
    }
  ];
  const store = {
    laterOnItems: JSON.parse(JSON.stringify(ITEMS)),
    laterOnProjects: [],
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
  stubImagePipeline(window);

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
      create: async () => ({}),
      onCreated: { addListener() {} }
    },
    runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({ ok: true }), onMessage: { addListener() {} } },
    windows: { getCurrent: async () => ({ id: 3 }) },
    sidePanel: { open: async () => ({}), close: async () => ({}) }
  };

  window.eval(DIALOG_SOURCE);
  window.eval(LIBRARY_SOURCE);

  const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const visible = () => document.querySelector(".lod-root:not([hidden])");
  const card = (id) => document.querySelector(`.card[data-id="${id}"]`);
  const coverSrc = (id) => card(id)?.querySelector(".cover img.cover-img")?.getAttribute("src") || "";

  await tick();
  check("卡片渲染出来了", !!card("item-1"));
  check("初始用的是自动抓的封面", coverSrc("item-1") === "https://site.com/auto.jpg", coverSrc("item-1"));

  // ── 移除封面 ──
  click(card("item-1").querySelector(".edit"));
  await tick();
  check("编辑弹窗里带封面区", visible().querySelector(".lod-cover").hidden === false);
  click(visible().querySelectorAll(".lod-cover-btn")[1]);
  await tick(20);
  click(visible().querySelector(".lod-ok"));
  await tick(300);

  let saved = store.laterOnItems.find((entry) => entry.id === "item-1");
  check("移除封面写进了库（image 变空）", saved?.image === "", String(saved?.image).slice(0, 30));
  check("标记为「封面由用户定过」", saved?.imageEdited === true, String(saved?.imageEdited));
  check("卡片上的封面图被撤掉", coverSrc("item-1") === "", coverSrc("item-1"));
  check("退回 LaterOn 的 Logo 占位", !!card("item-1")?.querySelector(".cover .cover-placeholder"));

  // ── 上传一张自己的图 ──
  click(card("item-1").querySelector(".edit"));
  await tick();
  const file = new window.File([new Uint8Array([9, 8, 7])], "mine.png", { type: "image/png" });
  await pickFile(window, file, tick);
  click(visible().querySelector(".lod-ok"));
  await tick(300);

  saved = store.laterOnItems.find((entry) => entry.id === "item-1");
  check("条目里只记 local:// 指针，不存 base64 大图", saved?.image === "local://item-1", String(saved?.image).slice(0, 40));
  check("封面本体存进了单独的 laterOnCovers 键", store.laterOnCovers?.["item-1"] === FAKE_DATA_URL, String(store.laterOnCovers?.["item-1"]).slice(0, 40));
  check("卡片立刻显示新封面（不用刷新页面）", coverSrc("item-1") === FAKE_DATA_URL, coverSrc("item-1").slice(0, 40));

  // ── 没动封面就保存：不该写库 ──
  const before = JSON.stringify(store.laterOnItems);
  click(card("item-1").querySelector(".edit"));
  await tick();
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("没改任何东西就保存 → 不写库", JSON.stringify(store.laterOnItems) === before);
  check("会提示「没有改动」", /没有改动/.test(document.querySelector("#toast").textContent), document.querySelector("#toast").textContent);
}

(async () => {
  await partDialog();
  partMerge();
  await partLibrary();
  console.log(failures ? `\n❌ 有 ${failures} 项没通过` : "\n🎉 全部通过");
  process.exit(failures ? 1 : 0);
})();
