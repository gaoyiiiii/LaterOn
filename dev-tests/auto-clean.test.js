// 验证「已读收藏自动清除」：标为已读超过设定天数（默认 30，范围 30–180）就自动删除。
// 用 vm 把真实 background.js 加载进 mock 了 chrome 的沙箱，通过 storage.onChanged 触发清除，
// 测的就是上线那份代码本身。
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(label, ok, extra = "") {
  if (ok) console.log(`✅ ${label}${extra ? `  → ${extra}` : ""}`);
  else { failures += 1; console.log(`❌ ${label}${extra ? `  → ${extra}` : ""}`); }
}

const listeners = {};
const store = { laterOnSettings: { autoCleanDays: 30 } };
const alarms = [];
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
    },
    onChanged: { addListener(fn) { listeners.onStorageChanged = fn; } }
  },
  alarms: {
    create(name, info) { alarms.push({ name, info }); },
    onAlarm: { addListener(fn) { listeners.onAlarm = fn; } }
  },
  contextMenus: { removeAll(cb) { if (typeof cb === "function") cb(); }, create() {}, onClicked: { addListener() {} } },
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
    onCreated: { addListener() {} },
    update() { return Promise.resolve(); },
    query() { return Promise.resolve([]); },
    create() { return Promise.resolve({}); }
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  scripting: { insertCSS() { return Promise.resolve(); } },
  windows: { update() {}, create() {} },
  sidePanel: { open() {}, setPanelBehavior() {} }
};

const sandbox = {
  chrome: mockChrome, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, URL, Set, Map, RegExp, JSON, Object, Array, Math, Date,
  parseInt, parseFloat, isNaN, String, Number, Boolean, Symbol, Error
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "background.js" });

// 触发一次清除：模拟「设置变了」→ 后台立刻按新设置扫一遍。
async function purge() {
  await listeners.onStorageChanged({ laterOnSettings: { newValue: store.laterOnSettings } }, "local");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const ago = (days) => Date.now() - days * DAY;
const item = (id, extra = {}) => ({ id, title: id, url: `https://x.com/${id}`, savedAt: ago(400), status: "unread", ...extra });

async function run() {
  console.log("── ① 定时与触发器 ──");
  check("后台注册了自动清除的定时任务", alarms.some((a) => a.name === "laterOnAutoClean"), JSON.stringify(alarms[0]?.info));
  check("监听了设置变化（改天数立即生效）", typeof listeners.onStorageChanged === "function");
  check("监听了定时任务触发", typeof listeners.onAlarm === "function");

  console.log("\n── ② 默认 30 天：过期的删、没到期的留 ──");
  {
    store.laterOnSettings = { autoCleanDays: 30 };
    store.laterOnItems = [
      item("old", { status: "done", doneAt: ago(31) }),
      item("fresh", { status: "done", doneAt: ago(29) }),
      item("reading", { status: "reading", savedAt: ago(200) }),
      item("unread", { status: "unread", savedAt: ago(300) })
    ];
    await purge();
    const ids = store.laterOnItems.map((it) => it.id).join(",");
    check("超过 30 天的已读被清除", !ids.includes("old"), ids);
    check("29 天的已读保留", ids.includes("fresh"), ids);
    check("在读的不会被清掉（哪怕放了很久）", ids.includes("reading"), ids);
    check("未读的不会被清掉", ids.includes("unread"), ids);
  }

  console.log("\n── ③ 自定义顺序里的 id 也要跟着去掉 ──");
  {
    store.laterOnSettings = { autoCleanDays: 30 };
    store.laterOnItems = [item("a", { status: "done", doneAt: ago(60) }), item("b", { status: "done", doneAt: ago(1) })];
    store.laterOnOrder = { all: ["a", "b"], p1: ["b", "a"] };
    await purge();
    check("全部收藏的顺序里去掉了已删除的", JSON.stringify(store.laterOnOrder.all) === JSON.stringify(["b"]), JSON.stringify(store.laterOnOrder.all));
    check("项目的顺序也一并清理", JSON.stringify(store.laterOnOrder.p1) === JSON.stringify(["b"]), JSON.stringify(store.laterOnOrder.p1));
  }

  console.log("\n── ④ 天数可调（最长 180 天）──");
  {
    store.laterOnSettings = { autoCleanDays: 180 };
    store.laterOnItems = [item("mid", { status: "done", doneAt: ago(100) }), item("veryold", { status: "done", doneAt: ago(200) })];
    await purge();
    const ids = store.laterOnItems.map((it) => it.id).join(",");
    check("设 180 天时，100 天的保留", ids.includes("mid"), ids);
    check("设 180 天时，200 天的清除", !ids.includes("veryold"), ids);
  }

  console.log("\n── ⑤ 越界的天数会被夹回 30–180 ──");
  {
    // 填 10 天（低于下限）：夹回 30 天，所以 20 天的已读不该被删。
    store.laterOnSettings = { autoCleanDays: 10 };
    store.laterOnItems = [item("y", { status: "done", doneAt: ago(20) }), item("z", { status: "done", doneAt: ago(40) })];
    await purge();
    const ids = store.laterOnItems.map((it) => it.id).join(",");
    check("低于 30 天按 30 天算（20 天的保留）", ids.includes("y"), ids);
    check("40 天的照常清除", !ids.includes("z"), ids);

    // 填 999 天（高于上限）：夹回 180 天，所以 200 天的仍然该删。
    store.laterOnSettings = { autoCleanDays: 999 };
    store.laterOnItems = [item("w1", { status: "done", doneAt: ago(200) }), item("w2", { status: "done", doneAt: ago(150) })];
    await purge();
    const ids2 = store.laterOnItems.map((it) => it.id).join(",");
    check("高于 180 天按 180 天算（200 天的清除）", !ids2.includes("w1"), ids2);
    check("150 天的保留", ids2.includes("w2"), ids2);

    // 没设过这个值（老用户）→ 用默认 30 天。
    store.laterOnSettings = {};
    store.laterOnItems = [item("d1", { status: "done", doneAt: ago(35) }), item("d2", { status: "done", doneAt: ago(5) })];
    await purge();
    const ids3 = store.laterOnItems.map((it) => it.id).join(",");
    check("没设过天数时用默认 30 天", !ids3.includes("d1") && ids3.includes("d2"), ids3);
  }

  console.log("\n── ⑥ 老数据保护：没有标记时间的一律不动 ──");
  {
    store.laterOnSettings = { autoCleanDays: 30 };
    store.laterOnItems = [
      item("legacy1", { status: "done", doneAt: null, savedAt: ago(500) }),   // 新字段但没有时间
      { id: "legacy2", title: "legacy2", read: true, savedAt: ago(500) }       // 1.40 之前只有 read 布尔
    ];
    await purge();
    const ids = store.laterOnItems.map((it) => it.id).join(",");
    check("已读但没有 doneAt 的不会被删", ids.includes("legacy1"), ids);
    check("只有旧 read 布尔的老收藏也不会被删", ids.includes("legacy2"), ids);
  }

  console.log(failures ? `\n❌ 有 ${failures} 项没通过` : "\n🎉 全部通过");
  process.exit(failures ? 1 : 0);
}

run().catch((error) => { console.error(error); process.exit(1); });
