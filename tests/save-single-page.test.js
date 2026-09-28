// 模拟验证：收藏「单篇」时的两种行为（由设置里的「收藏当前网页前，先选项目」控制）。
// 用假的 chrome API 把 background.js 跑起来，检查：
//  1) 尚未存过设置时默认关闭：直接收藏到「等待整理」
//  2) 用户明确关闭时：一键直接收藏，收进「等待整理」，不弹任何浮层
//  3) 开关打开时：先在当前网页里弹出「选项目」浮层，此刻还没有真正收藏
//  3) 浮层里选好项目并确认 → 这一篇带上所选项目，且只弹一条结果提示（不再多出「开始/总结」）
//  4) 这一篇已经收藏过时：确认后被搬进所选项目，提示写明「已移到」
//  5) 浮层里取消 → 什么都不收藏
//  6) 再关掉开关 → 回到「直接收藏」
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { URL } = require("url");

const SOURCE = path.resolve(__dirname, "..", "background.js");
const src = fs.readFileSync(SOURCE, "utf8");
const librarySource = fs.readFileSync(path.resolve(__dirname, "..", "library.js"), "utf8");
const libraryCss = fs.readFileSync(path.resolve(__dirname, "..", "library.css"), "utf8");
const PICKER_TIMEOUT_MS = Number(/const PICKER_INJECT_TIMEOUT_MS = (\d+)/.exec(src)[1]);

const PENDING_KEY = "laterOnPendingBatch";
const LAST_PROJECT_KEY = "laterOnLastProjectId";
const FOLDER_ID = "folder-work";
const PAGE_URL = "https://site1.com/article";
const DUP_URL = "https://dup.com/old";

function makeTab(id, url, title, extra = {}) {
  return { id, url, title, favIconUrl: `https://${new URL(url).hostname}/favicon.ico`, windowId: 1, active: true, status: "complete", ...extra };
}
const tab = makeTab(1, PAGE_URL, "单篇文章");

const store = {
  laterOnItems: [
    { id: "old-1", title: "早就收藏过的一篇", description: "暂无摘要", image: "", favicon: "", source: "dup.com", projectId: null, url: DUP_URL, savedAt: 1, read: false }
  ],
  laterOnProjects: [{ id: FOLDER_ID, name: "工作", createdAt: 1 }],
  laterOnSettings: {},
  [LAST_PROJECT_KEY]: FOLDER_ID
};
const session = {};

const pills = [];
const windowsCreated = [];
const overlays = [];
const runtimeNotices = [];
let pendingOverlayPayload = null;
let hangPickerPayloadInjection = false;
const bus = {};

const chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: store[keys] };
        if (Array.isArray(keys)) {
          const out = {};
          keys.forEach((k) => { out[k] = store[k]; });
          return out;
        }
        return { ...store };
      },
      async set(obj) { Object.assign(store, obj); },
      async remove(key) { delete store[key]; }
    },
    session: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: session[keys] };
        return { ...session };
      },
      async set(obj) { Object.assign(session, obj); },
      async remove(key) { delete session[key]; }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    query: () => Promise.resolve([tab]),
    get: (id) => (id === tab.id ? Promise.resolve(tab) : Promise.reject(new Error("no tab"))),
    update: async () => {},
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    onCreated: { addListener() {} }
  },
  windows: {
    get: async () => ({ left: 0, top: 0, width: 1440, height: 900 }),
    create: async (options) => { windowsCreated.push(options); return { id: 99 }; },
    remove: async () => {},
    update: async () => {}
  },
  scripting: {
    insertCSS: async () => {},
    executeScript(options) {
      const tabId = options.target?.tabId;
      if (typeof options.func === "function" && String(options.func).includes("lateron-picker-payload-data")) {
        if (hangPickerPayloadInjection) return new Promise(() => {});
        pendingOverlayPayload = options.args?.[0];
        return Promise.resolve([{ result: undefined }]);
      }
      if (typeof options.func === "function" && String(options.func).includes("lateron-folder-picker")) {
        return Promise.resolve([{ result: true }]);
      }
      if (options.files?.includes("content-folder-picker.js")) {
        overlays.push({ tabId, payload: pendingOverlayPayload });
        pendingOverlayPayload = null;
        return Promise.resolve([{ result: undefined }]);
      }
      if (Array.isArray(options.args)) {
        pills.push({ tabId, items: options.args[0] });
        return Promise.resolve([{ result: undefined }]);
      }
      if (!options.files?.includes("content-metadata.js")) return Promise.resolve([{ result: undefined }]);
      const target = tabId === 2 ? { ...tab, url: DUP_URL, title: "早就收藏过的一篇" } : tab;
      return Promise.resolve([{
        result: {
          title: target.title,
          description: `这是 ${target.title} 的摘要`,
          image: `https://img.example.com/${tabId}.jpg`,
          favicon: target.favIconUrl,
          source: new URL(target.url).hostname,
          url: target.url,
          titleFrom: "meta-title",
          imageFrom: "share"
        }
      }]);
    }
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    sendMessage: async (message) => {
      runtimeNotices.push(message);
      return message?.type === "SHOW_LIBRARY_NOTICE" ? { shown: true } : undefined;
    },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { bus.listener = fn; } }
  },
  commands: { onCommand: { addListener() {} } }
};

// 确认之后后台是异步收藏的，这里等它真正跑完（诊断里的状态会变成「完成」或「失败」）。
async function waitForDone(deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const stage = store.laterOnDiag?.lastStage;
    if (stage === "完成" || stage === "失败") return stage;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return store.laterOnDiag?.lastStage;
}

function sendFromPage(message) {
  return new Promise((resolve) => {
    const kept = bus.listener(message, { tab: { id: 1 } }, resolve);
    if (!kept) resolve(undefined);
  });
}

const sandbox = {
  chrome, crypto: webcrypto, URL, setTimeout, clearTimeout, console, Date, Promise, JSON, Set, Map,
  importScripts() {},
  LaterOnUrl: { normalize(value) { try { const url = new URL(value); url.hash = ""; return url.href.replace(/\/$/, ""); } catch { return String(value || ""); } } }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "background.js" });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

(async () => {
  // ── 第 0 步：没有存过该字段 → 默认关闭并直接收藏 ────────────
  console.log("── 第 0 步：首次使用默认关闭 ──");
  const defaultResult = await sandbox.quickSave(tab, "shortcut");
  check("没有设置记录时不弹项目选择", !defaultResult?.pending && overlays.length === 0, JSON.stringify(defaultResult));
  check("默认直接收藏进等待整理", store.laterOnItems.some((i) => i.url === PAGE_URL && !i.projectId));
  store.laterOnItems = store.laterOnItems.filter((i) => i.url !== PAGE_URL);
  pills.length = 0;
  overlays.length = 0;

  // ── 第 1 步：用户明确关闭 → 直接收藏，不弹浮层 ────────────────
  console.log("── 第 1 步：用户明确关闭开关 ──");
  store.laterOnSettings = { askFolderOnSingle: false };
  await sandbox.quickSave(tab, "shortcut");
  check("没有弹任何浮层、也没开窗口", overlays.length === 0 && windowsCreated.length === 0, `浮层 ${overlays.length} / 窗口 ${windowsCreated.length}`);
  const saved = store.laterOnItems.find((i) => i.url === PAGE_URL);
  check("这一篇被直接收藏了", !!saved, saved ? saved.title : "没找到");
  check("关闭后收进「等待整理」（不带项目）", saved && (saved.projectId || null) === null, `projectId=${JSON.stringify(saved?.projectId)}`);
  check("只弹了一条结果提示", pills.length === 1 && String(pills[0].items[0].text).includes("已保存："), pills.map((p) => p.items[0].text).join(" | "));

  // ── 第 2 步：打开开关 → 先弹浮层，此刻不收藏 ──────────────────
  console.log("\n── 第 2 步：打开「收藏单篇前先选项目」──");
  store.laterOnSettings = { askFolderOnSingle: true, askFolderOnSingleOptIn: true };
  store.laterOnItems = [{ id: "old-1", title: "早就收藏过的一篇", description: "暂无摘要", image: "", favicon: "", source: "dup.com", projectId: null, url: DUP_URL, savedAt: 1, read: false }];
  pills.length = 0;
  const triggered = await sandbox.quickSave(tab, "shortcut");
  check("进入了「等待选择项目」", triggered?.pending === true && triggered?.tabCount === 1, JSON.stringify(triggered));
  check("在当前网页里弹出浮层（没新开窗口）", overlays.length === 1 && windowsCreated.length === 0, `浮层 ${overlays.length} / 窗口 ${windowsCreated.length}`);
  check("此刻还没有真正收藏", !store.laterOnItems.some((i) => i.url === PAGE_URL), `${store.laterOnItems.length} 条`);
  check("浮层里只有这一篇", overlays[0]?.payload?.pages?.length === 1 && overlays[0].payload.pages[0].url === PAGE_URL, `${overlays[0]?.payload?.pages?.length} 个页面`);
  check("浮层默认选中上次用过的项目", overlays[0]?.payload?.selected === FOLDER_ID, overlays[0]?.payload?.selected);
  check("浮层里列出了已有项目和「等待整理」", (overlays[0]?.payload?.folders?.length || 0) === 2, (overlays[0]?.payload?.folders || []).map((f) => f.name).join(" / "));
  check("这一篇没收藏过，浮层不提示「已收藏过」", overlays[0]?.payload?.savedCount === 0, `savedCount=${overlays[0]?.payload?.savedCount}`);
  check("这一篇被暂存下来了", session[PENDING_KEY]?.tabs?.length === 1, `${session[PENDING_KEY]?.tabs?.length} 个`);

  // ── 第 3 步：在浮层里确认 → 收藏进所选项目 ──────────────────
  console.log("\n── 第 3 步：选好项目并确认 ──");
  const reply = await sendFromPage({ type: "CONFIRM_BATCH_SAVE", projectId: FOLDER_ID });
  check("确认后立刻收到回执（好让浮层马上关闭）", reply?.ok === true && reply?.tabCount === 1, JSON.stringify(reply));
  await waitForDone();
  const done = store.laterOnItems.find((i) => i.url === PAGE_URL);
  check("收藏成功，并且带上了所选项目", !!done && done.projectId === FOLDER_ID, `projectId=${done?.projectId}`);
  check("单篇只弹一条提示（没有「开始收藏」「全部完成」）", pills.length === 1, pills.map((p) => p.items[0].text).join(" | "));
  check("提示里写明了这一篇的标题", String(pills[0]?.items?.[0]?.text).includes("单篇文章"), pills[0]?.items?.[0]?.text);
  check("诊断里记下了封面来源（设置页自检不断更）", (store.laterOnDiag?.lastCoverFrom || "none") !== "none", store.laterOnDiag?.lastCoverFrom);
  check("记住了这次选的项目", store[LAST_PROJECT_KEY] === FOLDER_ID, store[LAST_PROJECT_KEY]);
  check("待处理批次已清空", session[PENDING_KEY] === undefined);

  // ── 第 4 步：已经收藏过的一篇 → 确认后被搬进所选项目 ────────
  console.log("\n── 第 4 步：收藏已存在的一篇 ──");
  pills.length = 0;
  const dupTab = makeTab(2, DUP_URL, "早就收藏过的一篇");
  await sandbox.quickSave(dupTab, "shortcut");
  check("浮层提前说明这篇已经收藏过", overlays.at(-1)?.payload?.savedCount === 1, `savedCount=${overlays.at(-1)?.payload?.savedCount}`);
  await sendFromPage({ type: "CONFIRM_BATCH_SAVE", projectId: FOLDER_ID });
  await waitForDone();
  const moved = store.laterOnItems.find((i) => i.url === DUP_URL);
  check("没有新增重复的一条", store.laterOnItems.filter((i) => i.url === DUP_URL).length === 1, `${store.laterOnItems.filter((i) => i.url === DUP_URL).length} 条`);
  check("被搬进了所选项目", moved?.projectId === FOLDER_ID, `projectId=${moved?.projectId}`);
  check("提示写明「已移到」哪个项目", pills.some((p) => String(p.items[0].text).includes("已移到「工作」")), pills.map((p) => p.items[0].text).join(" | "));

  // ── 第 5 步：浮层里按 Esc 取消 → 什么都不收藏 ─────────────────
  console.log("\n── 第 5 步：取消 ──");
  store.laterOnItems = [];
  pills.length = 0;
  await sandbox.quickSave(tab, "shortcut");
  const cancelled = await sendFromPage({ type: "CANCEL_BATCH_SAVE" });
  check("取消后清掉了待处理批次", cancelled?.cancelled === true && session[PENDING_KEY] === undefined, JSON.stringify(cancelled));
  check("取消不会收藏任何东西", store.laterOnItems.length === 0, `${store.laterOnItems.length} 条`);

  // ── 第 6 步：再关掉开关 → 回到「直接收藏」───────────────────
  console.log("\n── 第 6 步：关掉开关 ──");
  store.laterOnSettings = { askFolderOnSingle: false };
  const overlayBefore = overlays.length;
  await sandbox.quickSave(tab, "shortcut");
  check("不再弹浮层", overlays.length === overlayBefore, `浮层 +${overlays.length - overlayBefore}`);
  const again = store.laterOnItems.find((i) => i.url === PAGE_URL);
  check("直接收进「等待整理」", !!again && (again.projectId || null) === null, `projectId=${JSON.stringify(again?.projectId)}`);

  // ── 第 7 步：侧边栏 / 工具栏小窗口里的「收藏」按钮 ────────────
  // 这两个入口以前各自直接写库，会绕过开关；现在统一走后台的 QUICK_SAVE_TAB。
  console.log("\n── 第 7 步：面板里的收藏按钮 ──");
  store.laterOnItems = [];
  store.laterOnSettings = { askFolderOnSingle: true, askFolderOnSingleOptIn: true };
  const overlaysBeforePanel = overlays.length;
  const panelPending = await sendFromPage({ type: "QUICK_SAVE_TAB", source: "panel" });
  check("开关打开时，点按钮同样先弹浮层（不直接收藏）", panelPending?.ok === true && panelPending?.pending === true, JSON.stringify(panelPending));
  check("浮层确实弹出来了", overlays.length === overlaysBeforePanel + 1, `浮层 +${overlays.length - overlaysBeforePanel}`);
  check("此刻还没真正收藏", store.laterOnItems.length === 0, `${store.laterOnItems.length} 条`);
  await sendFromPage({ type: "CANCEL_BATCH_SAVE" });

  store.laterOnSettings = { askFolderOnSingle: false };
  const overlaysBeforeDirect = overlays.length;
  const panelDirect = await sendFromPage({ type: "QUICK_SAVE_TAB", source: "panel" });
  check("开关关闭时，点按钮直接收藏", panelDirect?.ok === true && panelDirect?.pending !== true, JSON.stringify(panelDirect));
  check("这时不弹浮层", overlays.length === overlaysBeforeDirect, `浮层 +${overlays.length - overlaysBeforeDirect}`);
  check("结果回传给按钮显示（不是重复的旧收藏）", panelDirect?.duplicated === false, JSON.stringify(panelDirect));
  const fromPanel = store.laterOnItems.find((i) => i.url === PAGE_URL);
  check("这一篇被收进「等待整理」", !!fromPanel && (fromPanel.projectId || null) === null, `projectId=${JSON.stringify(fromPanel?.projectId)}`);
  check("诊断里记下这次来自面板按钮", store.laterOnDiag?.lastTrigger === "panel", store.laterOnDiag?.lastTrigger);

  const badPage = await sendFromPage({ type: "QUICK_SAVE_TAB", source: "panel", tabId: 404 });
  check("页面无法收藏时按钮收到明确的失败原因", badPage?.ok === false && !!badPage?.error, JSON.stringify(badPage));

  // ── 第 8 步：页面注入卡住时，只重试网页浮层，绝不能打开独立窗口 ──
  console.log("\n── 第 8 步：浮层注入卡住时不打开其它形态的窗口 ──");
  store.laterOnSettings = { askFolderOnSingle: true, askFolderOnSingleOptIn: true };
  hangPickerPayloadInjection = true;
  const windowsBeforeFallback = windowsCreated.length;
  const fallbackStartedAt = Date.now();
  const fallbackResult = await sandbox.quickSave(tab, "shortcut");
  const fallbackElapsed = Date.now() - fallbackStartedAt;
  hangPickerPayloadInjection = false;
  check("两次网页内注入都失败后返回明确结果", fallbackResult?.ok === false && fallbackResult?.pending === false && !!fallbackResult?.error, JSON.stringify(fallbackResult));
  check("绝不打开独立选择窗口", windowsCreated.length === windowsBeforeFallback, `窗口 +${windowsCreated.length - windowsBeforeFallback}`);
  check("会重试但不会无限等待", fallbackElapsed >= PICKER_TIMEOUT_MS * 2 && fallbackElapsed < PICKER_TIMEOUT_MS * 2 + 1500, `${fallbackElapsed}ms`);
  check("网页上给出重试提示", pills.some((entry) => /页面加载完成后再试/.test(entry.items?.[0]?.text || "")), pills.at(-1)?.items?.[0]?.text);
  check("诊断里写明网页内选择框未打开", store.laterOnDiag?.lastStage === "网页内选择框未打开", store.laterOnDiag?.lastStage);
  await sendFromPage({ type: "CANCEL_BATCH_SAVE" });

  // ── 第 9 步：在全屏收藏库按 Alt+1，要有页内文字反馈 ─────────
  console.log("\n── 第 9 步：全屏收藏库里的快捷键反馈 ──");
  const noticesBefore = runtimeNotices.length;
  await sandbox.handleCommand("quick-save", {
    id: 88,
    windowId: 1,
    url: "chrome-extension://lateron/library.html",
    title: "LaterOn · 我的收藏"
  });
  const libraryNotice = runtimeNotices.at(-1);
  check("给全屏收藏库发送页内提示", runtimeNotices.length === noticesBefore + 1 && libraryNotice?.type === "SHOW_LIBRARY_NOTICE", JSON.stringify(libraryNotice));
  check("提示说清要先打开想保存的网页", /打开想保存的网页/.test(libraryNotice?.message || "") && /Alt\+1/.test(libraryNotice?.message || ""), libraryNotice?.message);
  check("全屏页用收藏成功通知同款药丸变体", /showToast\([^\n]+3200,\s*"pill"\)/.test(librarySource));
  const pillRule = /\.toast\.pill-toast\s*\{[\s\S]*?\}/.exec(libraryCss)?.[0] || "";
  check("药丸复用右上角位置与圆角样式", /top:\s*18px/.test(pillRule) && /right:\s*18px/.test(pillRule) && /border-radius:\s*999px/.test(pillRule), pillRule.replace(/\s+/g, " ").slice(0, 180));
  check("药丸复用成功通知的绿色对勾", /\.toast\.pill-toast::before[\s\S]*content:\s*"✓"[\s\S]*#4fe2b5/.test(libraryCss));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
