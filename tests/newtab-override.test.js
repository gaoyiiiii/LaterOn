// 验证「新标签劫持」逻辑：后台监听 onCreated，凡是默认新标签就重定向到 LaterOn 全屏墙，
// 且受设置项 newTabPage 控制（关掉则恢复系统默认新标签）。
// 用 vm 把真实 background.js 加载进一个 mock 了 chrome 的沙箱里跑，捕获真实的 onCreated 监听器，
// 这样测的就是上线那份代码本身，而不是另写一份复制逻辑。
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

// ── mock chrome ──────────────────────────────────────────────
const listeners = {};
const store = { laterOnSettings: { newTabPage: true } };
const updated = [];
const mockChrome = {
  storage: {
    local: {
      get(keys) {
        const pick = (k) => (k in store ? { [k]: store[k] } : {});
        if (typeof keys === "string") return Promise.resolve(pick(keys));
        if (Array.isArray(keys)) return Promise.resolve(Object.assign({}, ...keys.map(pick)));
        return Promise.resolve(Object.assign({}, ...Object.keys(keys).map(pick)));
      },
      set(patch) { Object.assign(store, patch); return Promise.resolve(); }
    }
  },
  contextMenus: {
    removeAll(cb) { if (typeof cb === "function") cb(); },
    create() {},
    onClicked: { addListener() {} }
  },
  commands: { onCommand: { addListener() {} } },
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.onMessage = fn; } },
    getURL: (p) => `chrome-extension://lateron/${p}`
  },
  tabs: {
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    onCreated: { addListener(fn) { listeners.onCreated = fn; } },
    update(id, props) { updated.push({ id, props }); return Promise.resolve(); },
    query() { return Promise.resolve([]); },
    create() { return Promise.resolve({}); }
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  scripting: { insertCSS() { return Promise.resolve(); } },
  windows: { update() {}, create() {} },
  sidePanel: { open() {}, setPanelBehavior() {} }
};

const sandbox = {
  chrome: mockChrome,
  console,
  setTimeout, clearTimeout,
  Promise, URL, Set, Map, RegExp, JSON, Object, Array, Math, Date,
  parseInt, parseFloat, isNaN, String, Number, Boolean, Symbol, Error
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "background.js" });

assert.ok(typeof listeners.onCreated === "function", "background.js 应当注册了 onCreated 监听器");

const LIBRARY_URL = "chrome-extension://lateron/library.html";

async function run() {
  // 1) 开关开 + 默认新标签 → 重定向到 library
  store.laterOnSettings = { newTabPage: true };
  updated.length = 0;
  await listeners.onCreated({ id: 101, pendingUrl: "chrome://newtab/", url: "chrome://newtab/" });
  assert.strictEqual(updated.length, 1, "开关开启时应把新标签重定向到全屏墙");
  assert.strictEqual(updated[0].props.url, LIBRARY_URL, "重定向目标应为 library.html");

  // 2) 开关关 + 默认新标签 → 不重定向
  store.laterOnSettings = { newTabPage: false };
  updated.length = 0;
  await listeners.onCreated({ id: 102, pendingUrl: "chrome://newtab/", url: "chrome://newtab/" });
  assert.strictEqual(updated.length, 0, "开关关闭时不应劫持新标签");

  // 3) 普通网页（非新标签）→ 不劫持
  store.laterOnSettings = { newTabPage: true };
  updated.length = 0;
  await listeners.onCreated({ id: 103, pendingUrl: "https://example.com", url: "https://example.com" });
  assert.strictEqual(updated.length, 0, "用户直接打开的网页不应被劫持");

  // 4) 其它 chrome:// 页面 → 不劫持
  updated.length = 0;
  await listeners.onCreated({ id: 104, pendingUrl: "chrome://extensions/", url: "chrome://extensions/" });
  assert.strictEqual(updated.length, 0, "其它 chrome 内部页不应被劫持");

  // 5) 新标签变体 chrome://new-tab-page/ → 重定向
  updated.length = 0;
  await listeners.onCreated({ id: 105, pendingUrl: "chrome://new-tab-page/", url: "chrome://new-tab-page/" });
  assert.strictEqual(updated.length, 1, "new-tab-page 变体也应重定向");
  assert.strictEqual(updated[0].props.url, LIBRARY_URL);

  // 6) 已经是 library 的标签（理论上不会发生）→ 不重复重定向（避免死循环）
  updated.length = 0;
  await listeners.onCreated({ id: 106, pendingUrl: LIBRARY_URL, url: LIBRARY_URL });
  assert.strictEqual(updated.length, 0, "已是全屏墙的标签不应再重定向");

  console.log("✓ newtab-override 测试全部通过（6 个场景）");
}

run().catch((e) => { console.error("✗ 测试失败:", e.message); process.exit(1); });
