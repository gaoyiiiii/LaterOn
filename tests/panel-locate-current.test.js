// 侧栏「定位到正在读的那篇」行为测试。
// 用 jsdom 加载真实 sidepanel.html + sidepanel.js，自己铺一套假坐标 / 假滚动
// （jsdom 没有排版，window.scrollTo 也不真的滚），覆盖：
//  1) 正在读那篇在分批渲染的后面几批里 → 列表画完才定位（不能拿半张列表的坐标去滚）
//  2) 平滑滚动被浏览器丢掉了（侧栏刚滑出来时页面还不可滚动）→ 复查后补滚并到位
//  3) 打开时本来就在视野里 → 不乱跳
//  4) 那篇被筛选条件挡在外面 → 安静放弃，不报错
//  5) 在别处点开另一篇 → 跟着高亮并滚过去
//  6) 定位结果会记进 laterOnLocateDiag（设置页「自检信息」能看）
//  7) 切到另一个项目里的已收藏标签页 → 先自动切项目，再高亮定位文章
//  8) 已收藏页顶部显示“已收藏”，未收藏页才显示“收藏”操作
// 运行：NODE_PATH=<jsdom 路径> node tests/panel-locate-current.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8");
const i18nSource = fs.readFileSync(`${ROOT}/i18n.js`, "utf8");
const sidepanelSource = fs.readFileSync(`${ROOT}/sidepanel.js`, "utf8");
const urlSource = fs.readFileSync(`${ROOT}/url-utils.js`, "utf8");
const tabNavigationSource = fs.readFileSync(`${ROOT}/tab-navigation.js`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const now = Date.now();
const CARD_H = 100;      // 一张卡片占的高度（含间距）
const CARD_INNER = 92;   // 卡片自身高度
const HEAD_H = 238;      // 列表上方那一堆（收藏条 / 搜索 / 筛选 / 项目）的高度
const VIEWPORT = 800;
const STICKY_H = 58;
const EDGE_GAP = 10;

// 把第 index 张卡滚到视口中间，页面应该停在哪个 scrollY
const expectedTop = (index, stickyBottom = STICKY_H) => {
  const visibleTop = stickyBottom + EDGE_GAP;
  return Math.max(0, HEAD_H + index * CARD_H - visibleTop - (VIEWPORT - visibleTop - CARD_INNER) / 2);
};

function makeItem(overrides = {}) {
  return {
    id: "x", title: "标题", description: "摘要", image: "", favicon: "",
    source: "x.com", projectId: null, url: "https://x.com", savedAt: now, status: "unread",
    ...overrides
  };
}

// 建一个页面环境，并铺上假排版：
//  - 每张卡片按它在列表里的序号算出 top（第 n 张 = HEAD_H + n * CARD_H - 当前滚动距离）
//  - window.scrollTo 真的会改变「滚动距离」，这样事后能量出它到底进没进视野
//  - dropSmooth=true 时「平滑滚动」什么都不做，用来模拟浏览器把这次滚动丢掉了
function boot({ store, dropSmooth = false, activeTab: initialTab = null, stickyBottom = STICKY_H }) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
  virtualConsole.on("error", (message) => errors.push(String(message)));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/sidepanel.html",
    virtualConsole
  });
  const { window } = dom;
  const { document } = window;

  const memStore = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (memStore.has(key) ? memStore.get(key) : null),
      setItem: (key, value) => memStore.set(key, String(value)),
      removeItem: (key) => memStore.delete(key)
    }
  });

  // ── 假排版 / 假滚动 ──
  let scrollY = 0;
  const scrollCalls = [];
  const cardIndex = (el) => Array.prototype.indexOf.call(document.querySelectorAll("#items .item"), el);

  Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  Object.defineProperty(window, "pageYOffset", { configurable: true, get: () => scrollY });

  window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches?.("header")) {
      return { top: 0, bottom: stickyBottom, height: stickyBottom, left: 0, right: 280, width: 280, x: 0, y: 0, toJSON() {} };
    }
    const index = cardIndex(this);
    if (index < 0) return { top: 0, bottom: 0, height: 0, left: 0, right: 280, width: 280, x: 0, y: 0, toJSON() {} };
    const top = HEAD_H + index * CARD_H - scrollY;
    return { top, bottom: top + CARD_INNER, height: CARD_INNER, left: 0, right: 280, width: 280, x: 0, y: top, toJSON() {} };
  };
  // 文档总高度：跟着列表里有多少张卡变
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => HEAD_H + document.querySelectorAll("#items .item").length * CARD_H + 30
  });
  window.scrollTo = function (arg, legacyTop) {
    const options = typeof arg === "object" && arg !== null ? arg : { top: legacyTop };
    const behavior = options.behavior || "auto";
    scrollCalls.push({ behavior, top: Math.round(options.top || 0) });
    if (behavior === "smooth" && dropSmooth) return;   // 模拟浏览器把平滑滚动丢掉了
    scrollY = Math.max(0, Math.round(options.top || 0));
  };

  const changeListeners = [];
  // 大多数定位用例只在验证存储里的 CURRENT_ITEM_KEY，不模拟浏览器当前页。
  // 这时 query 返回空数组，避免一个无关 URL 把预设的当前文章清掉。
  let activeTab = initialTab;
  let activatedListener = null;
  let updatedListener = null;
  window.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve(store),
        set: async (patch) => {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: store[key], newValue: JSON.parse(JSON.stringify(value)) };
            store[key] = JSON.parse(JSON.stringify(value));
          }
          window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        }
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    },
    tabs: {
      query: () => Promise.resolve(activeTab ? [activeTab] : []),
      update: () => Promise.resolve({}),
      onActivated: { addListener(fn) { activatedListener = fn; } },
      onUpdated: { addListener(fn) { updatedListener = fn; } }
    },
    windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
    runtime: {
      getURL: (path) => `chrome-extension://lateron/${path}`,
      sendMessage: () => Promise.resolve({ ok: false }),
      onMessage: { addListener() {} }
    }
  };

  window.eval(i18nSource);
  window.eval(urlSource);
  window.eval(tabNavigationSource);
  window.eval(sidepanelSource);

  return {
    window,
    document,
    store,
    errors,
    scrollCalls,
    // 某个 id 的卡片现在是不是整个都落在可视区域里（顶部 58px 被吸顶标题栏压住不算）
    inView(id) {
      const card = document.querySelector(`.item[data-id="${id}"]`);
      if (!card) return null;
      const rect = card.getBoundingClientRect();
      return rect.top >= stickyBottom + EDGE_GAP - 1 && rect.bottom <= VIEWPORT + 1;
    },
    isHighlighted(id) {
      const card = document.querySelector(`.item[data-id="${id}"]`);
      return !!card && card.classList.contains("is-current");
    },
    switchTab(tab) {
      activeTab = { id: 1, windowId: 7, active: true, ...tab };
      activatedListener?.({ tabId: activeTab.id, windowId: activeTab.windowId });
    },
    updateTab(changeInfo, tab = {}) {
      activeTab = { ...activeTab, ...tab, active: true };
      updatedListener?.(activeTab.id, changeInfo, activeTab);
    }
  };
}

// 60 篇：多于第一批的 30 张，正在读那篇排在第 45 位（落在分批渲染的后面几批里）
function bigStore(currentIndex, overrides = {}) {
  const items = Array.from({ length: 60 }, (_, i) =>
    makeItem({ id: `a-${i}`, title: `第 ${i} 篇`, savedAt: now - i * 1000 })
  );
  return {
    laterOnItems: items,
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {},
    laterOnFilterChosen: true,
    laterOnCurrentItem: currentIndex == null ? null : `a-${currentIndex}`,
    ...overrides
  };
}

(async () => {
  // ═══ ① 正在读那篇排在后面（不在第一批里）：列表画完才定位 ═══
  console.log("── ① 正在读那篇在分批渲染的后面 → 等列表铺完再滚过去 ──");
  const envA = boot({ store: bigStore(45) });
  check("刚启动时还没滚（那张卡还没画出来）", envA.scrollCalls.length === 0, `${envA.scrollCalls.length} 次`);
  await tick(1500);
  check("列表画完后滚动发生了", envA.scrollCalls.length >= 1, `${envA.scrollCalls.length} 次`);
  check("滚到的位置正好是「第 45 张居中」",
    envA.scrollCalls.length > 0 && envA.scrollCalls[envA.scrollCalls.length - 1].top === expectedTop(45),
    `实际 ${JSON.stringify(envA.scrollCalls[envA.scrollCalls.length - 1])} / 期望 ${expectedTop(45)}`);
  check("滚完之后它确实在可视区域里", envA.inView("a-45") === true, String(envA.inView("a-45")));
  check("它同时是唯一高亮的那张", envA.isHighlighted("a-45"));

  // ═══ ② 平滑滚动被浏览器丢掉了 → 复查后补一次，把人送到 ═══
  console.log("\n── ② 平滑滚动被丢掉 → 复查后补一次并滚到位 ──");
  const envB = boot({ store: bigStore(45), dropSmooth: true });
  await tick(1500);
  const smooth = envB.scrollCalls.filter((call) => call.behavior === "smooth");
  const instant = envB.scrollCalls.filter((call) => call.behavior === "auto");
  check("先尝试了平滑滚动", smooth.length >= 1, `${smooth.length} 次`);
  check("发现没到位后又补了一次瞬间滚动", instant.length >= 1, `${instant.length} 次`);
  check("补完之后它落在可视区域里", envB.inView("a-45") === true, String(envB.inView("a-45")));

  // ═══ ③ 打开时就已经在视野里 → 不乱跳 ═══
  console.log("\n── ③ 打开时它本来就看得见 → 不滚动 ──");
  const envC = boot({ store: bigStore(2) });
  await tick(1500);
  check("本来就在视野里，一次都没滚", envC.scrollCalls.length === 0, `${envC.scrollCalls.length} 次`);
  check("高亮照常打上", envC.isHighlighted("a-2"));

  // ═══ ④ 那篇被筛选条件挡在外面 → 不定位也不报错 ═══
  console.log("\n── ④ 正在读那篇被筛选挡住 → 安静放弃，不报错 ──");
  const envD = boot({ store: bigStore(45, { laterOnFilter: "done" }) });   // 筛「已读」，但这批全是未读
  await tick(1500);
  check("列表是空的（被筛掉了）", envD.document.querySelectorAll("#items .item").length === 0);
  check("没有硬滚（不报错、不卡住）", envD.scrollCalls.length === 0, `${envD.scrollCalls.length} 次`);
  check("没有 jsdom 报错", envD.errors.length === 0, envD.errors.slice(0, 2).join(" | "));

  // ═══ ⑤ 切到「正在读」的另一篇：跟着滚过去 ═══
  console.log("\n── ⑤ 在别处点开另一篇 → 侧栏跟着高亮并滚过去 ──");
  const envE = boot({ store: bigStore(2) });
  await tick(1500);
  check("先定位在靠前那篇", envE.isHighlighted("a-2"));
  await envE.window.chrome.storage.local.set({ laterOnCurrentItem: "a-50" });
  await tick(1200);
  check("高亮换到了新那篇", envE.isHighlighted("a-50") && !envE.isHighlighted("a-2"));
  check("并且滚到了新那篇", envE.inView("a-50") === true, String(envE.inView("a-50")));

  // ═══ ⑥ 定位结果记进诊断（设置页能看到）═══
  console.log("\n── ⑥ 定位结果写进 laterOnLocateDiag ──");
  const diag = envE.store.laterOnLocateDiag;
  check("写入了定位诊断", !!diag && typeof diag.at === "number", JSON.stringify(diag));
  check("记下了找没找到那张卡", diag?.found === true, String(diag?.found));
  check("记下了滚完在不在视野里", diag?.inView === true, String(diag?.inView));

  const envF = boot({ store: bigStore(45, { laterOnFilter: "done" }) });
  await tick(1500);
  check("被筛选挡住时诊断里写明「没找到」", envF.store.laterOnLocateDiag?.found === false,
    JSON.stringify(envF.store.laterOnLocateDiag));

  // ═══ ⑦ 切换浏览器标签页：目标收藏在另一个项目里 ═══
  console.log("\n── ⑦ 切到另一个项目的已收藏网页 → 自动切项目并定位 ──");
  const crossProjectStore = {
    laterOnItems: [
      makeItem({ id: "work-1", title: "工作文章", projectId: "work", url: "https://example.com/work" }),
      makeItem({ id: "read-1", title: "阅读文章", projectId: "read", url: "https://example.com/read", savedAt: now - 1000 })
    ],
    laterOnProjects: [
      { id: "work", name: "工作" },
      { id: "read", name: "阅读" }
    ],
    laterOnActiveProject: "work",
    laterOnSettings: {},
    laterOnCovers: {},
    laterOnCurrentItem: "work-1"
  };
  const envG = boot({
    store: crossProjectStore,
    activeTab: { id: 1, windowId: 7, active: true, url: "https://example.com/work", title: "工作文章" }
  });
  await tick(300);
  check("起点在「工作」项目", envG.store.laterOnActiveProject === "work" && envG.isHighlighted("work-1"));
  envG.switchTab({ id: 2, url: "https://example.com/read", title: "阅读文章" });
  await tick(500);
  const activeProjectName = envG.document.querySelector("#projectFilters .project-filter.active .project-name")?.textContent;
  check("侧栏自动切到目标文章所属的「阅读」项目",
    envG.store.laterOnActiveProject === "read" && activeProjectName === "阅读",
    `store=${envG.store.laterOnActiveProject} / active=${activeProjectName}`);
  check("旧项目文章被筛掉，目标文章已出现并高亮",
    !envG.document.querySelector('.item[data-id="work-1"]') && envG.isHighlighted("read-1"));
  check("目标文章定位在可视区域", envG.inView("read-1") === true, String(envG.inView("read-1")));
  const saveButton = envG.document.querySelector("#saveCurrent");
  check("已保存页面顶部明确显示“已保存”", saveButton.disabled && saveButton.classList.contains("saved")
    && saveButton.querySelector(".save-label").textContent === "已保存", saveButton.textContent.trim());
  envG.switchTab({ id: 3, url: "https://example.com/new", title: "还没收藏的文章" });
  await tick(300);
  check("未收藏页面恢复为可点击的“收藏”按钮", !saveButton.disabled && !saveButton.classList.contains("saved")
    && saveButton.querySelector(".save-label").textContent === "收藏", saveButton.textContent.trim());

  // ═══ ⑧ 侧栏拖宽 / 顶部栏变高后仍然不会遮住卡片 ═══
  console.log("\n── ⑧ 顶部吸顶区变高 → 按实际可见区域重新居中 ──");
  const wideStickyBottom = 96;
  const envH = boot({ store: bigStore(45), stickyBottom: wideStickyBottom });
  await tick(1500);
  const wideLastScroll = envH.scrollCalls[envH.scrollCalls.length - 1];
  check("定位使用实测顶部栏高度，而不是写死 58px",
    wideLastScroll?.top === expectedTop(45, wideStickyBottom),
    `实际 ${JSON.stringify(wideLastScroll)} / 期望 ${expectedTop(45, wideStickyBottom)}`);
  check("高亮卡片完整落在吸顶栏下方", envH.inView("a-45") === true, String(envH.inView("a-45")));

  console.log(`\n${failures === 0 ? "🎉 全部通过" : `❌ 有 ${failures} 项没通过`}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("测试跑挂了：", error);
  process.exit(1);
});
