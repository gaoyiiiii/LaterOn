// 主题（浅色 / 深色）在各界面之间的同步测试。覆盖：
//  1) 有界面的页面都引入了 theme-vars.css + theme.js（全屏 / 设置 / 收藏浮层 / 侧栏）
//  2) 侧栏的样式不再自己写死 :root 颜色变量——否则会盖掉 [data-theme="dark"] 的覆盖
//  3) 真正跑一遍 theme.js：设置切到 dark，侧栏页面的 <html> 也跟着变 data-theme="dark"
//  4) 设置改动实时同步（不用重开侧栏）
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const themeSource = fs.readFileSync(`${ROOT}/theme.js`, "utf8");
const sidepanelCss = fs.readFileSync(`${ROOT}/sidepanel.css`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

console.log("── 第 1 步：每个界面都接了同一套主题 ──");
// 这几个都是当前产品里有完整界面的页面。
const surfaces = ["library.html", "settings.html", "sidepanel.html"];
for (const page of surfaces) {
  const source = fs.readFileSync(`${ROOT}/${page}`, "utf8");
  check(`${page} 引入了 theme-vars.css`, source.includes("theme-vars.css"));
  check(`${page} 引入了 theme.js`, source.includes("theme.js"));
}

console.log("\n── 第 2 步：侧栏样式不再写死 :root 颜色变量 ──");
// 侧栏以前自带一份 :root { --paper:#f6f5f1 ... }。它和 [data-theme="dark"] 同优先级、
// 但排在后面，会把深色覆盖赢回去——所以必须删掉。
const rootBlock = sidepanelCss.match(/:root\s*\{[^}]*\}/)?.[0] || "";
check("侧栏没有残留自己的 :root 定义", rootBlock === "", rootBlock.slice(0, 40));
check("侧栏背景 / 卡片改用主题变量", sidepanelCss.includes("background: var(--paper)") && sidepanelCss.includes("background:var(--card)"));
check("侧栏没有写死的白底（white）", !/background:\s*white/.test(sidepanelCss));
check("侧栏没有写死的浅色字 #181817 等", !/#181817|#393733|#77736b|#817d75/.test(sidepanelCss));

console.log("\n── 第 3 步：把设置切成深色 → 侧栏真的变深色 ──");
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
const dom = new JSDOM(fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8"), {
  runScripts: "outside-only",
  url: "chrome-extension://lateron/sidepanel.html",
  virtualConsole
});
const { window } = dom;

const store = { laterOnSettings: { theme: "dark", defaultSort: "newest" } };
const changeListeners = [];
window.chrome = {
  storage: {
    local: {
      get: (key) => Promise.resolve({ [key]: store[key] }),
      set: (patch) => {
        const changes = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        changeListeners.forEach((fn) => fn(changes, "local"));
        return Promise.resolve();
      }
    },
    onChanged: { addListener(fn) { changeListeners.push(fn); } }
  }
};

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  window.eval(themeSource);
  await tick();
  const theme = () => window.document.documentElement.dataset.theme;
  check("设置是 dark 时，侧栏 <html> 带上 data-theme=\"dark\"", theme() === "dark", `实际=${theme()}`);

  console.log("\n── 第 4 步：改设置实时同步，不用重开侧栏 ──");
  await window.chrome.storage.local.set({ laterOnSettings: { ...store.laterOnSettings, theme: "light" } });
  await tick();
  check("切成 light 后，侧栏立刻跟着变浅色", theme() === "light", `实际=${theme()}`);

  await window.chrome.storage.local.set({ laterOnSettings: { ...store.laterOnSettings, theme: "dark" } });
  await tick();
  check("再切回 dark，侧栏又跟着变深色", theme() === "dark", `实际=${theme()}`);

  console.log("\n── 第 5 步：全程没有未捕获的错误 ──");
  check("没有 jsdom 报错", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
