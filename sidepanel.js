const STORAGE_KEY = "laterOnItems";
const PROJECTS_KEY = "laterOnProjects";
const ACTIVE_PROJECT_KEY = "laterOnActiveProject";
const SETTINGS_KEY = "laterOnSettings";
const tr = (key, vars) => window.LaterOnI18n?.t(key, vars) || key;
// 与全屏界面共享的「当前正在读哪篇」标记（详见 library.js 的注释）。
const CURRENT_ITEM_KEY = "laterOnCurrentItem";
// 与全屏界面共享的「当前筛到哪一档」（全部 / 未读 / 已读）：一边切，另一边跟着切。
const FILTER_KEY = "laterOnFilter";
const FILTER_CHOSEN_KEY = "laterOnFilterChosen";
const DEFAULT_FILTER = "unread";
// 与全屏界面共享的「自定义顺序」：全屏拖出来的阅读顺序，侧栏照着排。
const ORDER_KEY = "laterOnOrder";
// 用户自己上传的封面（体积大）：单独放一个键，不和收藏列表混在一个数组里。
// 否则每次读写列表都要「连图一起搬」，数据攒多了侧栏打开就会卡很久。
const COVERS_KEY = "laterOnCovers";
// 侧栏「秒开」缓存：把上一回的收藏列表快照存进本页的 localStorage（同步可读）。
// 打开侧栏时先画缓存，再去 chrome.storage 拿最新数据核对——就算存储读取慢，
// 界面也不会白屏干等。
const CACHE_KEY = "laterOnPanelCache";
// 本机 localStorage 是不是本身就慢（第一次读就超过 0.4 秒即判定）。
// 慢的话就彻底不再碰它：秒开快照靠不住，反复读写反而一次比一次拖。
let localStorageSlow = false;
let cacheSaveTimer = null;
let sidePanelWindowId = null;
let sidePanelReady = false;

// 侧栏自己所在窗口的 id 是异步取的（`chrome.windows.getCurrent()`），
// 而完整界面的握手请求可能比它先到。把这次查询存成 Promise，
// 收到握手时等它就绪再回答，避免完整界面白白等到超时。
const windowIdReady = chrome.windows.getCurrent().then(
  (windowInfo) => { sidePanelWindowId = windowInfo.id; return windowInfo.id; },
  () => null
);

// 完整界面会等待这个握手完成，再将当前标签页跳转到文章。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "PING_SIDEPANEL") return;
  windowIdReady.then((id) => sendResponse({ ready: sidePanelReady && id === message.windowId }));
  return true;   // 异步应答
});

let items = [];
let projects = [];
let currentItem = null;
let filter = DEFAULT_FILTER;
let query = "";
let activeProject = "unfiled";
let autoMarkRead = true;   // 点开文章是否自动标记为「在读」（与设置页同步）
let sortMode = "newest";   // 全屏那边的排序方式（只有 custom 会影响这里的先后顺序）
let orders = {};           // 用户拖出来的自定义顺序（与全屏共享：{ 范围: [收藏 id] }）
let covers = {};           // 用户上传的封面：{ 收藏 id: dataURL }（与 COVERS_KEY 对应）
let loadGeneration = 0;
const itemMap = new Map();
let currentItemId = null;     // 当前正在读的文章 id（与全屏界面共享，用于高亮 + 滚动定位）
// 收藏一多（几百上千条），一次性把卡片全画出来会把主线程占住好几秒——
// 界面在这期间是一点不动的白屏。所以分批画：先快速画出第一屏，
// 剩下的排在浏览器空闲时继续。（放在文件靠前的位置：init() 会立刻用到它们）
// 侧栏一屏通常只看得到 4–6 张。首批画 8 张已经覆盖一屏，继续同步创建 30 张
// 只会把“第一眼能点”推迟；剩余卡片交给空闲时段补齐。
const FIRST_BATCH = 8;
// 秒开缓存只为第一屏服务，不是第二份完整数据库。存得越大，localStorage 冷读和
// JSON.parse 越慢；真实完整列表随后仍会由 chrome.storage.local 校准。
const CACHE_PREVIEW_LIMIT = 12;
let renderToken = 0;
// 「正在读」那一篇的定位任务：列表是分批画的，卡片可能还没画出来，
// 就算画出来了，列表没铺完时量到的坐标也是不准的。所以要等列表铺完再定位，并事后复查一次。
let pendingLocate = false;    // 有一个定位任务在等（可能被列表没画完卡着）
let renderComplete = false;   // 当前这一轮渲染是不是已经把整张列表画完了
let locateTimer = null;       // 滚动动画结束后复查用的定时器
// 顶部吸顶标题栏的窄栏兜底高度。实际定位会实时量 header：
// 侧栏拖宽后它会变成 64px，再写死 58px 就会让卡片上沿藏在吸顶栏下面。
const TOPBAR_FALLBACK_H = 58;
const LOCATE_EDGE_GAP = 10;
const nextFrame = (fn) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
let searchTimer = null;
let itemContextMenu = null;

// 三档：未读 / 在读 / 已读（已完成）。点「标为已读」按钮 = 标记完成，再点取消；
// 「在读」由点开文章自动进入——这样「点过但没读完」不再被算作已读。
function nextStatus(status) {
  return status === "done" ? "unread" : "done";
}
// 标记按钮上的文字：已完成时提示「标为未读」，其余提示「标为已读」。
function readToggleLabel(status) {
  return status === "done" ? tr("unreadButton") : tr("readButton");
}

// 筛选只认这三档。第一次打开还没有偏好，或存入了异常值时，默认展示「未读」；
// 用户手动切换后会写进 FILTER_KEY，以后恢复上次选择。
const FILTER_VALUES = new Set(["all", "unread", "done"]);
function normalizeFilter(value) {
  return FILTER_VALUES.has(value) ? value : DEFAULT_FILTER;
}
// 把三个筛选按钮的高亮同步成当前的 filter（全屏那边改了筛选，这边也要亮对按钮）。
function syncFilterButtons() {
  document.querySelectorAll(".filters .filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
}
// 切换筛选：本地先生效，再写进共享存储，让全屏界面跟着切。
async function setFilter(value) {
  const next = normalizeFilter(value);
  if (next === filter) { syncFilterButtons(); return; }
  filter = next;
  syncFilterButtons();
  render();
  try { await chrome.storage.local.set({ [FILTER_KEY]: filter, [FILTER_CHOSEN_KEY]: true }); } catch { /* 存不下就算了，本地筛选照常用 */ }
}

const list = document.querySelector("#items");
const empty = document.querySelector("#emptyState");
const template = document.querySelector("#itemTemplate");
const saveButton = document.querySelector("#saveCurrent");
const status = document.querySelector("#status");

// 先让浏览器完成一帧绘制骨架屏，再启动数据读取和真实列表渲染。
// 如果这里直接同步 init()，首屏缓存很快时骨架会在第一次 paint 前就被移除，
// 用户只会看到“突然出现的正式内容”，看不到正在加载的反馈。
if (typeof requestAnimationFrame === "function") {
  requestAnimationFrame(() => requestAnimationFrame(() => init()));
} else {
  setTimeout(() => init(), 16);
}

// 页面里加载最慢的几个文件（CSS / JS）。慢在「读页面」还是「读数据」，看这个就知道。
function slowestResources() {
  try {
    const entries = (typeof performance !== "undefined" && performance.getEntriesByType)
      ? performance.getEntriesByType("resource")
      : [];
    return entries
      .filter((entry) => typeof entry.duration === "number" && entry.duration > 150)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3)
      .map((entry) => ({
        name: String(entry.name).split("/").pop() || String(entry.name),
        ms: Math.round(entry.duration)
      }));
  } catch {
    return [];
  }
}

// 各段的中文名：横幅 / 诊断里都用它，顺序就是显示顺序。
const bootSegments = () => [
  ["page", tr("segPage")], ["cache", tr("segCache")], ["paint", tr("segPaint")],
  ["data", tr("segData")], ["migrate", tr("segMigrate")], ["other", tr("segOther")]
];

// 慢在哪一段 → 一句话结论（写给人看，不写术语）。
function slowConclusion(seg) {
  const worst = bootSegments()
    .filter(([key]) => (seg[key] || 0) > 0)
    .sort((a, b) => (seg[b[0]] || 0) - (seg[a[0]] || 0))[0];
  if (!worst) return "";
  const [key, label] = worst;
  const ms = seg[key];
  if (document.documentElement.lang === "en") {
    if (key === "page") return "Most time was spent preparing the page — Chrome was opening the side panel or loading its files; the number of saves isn’t the cause.";
    if (key === "cache") return `The local snapshot took ${ms} ms to read, so it will be skipped for the rest of this session.`;
    if (key === "data") return `Reading local storage took ${ms} ms. The cached first screen was shown while it finished.`;
    if (key === "paint") return `Painting the first screen took ${ms} ms. Remaining cards are being rendered in batches.`;
    if (key === "migrate") return `Migrating old covers took ${ms} ms. This should only happen once after upgrading.`;
    return `Finishing up took ${ms} ms.`;
  }
  if (key === "page") return "「准备页面」占了大头 → 是 Chrome 打开侧边栏 / 加载页面文件慢，跟收藏多少无关。";
  if (key === "cache") return `「读本地缓存」占了大头（${ms} 毫秒）→ 侧栏的秒开快照读取慢，接下来本次会话会直接跳过它，不再反复卡。`;
  if (key === "data") return `「读收藏数据」占了大头（${ms} 毫秒）→ 本地存储冷的时候这一次读取会慢，列表已先用缓存画出来了。`;
  if (key === "paint") return `「画第一屏」占了大头（${ms} 毫秒）→ 卡片太多，一次画不完（已分批，剩下的后台续画）。`;
  if (key === "migrate") return `「整理旧封面」占了大头（${ms} 毫秒）→ 升级后第一次打开会搬一次封面，之后不会再有。`;
  return `其余收尾花了 ${ms} 毫秒。`;
}

// 把「慢在哪一步」直接写在侧栏顶部：不用去设置页翻，也不用盯着转瞬即逝的提示。
function showSlowBanner({ total, firstPaint, seg, slow }) {
  const banner = document.querySelector("#slowBanner");
  if (!banner) return;
  // 只列出真正花掉时间的段（<80 毫秒的不值一提），免得横幅又长又没重点。
  const english = document.documentElement.lang === "en";
  const parts = bootSegments()
    .filter(([key]) => (seg[key] || 0) > 80)
    .map(([key, label]) => `${label} ${seg[key]} ${english ? "ms" : "毫秒"}`);
  const headline = firstPaint < total
    ? (english ? `First screen in ${(firstPaint / 1000).toFixed(1)} s; latest data ready in ${(total / 1000).toFixed(1)} s` : `首屏 ${(firstPaint / 1000).toFixed(1)} 秒可见，最新数据校准完成共 ${(total / 1000).toFixed(1)} 秒`)
    : (english ? `Opened in ${(total / 1000).toFixed(1)} s` : `这次打开用了 ${(total / 1000).toFixed(1)} 秒`);
  const lines = [`${headline}${english ? ": " : "："}${parts.length ? parts.join(" · ") : (english ? "every stage was under 80 ms" : "各段都不到 80 毫秒")}`];
  if (slow.length) lines.push(english ? `Slowest files: ${slow.map((entry) => `${entry.name} ${entry.ms} ms`).join(", ")}` : `最慢的文件：${slow.map((entry) => `${entry.name} ${entry.ms} 毫秒`).join("、")}`);
  const conclusion = slowConclusion(seg);
  if (conclusion) lines.push(conclusion);
  // 数据体积异常大单独说一句：这是「读数据慢」最常见的原因。
  if ((seg.bytes || 0) > 300000) {
    lines.push(english
      ? `Save data is ${Math.round(seg.bytes / 1024)} KB (normally only tens of KB). Large embedded content may be slowing it down.`
      : `收藏数据 ${Math.round(seg.bytes / 1024)} KB（正常几十 KB）→ 里面有体积大的内容，建议删掉带大图的旧收藏。`);
  }
  banner.textContent = lines.join("\n");
  banner.hidden = false;
}

// 到底慢在「读存储」还是慢在别的地方，一眼能看出来，不用猜。
function reportOpenSpeed(seg, bootStart, cacheHit) {
  const total = Math.round(nowMs() - bootStart);
  // 命中快照时，用户在真实存储返回前就已经能操作；把“首屏可见”和“后台校准完成”
  // 分开记录，避免一个 6 秒的冷存储读数让人误以为界面也白等了 6 秒。
  const firstPaint = cacheHit ? seg.page + seg.cache + seg.paint : total;
  // 「其余」= 总耗时里没被任何一段认领的部分（比如等待浏览器调度、脚本解析）。
  const other = Math.max(0, total - (seg.page + seg.cache + seg.paint + seg.data + seg.migrate));
  const full = { ...seg, other };
  // 数据超过 300 KB 就值得一说：正常只有几十 KB，大说明里面混进了图片之类的大块内容。
  const fatData = (seg.bytes || 0) > 300000;
  const slow = slowestResources();
  try { console.info(`[LaterOn] 打开耗时 总 ${total} 毫秒`, full, slow); } catch {}
  // 本地快照读起来比预期的慢很多 → 说明这台机器上 localStorage 本身就是慢的，
  // 那就别再一遍遍去读它了（每次 render 都会写一次，慢起来是叠加的）。
  if (seg.cache > 400) localStorageSlow = true;
  // 存一份到存储里：设置页「自检信息 → 侧栏打开耗时」也能看到。
  saveOpenDiag({
    at: Date.now(),
    page: seg.page,
    cache: seg.cache,
    paint: seg.paint,
    data: seg.data,
    migrate: seg.migrate,
    other,
    bytes: seg.bytes || 0,
    total,
    firstPaint,
    cacheHit,
    items: items.length,
    localStorageSlow,
    localStorageOk: probeLocalStorage(),
    slow
  });
  // 只有「真的等住了」才在界面上说话：1 秒以内是正常水平（冷启动时读一次存储
  // 本来就要几百毫秒，而列表早已先用秒开缓存画出来了），弹横幅反而像在报错。
  // 数据照样每次都存进诊断，去设置页「自检信息 → 侧栏打开耗时」随时能翻。
  if (total > 2000) showSlowBanner({ total, firstPaint, seg: full, slow });
}

// localStorage 到底能不能用？用不上「秒开缓存」的话会明显拖慢打开速度，这里记一笔。
function probeLocalStorage() {
  try {
    localStorage.setItem("laterOnProbe", "1");
    localStorage.removeItem("laterOnProbe");
    return true;
  } catch {
    return false;
  }
}

// 写诊断记录：失败了就算了，绝不影响界面。
function saveOpenDiag(record) {
  try { chrome.storage.local.set({ laterOnPanelDiag: record }); } catch {}
}

async function init() {
  // 计时起点：boot.js 在页面 <head> 里记的那一刻（比侧栏脚本更早），
  // 这样「页面加载」和「读数据」花的时间能分别算出来。
  const bootStart = window.LaterOnBoot?.t0 ?? nowMs();
  // 语言设置是独立的存储读取，不能阻塞首屏，也不能把它算进「准备页面」。
  // 先启动请求，下面继续读缓存 / 收藏；完成后再把静态文字切换到用户语言。
  const languagePromise = Promise.resolve(
    window.LaterOnI18n?.ready || window.LaterOnI18n?.getLanguage?.()
  ).catch(() => null);
  const scriptReady = nowMs();   // = 页面 + 脚本就绪时刻（差值 = 浏览器准备页面用了多久）
  // 每一段都单独计时：之前只记了「读数据」，结果总耗时比各段加起来大好几秒，
  // 那几秒花在哪完全看不出来。现在一段都不放过。
  const seg = { page: Math.round(scriptReady - bootStart), cache: 0, paint: 0, data: 0, migrate: 0 };

  // 语言读取完成后再应用翻译；此时如果首屏已经画出来，只重画一次文字和当前列表。
  // 不等待它，避免一次冷 storage 读取把侧栏首屏拖到几秒之后。
  languagePromise.then(() => {
    window.LaterOnI18n?.applyStatic();
    if (currentItem) syncSaveButtonState(!!currentItemId);
    if (sidePanelReady || cacheHit) {
      render();
      renderProjectFilters();
    }
  });

  // ① 先把「读存储」发出去，但**不等它**。存储冷的时候这一次读取要好几秒，
  //    早点发出去，它就能和后面的「读本地缓存」「画第一屏」同时跑；
  //    排成一队的话，谁慢整条链就卡在谁后面（这正是之前白等十几秒的原因）。
  const storageStart = nowMs();
  // 封面（COVERS_KEY）故意不在这批里：它可能比整个列表还大，
  // 排在首屏之后单独读，列表才能最快出来。
  const storedPromise = chrome.storage.local
    .get([STORAGE_KEY, PROJECTS_KEY, ACTIVE_PROJECT_KEY, CURRENT_ITEM_KEY, SETTINGS_KEY, FILTER_KEY, FILTER_CHOSEN_KEY, ORDER_KEY])
    .catch((error) => ({ __laterOnLoadError: String(error?.message || error || "读取失败") }));

  // ② 读「秒开缓存」并立刻画第一屏：上一回的列表快照就在本页 localStorage 里，
  //    同步读、立刻画，不用等 chrome.storage 返回。
  let cacheHit = false;
  const cacheStart = nowMs();
  const cached = readSlimCache();
  seg.cache = Math.round(nowMs() - cacheStart);
  if (cached?.length) {
    cacheHit = true;
    items = normalizeItems(cached);
    const paintStart = nowMs();
    render();
    renderProjectFilters();
    seg.paint = Math.round(nowMs() - paintStart);
  }
  if (typeof window.LaterOnBoot?.stage === "function") window.LaterOnBoot.stage(tr("readingSaves"));

  // ③ 现在才等存储结果（它从 ① 就开始跑了）。
  const stored = await storedPromise;
  seg.data = Math.round(nowMs() - storageStart);
  // 读取失败和“存储里确实没有收藏”不是一回事。以前两者都落成 {}，随后会把
  // 秒开缓存覆盖成空数组；一次偶发 I/O 错误就可能让下一次也失去可见内容。
  if (stored.__laterOnLoadError) {
    seg.error = stored.__laterOnLoadError;
    if (!cacheHit) {
      render();
      renderProjectFilters();
    }
    reportOpenSpeed(seg, bootStart, cacheHit);
    sidePanelReady = true;
    // loadCurrentPage() 会同步重置顶部状态，因此先启动它，再放回这条更重要的读取提示。
    loadCurrentPage();
    status.textContent = cacheHit
      ? tr("noRefreshShowingCache")
      : tr("loadFailedRetry");
    return;
  }
  const migrateStart = nowMs();
  const migrated = await migrateLegacyCovers(stored[STORAGE_KEY]);
  seg.migrate = Math.round(nowMs() - migrateStart);
  // 读回来的这批数据有多大？体积是「读数据慢」最常见的解释——
  // 早期版本把封面 base64 直接塞在条目里，能塞到好几兆，读完必然慢。
  try { seg.bytes = JSON.stringify(stored[STORAGE_KEY] || []).length; } catch { /* 量不出来就不量 */ }
  items = normalizeItems(migrated || stored[STORAGE_KEY]);
  projects = stored[PROJECTS_KEY] || [];
  activeProject = normalizeProject(stored[ACTIVE_PROJECT_KEY]);
  currentItemId = stored[CURRENT_ITEM_KEY] || null;
  autoMarkRead = (stored[SETTINGS_KEY] || {}).autoMarkRead !== false;
  sortMode = (stored[SETTINGS_KEY] || {}).defaultSort || "newest";
  orders = stored[ORDER_KEY] || {};
  // 全屏那边可能已经切过筛选了，打开侧栏时接着用同一档。
  filter = stored[FILTER_CHOSEN_KEY] ? normalizeFilter(stored[FILTER_KEY]) : DEFAULT_FILTER;
  syncFilterButtons();
  const paintStart2 = nowMs();
  render();
  renderProjectFilters();
  // 没用上缓存时，这一次才是「第一屏」，它才是用户真正等的那一刻。
  if (!cacheHit) seg.paint = Math.round(nowMs() - paintStart2);
  // 把这次打开的分段耗时记下来并（慢的时候）直接显示在界面上。
  // 异步写存储，绝不等它返回。
  reportOpenSpeed(seg, bootStart, cacheHit);
  // 封面留到最后单独读：它大，但缺了它也只是晚几毫秒显示缩略图，不影响列表先出来。
  loadCovers();
  sidePanelReady = true;
  // 如果这次打开是因为在别处点开了一篇，直接把那篇滚到可视区域里。
  applyCurrentAndLocate();
  // 顶部「当前网页」那一栏不再拖住打开流程：它要唤醒后台抓页面信息，
  // 冷启动可能几秒，让它在后台自己补，列表早就画完了。
  loadCurrentPage();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    items = normalizeItems(changes[STORAGE_KEY].newValue || []);
    render();
    renderProjectFilters();
    if (currentItem?.url) syncCurrentTabItem(currentItem.url);
  }
  if (area === "local" && changes[COVERS_KEY]) {
    covers = changes[COVERS_KEY].newValue || {};
    render();
  }
  if (area === "local" && changes[PROJECTS_KEY]) {
    projects = changes[PROJECTS_KEY].newValue || [];
    if (activeProject !== "unfiled" && !projects.some((project) => project.id === activeProject)) activeProject = "unfiled";
    render();
    renderProjectFilters();
  }
  if (area === "local" && changes[ACTIVE_PROJECT_KEY]) {
    activeProject = normalizeProject(changes[ACTIVE_PROJECT_KEY].newValue);
    renderProjectFilters();
    render();
  }
  if (area === "local" && changes[SETTINGS_KEY]) {
    const s = changes[SETTINGS_KEY].newValue || {};
    if (typeof s.autoMarkRead === "boolean") autoMarkRead = s.autoMarkRead;
    const nextSort = s.defaultSort || "newest";
    if (nextSort !== sortMode) { sortMode = nextSort; render(); }
  }
  if (area === "local" && changes[ORDER_KEY]) {
    orders = changes[ORDER_KEY].newValue || {};
    render();
  }
  if (area === "local" && changes[CURRENT_ITEM_KEY]) {
    currentItemId = changes[CURRENT_ITEM_KEY].newValue || null;
    applyCurrentAndLocate();
  }
  if (area === "local" && changes[FILTER_KEY]) {
    // 全屏那边切了筛选 → 这边跟着切（反过来同理）。自己写的值不会变，被这个判断挡掉。
    const next = normalizeFilter(changes[FILTER_KEY].newValue);
    if (next !== filter) { filter = next; syncFilterButtons(); render(); }
  }
});

// 封面本体（用户上传的图，可能几百 KB）单独读，读完补画图。
async function loadCovers() {
  try {
    const stored = await chrome.storage.local.get(COVERS_KEY);
    covers = stored[COVERS_KEY] || {};
    render();
  } catch { /* 封面读不到就先不显示图 */ }
}

// 当前网页这一栏也分两段：先用标签页自带的信息（浏览器本地就有）立刻显示、
// 收藏按钮立刻能点；封面 / 摘要交给后台慢慢补。
// 后台（service worker）空闲时会被 Chrome 回收，唤醒一次可能好几秒，
// 不能让它把整个侧栏拖住——所以这里加了超时，超时就维持基础信息。
const CURRENT_PAGE_TIMEOUT_MS = 4000;

// 编辑弹窗不是首屏能力：侧栏打开时不加载 27KB 的 dialog.js 和对应 CSS，
// 用户第一次点击编辑时再按需加载，避免冷启动把非必要资源也排进就绪链路。
let dialogLoadPromise = null;
function ensureDialogLoaded() {
  if (window.LaterOnDialog) return Promise.resolve(window.LaterOnDialog);
  if (dialogLoadPromise) return dialogLoadPromise;
  dialogLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-lateron-dialog-style]')) {
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = "dialog.css";
      style.dataset.lateronDialogStyle = "";
      document.head.append(style);
    }
    const script = document.createElement("script");
    script.src = "dialog.js";
    script.onload = () => window.LaterOnDialog ? resolve(window.LaterOnDialog) : reject(new Error("弹窗脚本未就绪"));
    script.onerror = () => reject(new Error("弹窗脚本加载失败"));
    document.head.append(script);
  });
  return dialogLoadPromise;
}

// 给 Promise 加超时：到点就返回兜底值，绝不让界面无限期等下去。
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    promise.then((value) => finish(value), () => finish(fallback));
  });
}

async function loadCurrentPage() {
  const generation = ++loadGeneration;
  resetCurrentPage();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error(tr("noCurrentPage"));
    if (!/^https?:/i.test(tab.url || "")) {
      const scheme = String(tab.url || "").split(":", 1)[0].toLowerCase();
      throw new Error(scheme === "file"
        ? tr("localFileUnsupported")
        : tr("browserPageUnsupported"));
    }
    const fallback = fallbackMetadata(tab);
    // 第一段：立刻显示，按钮放开，不等后台。
    applyCurrentPage({ ...fallback, url: tab.url }, generation);
    // 第二段：抓取交给后台，和「一键收藏」「弹窗」共用同一份逻辑。
    const response = await withTimeout(
      chrome.runtime.sendMessage({ type: "EXTRACT_METADATA", tabId: tab.id }).catch(() => null),
      CURRENT_PAGE_TIMEOUT_MS,
      null
    );
    if (generation !== loadGeneration) return;
    if (response?.ok && response.metadata) {
      applyCurrentPage({ ...fallback, ...response.metadata, url: tab.url }, generation);
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    document.querySelector("#currentSource").textContent = error.message;
  }
}

function applyCurrentPage(result, generation) {
  if (generation !== loadGeneration) return;
  currentItem = { ...result, title: result.title || result.url };
  syncCurrentTabItem(currentItem.url);
  document.querySelector("#currentTitle").textContent = currentItem.title;
  document.querySelector("#currentSource").textContent = currentItem.source;
  if (currentItem.image) setCurrentThumb(currentItem.image);
}

chrome.tabs.onActivated.addListener(() => loadCurrentPage());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.status === "complete" || changeInfo.url)) loadCurrentPage();
});

function resetCurrentPage() {
  currentItem = null;
  saveButton.disabled = true;
  saveButton.classList.remove("done", "saved");
  saveButton.querySelector("span").textContent = "＋";
  saveButton.querySelector(".save-label").textContent = tr("saveCurrent");
  document.querySelector("#currentTitle").textContent = tr("currentPage");
  document.querySelector("#currentSource").textContent = tr("currentLoading");
  resetCurrentThumb();
  status.textContent = "";
}

function syncSaveButtonState(isSaved) {
  saveButton.classList.remove("done");
  saveButton.classList.toggle("saved", isSaved);
  saveButton.disabled = isSaved || !currentItem;
  saveButton.querySelector("span").textContent = isSaved ? "✓" : "＋";
  saveButton.querySelector(".save-label").textContent = tr(isSaved ? "saved" : "saveCurrent");
  saveButton.title = tr(isSaved ? "saved" : "saveCurrent");
  saveButton.setAttribute("aria-label", tr(isSaved ? "saved" : "saveCurrent"));
}

function fallbackMetadata(tab) {
  let source = tr("webPage");
  try { source = new URL(tab.url).hostname.replace(/^www\./, ""); } catch {}
  return {
    title: tab.title || tab.url,
    description: tr("noDescription"),
    image: "",
    favicon: tab.favIconUrl || "",
    source
  };
}

// 当前标签页和收藏条目用同一套网址归一化规则比较：忽略 www、末尾斜杠、追踪参数和 hash，
// 避免同一篇文章因为分享链接参数不同而匹配不上。
function syncCurrentTabItem(url) {
  const normalize = globalThis.LaterOnUrl?.normalize || ((value) => String(value || "").trim().toLowerCase());
  const normalized = normalize(url);
  const matched = normalized
    ? items.find((item) => normalize(item.url) === normalized)
    : null;
  const nextId = matched?.id || null;
  const previousId = currentItemId;
  currentItemId = nextId;
  syncSaveButtonState(!!matched);

  if (matched) {
    if (previousId !== nextId) chrome.storage.local.set({ [CURRENT_ITEM_KEY]: nextId }).catch(() => {});
    // 切换到另一个已收藏标签页时，目标文章可能属于另一个项目。
    // 必须先切换项目再定位，否则它会被旧项目的筛选挡住，卡片根本不在 DOM 里。
    const targetProject = normalizeProject(matched.projectId || "unfiled");
    if (targetProject !== activeProject) {
      activeProject = targetProject;
      renderProjectFilters();
      render();
      // 与全屏界面共享当前项目；侧栏跟随标签页后，下次打开也继续停在这里。
      chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: activeProject }).catch(() => {});
    }
    // render() 之后由 applyCurrentAndLocate 负责高亮与定位；
    // 项目没变时则直接复用已经画好的卡片。
    applyCurrentAndLocate();
    return;
  }

  // 当前页面从未收藏过：取消旧的“正在阅读”高亮并回到侧栏顶部，方便直接收藏。
  pendingLocate = false;
  clearTimeout(locateTimer);
  for (const article of itemMap.values()) article.classList.remove("is-current");
  window.scrollTo({ top: 0, behavior: "auto" });
}

saveButton.addEventListener("click", async () => {
  if (!currentItem || currentItemId) return;
  saveButton.disabled = true;
  // 统一交给后台处理（和快捷键、右键菜单同一条链路）：
  // 设置里打开「收藏单篇前先选项目」时，点这里同样会先在网页里弹出选项目浮层。
  const response = await chrome.runtime.sendMessage({ type: "QUICK_SAVE_TAB", source: "panel" }).catch(() => null);
  if (response?.ok && response.pending) {
    // 已经弹出浮层了，真正的收藏等用户在浮层里确认（结果会弹在网页上）。
    saveButton.disabled = false;
    status.textContent = tr("pickerOpened");
    return;
  }
  if (response?.ok) {
    syncSaveButtonState(true);
    status.textContent = "";
  } else {
    saveButton.disabled = false;
    status.textContent = response?.error || tr("saveFailed");
  }
});

document.querySelector("#openLibrary").addEventListener("click", async () => {
  let libraryOpened = false;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.runtime.sendMessage({ type: "OPEN_LIBRARY" });
    if (!response?.ok || !activeTab?.windowId) throw new Error("完整界面未能打开");
    libraryOpened = true;
    await chrome.sidePanel.close({ windowId: activeTab.windowId });
  } catch (error) {
    console.error("切换完整界面失败", error);
    if (libraryOpened) window.close();
    else status.textContent = tr("libraryOpenFailed");
  }
});
document.querySelector("#searchInput").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = event.target.value.trim().toLowerCase(); render(); }, 120);
});

// 事件委托：整页只挂一个监听器，避免给每张卡片单独绑监听。
list.addEventListener("click", (event) => {
  const article = event.target.closest(".item");
  if (!article) return;
  const item = items.find((entry) => entry.id === article.dataset.id);
  if (!item) return;
  if (event.target.closest(".delete")) deleteItem(item.id);
  else if (event.target.closest(".edit")) editItem(item);
  else if (event.target.closest(".read-toggle")) updateItem(item.id, { status: nextStatus(item.status) });
  else if (event.target.closest(".open-item")) {
    // 这是一个真实链接：⌘/Ctrl/Shift 点击交还给浏览器，保留标准的新标签页/新窗口行为。
    // 只有普通左键才接管，继续使用 LaterOn 的“复用已打开标签页”逻辑。
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openItem(item);
  }
});

list.addEventListener("contextmenu", (event) => {
  const link = event.target.closest(".open-item");
  const article = link?.closest(".item");
  if (!article) return;
  const item = items.find((entry) => entry.id === article.dataset.id);
  if (!item || !safeTarget(item.url)) return;
  // 侧栏卡片的封面和文字都属于同一个网页入口。用自己的菜单取代浏览器针对
  // “选中文字 / 单独图片”的菜单，避免出现复制图片、查询文字等无关动作。
  event.preventDefault();
  event.stopPropagation();
  showItemContextMenu(item, event.clientX, event.clientY);
});

function closeItemContextMenu() {
  itemContextMenu?.remove();
  itemContextMenu = null;
}

function showItemContextMenu(item, x, y) {
  closeItemContextMenu();
  const menu = document.createElement("div");
  menu.className = "folder-menu";
  menu.setAttribute("role", "menu");
  menu.append(
    sidepanelMenuItem(tr("openInNewTab"), "open", () => openItemInNewTab(item)),
    sidepanelMenuItem(tr("itemEdit"), "pencil", () => editItem(item)),
    sidepanelMenuItem(tr("delete"), "trash", () => deleteItem(item.id), true)
  );
  document.body.append(menu);
  itemContextMenu = menu;

  const margin = 8;
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 172;
  const height = rect.height || 120;
  menu.style.left = `${Math.min(Math.max(margin, x - width), Math.max(margin, window.innerWidth - width - margin))}px`;
  menu.style.top = `${Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin))}px`;
  requestAnimationFrame(() => menu.classList.add("is-open"));
  menu.querySelector("button")?.focus({ preventScroll: true });
}

function sidepanelMenuItem(label, icon, onPick, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `folder-menu-item${danger ? " danger" : ""}`;
  button.setAttribute("role", "menuitem");
  const paths = {
    open: "M14 5h5v5M19 5l-8 8M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5",
    pencil: "M4 20h4L20 8l-4-4L4 16zM14 6l4 4",
    trash: "M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m3 0-1 13H7L6 7"
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[icon] || paths.open);
  svg.append(path);
  const text = document.createElement("span");
  text.textContent = label;
  button.append(svg, text);
  button.addEventListener("click", () => {
    closeItemContextMenu();
    onPick();
  });
  return button;
}

async function openItemInNewTab(item) {
  const target = safeTarget(item.url);
  if (!target) { status.textContent = tr("invalidItemUrl"); return; }
  try {
    // 和浏览器原生 ⌘/Ctrl + 点击一致：在当前窗口后台新建标签，不打断侧栏里的浏览。
    await chrome.tabs.create({ url: target, active: false });
  } catch {
    status.textContent = tr("invalidItemUrl");
  }
}

document.addEventListener("pointerdown", (event) => {
  if (itemContextMenu && !itemContextMenu.contains(event.target)) closeItemContextMenu();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeItemContextMenu();
});
document.addEventListener("scroll", closeItemContextMenu, true);
window.addEventListener("blur", closeItemContextMenu);
window.addEventListener("resize", closeItemContextMenu);
document.querySelectorAll(".filters .filter").forEach((button) => button.addEventListener("click", () => {
  setFilter(button.dataset.filter);
}));

// 剩下的排在浏览器空闲时继续，鼠标点什么都不会被卡住。
function nextIdle(fn) {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 300 });
  else window.setTimeout(fn, 16);
}

// 骨架屏 / 「正在打开…」提示条：真内容一画出来就撤掉，让真界面露面。
// body 上的 .booting 一去掉，#appBody 就从「不占位」变回正常显示，两者不会同时出现。
function hideBootPlaceholder() {
  document.querySelector("#bootSkeleton")?.remove();
  document.querySelector("#bootTip")?.remove();
  document.body?.classList.remove("booting");
  if (typeof window.LaterOnBoot?.done === "function") window.LaterOnBoot.done();
}

function render() {
  // 只要画得出东西（秒开缓存也好、真数据也好），骨架屏就完成使命了。
  hideBootPlaceholder();
  const visible = items.filter((item) => {
    // 搜索是全局的（和全屏页同一个规矩）：搜索框里有字时一律在「全部收藏」里找，
    // 不受上面那排项目筛选影响——否则在某个项目里搜一个明明存在的标题会一无所获，
    // 还以为是收藏丢了。「未读 / 已读」那一档仍然生效，它是用户自己拨过去的开关。
    const matchesProject = !!query
      || activeProject === "all"
      || (activeProject === "unfiled" ? !item.projectId : item.projectId === activeProject);
    // 「未读」= 还没读完（未读 + 在读）；「已读」= 手动标完成的那批。
    const matchesFilter = filter === "all" || (filter === "done" ? item.status === "done" : item.status !== "done");
    const text = `${item.title} ${item.description} ${item.source}`.toLowerCase();
    return matchesProject && matchesFilter && (!query || text.includes(query));
  });
  // 全屏那边选了「自定义顺序」并拖过卡片 —— 侧栏用同一份顺序，两边看到的先后一致。
  if (sortMode === "custom") {
    const rank = new Map((orders[activeProject || "all"] || []).map((id, index) => [id, index]));
    visible.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (b.savedAt || 0) - (a.savedAt || 0);
    });
  }
  const token = ++renderToken;
  renderComplete = false;   // 这一轮还没画完，先别拿半张列表的坐标去做定位
  document.querySelector("#itemCount").textContent = tr("cardCount", { n: visible.length });

  // 已经不在列表里的卡片先撤掉（删掉的收藏要立刻从界面消失）。
  const visibleIds = new Set(visible.map((item) => item.id));
  for (const [id, article] of itemMap) {
    if (!visibleIds.has(id)) { article.remove(); itemMap.delete(id); }
  }
  empty.hidden = visible.length > 0;
  // 第一批同步画出来（保证「立刻有东西看」），其余交给空闲时段续画。
  renderSlice(visible, 0, token);
  // 每次画完存一份快照进 localStorage，下次打开侧栏先拿它秒开第一屏。
  saveSlimCache();
}

// 画 [start, start + FIRST_BATCH) 这段；没画完就约下一次空闲再继续。
// token 用来作废上一次没画完的重渲染，避免两次渲染交错。
function renderSlice(visible, start, token) {
  if (token !== renderToken) return;
  const end = Math.min(start + FIRST_BATCH, visible.length);
  for (let index = start; index < end; index += 1) {
    const item = visible[index];
    let article = itemMap.get(item.id);
    if (!article) { article = createItem(item); itemMap.set(item.id, article); }
    else updateItemCard(article, item);
    article.dataset.currentLabel = tr("currentReading");
    article.classList.toggle("is-current", item.id === currentItemId);
    if (list.children[index] !== article) list.insertBefore(article, list.children[index] || null);
  }
  if (end < visible.length) {
    const next = () => renderSlice(visible, end, token);
    // 有定位任务在等 → 不等空闲了，下一帧接着画，让列表尽快铺完（没铺完量不准位置）。
    if (pendingLocate) nextFrame(next);
    else nextIdle(next);
    return;
  }
  finishRender(token);
}

// 整张列表画完了：这时量出来的坐标才可信，可以去做「滚到正在读那篇」了。
function finishRender(token) {
  if (token !== renderToken) return;
  renderComplete = true;
  // 注意：这里必须包一层。直接写 nextFrame(locateCurrent) 会把 rAF 的时间戳
  // 当成「第几次尝试」传进去（几万毫秒），结果第一次就走成瞬间滚动、而且不再复查。
  if (pendingLocate) nextFrame(() => locateCurrent());
}

// 高亮「正在读」的那篇，并保证它落在可视区域里（只在该视图还活着时调用）。
// 分两步：卡片已经画出来就立刻定位（快路径）；还没画到 / 列表没铺完，
// 就挂一个定位任务，等整张列表画完（finishRender）再定位。
function applyCurrentAndLocate() {
  // 当前文章变了，上一篇的延迟复查也必须作废，否则会把新定位抢回去。
  clearTimeout(locateTimer);
  for (const [id, article] of itemMap) {
    article.dataset.currentLabel = tr("currentReading");
    article.classList.toggle("is-current", id === currentItemId);
  }
  pendingLocate = Boolean(currentItemId);
  if (!pendingLocate) return;
  locateCurrent();
}

function locateCurrent(attempt = 0) {
  if (!pendingLocate || !currentItemId) return;
  const article = itemMap.get(currentItemId);
  if (!article) {
    // 列表都画完了还没有它 → 被筛选条件挡在外面（比如筛「已读」但它还没读完），这次不定位。
    if (renderComplete) { pendingLocate = false; saveLocateDiag({ found: false, attempts: attempt }); }
    return;
  }
  // 已经在视野里先别乱跳，但不立刻宣布完成：侧栏刚展开、
  // 宽度媒体查询或封面完成布局时，卡片还可能被再挤到吸顶栏下面。
  // 延迟复查一次，如果位置变了就用瞬时滚动补正。
  if (isCardInView(article)) {
    if (attempt === 0) {
      locateTimer = setTimeout(() => {
        if (!pendingLocate) return;
        const target = itemMap.get(currentItemId);
        if (target && !isCardInView(target)) { locateCurrent(1); return; }
        pendingLocate = false;
        saveLocateDiag({ found: Boolean(target), inView: Boolean(target), scrolled: false, attempts: 0 });
      }, 320);
      return;
    }
    pendingLocate = false;
    saveLocateDiag({ found: true, inView: true, scrolled: attempt > 0, attempts: attempt });
    return;
  }
  // 第一次用平滑滚动（好看），补的几次用瞬间滚动（可靠）。
  scrollCardToCenter(article, attempt === 0);
  // 侧栏刚滑出来的那一瞬间页面可能还不可滚动，这次滚动会被浏览器直接丢掉 ——
  // 表现就是「明明定位了，那篇却不在视野里」。所以隔一会儿复查：没进视野就再滚一次，
  // 最多试 3 次。
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => {
    if (!pendingLocate) return;
    const target = itemMap.get(currentItemId) || article;
    if (!isCardInView(target) && attempt < 2) { locateCurrent(attempt + 1); return; }
    pendingLocate = false;
    saveLocateDiag({
      found: true,
      inView: isCardInView(target),
      scrolled: true,
      attempts: attempt + 1,
      scrollY: Math.round(window.scrollY || 0)
    });
  }, 420);
}

// 自己算位置、自己滚。不用 scrollIntoView：侧栏里它时有失灵（滚动被丢掉、或滚偏），
// 而 window.scrollTo 是我们能自己算、也能自己验证的。
function scrollCardToCenter(article, smooth) {
  const rect = article.getBoundingClientRect();
  const viewport = window.innerHeight || 0;
  if (!viewport || !rect.height) return;
  const current = window.scrollY || window.pageYOffset || 0;
  const visibleTop = visibleTopInset();
  const visibleHeight = Math.max(0, viewport - visibleTop);
  // 目标：把卡片放到「吸顶栏以下」那块真正可见区域的中间。
  let target = current + rect.top - visibleTop - (visibleHeight - rect.height) / 2;
  // 别滚出文档范围（滚到底就停在那儿）
  const docHeight = document.documentElement?.scrollHeight || document.body?.scrollHeight || 0;
  const max = docHeight - viewport;
  if (max > 0) target = Math.min(Math.max(0, target), max);
  else target = Math.max(0, target);
  if (Math.abs(target - current) < 2) return;   // 已经在那儿了，不用滚
  try {
    window.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
  } catch {
    window.scrollTo(0, target);   // 老式写法兜底
  }
}

// 实时量出顶部不可见区域，多留 10px 呼吸空间，避免高亮边框贴着栏底。
function visibleTopInset() {
  const headerRect = document.querySelector("header")?.getBoundingClientRect?.();
  const measured = Number(headerRect?.bottom);
  return (Number.isFinite(measured) && measured > 0 ? measured : TOPBAR_FALLBACK_H) + LOCATE_EDGE_GAP;
}

// 卡片是不是整个都落在真正可见区域里（被吸顶栏压住不算）。
function isCardInView(article) {
  const rect = article.getBoundingClientRect();
  const viewport = window.innerHeight || 0;
  // 量不出来（还没排版）就别乱动，等下一次机会。
  if (!viewport || !rect.height) return true;
  return rect.top >= visibleTopInset() - 1 && rect.bottom <= viewport + 1;
}

// 定位到底成没成，记一笔：设置页「自检信息 → 侧栏『滚到正在读』」能看到，不用猜。
function saveLocateDiag(record) {
  try {
    chrome.storage.local.set({
      laterOnLocateDiag: { at: Date.now(), itemId: currentItemId, viewport: window.innerHeight || 0, ...record }
    });
  } catch {}
}

function renderProjectFilters() {
  const counts = new Map();
  let unfiled = 0;
  for (const item of items) {
    if (item.projectId) counts.set(item.projectId, (counts.get(item.projectId) || 0) + 1);
    else unfiled += 1;
  }
  const container = document.querySelector("#projectFilters");
  container.replaceChildren();
  // 侧栏只保留「等待整理 + 具体项目」：它陪伴当前阅读范围，不承担全库总览。
  // 「等待整理」和普通项目走完全相同的点击、存储与跨视图同步逻辑。
  const choices = [
    { id: "unfiled", name: tr("inbox"), count: unfiled },
    ...projects.map((project) => ({ ...project, count: counts.get(project.id) || 0 }))
  ];
  choices.forEach((choice) => {
    const button = document.createElement("button");
    button.className = `project-filter${activeProject === choice.id ? " active" : ""}`;
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = choice.name;
    const count = document.createElement("strong");
    count.textContent = choice.count;
    button.append(name, count);
    button.addEventListener("click", () => {
      activeProject = normalizeProject(choice.id);
      renderProjectFilters();
      render();
      chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: activeProject });
    });
    container.append(button);
  });

}

function normalizeProject(projectId) {
  if (projectId === "unfiled") return "unfiled";
  // 「全部项目」只属于全屏图板总览；侧栏没有这个范围，收到 all 或失效项目时
  // 回到「等待整理」，保证始终有一个真实可见的目录处于选中状态。
  return projects.some((project) => project.id === projectId) ? projectId : "unfiled";
}

// 旧收藏只有 read 布尔、没有 status：按 read 推导成三档之一，兼容已有数据。
// doneAt（标为已读的时刻）由全屏界面负责补写并落盘，这里只保证内存里读得到，不重复写存储。
function normalizeItems(list) {
  return (list || []).map((it) => {
    if (!it) return it;
    const status = it.status || (it.read ? "done" : "unread");
    return { ...it, status, doneAt: status === "done" ? Number(it.doneAt) || null : null };
  });
}

// ── 封面取值 ────────────────────────────────────────────────
// item.image 里存的可能是三种东西：
//   ① 远程图片网址（自动抓取的）——直接用
//   ② local://<收藏id> —— 用户上传的封面，本体在 COVERS_KEY 那个键里，按 id 取
//   ③ data: 开头的老数据（封面搬家功能上线前存的）——兼容直接用
function resolveImage(item) {
  const image = item?.image;
  if (typeof image !== "string" || !image) return "";
  if (image.startsWith("local://")) return covers[image.slice(8)] || "";
  return image;
}

// 一次性搬家：把还躺在收藏列表里的 base64 封面挪到单独的键里。
// 搬完列表数据回归「纯文字」，读写都快。已搬过（没有 data: 封面）就什么都不做。
async function migrateLegacyCovers(rawItems) {
  if (!Array.isArray(rawItems)) return null;
  const moved = {};
  let changed = false;
  const next = rawItems.map((it) => {
    if (it && it.id && typeof it.image === "string" && it.image.startsWith("data:")) {
      moved[it.id] = it.image;
      changed = true;
      return { ...it, image: `local://${it.id}` };
    }
    return it;
  });
  if (!changed) return null;
  try {
    const stored = await chrome.storage.local.get(COVERS_KEY);
    const merged = { ...(stored[COVERS_KEY] || {}), ...moved };
    covers = merged;
    await chrome.storage.local.set({ [STORAGE_KEY]: next, [COVERS_KEY]: merged });
  } catch { /* 搬不动就先用老数据，不影响显示 */ }
  return next;
}

// ── 秒开缓存 ────────────────────────────────────────────────
// 收藏列表（不含封面本体，那在 COVERS_KEY 里）的快照存本页 localStorage。
// 侧栏每次重新画完都存一份，下次打开先拿它画第一屏。
// 写快照是给「下一次打开」用的，不急——推迟到下一轮事件循环再写，
// 这样它永远不会挡住眼前的这一次绘制。
function saveSlimCache() {
  if (localStorageSlow) return;
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      const json = JSON.stringify(items.slice(0, CACHE_PREVIEW_LIMIT));
      if (json.length < 2000000) localStorage.setItem(CACHE_KEY, json);
      else localStorage.removeItem(CACHE_KEY);
    } catch { /* localStorage 用不了就算了，不影响正常功能 */ }
  }, 300);
}
function readSlimCache() {
  if (localStorageSlow) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 用户上传的封面增删后，把 COVERS_KEY 整体写回存储。
async function saveCovers(next) {
  covers = next;
  try { await chrome.storage.local.set({ [COVERS_KEY]: covers }); } catch { /* 写不进去时本地照样显示 */ }
}

// 缩略图：卡片 DOM 是复用的，用户自己换/移除封面后要能同步刷新。
function applyThumb(article, item) {
  const thumb = article.querySelector(".thumb");
  if (!thumb) return;
  // 占位（LaterOn Logo）是模板自带的，封面图插在它上面盖住；没有封面就只留占位。
  const current = thumb.querySelector("img.thumb-img");
  const src = resolveImage(item);
  if (src) {
    if (current && current.getAttribute("src") === src) return;
    const image = document.createElement("img");
    image.className = "thumb-img";
    // 小红书等站点的图片 CDN 会拒绝带 chrome-extension:// Referer 的请求（403），
    // 明确声明「不发 Referer」它们才会正常返回图片。
    image.referrerPolicy = "no-referrer";
    image.src = src;
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      const fallback = nextCoverFallback(image.src);
      if (fallback) image.src = fallback;
      // 降级链走完仍拿不到图：移掉坏图，露出底下的 Logo 占位。
      else image.remove();
    });
    if (current) current.replaceWith(image);
    else thumb.prepend(image);
  } else if (current) {
    current.remove();
  }
}

function createItem(item) {
  const fragment = template.content.cloneNode(true);
  const article = fragment.querySelector(".item");
  article.dataset.id = item.id;
  const openLink = fragment.querySelector(".open-item");
  openLink.href = safeTarget(item.url) || "#";
  fragment.querySelector("h2").textContent = item.title;
  setText(fragment.querySelector(".description"), item.description);
  fragment.querySelector(".source").textContent = item.source;
  fragment.querySelector("time").textContent = formatTime(item.savedAt);
  const favicon = fragment.querySelector(".meta img");
  favicon.src = item.favicon;
  favicon.addEventListener("error", () => { favicon.style.visibility = "hidden"; });
  applyThumb(article, item);
  article.classList.toggle("is-read", item.status === "done");
  article.classList.toggle("is-reading", item.status === "reading");
  const readToggle = article.querySelector(".read-toggle");
  if (readToggle) {
    readToggle.classList.toggle("is-on", item.status === "done");
    setText(readToggle, readToggleLabel(item.status));
    readToggle.setAttribute("aria-label", readToggleLabel(item.status));
    readToggle.title = readToggleLabel(item.status);
  }
  return article;
}

function updateItemCard(article, item) {
  article.classList.toggle("is-read", item.status === "done");
  article.classList.toggle("is-reading", item.status === "reading");
  const readToggle = article.querySelector(".read-toggle");
  if (readToggle) {
    readToggle.classList.toggle("is-on", item.status === "done");
    setText(readToggle, readToggleLabel(item.status));
    readToggle.setAttribute("aria-label", readToggleLabel(item.status));
    readToggle.title = readToggleLabel(item.status);
  }
  // 卡片 DOM 是复用的，不同步的话改完标题/摘要会一直显示旧文字。
  setText(article.querySelector("h2"), item.title);
  setText(article.querySelector(".description"), item.description);
  article.querySelector(".open-item").href = safeTarget(item.url) || "#";
  applyThumb(article, item);
}

// 只在文字真的变了时才写 DOM —— 避免每次重渲染都惊动浏览器重新排版。
function setText(element, value) {
  if (!element) return;
  const next = value == null ? "" : String(value);
  if (element.textContent !== next) element.textContent = next;
}

// ── 编辑收藏的标题 / 摘要 ──────────────────────────────────
// 自动抓取难免有偏差（标题带站名、摘要抓成导航文字），所以允许用户自己改。
// 改过的会被标记为 titleEdited / descriptionEdited，
// 之后再次收藏同一网址时，后台不会再拿自动抓取的结果覆盖掉用户手写的版本。
const NO_SUMMARY = "暂无摘要";
const IS_EMPTY_SUMMARY = /^\s*(暂无摘要|No summary)?\s*$/i;

async function editItem(item) {
  try {
    await ensureDialogLoaded();
  } catch {
    status.textContent = tr("dialogLoadFailed");
    return;
  }
  const result = await LaterOnDialog.prompt({
    title: tr("editItem"),
    message: IS_EMPTY_SUMMARY.test(item.description) ? tr("missingSummaryHint") : "",
    // 封面：可以自己上传一张本地图片（自动压缩后保存），也可以移除。
    cover: { name: "cover", label: tr("cover"), value: resolveImage(item) },
    fields: [
      { name: "title", label: tr("title"), value: item.title, maxLength: 200 },
      {
        name: "description",
        label: tr("summary"),
        value: IS_EMPTY_SUMMARY.test(item.description) ? "" : item.description,
        placeholder: tr("summaryPlaceholder"),
        multiline: true,
        maxLength: 500
      }
    ],
    confirmText: tr("save")
  });
  if (!result?.ok) return;

  const values = result.values || {};
  const patch = {};
  const nextTitle = (values.title ?? item.title).trim();
  const nextDescription = (values.description ?? item.description).trim();
  if (nextTitle && nextTitle !== item.title) {
    patch.title = nextTitle;
    patch.titleEdited = true;
  }
  const finalDescription = nextDescription || NO_SUMMARY;
  if (finalDescription !== item.description) {
    patch.description = finalDescription;
    patch.descriptionEdited = true;
  }
  // 封面：data URL（用户上传）或 ""（移除）。没动过时等于旧值，不会写。
  // 本体（base64 大图）放进单独的 COVERS_KEY，收藏条目里只记一个 local://<id> 的指针，
  // 这样收藏列表始终是纯文字小数据，侧栏打开才不会被拖慢。
  const originalCover = resolveImage(item);
  if (typeof values.cover === "string" && values.cover !== originalCover) {
    if (values.cover) {
      await saveCovers({ ...covers, [item.id]: values.cover });
      patch.image = `local://${item.id}`;
    } else {
      const nextCovers = { ...covers };
      delete nextCovers[item.id];
      await saveCovers(nextCovers);
      patch.image = "";
    }
    // 记一笔：这是用户自己定的封面，之后再收藏同一网址时别用自动抓取的把它盖掉。
    patch.imageEdited = true;
  }
  if (!Object.keys(patch).length) return;
  await updateItem(item.id, patch);
  // 立刻重画一次：存储的变更广播不一定会回到自己这个页面，靠它会显得「改了没反应」。
  render();
}

async function openItem(item) {
  const target = safeTarget(item.url);
  if (!target) {
    status.textContent = tr("invalidItemUrl");
    return;
  }
  // 记下「正在读这篇」——全屏界面据此高亮并滚动定位，两个视图保持一致。
  chrome.storage.local.set({ [CURRENT_ITEM_KEY]: item.id });
  const openTab = await globalThis.LaterOnTabs.findOpen(target);
  if (openTab) {
    if (autoMarkRead && item.status === "unread") await updateItem(item.id, { status: "reading" });
    await globalThis.LaterOnTabs.activate(openTab);
    // 如果命中的页面在另一个窗口，也让 LaterOn 侧栏跟到那个窗口。
    if (openTab.windowId != null && typeof chrome.sidePanel?.open === "function") {
      await chrome.sidePanel.open({ windowId: openTab.windowId }).catch(() => null);
    }
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await chrome.tabs.update(tab.id, { url: target });
  // 打开未读的那篇会自动标记为「在读」（读完再由用户手动点按钮标成已完成）。
  if (autoMarkRead && item.status === "unread") await updateItem(item.id, { status: "reading" });
}

function safeTarget(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? String(url).trim() : "";
  } catch {
    return "";
  }
}

async function updateItem(id, patch) {
  const next = { ...patch };
  if (patch.status) {
    next.read = patch.status === "done";  // 同步 read，兼容旧字段
    // 记下「什么时候标成已读的」——自动清除从这个时刻起算（和全屏界面同一套规则）。
    const current = items.find((item) => item.id === id);
    next.doneAt = patch.status === "done"
      ? (current?.status === "done" && Number(current.doneAt) ? current.doneAt : Date.now())
      : null;
  }
  items = items.map((item) => item.id === id ? { ...item, ...next } : item);
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

async function deleteItem(id) {
  const target = items.find((entry) => entry.id === id);
  if (!target) return;
  // 删除是没法撤销的，删之前一定问一句（弹窗组件是 defer 加载的，
  // 万一还没就绪就直接删，别把删除卡死）。
  const raw = (target.title || "").trim() || tr("itemFallback");
  const title = raw.length > 26 ? `${raw.slice(0, 26)}…` : raw;
  if (window.LaterOnDialog) {
    const confirmed = await window.LaterOnDialog.confirm({
      tone: "danger",
      title: tr("deleteItemTitle", { title }),
      message: tr("deleteCannotUndo"),
      confirmText: tr("delete")
    });
    if (!confirmed) return;
  }
  items = items.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
  // 删了收藏，它自己上传的封面也要跟着删，别留在存储里占地方。
  if (covers[id]) {
    const nextCovers = { ...covers };
    delete nextCovers[id];
    await saveCovers(nextCovers);
  }
}

function formatTime(timestamp) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days < 1) return tr("today");
  if (days < 30) return tr("daysAgo", { n: days });
  return new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en" : "zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

// YouTube 的最大分辨率封面（maxresdefault）对部分视频并不存在，
// 加载失败时逐级降级，而不是让卡片/预览留下空白。
const COVER_CHAIN = ["maxresdefault.jpg", "hq720.jpg", "hqdefault.jpg", "mqdefault.jpg"];
function nextCoverFallback(currentSrc) {
  let url;
  try {
    url = new URL(currentSrc);
  } catch {
    return "";
  }
  const matched = /^\/vi\/([^/]+)\/([^/]+\.jpg)$/.exec(url.pathname);
  if (!matched || url.hostname !== "i.ytimg.com") return "";
  const index = COVER_CHAIN.indexOf(matched[2]);
  if (index === -1) return "";
  const next = COVER_CHAIN[index + 1];
  if (!next) return "";
  url.pathname = `/vi/${matched[1]}/${next}`;
  url.search = "";
  return url.href;
}

// 没抓到封面（或封面加载不出来）时，缩略图区域继续显示 LaterOn 的 Logo。
function resetCurrentThumb() {
  const thumb = document.querySelector("#currentThumb");
  thumb.style.backgroundImage = "";
  thumb.classList.remove("has-cover");
}

function setCurrentThumb(src) {
  const thumb = document.querySelector("#currentThumb");
  const probe = new Image();
  // 先悄悄试加载：确认拿得到图才盖到缩略图上，拿不到就让 Logo 继续兜底。
  probe.addEventListener("load", () => {
    thumb.style.backgroundImage = `url("${src.replace(/"/g, "%22")}")`;
    thumb.classList.add("has-cover");
  });
  probe.addEventListener("error", () => {
    const fallback = nextCoverFallback(src);
    if (fallback) setCurrentThumb(fallback);
    else resetCurrentThumb();
  });
  probe.src = src;
}
