// 模拟验证：一键收藏「先在网页里弹出选项目浮层 → 再一篇一篇收藏」的完整流程。
// 用假的 chrome API 把 background.js 跑起来，检查：
//  1) 触发快捷键后不会立刻收藏，而是在当前网页里注入一个「选项目」浮层（不新开窗口）
//  2) 浮层里确认后，新收藏全部带上了所选项目（projectId）
//  3) 已收藏过的网址会被移进这次新选的项目（信息缺的顺带补上），并单独提示「已移到…」
//  4) 仍然是一篇一篇顺序执行、完成一篇通知一篇，且通知发到「按键那一刻的活动标签页」
//  5) 取消 / 重复触发 / 新建项目（含重名与空名）的处理
//  6) 当前停在 Chrome 内部页（注入不了内容）时，不创建任何其它形态的选择窗口
//  7) 设置里关掉「先选项目」后，直接收藏、不再弹任何东西
//  8) 再收一次（全在库里）时：不新增，但把已收藏的都搬进新选的项目
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { webcrypto } = require("crypto");
const { URL } = require("url");

const SOURCE = path.resolve(__dirname, "..", "background.js");
const src = fs.readFileSync(SOURCE, "utf8");
const TIMEOUT_MS = Number(/const EXTRACT_TIMEOUT_MS = (\d+)/.exec(src)[1]);

const PENDING_KEY = "laterOnPendingBatch";
const LAST_PROJECT_KEY = "laterOnLastProjectId";

const HANG_ID = 3;      // 卡死、永不返回的标签
const DISCARDED_ID = 8; // 休眠标签
const DUP_URL = "https://dup.com/old";
const FOLDER_ID = "folder-work";

function makeTab(id, url, title, extra = {}) {
  return { id, url, title, favIconUrl: `https://${new URL(url).hostname}/favicon.ico`, windowId: 1, active: false, status: "complete", ...extra };
}

const tabs = [
  makeTab(1, "https://site1.com/a", "文章一"),
  makeTab(2, "https://site2.com/b", "文章二"),
  makeTab(HANG_ID, "https://slow.com/hang", "卡死页面"),
  makeTab(4, "https://site4.com/d", "文章四"),
  makeTab(5, DUP_URL, "重复的老文章"),
  makeTab(6, "https://site6.com/f", "文章六"),
  makeTab(7, "https://site7.com/g", "文章七"),
  makeTab(DISCARDED_ID, "https://site8.com/h", "休眠标签", { discarded: true, status: "unloaded" }),
  makeTab(9, "https://site9.com/i", "文章九"),
  makeTab(10, "https://site10.com/j", "没有封面摘要的页面"),
  makeTab(11, "https://site11.com/k", "文章十一"),
  makeTab(12, "https://site12.com/l", "文章十二")
];
tabs[0].active = true;

const store = {
  laterOnItems: [
    { id: "old-1", title: "重复的老文章", description: "暂无摘要", image: "", favicon: "", source: "dup.com", projectId: null, url: DUP_URL, savedAt: 1, read: false },
    { id: "old-2", title: "无关的老收藏", description: "摘要", image: "https://img/x.jpg", favicon: "", source: "x.com", projectId: null, url: "https://x.com/y", savedAt: 2, read: false }
  ],
  laterOnProjects: [{ id: FOLDER_ID, name: "工作", createdAt: 1 }],
  laterOnSettings: {},
  // 上次用过的项目：触发浮层时应该默认选中它。
  [LAST_PROJECT_KEY]: FOLDER_ID
};
const session = {};

const pills = [];         // 收到的药丸通知
const badge = [];         // 角标变化
const windowsCreated = [];
const windowsRemoved = [];
const overlays = [];      // 注入到网页里的「选择项目」浮层
let pendingOverlayPayload = null;
const bus = {};           // 页面 → 后台的消息通道（模拟 chrome.runtime.onMessage）
let pickerOpen = false;
const extractionLog = [];
let inflight = 0;
let inflightMax = 0;

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
    }
  },
  tabs: {
    query(filter = {}) {
      // 没有选项目窗口开着时返回空；开着时返回它（用于验证「重复触发会先关掉旧的」）。
      if (filter.url) return Promise.resolve(pickerOpen ? [{ id: 99, windowId: 99, url: filter.url }] : []);
      if (filter.active && filter.currentWindow) return Promise.resolve(tabs.filter((t) => t.active));
      if (filter.currentWindow) return Promise.resolve(tabs.slice());
      return Promise.resolve([]);
    },
    get: (id) => {
      const tab = tabs.find((t) => t.id === id);
      return tab ? Promise.resolve(tab) : Promise.reject(new Error("no tab"));
    },
    update: async () => {},
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    onCreated: { addListener() {} }
  },
  windows: {
    get: async () => ({ left: 0, top: 0, width: 1440, height: 900 }),
    create: async (options) => { windowsCreated.push(options); pickerOpen = true; return { id: 99 }; },
    remove: async (id) => { windowsRemoved.push(id); pickerOpen = false; },
    update: async () => {}
  },
  scripting: {
    insertCSS: async () => {},
    executeScript(options) {
      const tabId = options.target?.tabId;
      // 注入「选择项目」浮层：记下这次注入的内容（相当于用户在网页里看到了浮层）。
      if (typeof options.func === "function" && String(options.func).includes("lateron-picker-payload-data")) {
        pendingOverlayPayload = options.args?.[0];
        return Promise.resolve([{ result: undefined }]);
      }
      if (typeof options.func === "function" && String(options.func).includes("lateron-folder-picker")) {
        return Promise.resolve([{ result: true }]);
      }
      if (options.files?.includes("content-folder-picker.js")) {
        overlays.push({ tabId, payload: pendingOverlayPayload, at: Date.now() - start });
        pendingOverlayPayload = null;
        return Promise.resolve([{ result: undefined }]);
      }
      if (Array.isArray(options.args)) {
        pills.push({ tabId, items: options.args[0], at: Date.now() - start });
        return Promise.resolve([{ result: undefined }]);
      }
      if (!options.files?.includes("content-metadata.js")) return Promise.resolve([{ result: undefined }]);
      extractionLog.push(tabId);
      inflight += 1;
      inflightMax = Math.max(inflightMax, inflight);
      if (tabId === HANG_ID) {
        setTimeout(() => { inflight -= 1; }, TIMEOUT_MS);
        return new Promise(() => {});
      }
      const tab = tabs.find((t) => t.id === tabId);
      const bare = tabId === 10;
      return new Promise((resolve) => {
        setTimeout(() => {
          inflight -= 1;
          resolve([{
            result: {
              title: tab.title,
              description: bare ? "" : `这是 ${tab.title} 的摘要文字`,
              image: bare ? "" : `https://img.example.com/${tabId}.jpg`,
              favicon: tab.favIconUrl,
              source: new URL(tab.url).hostname,
              url: tab.url
            }
          }]);
        }, 40);
      });
    }
  },
  action: {
    setBadgeText: async ({ text }) => { badge.push(text); },
    setBadgeBackgroundColor: async () => {}
  },
  contextMenus: { removeAll: (cb) => cb && cb(), create() {}, onClicked: { addListener() {} } },
  runtime: {
    getURL: (path) => `chrome-extension://lateron/${path}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { bus.listener = fn; } }
  },
  commands: { onCommand: { addListener() {} } }
};

// 模拟「网页里的浮层给后台发消息」：走真正的 onMessage 通道，拿到 sendResponse 的结果。
function sendFromPage(message) {
  return new Promise((resolve) => {
    const kept = bus.listener(message, { tab: { id: 1 } }, resolve);
    if (!kept) resolve(undefined);
  });
}

// 确认之后后台是异步「一篇一篇」收的，这里等它真正跑完。
// 注意：调用前要先清掉上一次的 lastStage，否则可能一进来就以为是「完成」。
async function waitForBatchDone(deadlineMs = 12000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const stage = store.laterOnDiag?.lastStage;
    if (stage === "完成" || stage === "失败") return stage;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return store.laterOnDiag?.lastStage;
}

const sandbox = { chrome, crypto: webcrypto, URL, setTimeout, clearTimeout, console, Date, Promise, JSON, Set, Map };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const start = Date.now();
vm.runInContext(src, sandbox, { filename: "background.js" });

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};

(async () => {
  // ── 第 1 步：触发快捷键，应该只弹窗、不收藏 ──────────────────
  console.log("── 第 1 步：按下快捷键 ──");
  const triggered = await sandbox.saveAllTabsInWindow("shortcut");

  check("触发了「等待选择项目」", triggered?.pending === true, JSON.stringify(triggered));
  check("告诉了这次涉及几个标签页", triggered?.tabCount === 12, `tabCount=${triggered?.tabCount}`);
  check("没有立刻收藏任何东西", store.laterOnItems.length === 2, `${store.laterOnItems.length} 条`);
  check("没有新开窗口，而是在当前网页里弹出浮层", overlays.length === 1 && windowsCreated.length === 0, `浮层 ${overlays.length} 次 / 新窗口 ${windowsCreated.length} 个`);
  check("浮层注入到了用户正在看的那个网页", overlays[0]?.tabId === 1, `tabId=${overlays[0]?.tabId}`);

  const folderPayload = overlays[0]?.payload?.folders || [];
  const unfiledRow = folderPayload.find((folder) => folder.id === "");
  const workRow = folderPayload.find((folder) => folder.id === FOLDER_ID);
  check("浮层里列出了「等待整理」和已有项目", !!unfiledRow && !!workRow, folderPayload.map((f) => `${f.name}(${f.count})`).join(" / "));
  check("每个项目都带上了已收藏数量", unfiledRow?.count === 2 && workRow?.count === 0, `等待整理=${unfiledRow?.count} 工作=${workRow?.count}`);
  check("浮层默认选中上次用过的项目", overlays[0]?.payload?.selected === FOLDER_ID, `selected=${JSON.stringify(overlays[0]?.payload?.selected)}`);
  check("浮层里带上了将要收藏的页面清单", overlays[0]?.payload?.pages?.length === 12 && overlays[0].payload.pages[0].title === "文章一", `${overlays[0]?.payload?.pages?.length} 个页面`);
  check("浮层的主题跟着扩展设置走", overlays[0]?.payload?.theme === "light", `theme=${overlays[0]?.payload?.theme}`);
  check("提前告诉用户这一批里有几篇已经收藏过", overlays[0]?.payload?.savedCount === 1, `savedCount=${overlays[0]?.payload?.savedCount}`);

  check("这一批标签页被暂存下来了", session[PENDING_KEY]?.tabs?.length === 12, `${session[PENDING_KEY]?.tabs?.length} 个`);
  check("暂存里记下了「按键那一刻的活动标签页」", session[PENDING_KEY]?.notifyTabId === 1, `notifyTabId=${session[PENDING_KEY]?.notifyTabId}`);

  // ── 第 2 步：在浮层里选中「工作」并确认（走真实的「页面 → 后台」消息通道）──
  console.log("\n── 第 2 步：选了「工作」项目并确认 ──");
  const confirmReply = await sendFromPage({ type: "CONFIRM_BATCH_SAVE", projectId: FOLDER_ID });
  check("浮层点确认后立刻收到回执（好让它马上关闭）", confirmReply?.ok === true && confirmReply?.tabCount === 12, JSON.stringify(confirmReply));

  // 回执之后后台才逐篇收藏，这里等它跑完（平时它同时会往网页里弹药丸，我们看最终结果）。
  const deadline = Date.now() + 8000;
  while (store.laterOnDiag?.lastStage !== "完成" && store.laterOnDiag?.lastStage !== "失败" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const elapsed = Date.now() - start;

  const items = store.laterOnItems;
  const addedItems = items.filter((i) => i.url !== "https://x.com/y" && i.id !== "old-1");
  const patched = items.find((i) => i.id === "old-1");
  const diag = store.laterOnDiag || {};
  const result = { added: diag.lastAdded, duplicated: diag.lastDuplicated, enriched: diag.lastEnriched, degraded: diag.lastDegraded };

  console.log(`耗时 ${elapsed}ms | 结果 ${JSON.stringify(result)}`);
  console.log(`同时在跑的最大数量 ${inflightMax} | 药丸通知 ${pills.length} 条\n`);

  check("新增 11 篇", result.added === 11, `added=${result.added}`);
  check("跳过 1 篇重复", result.duplicated === 1, `duplicated=${result.duplicated}`);
  check("新收藏全部放进了所选项目", addedItems.length === 11 && addedItems.every((i) => i.projectId === FOLDER_ID), `${addedItems.filter((i) => i.projectId === FOLDER_ID).length}/11 带 projectId`);
  check("重复的那条也被移进了所选项目", patched.projectId === FOLDER_ID, `projectId=${patched.projectId}`);
  check("回填了重复那条的封面和摘要", !!patched.image && patched.description !== "暂无摘要", `image=${patched.image ? "有" : "无"}`);
  check("重复那条没有被重复插入（还是原来的 id）", items.filter((i) => i.url === DUP_URL).length === 1, `${items.filter((i) => i.url === DUP_URL).length} 条`);
  check("诊断里记下了搬家数量", diag.lastMoved === 1, `lastMoved=${diag.lastMoved}`);
  check("记住了这次选的项目（下次默认选中）", store[LAST_PROJECT_KEY] === FOLDER_ID, store[LAST_PROJECT_KEY]);
  check("待处理批次已清空（不会重复执行）", session[PENDING_KEY] === undefined);
  check("顺序执行（任何时刻最多 1 个标签在抓取）", inflightMax === 1, `最大并发 ${inflightMax}`);
  check("休眠标签被跳过、没有白等", !extractionLog.includes(DISCARDED_ID));
  check("每完成一篇就立刻通知一篇", pills.length === 15, `${pills.length} 条（1 开始 + 12 逐篇 + 2 收尾）`);
  check("通知全部发到「按键那一刻的活动标签页」", pills.every((p) => p.tabId === 1), `涉及标签 ${[...new Set(pills.map((p) => p.tabId))].join(",")}`);

  const firstPill = pills[0]?.items?.[0]?.text || "";
  check("第 1 条通知写明存进哪个项目", firstPill.includes("工作"), firstPill);

  const perItem = pills.slice(1, 13).map((p) => p.items[0].text);
  const expectedTitles = ["文章一", "文章二", "卡死页面", "文章四", "重复的老文章", "文章六", "文章七", "休眠标签", "文章九", "没有封面摘要的页面", "文章十一", "文章十二"];
  check("逐篇通知的顺序与标签页顺序一致", perItem.every((text, i) => text.includes(expectedTitles[i])), perItem.map((t) => t.replace(/^[^：]*：/, "")).join(" → "));

  const dupPill = pills[5]?.items?.[0] || {};
  check("已收藏过的那篇提示写明「已移到」哪个项目", typeof dupPill.text === "string" && dupPill.text.includes("已移到「工作」") && dupPill.text.includes("重复的老文章"), dupPill.text);
  check("用的是「搬家」样式（不是灰色的「已收藏过」）", dupPill.kind === "move", `kind=${dupPill.kind}`);

  const summaryPill = pills[13]?.items?.[0]?.text || "";
  check("总结里既说新增、也说有几篇搬了家", summaryPill.includes("新增 11 篇") && summaryPill.includes("1 篇已收藏的移入「工作」"), summaryPill);
  check("收藏库新增 11 条、按标签页顺序排列", addedItems.length === 11 && items[0].title === "文章一", `最上面是「${items[0].title}」`);
  check("卡死的页面降级为新收藏（没有丢）", items.some((i) => i.title === "卡死页面"));
  check("未抓全的 3 篇被标记", result.degraded === 3, `degraded=${result.degraded}`);
  check("诊断记录为「完成」", diag.lastStage === "完成", JSON.stringify({ stage: diag.lastStage, added: diag.lastAdded, dup: diag.lastDuplicated }));

  // ── 第 3 步：取消 / 重复触发 / 新建项目 ────────────────────
  console.log("\n── 第 3 步：取消 / 重复触发 / 新建项目 ──");
  await sandbox.saveAllTabsInWindow("menu");
  const before = store.laterOnItems.length;
  check("重复触发会再弹一次浮层（覆盖旧的）", overlays.length === 2, `注入 ${overlays.length} 次`);
  const cancelled = await sendFromPage({ type: "CANCEL_BATCH_SAVE" });
  check("取消后清掉了待处理批次", cancelled?.cancelled === true && session[PENDING_KEY] === undefined, JSON.stringify(cancelled));
  check("取消不会收藏任何东西", store.laterOnItems.length === before, `${store.laterOnItems.length} 条`);
  const again = await sendFromPage({ type: "CONFIRM_BATCH_SAVE", projectId: FOLDER_ID });
  check("没有待处理批次时，确认会被拒绝", again?.ok === false, JSON.stringify(again));

  const created = await sendFromPage({ type: "CREATE_PROJECT", name: "  临时收藏  " });
  check("新建项目成功（名称去掉首尾空格）", created?.ok === true && created.project?.name === "临时收藏", JSON.stringify(created?.project));
  check("新项目写进同一份数据、形状一致", (store.laterOnProjects || []).some((p) => p.id === created.project.id && typeof p.createdAt === "number"), (store.laterOnProjects || []).map((p) => p.name).join(" / "));
  const sameName = await sendFromPage({ type: "CREATE_PROJECT", name: "临时收藏" });
  check("同名项目不重复创建、直接选用已有那个", sameName?.project?.id === created.project.id && (store.laterOnProjects || []).filter((p) => p.name === "临时收藏").length === 1, `同名 ${(store.laterOnProjects || []).filter((p) => p.name === "临时收藏").length} 个`);
  const emptyName = await sendFromPage({ type: "CREATE_PROJECT", name: "   " });
  check("空名称会被拒绝", emptyName?.ok === false, JSON.stringify(emptyName));

  // ── 第 4 步：停在 Chrome 内部页时不创建独立 / 全屏选择窗口 ──
  console.log("\n── 第 4 步：内部页不创建其它形态的选择窗口 ──");
  tabs[0].active = false;
  tabs.push(makeTab(20, "chrome://settings", "设置", { active: true }));
  const overlayCount = overlays.length;
  const windowCount = windowsCreated.length;
  const unsupported = await sandbox.saveAllTabsInWindow("shortcut");
  check("内部页无法承载网页浮层时返回明确失败", unsupported?.ok === false && unsupported?.pending === false && /普通网页/.test(unsupported?.error || ""), JSON.stringify(unsupported));
  check("没有注入浮层，也没有创建独立窗口", overlays.length === overlayCount && windowsCreated.length === windowCount, `浮层 +${overlays.length - overlayCount} / 窗口 +${windowsCreated.length - windowCount}`);
  check("暂存的标签页数不受影响（内部页不计入）", session[PENDING_KEY]?.tabs?.length === 12, `${session[PENDING_KEY]?.tabs?.length} 个`);
  await sendFromPage({ type: "CANCEL_BATCH_SAVE" });

  // 再按一次也必须保持一致，不能偶发地创建另一套窗口。
  const unsupportedAgain = await sandbox.saveAllTabsInWindow("shortcut");
  check("重复触发仍不创建窗口", unsupportedAgain?.ok === false && windowsCreated.length === windowCount && windowsRemoved.length === 0, `创建 ${windowsCreated.length - windowCount} / 关闭 ${windowsRemoved.length}`);
  await sendFromPage({ type: "CANCEL_BATCH_SAVE" });
  tabs.pop();
  tabs[0].active = true;

  // ── 第 5 步：设置里关掉「先选项目」 ──────────────────────
  console.log("\n── 第 5 步：关掉「先选项目」后直接收藏 ──");
  store.laterOnItems = [];
  store.laterOnSettings = { askFolderOnBatch: false };
  const createdBefore = windowsCreated.length;
  const overlayBefore = overlays.length;
  const direct = await sandbox.saveAllTabsInWindow("shortcut");
  check("直接收藏、不再弹浮层、也不再开窗口", windowsCreated.length === createdBefore && overlays.length === overlayBefore && direct.pending !== true, JSON.stringify(direct));
  check("仍然全部放进上次用过的项目", store.laterOnItems.length === 12 && store.laterOnItems.every((i) => i.projectId === FOLDER_ID), `${store.laterOnItems.filter((i) => i.projectId === FOLDER_ID).length}/12`);

  // ── 第 6 步：再收一次（12 篇都已在库里）→ 应该「一条不新增，全部搬进新选的项目」──
  console.log("\n── 第 6 步：已收藏过的链接会被搬进这次新选的项目 ──");
  const before6 = store.laterOnItems.length;
  const pillsBefore6 = pills.length;
  store[LAST_PROJECT_KEY] = ""; // 这次「上次用过的项目」是空的 → 目标为「等待整理」
  await sandbox.saveAllTabsInWindow("shortcut");
  const diag6 = store.laterOnDiag || {};
  check("一条也没新增（12 篇都已在库里）", diag6.lastAdded === 0 && store.laterOnItems.length === before6, `added=${diag6.lastAdded} / ${store.laterOnItems.length} 条`);
  check("12 篇全部从「工作」搬回「等待整理」", store.laterOnItems.every((i) => (i.projectId || null) === null), `仍在「工作」的 ${store.laterOnItems.filter((i) => i.projectId === FOLDER_ID).length} 篇`);
  check("搬了家但没被复制成两条", store.laterOnItems.length === 12, `${store.laterOnItems.length} 条`);
  check("诊断里记下了「搬家 12 篇」", diag6.lastMoved === 12, `lastMoved=${diag6.lastMoved}`);

  const pills6 = pills.slice(pillsBefore6).map((p) => p.items[0]);
  const movedPills = pills6.filter((p) => String(p.text).startsWith("已移到「等待整理」"));
  check("每篇都弹了一条「已移到…」的通知", movedPills.length === 12, `共 ${movedPills.length} 条`);
  check("「搬家」通知用的是橙色搬家样式", movedPills.every((p) => p.kind === "move"), [...new Set(movedPills.map((p) => p.kind))].join(","));
  check("总结说明「把 12 篇已收藏的移入等待整理」", pills6.some((p) => /把 12 篇已收藏的移入「等待整理」/.test(String(p.text))), pills6.map((p) => p.text).join(" | "));

  // ── 第 7 步：选的项目在「等待选择」期间被删掉 → 退回「等待整理」──
  console.log("\n── 第 7 步：项目被删掉后的兜底 ──");
  store.laterOnItems = [];
  store.laterOnSettings = {}; // 重新打开「先选项目」
  store.laterOnProjects = [{ id: FOLDER_ID, name: "工作", createdAt: 1 }];
  store.laterOnDiag = {};
  await sandbox.saveAllTabsInWindow("shortcut");
  check("这一批都还没收藏过，浮层就不吓唬人", overlays.at(-1)?.payload?.savedCount === 0, `savedCount=${overlays.at(-1)?.payload?.savedCount}`);
  store.laterOnProjects = []; // 模拟：用户在这期间把「工作」删了
  await sendFromPage({ type: "CONFIRM_BATCH_SAVE", projectId: FOLDER_ID });
  await waitForBatchDone();
  check("项目已经不存在时，收藏退回「等待整理」", store.laterOnItems.length === 12 && store.laterOnItems.every((i) => (i.projectId || null) === null), `${store.laterOnItems.filter((i) => i.projectId).length} 篇带 projectId`);
  check("也不会再把它记成「上次用过的项目」", !store[LAST_PROJECT_KEY], JSON.stringify(store[LAST_PROJECT_KEY]));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});

// 说明：最后一步依赖「设置里 askFolderOnBatch 为 false」，这里在跑之前改一下。
