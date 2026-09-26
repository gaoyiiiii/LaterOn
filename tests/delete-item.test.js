// 删除单篇收藏必须先弹确认（危险操作，一点就没太容易误删）。
// 用 jsdom 加载真实的 library.html + dialog.js + library.js，覆盖：
//  1) 点卡片上的垃圾桶 → 弹出自定义确认弹窗（不是浏览器自带 alert）
//  2) 弹窗标题写明是哪一篇；标题太长会截断
//  3) 点「取消」/ 按 Esc 都不删；点「删除」才真的删掉，并弹 toast
// 运行：NODE_PATH=<jsdom 路径> node tests/delete-item.test.js
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

const now = Date.now();
const LONG_TITLE = "一篇标题特别长的收藏，长到如果不截断就会把整个确认弹窗撑成一大段文字";
const item = (id, extra) => ({
  id, title: `标题 ${id}`, description: "摘要", image: "", favicon: "",
  source: "少数派", url: `https://example.com/${id}`, savedAt: now, read: false, ...extra
});
const store = {
  laterOnItems: [
    item("i1", { title: "标题一" }),
    item("i2", { title: LONG_TITLE }),
    item("i3", { title: "标题三" })
  ],
  laterOnProjects: [],
  laterOnActiveProject: "unfiled",
  laterOnSettings: {}
};
const changeListeners = [];
const nativeDialogs = [];
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
  tabs: { query: () => Promise.resolve([{ id: 1, windowId: 1 }]) },
  runtime: { getURL: (p) => `chrome-extension://lateron/${p}`, onMessage: { addListener() {} } }
};
window.confirm = (m) => { nativeDialogs.push(String(m)); return true; };
window.alert = (m) => { nativeDialogs.push(String(m)); };

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const pressKey = (el, key) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

window.eval(dialogSource);
window.eval(librarySource);

const cardOf = (id) => document.querySelector(`.card[data-id="${id}"]`);
const dialog = () => document.querySelector(".lod-root:not([hidden])");
const dialogText = (selector) => dialog()?.querySelector(selector)?.textContent || "";
const clickDelete = (id) => click(cardOf(id).querySelector(".delete"));

(async () => {
  await tick(30);

  console.log("── 点删除先弹确认 ──");
  clickDelete("i1");
  await tick(30);
  check("弹出了确认弹窗", !!dialog());
  check("是危险操作的红色主题", dialog()?.dataset.tone === "danger", dialog()?.dataset.tone);
  check("标题写明删的是哪一篇", dialogText(".lod-title") === "删除「标题一」？", dialogText(".lod-title"));
  check("说明删了没法恢复", /无法恢复/.test(dialogText(".lod-message")), dialogText(".lod-message"));
  check("确认按钮就是「删除」", dialogText(".lod-ok") === "删除", dialogText(".lod-ok"));

  console.log("\n── 取消 / Esc 都不删 ──");
  click(dialog().querySelector(".lod-cancel"));
  await tick(320);   // 弹窗有关闭动画，等它真正 resolve
  check("点「取消」收藏还在", store.laterOnItems.some((it) => it.id === "i1"));
  clickDelete("i1");
  await tick(30);
  pressKey(dialog(), "Escape");
  await tick(320);
  check("按 Esc 收藏也还在", store.laterOnItems.some((it) => it.id === "i1"));

  console.log("\n── 确认才真的删 ──");
  clickDelete("i1");
  await tick(30);
  click(dialog().querySelector(".lod-ok"));
  await tick(320);
  check("收藏被删掉了", !store.laterOnItems.some((it) => it.id === "i1"), store.laterOnItems.map((it) => it.id).join(","));
  check("卡片也从列表里消失", !cardOf("i1"));
  check("弹了「已删除收藏」的提示", document.querySelector("#toast").textContent === "已删除收藏", document.querySelector("#toast").textContent);

  console.log("\n── 标题太长会截断 ──");
  clickDelete("i2");
  await tick(30);
  const expected = `删除「${LONG_TITLE.slice(0, 26)}…」？`;
  check("长标题截断成 26 字 + 省略号", dialogText(".lod-title") === expected, dialogText(".lod-title"));
  pressKey(dialog(), "Escape");
  await tick(320);

  console.log("\n── 用的不是浏览器自带弹窗 ──");
  check("全程没有调用浏览器自带的 confirm/alert", nativeDialogs.length === 0, nativeDialogs.join(" | "));
  check("整个过程没有未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures ? `\n有 ${failures} 项失败` : "\n全部检查通过 🎉");
  process.exit(failures ? 1 : 0);
})();
