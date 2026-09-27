const STORAGE_KEY = "laterOnItems";
const PROJECTS_KEY = "laterOnProjects";
const ACTIVE_PROJECT_KEY = "laterOnActiveProject";
const SETTINGS_KEY = "laterOnSettings";
// 全屏与侧栏共享的「当前正在读哪篇」标记：任意一方点开文章都写它，
// 另一方据此高亮 + 滚动定位，保证两个视图的阅读位置一致。
const CURRENT_ITEM_KEY = "laterOnCurrentItem";
// 全屏与侧栏共享的「当前筛到哪一档」（全部 / 未读 / 已读）：
// 一边切换筛选，另一边跟着切——不用两边各点一次。
const FILTER_KEY = "laterOnFilter";
const FILTER_CHOSEN_KEY = "laterOnFilterChosen";
const DEFAULT_FILTER = "unread";
// 「自定义顺序」：用户在一个项目里拖出来的阅读顺序。
// 结构是 { 范围: [收藏 id, ...] }，范围是 "all" / "unfiled" / 某个项目 id——
// 每个项目各自记一份，互不干扰。
const ORDER_KEY = "laterOnOrder";
// 用户自己上传的封面（体积大）：单独放一个键，不和收藏列表混在一个数组里。
// 否则每次读写列表都要「连图一起搬」，数据攒多了哪个页面打开都会卡很久。
const COVERS_KEY = "laterOnCovers";
// 图钉图标：菜单里的「置顶 / 取消置顶」和列表上的置顶角标共用这一个形状。
// 路径是「实心」画法（Material 的 push_pin），因为角标只有十几像素——
// 描边款在这个尺寸下会糊成一团黑，根本看不出是图钉。用实心 + currentColor 填充，
// 小到 11px 也还认得出「钉子 + 针」的轮廓。
// ⚠️ 放在文件最上面的常量区：renderProjects() 在页面初始化时就会用到它，
// 声明在下面会踩到 const 的暂时性死区，整个页面直接白屏。
const PIN_FILL_PATH = "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z";
let items = [];
let projects = [];
let filter = DEFAULT_FILTER;
let query = "";
let sort = "newest";
let orders = {};
let activeProject = "all";
let autoMarkRead = true;
// 视图：全部项目 = 图板（一个类目一张），待整理 / 某个项目 = 卡片列表。
// 不再提供手动切换——图板只在「全部项目」总览下有意义，钻进某个项目就是卡片。
let settings = {};          // 当前设置（主题等）：卡片上弹浮层时要跟它对齐配色
let libraryTabId = null;
let libraryWindowId = null;
const cardMap = new Map();
// 完整收藏库也可能累积到上千条。第一屏同步画 48 张（桌面宽屏也足够覆盖数屏），
// 其余分批排进空闲时间，避免一次 render() 长时间占住主线程。
const LIBRARY_RENDER_BATCH = 48;
let libraryRenderToken = 0;
let dragPreview = null;
// 当前这次拖拽的全部状态（null = 现在没在拖）。卡片视图和图板视图共用同一套逻辑，
// 区别只有「拖的是什么、松手后写到哪儿」，都记在这个对象里：
//   container / selector / idAttr —— 在哪个容器里拖哪些元素、元素的 id 记在哪个 data 属性上
//   id —— 正在拖的这个的 id
//   layout —— 拖动开始那一刻拍的布局快照（整段拖动都用它，绝不重新读真实位置）
//   slot —— 当前算出的插入位置（用来判断要不要重排，避免抖动）
let drag = null;
let dragHomeFrame = null;   // 原位置留下的那个空虚线框（绝对定位浮层，不占格子）
let selectMode = false;
const selectedIds = new Set();
let renamingId = null;        // 正在改名的项目 id（null = 当前没有在改名）
let renameDraft = "";         // 改名输入框里的内容，重渲染时不会丢
let renameFocusPending = false;
let folderMenu = null;        // 项目的「更多 / 右键」菜单
let folderDragId = null;      // 正在拖拽排序的项目 id（null = 当前没在拖）
let currentItemId = null;     // 当前正在读的文章 id（来自 CURRENT_ITEM_KEY，两个视图共享）
let covers = {};              // 用户上传的封面：{ 收藏 id: dataURL }（与 COVERS_KEY 对应）
let folderDragPreview = null; // 跟着光标走的拖拽影像（行本身是透明的，要做一份实体化的）
let folderDropLine = null;    // 列表里那条「会插到这里」的指示线
let folderDragBlocked = false; // 这次按下是从「改名输入框 / ⋯ 按钮」上开始的，不能当拖拽

const grid = document.querySelector("#cardGrid");
const boardGrid = document.querySelector("#boardGrid");
const empty = document.querySelector("#emptyState");
const countText = document.querySelector("#countText");
const template = document.querySelector("#cardTemplate");
const boardTemplate = document.querySelector("#boardTemplate");
const searchInput = document.querySelector("#searchInput");
const sortSelect = document.querySelector("#sortSelect");
const toast = document.querySelector("#toast");
const tr = (key, vars) => {
  if (window.LaterOnI18n?.t) return window.LaterOnI18n.t(key, vars);
  const fallback = {
    noInbox: "还没有要整理的", searchCount: "在全部收藏里找到 {count} 篇 · {unfinished} 篇没看完",
    scopedCount: "{count} 篇收藏 · {unfinished} 篇没看完", noMatches: "没有找到匹配的收藏",
    noMatchesHint: "换个关键词，或切换顶部的阅读状态筛选。", quiet: "这里还很安静",
    quietHint: "打开一个想稍后阅读的网页，点击浏览器工具栏中的 LaterOn 图标即可收藏。",
    noBoard: "没有匹配的类目", noBoardHint: "换个关键词，或切换顶部的阅读状态筛选。",
    boardCount: "{groups} 个类目 · 共 {total} 篇收藏 · {unfinished} 篇没看完", notFinished: "没看完"
  };
  return String(fallback[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? `{${k}}`);
};

// 在全屏收藏库里按 Alt+1 / Alt+2 时，后台不能对这个扩展页面执行网页收藏或翻译。
// 直接复用本页 toast 解释原因，避免用户只看到工具栏图标上的「!」却不知道发生了什么。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SHOW_LIBRARY_NOTICE") return;
  if (message.tabId != null && libraryTabId != null && message.tabId !== libraryTabId) return;
  showToast(message.message || tr("openRegularPage"), 3200, "pill");
  sendResponse({ shown: true });
});

init();

function normalizeItems(list) {
  // 旧收藏只有 read 布尔、没有 status：按 read 推导成三档之一，兼容已有数据。
  // 顺带补 doneAt（标为已读的时刻，自动清除按它起算）：本版本之前就标好的老收藏
  // 没有这个时间，这里补成「现在」，从今天开始计 30 天，不会一升级就全被清掉。
  return (list || []).map((it) => {
    if (!it) return it;
    const status = it.status || (it.read ? "done" : "unread");
    const doneAt = status === "done" ? (Number(it.doneAt) || Date.now()) : null;
    return { ...it, status, doneAt };
  });
}

// ── 封面取值 / 搬家 / 写回 ──────────────────────────────────
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
// 搬完列表数据回归「纯文字」，哪个页面打开都快。已搬过（没有 data: 封面）就什么都不做。
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

// 用户上传的封面增删后，把 COVERS_KEY 整体写回存储。
async function saveCovers(next) {
  covers = next;
  try { await chrome.storage.local.set({ [COVERS_KEY]: covers }); } catch { /* 写不进去时本地照样显示 */ }
}

// 删除收藏时，把它自己上传的封面也一并删掉。
async function removeCoversOf(ids) {
  const doomed = [...ids].filter((id) => covers[id]);
  if (!doomed.length) return;
  const next = { ...covers };
  for (const id of doomed) delete next[id];
  await saveCovers(next);
}

// 三档：未读 / 在读 / 已读（已完成）。点一下「标为已读」按钮 = 标记完成，再点取消；
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

// 搜索是临时查看状态；切换项目或移动收藏后离开搜索结果，避免旧关键词继续过滤新页面。
function clearSearch() {
  clearTimeout(searchTimer);
  if (searchInput?.value) searchInput.value = "";
  query = "";
}
// 把三个筛选按钮的高亮同步成当前的 filter。
// 之前只有「点按钮」时才改高亮，另一边改了存储这边就对不上了，所以抽出来单独调。
function syncFilterButtons() {
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
}
// 切换筛选：先本地生效，再写进共享存储，让另一个视图跟着切。
async function setFilter(value) {
  const next = normalizeFilter(value);
  if (next === filter) { syncFilterButtons(); return; }
  filter = next;
  syncFilterButtons();
  render();
  try { await chrome.storage.local.set({ [FILTER_KEY]: filter, [FILTER_CHOSEN_KEY]: true }); } catch { /* 存不下就算了，本地筛选照常用 */ }
}

async function init() {
  await window.LaterOnI18n?.getLanguage();
  window.LaterOnI18n?.applyStatic();
  document.title = document.documentElement.lang === "en" ? "LaterOn · My saves" : "LaterOn · 我的收藏";
  const [result, activeTabs] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEY, PROJECTS_KEY, ACTIVE_PROJECT_KEY, SETTINGS_KEY, CURRENT_ITEM_KEY, FILTER_KEY, FILTER_CHOSEN_KEY, ORDER_KEY, COVERS_KEY]),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]);
  covers = result[COVERS_KEY] || {};
  const migrated = await migrateLegacyCovers(result[STORAGE_KEY]);
  const rawItems = migrated || result[STORAGE_KEY] || [];
  items = normalizeItems(rawItems);
  // 补齐的 doneAt 要写回存储，否则下次打开又变回「没有时间」，永远不会被清除。
  if (items.some((item, i) => item.doneAt && !Number(rawItems[i]?.doneAt))) {
    chrome.storage.local.set({ [STORAGE_KEY]: items });
  }
  projects = sortPinnedFirst(result[PROJECTS_KEY] || []);
  orders = result[ORDER_KEY] || {};
  activeProject = normalizeProject(result[ACTIVE_PROJECT_KEY]);
  currentItemId = result[CURRENT_ITEM_KEY] || null;
  const userSettings = result[SETTINGS_KEY] || {};
  sort = userSettings.defaultSort || "newest";
  sortSelect.value = sort;
  autoMarkRead = userSettings.autoMarkRead !== false;
  // 旧版本会在回首页时写入 all，但那不是用户的筛选偏好；升级后首次打开回到未读。
  filter = result[FILTER_CHOSEN_KEY] ? normalizeFilter(result[FILTER_KEY]) : DEFAULT_FILTER;
  syncFilterButtons();
  libraryTabId = activeTabs[0]?.id || null;
  libraryWindowId = activeTabs[0]?.windowId || null;
  render();
  renderProjects();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    items = normalizeItems(changes[STORAGE_KEY].newValue || []);
    render();
    renderProjects();
  }
  if (area === "local" && changes[COVERS_KEY]) {
    covers = changes[COVERS_KEY].newValue || {};
    render();
  }
  if (area === "local" && changes[PROJECTS_KEY]) {
    projects = sortPinnedFirst(changes[PROJECTS_KEY].newValue || []);
    render();
    renderProjects();
  }
  if (area === "local" && changes[ACTIVE_PROJECT_KEY]) {
    activeProject = normalizeProject(changes[ACTIVE_PROJECT_KEY].newValue);
    renderProjects();
    render();
  }
  if (area === "local" && changes[SETTINGS_KEY]) {
    const s = changes[SETTINGS_KEY].newValue || {};
    if (s.defaultSort && s.defaultSort !== sort) { sort = s.defaultSort; sortSelect.value = sort; render(); }
    if (typeof s.autoMarkRead === "boolean") autoMarkRead = s.autoMarkRead;
  }
  if (area === "local" && changes[CURRENT_ITEM_KEY]) {
    currentItemId = changes[CURRENT_ITEM_KEY].newValue || null;
    applyCurrentHighlight();
    locateCard(currentItemId);
  }
  if (area === "local" && changes[ORDER_KEY]) {
    orders = changes[ORDER_KEY].newValue || {};
    render();
  }
  if (area === "local" && changes[FILTER_KEY]) {
    // 侧栏那边切了筛选 → 这边跟着切（反过来同理）。自己写的值不会变，自然被这个判断挡掉。
    const next = normalizeFilter(changes[FILTER_KEY].newValue);
    if (next !== filter) { filter = next; syncFilterButtons(); render(); }
  }
});

document.querySelectorAll(".project-nav").forEach((button) => {
  button.addEventListener("click", () => selectProject(button.dataset.project));
  enableDropTarget(button);
});

const projectsSection = document.querySelector(".projects-section");

function syncProjectsVisibility() {
  const insideProject = activeProject !== "all" && activeProject !== "unfiled";
  projectsSection?.classList.toggle("is-visible", insideProject);
}

document.querySelector("#openSettings")?.addEventListener("click", async (event) => {
  const url = chrome.runtime.getURL("settings.html");
  // 默认就在「当前这个标签页」里切到设置页，点设置页的「返回」正好回到刚才的收藏墙。
  // 按住 ⌘ / Ctrl / Shift 点，仍按老习惯在新标签页打开。
  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    chrome.tabs.create({ url });
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) await chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
});

async function createProject(nameValue) {
  const name = String(nameValue || "").trim();
  if (!name) return;
  // 同名就不重复建，直接跳到那个项目。
  const existing = projects.find((project) => project.name === name);
  if (existing) {
    selectProject(existing.id);
    showToast(tr("projectExists", { name }));
    return;
  }
  const project = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  projects = [...projects, project];
  try {
    await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  } catch {
    projects = projects.filter((entry) => entry.id !== project.id);
    showToast(tr("createProjectFailed"));
    return;
  }
  selectProject(project.id);
  showToast(tr("projectCreated", { name }));
}

async function promptCreateProject() {
  const result = await LaterOnDialog.prompt({
    title: tr("newProject"),
    message: tr("newProjectHint"),
    fields: [{ name: "name", label: tr("projectNameLabel"), placeholder: tr("projectNamePlaceholder"), maxLength: 28 }],
    confirmText: tr("create")
  });
  if (result?.ok) await createProject(result.values?.name);
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setFilter(button.dataset.filter));
});

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { query = searchInput.value.trim().toLowerCase(); render(); }, 120);
});

// 点左上角的 LaterOn 标识 = 回「全屏首页」。
// 首页 = 这一页刚打开时的那一屏：全部项目（图板总览）+ 筛选回到「全部」+ 没有搜索词 + 滚到顶。
// 之所以要一次性复位这么多：钻进某个项目或筛到「未读」之后，用户对「怎么退回去」是没有把握的，
// 点品牌标识就是那个万能的后退——不用去猜自己刚才点过什么。
function goHome() {
  clearSearch();
  setFilter("unread");
  selectProject("all");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelector("#homeBrand")?.addEventListener("click", (event) => {
  // 它是个 <a href="#">：默认行为只是往地址栏塞个 #、页面闪一下，这里全权接管。
  event.preventDefault();
  goHome();
});

// 事件委托：整页只挂一个监听器，避免给每张卡片单独绑监听。
grid.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  const item = items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;
  if (selectMode) {
    // 多选时卡片上的标题 / 封面还是真链接，不拦住默认行为的话，
    // 选中的同时浏览器会顺手把文章打开（点了就跑的现状就是这么来的）。
    // 顺带也拦下了左上角圆点里那个隐藏勾选框的「连带翻转」，避免一次点击翻两次。
    event.preventDefault();
    // 圆点自己接待：browser 的 label 行为在不同环境下表现不一致，靠它翻转很容易落空。
    toggleSelect(item.id, card);
    return;
  }
  if (event.target.closest(".read-toggle")) updateItem(item.id, { status: nextStatus(item.status) });
  else if (event.target.closest(".delete")) deleteItem(item.id);
  else if (event.target.closest(".edit")) editItem(item);
  else if (event.target.closest(".title-link, .cover-link")) openItem(event, item);
});
grid.addEventListener("change", (event) => {
  if (selectMode) {
    const check = event.target.closest(".select-check");
    if (check) {
      const card = event.target.closest(".card");
      const item = items.find((entry) => entry.id === card.dataset.id);
      if (item) toggleSelect(item.id, card, check.checked);
    }
    return;
  }
  const select = event.target.closest(".project-select");
  if (!select) return;
  const card = event.target.closest(".card");
  const item = items.find((entry) => entry.id === card.dataset.id);
  if (item) {
    clearSearch();
    updateItem(item.id, { projectId: select.value || null });
  }
});
// 卡片上右键 = 这一篇的菜单（打开 / 标记已读 / 编辑 / 移动 / 多选 / 删除）。
// 和多选模式不冲突：多选时右键照样出菜单，只是「多选」那一项变成「取消选择」。
grid.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  const item = items.find((entry) => entry.id === card.dataset.id);
  if (!item) return;
  // 不拦掉默认行为的话，浏览器会把自己的原生菜单叠在我们那个上面。
  event.preventDefault();
  openItemMenu(item.id, event.clientX, event.clientY);
});

// ── 卡片上的「所属项目」：点一下弹出选项目浮层（和网页收藏时同一个窗口）────
// 原生 <select> 的下拉我们不让它弹（mousedown 就拦掉），改成贴着这个按钮弹浮层。
// 浮层里选中/新建项目后，直接改这篇的 projectId，不用再走原生下拉。
const pickerReady = () => typeof window.openFolderPicker === "function";
grid.addEventListener("mousedown", (event) => {
  if (!pickerReady()) return; // 共享模块没加载就退回原生下拉
  const select = event.target.closest(".project-select");
  if (select) event.preventDefault();
});
grid.addEventListener("click", (event) => {
  const select = event.target.closest(".project-select");
  if (!select || !pickerReady()) return;
  event.preventDefault();
  const card = select.closest(".card");
  const item = items.find((entry) => entry.id === card.dataset.id);
  if (item) openCardProjectPicker(card, item, select);
});
grid.addEventListener("keydown", (event) => {
  const select = event.target.closest(".project-select");
  if (!select || !pickerReady()) return;
  // 键盘聚焦到下拉时，回车 / 空格 / 方向键也改为打开浮层（而不是原生下拉）。
  if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const card = select.closest(".card");
    const item = items.find((entry) => entry.id === card.dataset.id);
    if (item) openCardProjectPicker(card, item, select);
  }
});
// ── 拖拽排序（卡片视图和图板视图共用同一套）─────────────────
// 把一个元素拖到另一个元素上：插到它前面（光标落在左半边）或后面（右半边），
// 松手就把这个顺序存下来。
//
// ⚠️ 关键：拖动过程中**绝对不能改 DOM、也不能重新读元素位置**。
// 老做法是「在落点插入一个占格的空位 + 把被拖的元素 display:none」，
// 这会立刻让所有元素重新排布；下一次 dragover 再按新位置判定，
// 鼠标底下就换成了另一个 → 又插一次 → 两个来回互换，看着就是疯狂跳动
// （叠加 FLIP 动画后更糟：动画期间 getBoundingClientRect 读到的是中间值）。
// 现在改成：布局只在拖动开始时拍一次快照，之后判定用快照、让位用 transform。
//
// 参数：container 在哪个容器里拖 / selector 被拖的元素 / idAttr 元素上记 id 的
// data 属性名（"id" → data-id、"project" → data-project）/ commit 松手时怎么存。
function enableReorder({ container, selector, idAttr, commit, dragImageHotspotX = null }) {
  container.addEventListener("dragstart", (event) => {
    const el = event.target.closest(selector);
    if (!el) return;
    // 拖拽是另一种明确操作：离开多选状态，避免拖动后仍保留旧的勾选。
    if (selectMode) setSelectMode(false);
    // 从按钮 / 下拉上按下的是想点它，不是想拖整块（图板上那个改简介的铅笔就是）。
    if (event.target.closest("button, select")) { event.preventDefault(); return; }
    const id = el.dataset[idAttr];
    if (!id) return;
    drag = { container, selector, idAttr, id, layout: null, slot: null };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
    const bounds = el.getBoundingClientRect();
    dragPreview = el.cloneNode(true);
    dragPreview.removeAttribute("draggable");
    dragPreview.classList.remove("dragging");
    dragPreview.classList.add("drag-preview");
    dragPreview.style.width = `${bounds.width}px`;
    dragPreview.style.height = `${bounds.height}px`;
    document.body.append(dragPreview);
    const grabbedOffsetX = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    // 收藏卡片拖向左侧项目时，用卡片左边缘作为横向触发基准：拖影的光标热点
    // 固定在左边缘附近后，左边缘刚碰到项目行，真实指针也就进入了放置区。
    // 纵向仍保留用户原本抓住的位置，避免目标项目上下错位。
    const offsetX = Number.isFinite(dragImageHotspotX)
      ? Math.max(0, Math.min(bounds.width, dragImageHotspotX))
      : grabbedOffsetX;
    const offsetY = Math.max(0, Math.min(bounds.height, event.clientY - bounds.top));
    event.dataTransfer?.setDragImage?.(dragPreview, offsetX, offsetY);
    // 快照要在 setDragImage 之后拍，并且此时元素还没加 .dragging（那个类会改变外观）。
    drag.layout = snapshotLayout(container, selector, idAttr);
    showDragHomeFrame();
    container.classList.add("is-reordering");
    requestAnimationFrame(() => el.classList.add("dragging"));
  });
  container.addEventListener("dragend", () => {
    document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    dragPreview?.remove();
    dragPreview = null;
    // 先收再清：clearReorderPreview 要靠 drag 去找容器和快照，
    // 所以「置空」必须排在它后面（拖到别处或按 Esc 取消不会触发 drop，这里兜底）。
    clearReorderPreview();
    drag = null;
    clearDropHighlights();
  });
  container.addEventListener("dragover", (event) => {
    if (!drag || drag.container !== container || !drag.layout) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const index = insertionIndexAt(
      (Number.isFinite(event.clientX) ? event.clientX : 0) + window.scrollX,
      (Number.isFinite(event.clientY) ? event.clientY : 0) + window.scrollY
    );
    if (index === drag.slot) return;   // 位置没变就什么都不做，这是不抖动的第一道保险
    drag.slot = index;
    applyReorderPreview(index);
  });
  container.addEventListener("drop", (event) => {
    if (!drag || drag.container !== container) return;
    event.preventDefault();
    // 直接用最后一次算好的位置：松手时光标可能正好停在缝隙里，重新判定反而容易算偏。
    const index = drag.slot ?? insertionIndexAt(
      (Number.isFinite(event.clientX) ? event.clientX : 0) + window.scrollX,
      (Number.isFinite(event.clientY) ? event.clientY : 0) + window.scrollY
    );
    commit(index).catch(() => {});
  });
}

// 卡片：拖一张卡片到另一个位置 → 换阅读顺序（每个项目各存一份，互不影响）。
enableReorder({ container: grid, selector: ".card", idAttr: "id", commit: commitCardOrder, dragImageHotspotX: 8 });
// 图板：拖一块图板 → 换这个类目在图板墙上的位置。和拖卡片是同一套手感。
enableReorder({ container: boardGrid, selector: ".board-card", idAttr: "project", commit: commitBoardOrder });

// 拖动开始时拍一张布局快照：记下每个元素当时占的是第几个格子、格子在哪。
// 坐标存成文档坐标（加上滚动量），这样拖动中页面万一滚动了也不会算歪。
function snapshotLayout(container, selector, idAttr) {
  const elements = [...container.querySelectorAll(selector)];
  return {
    ids: elements.map((el) => el.dataset[idAttr]),
    rects: elements.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left + window.scrollX, top: rect.top + window.scrollY,
        right: rect.right + window.scrollX, bottom: rect.bottom + window.scrollY,
        width: rect.width, height: rect.height
      };
    })
  };
}

// 原位置留下的空虚线框：一块被拖走后，它原来的格子不应该空得没影，
// 而是显示一个虚线框占住「这里是它的老家」。
// 实现成绝对定位的浮层（不占网格格子）→ 不会让任何元素重新排布，
// 也就不会重新引发「插占格元素 → 位置全变 → 判定错乱」的抖动问题。
// 位置取自拖动开始时的快照（老家的格子全程不动），所以只需要算一次。
function showDragHomeFrame() {
  if (!drag?.layout) return;
  const fromIdx = drag.layout.ids.indexOf(drag.id);
  if (fromIdx === -1) return;
  const rect = drag.layout.rects[fromIdx];
  const container = drag.container;
  const box = container.getBoundingClientRect();
  if (!dragHomeFrame) {
    dragHomeFrame = document.createElement("div");
    dragHomeFrame.className = "drag-home-frame";
    dragHomeFrame.setAttribute("aria-hidden", "true");
  }
  container.append(dragHomeFrame);
  // 快照是文档坐标，浮层相对容器定位：先减掉滚动量换回视口坐标，再减掉容器自己的偏移。
  dragHomeFrame.style.width = `${rect.width}px`;
  dragHomeFrame.style.height = `${rect.height}px`;
  dragHomeFrame.style.left = `${rect.left - window.scrollX - box.left}px`;
  dragHomeFrame.style.top = `${rect.top - window.scrollY - box.top}px`;
}

function clearDragHomeFrame() {
  dragHomeFrame?.remove();
  dragHomeFrame = null;
}

// 光标现在的位置，应该插到第几个「不含被拖那个」的元素前面（0 = 最前面）。
// 判定用的是拖动开始时的快照坐标，所以元素怎么让开都不会反过来影响判定。
function insertionIndexAt(x, y) {
  if (!drag?.layout) return 0;
  const { ids, rects } = drag.layout;
  const fromIdx = ids.indexOf(drag.id);
  for (let k = 0; k < ids.length; k += 1) {
    if (k === fromIdx) continue;          // 自己原来那个格子不算目标
    const rect = rects[k];
    if (y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right) {
      // 落在左半边 = 插到它前面；右半边 = 插到它后面。
      const restIndex = k < fromIdx ? k : k - 1;
      return x >= rect.left + rect.width / 2 ? restIndex + 1 : restIndex;
    }
  }
  // 没压在任何元素上（格子之间的缝隙）：维持上一次的结果。
  // 这是不抖动的第二道保险——否则光标一进缝隙，所有元素就会让开又挤回来。
  if (drag.slot !== null) return drag.slot;
  return rects.length && y < rects[0].top ? 0 : ids.length - 1;
}

// 让位：不动 DOM，只把每个元素平移到「插进去之后它该在的格子」。
// .card / .board-card 本身都带 transform 过渡，所以这一步看起来就是其它元素平滑地
// 让开一格，被拖的那个也会滑到落点。松手会落在哪，拖的时候看得清清楚楚。
function applyReorderPreview(index) {
  if (!drag?.layout) return;
  const { ids, rects } = drag.layout;
  const fromIdx = ids.indexOf(drag.id);
  if (fromIdx === -1) return;
  for (let i = 0; i < ids.length; i += 1) {
    const el = drag.container.querySelector(`[data-${drag.idAttr}="${ids[i]}"]`);
    if (!el) continue;
    // 第 i 个元素原来就占第 i 个格子，算出插完后它该去哪个格子。
    let target;
    if (i === fromIdx) {
      target = index;                     // 被拖的那个：直接滑到落点
    } else {
      const restIndex = i < fromIdx ? i : i - 1;
      target = restIndex < index ? restIndex : restIndex + 1;
    }
    const dx = rects[target].left - rects[i].left;
    const dy = rects[target].top - rects[i].top;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

// 收起让位效果：把预览用的 transform 全部抹掉，并收掉老家的虚线框。
function clearReorderPreview() {
  if (drag?.layout) {
    for (const id of drag.layout.ids) {
      const el = drag.container.querySelector(`[data-${drag.idAttr}="${id}"]`);
      if (el) el.style.transform = "";
    }
  }
  // 快照也一起丢掉：松手后如果又来一次 dragover（drop 和 dragend 之间有可能），
  // 没有快照它就会直接返回，不会拿旧坐标去动已经重排好的 DOM。
  if (drag) { drag.slot = null; drag.layout = null; }
  clearDragHomeFrame();
  drag?.container.classList.remove("is-reordering");
}

// 把拖拽结果写成新的顺序存起来。
// 注意存的是「这个范围里所有收藏」的顺序，不只是眼前筛出来的这几张——
// 否则在「未读」筛选下拖一次，被筛掉的「已读」就会丢掉自己的位置。
async function commitCardOrder(dropIndex) {
  const draggedId = drag?.id;
  if (!draggedId || dropIndex == null) return;
  const scoped = items.filter((item) => activeProject === "all" || (activeProject === "unfiled" ? !item.projectId : item.projectId === activeProject));
  // 屏幕上现在这个顺序里，被拖的这张应该排到谁前面（null = 排最后）。
  const visibleIds = [...grid.querySelectorAll(".card")]
    .map((card) => card.dataset.id)
    .filter((id) => id && id !== draggedId);
  const anchorId = visibleIds[dropIndex] ?? null;

  const full = scopeOrder(scoped).filter((id) => id !== draggedId);
  const at = anchorId ? full.indexOf(anchorId) : -1;
  const nextOrder = at === -1
    ? [...full, draggedId]
    : [...full.slice(0, at), draggedId, ...full.slice(at)];

  const nextOrders = { ...orders, [orderScope()]: nextOrder };
  orders = nextOrders;
  await chrome.storage.local.set({ [ORDER_KEY]: nextOrders });

  // 存好之后再收起让位效果。顺序很讲究：先关掉过渡，再抹掉预览用的 transform，
  // 然后 render() 按新顺序排好——三步在同一帧内完成，所以卡片直接从「让开的样子」
  // 落到最终位置，不会先弹回原位再跳过去（那一下就是以前看起来「乱跳」的观感）。
  grid.classList.add("no-transition");
  clearReorderPreview();
  // 原来不是「自定义顺序」的话，拖这一次就说明你想自己排，顺手切过去并说一声。
  if (sort !== "custom") {
    sort = "custom";
    sortSelect.value = "custom";
    render();
    saveSortSetting();
    showToast(tr("customSortEnabled"));
  } else {
    render();
    showToast(tr("orderSaved"));
  }
  void grid.offsetHeight;   // 强制回流，让新位置立刻生效，再恢复过渡
  grid.classList.remove("no-transition");
}

// ── 图板排序 ────────────────────────────────────────────
// 图板的顺序 = 项目的顺序（存在 PROJECTS_KEY，和侧栏项目列表是同一份）。
// 这样只有一份真相：拖图板会同步改侧栏，在侧栏拖项目也会同步改图板。
// 注意：图板上只有项目，「待整理」不占一块（见 boardGroups）。
function boardOrderIds() {
  return projects.map((project) => project.id);
}

async function commitBoardOrder(dropIndex) {
  const draggedId = drag?.id;
  if (!draggedId || dropIndex == null) return;
  // 和卡片一样：拿屏幕上现在这个顺序里「要排在谁前面」当锚点，
  // 再换算回完整顺序里——搜索/筛选藏起来的那些类目才不会被挤走。
  const visibleIds = [...boardGrid.querySelectorAll(".board-card")]
    .map((card) => card.dataset.project)
    .filter((id) => id && id !== draggedId);
  const anchorId = visibleIds[dropIndex] ?? null;
  const full = boardOrderIds().filter((id) => id !== draggedId);
  const at = anchorId ? full.indexOf(anchorId) : -1;
  const next = at === -1 ? [...full, draggedId] : [...full.slice(0, at), draggedId, ...full.slice(at)];

  const nextProjects = next.map((id) => projects.find((project) => project.id === id)).filter(Boolean);
  for (const project of projects) if (!nextProjects.includes(project)) nextProjects.push(project);
  if (nextProjects.every((project, i) => project.id === projects[i]?.id)) return;   // 位置没变，不用写库

  const name = projects.find((project) => project.id === draggedId)?.name || tr("unnamedProject");
  boardGrid.classList.add("no-transition");
  clearReorderPreview();
  projects = nextProjects;
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  render();
  renderProjects();   // 侧栏的项目列表跟着换，两边顺序始终一致
  showToast(tr("movedToPosition", { name, n: next.indexOf(draggedId) + 1 }));
  void boardGrid.offsetHeight;
  boardGrid.classList.remove("no-transition");
}

// ── 项目排序的接线（挂在列表上，行是每次渲染重建的）──────────
const projectListEl = document.querySelector("#projectList");
projectListEl.addEventListener("pointerdown", (event) => {
  // 记下这次按压是不是从「改名输入框 / ⋯ 按钮」上开始的，
  // 因为拖拽事件的 target 是整行，读不出内层元素。
  folderDragBlocked = !!event.target?.closest?.(".project-rename, .project-more");
});
projectListEl.addEventListener("dragover", (event) => {
  if (!folderDragId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  moveFolderDropLine(Number.isFinite(event.clientY) ? event.clientY : 0);
});
projectListEl.addEventListener("drop", (event) => {
  if (!folderDragId) return;
  event.preventDefault();
  commitFolderOrder().catch(() => {});
});
sortSelect.addEventListener("change", () => {
  sort = sortSelect.value;
  render();
  // 排序方式存进共享设置：侧栏照着同一份排，下次打开也还是这一档，
  // 不会出现「全屏自定义顺序、侧栏还是按时间」的错位。
  saveSortSetting();
});
async function saveSortSetting() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = stored[SETTINGS_KEY] || {};
    if (settings.defaultSort === sort) return;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, defaultSort: sort } });
  } catch { /* 存不下就算了，本次会话的排序照常用 */ }
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (folderMenu) { closeFolderMenu(); return; }
    if (renamingId) { stopRename(); return; }
    if (selectMode) setSelectMode(false);
    return;
  }
  // F2 = 给正在查看的项目改名（和系统的文件管理器一致的习惯）。
  if (event.key === "F2" && !isTypingTarget(event.target) && projects.some((project) => project.id === activeProject)) {
    event.preventDefault();
    startRename(activeProject, projects.find((project) => project.id === activeProject).name);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault(); searchInput.focus();
  }
});

function isTypingTarget(element) {
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
}

// 当前在看哪个范围：全部项目 / 待整理 / 某个项目。自定义顺序按范围各存一份。
function orderScope() {
  return activeProject || "all";
}

// 这个范围里所有收藏的「当前顺序」：先按存下来的自定义顺序，
// 没排过的新收藏（比如刚存的）接在后面，新的在前。
function scopeOrder(scopedItems) {
  const saved = Array.isArray(orders[orderScope()]) ? orders[orderScope()] : [];
  const known = saved.filter((id) => scopedItems.some((item) => item.id === id));
  const rest = scopedItems
    .filter((item) => !known.includes(item.id))
    .sort((a, b) => b.savedAt - a.savedAt)
    .map((item) => item.id);
  return [...known, ...rest];
}

// 排序规则：仍是「最新收藏 / 最早收藏 / 按来源」时照旧；
// 选了「自定义顺序」就按用户拖出来的先后排（没排过的按收藏时间倒序排在末尾附近）。
function customOrderComparator(scopedItems) {
  if (sort !== "custom") {
    return (a, b) => sort === "oldest" ? a.savedAt - b.savedAt
      : sort === "source" ? a.source.localeCompare(b.source)
      : b.savedAt - a.savedAt;
  }
  const rank = new Map(scopeOrder(scopedItems).map((id, index) => [id, index]));
  return (a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return b.savedAt - a.savedAt;
  };
}

function render() {
  for (const id of selectedIds) {
    if (!items.some((entry) => entry.id === id)) selectedIds.delete(id);
  }
  syncViewUI();
  if (isBoardView()) { renderBoards(); return; }
  renderCardsView();
}

function renderCardsView() {
  boardGrid.replaceChildren();
  // 搜索是全局的：搜索框里有字时一律在「全部收藏」里找，不受当前所在项目限制。
  // （以前是在当前项目的范围里找，人在某个项目里搜一个明明存在的标题会一无所获，
  //   还以为这篇收藏丢了。）「未读 / 已读」那一档仍然生效——它是用户自己拨过去的开关，
  // 不该被搜索悄悄改掉；没结果时的提示里也说了可以切它。
  const scopedItems = query
    ? items
    : items.filter((item) => activeProject === "all" || (activeProject === "unfiled" ? !item.projectId : item.projectId === activeProject));
  let visible = scopedItems.filter((item) => {
    // 「未读」= 还没读完（未读 + 在读）；「已读」= 手动标完成的那批。
    // 这样点开文章（自动进「在读」）不会让它从「未读」里消失——没读完就还算没读。
    const matchesFilter = filter === "all" || (filter === "done" ? item.status === "done" : item.status !== "done");
    const haystack = `${item.title} ${item.description} ${item.source} ${item.url}`.toLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });
  visible.sort(customOrderComparator(scopedItems));
  // 计数要说清是「在哪找的」：搜索时报命中数，并写明是在全部收藏里找的
  // ——否则人在某个项目里会以为顶上那个数字还是这个项目的。
  countText.textContent = query
    ? tr("searchCount", { count: visible.length, unfinished: visible.filter((item) => item.status !== "done").length })
    : tr("scopedCount", { count: scopedItems.length, unfinished: scopedItems.filter((item) => item.status !== "done").length });

  // 增量更新：只增删/重排发生变化的卡片，保留已有 DOM（不丢滚动、不重建监听）。
  const visibleIds = new Set(visible.map((item) => item.id));
  for (const [id, card] of cardMap) {
    if (!visibleIds.has(id)) { card.remove(); cardMap.delete(id); }
  }
  const token = ++libraryRenderToken;
  renderCards(visible, 0, token);
  // 同步「正在读」高亮（不丢滚动：只增删/重排发生变化的卡片）。
  applyCurrentHighlight();

  empty.hidden = visible.length > 0;
  if (!visible.length && items.length) {
    empty.querySelector("h2").textContent = tr("noMatches");
    empty.querySelector("p").textContent = tr("noMatchesHint");
  } else if (!items.length) {
    empty.querySelector("h2").textContent = tr("quiet");
    empty.querySelector("p").textContent = tr("quietHint");
  }
}

// ── 图板视图 ──────────────────────────────────────────────
// 一个类目 = 一张图板：封面由这个类目里最新几篇收藏的封面拼成（一张大的 + 两张小的），
// 下面是类目名、简介和篇数。点进去就是原来的卡片列表。
// 图板 = 全部项目总览。待整理 / 某个项目都是卡片列表，没有图板可看。
// 搜索时也让位给卡片列表：搜索要找的是「文章」，不是「类目」——所以只要搜索框里有字，
// 即便是「全部项目」也直接铺出命中的卡片（见 renderCardsView 里的全局搜索）。
function isBoardView() {
  return activeProject === "all" && !query;
}

// 哪些控件在当前视图下该出现：排序和批量选择只对卡片列表有意义，
// 图板视图（全部项目）下收起它们。
function syncViewUI() {
  const board = isBoardView();
  grid.hidden = board;
  boardGrid.hidden = !board;
  sortSelect.hidden = board;
  const selectButton = document.querySelector("#selectMode");
  if (selectButton) selectButton.hidden = board;
  if (board && selectMode) setSelectMode(false);
}

// 顶部「未读 / 已读」筛选（filter 是模块级变量，两个视图共用）
function matchesReadFilter(item) {
  return filter === "all" || (filter === "done" ? item.status === "done" : item.status !== "done");
}

// 类目分组：一个项目一块图板。
// 「待整理」（没归到任何项目的收藏）不占一块，也不在侧栏当筛选项——
// 那些收藏在「全部项目」的卡片视图里照样看得到，只是不再单独成一类。
// 顶部「未读 / 已读」筛选照样生效——只影响每组里算进来的篇数和封面。
function boardGroups() {
  const groups = projects.map((project) => ({
    id: project.id,
    name: project.name,
    note: project.note || "",
    cover: project.cover || "",
    // 用户在图板设置里自己挑的封面组合（收藏 id，按顺序，最多 3 个）。
    pick: Array.isArray(project.coverPick) ? project.coverPick : [],
    items: items.filter((item) => item.projectId === project.id && matchesReadFilter(item)),
    // 这个项目里的全部收藏（不管筛选）。只给「自己挑的封面」用：
    // 那是用户明确指定的门面，不该因为切一下未读/已读就换一张脸。
    own: items.filter((item) => item.projectId === project.id)
  }));
  // 按存下来的图板顺序排（拖过就有顺序，没拖过就是项目的创建顺序）。
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ordered = [];
  for (const id of boardOrderIds()) {
    const group = byId.get(id);
    if (group) ordered.push(group);
  }
  for (const group of groups) if (!ordered.includes(group)) ordered.push(group);
  // 真正的空项目也要显示：这里叫“全部项目”，而且用户刚从末尾加号创建的项目
  // 返回首页后必须找得到。只有“本来有内容、但当前阅读筛选下一篇都不剩”的项目才隐藏。
  // 注意：搜索时根本不会走到这里——有搜索词时视图直接切到卡片列表（见 isBoardView），
  // 因为搜索要找的是「文章」，按类目名去筛图板是另一回事。
  return ordered.filter((group) => group.items.length > 0 || group.own.length === 0);
}

function renderBoards() {
  for (const [, card] of cardMap) card.remove();
  cardMap.clear();
  grid.replaceChildren();

  const groups = boardGroups();
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  const unfinished = groups.reduce((sum, group) => sum + group.items.filter((item) => item.status !== "done").length, 0);
  // 没归到项目里的收藏不占图板，但得让人知道还有这么多没归位，
  // 否则顶上的篇数和卡片视图对不上，会以为收藏丢了。
  const loose = items.filter((item) => !item.projectId && matchesReadFilter(item)).length;
  // 「全部项目」是项目总览，不把未归类收藏伪装成一个项目统计；
  // 待整理数量只在左侧待整理入口显示。
  countText.textContent = tr("boardCount", { groups: groups.length, total, unfinished });

  boardGrid.replaceChildren();
  for (const group of groups) boardGrid.append(createBoardCard(group));
  boardGrid.append(createProjectBoard());

  empty.hidden = groups.length > 0;
  if (!groups.length && items.length) {
    empty.querySelector("h2").textContent = tr("noBoard");
    empty.querySelector("p").textContent = tr("noBoardHint");
  } else if (!items.length) {
    empty.querySelector("h2").textContent = tr("quiet");
    empty.querySelector("p").textContent = tr("quietHint");
  }
}

function createProjectBoard() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "board-create";
  button.setAttribute("aria-label", tr("newProjectButton"));
  button.title = tr("newProjectButton");

  const plus = document.createElement("span");
  plus.className = "board-create-plus";
  plus.textContent = "+";
  plus.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.textContent = tr("newProject");
  button.append(plus, label);
  button.addEventListener("click", () => { promptCreateProject().catch(() => showToast(tr("createProjectFailed"))); });
  return button;
}

function createBoardCard(group) {
  const fragment = boardTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".board-card");
  const cover = fragment.querySelector(".board-cover");
  card.dataset.project = group.id;
  // 整块图板可拖：拖它就能换这个类目在图板墙上的位置（和拖卡片同一套逻辑）。
  // 右上角那个改简介的铅笔是按钮，按下时不会触发拖拽。
  card.draggable = true;
  if (group.cover) {
    // 用户给这个类目设了自定义封面：整块铺满，不再拼多篇。
    cover.append(createBoardCellFromSrc(group.cover));
    cover.dataset.count = "1";
  } else {
    const picked = boardCoverItems(group);
    if (!picked.length) {
      // 这个类目还一篇收藏都没有：留一块空的封面板（只有底色，不放图标）。
      const cell = document.createElement("div");
      cell.className = "board-cell";
      cover.append(cell);
    } else {
      for (const item of picked) cover.append(createBoardCell(item));
    }
    // 拼图布局由张数决定：1 张铺满、2 张左右各半、3 张左边一张大的 + 右边上下两张。
    cover.dataset.count = String(Math.max(picked.length, 1));
  }

  const name = fragment.querySelector(".board-name");
  name.textContent = group.name;
  name.title = group.name;
  const note = boardNote(group);
  const noteEl = fragment.querySelector(".board-note");
  noteEl.textContent = note.text;
  noteEl.classList.toggle("is-auto", note.auto);
  noteEl.title = note.text;
  fragment.querySelector(".board-meta").textContent = boardMeta(group);
  return card;
}

// 拼封面用哪几篇：
//   ① 用户在「编辑项目」里自己挑过 → 就照他挑的顺序来（那是他指定的门面，
//      所以从「这个项目的全部收藏」里找，不受顶部未读/已读筛选影响）；
//   ② 没挑过，或者挑的那几篇被删了 / 挪走了 / 封面没了 → 自动：最新的优先，有封面的优先
//      （没封面的只用来补空位）。
function boardCoverItems(group) {
  const picked = (group.pick || [])
    .map((id) => (group.own || group.items).find((item) => item.id === id))
    .filter((item) => item && resolveImage(item));
  if (picked.length) return picked.slice(0, 3);
  const sorted = [...group.items].sort((a, b) => b.savedAt - a.savedAt);
  const withCover = sorted.filter((item) => resolveImage(item));
  const withoutCover = sorted.filter((item) => !resolveImage(item));
  return [...withCover, ...withoutCover].slice(0, 3);
}

function createBoardCell(item) {
  const cell = document.createElement("div");
  cell.className = "board-cell";
  const src = resolveImage(item);
  if (!src) return cell;
  const img = document.createElement("img");
  img.className = "board-img";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => {
    const fallback = nextCoverFallback(img.src);
    if (fallback) img.src = fallback;
    else img.remove();
  });
  img.src = src;
  cell.append(img);
  return cell;
}

// 给一个现成的图片地址（比如用户在「编辑项目」里上传的自定义封面）造一块封面单元。
function createBoardCellFromSrc(src) {
  const cell = document.createElement("div");
  cell.className = "board-cell";
  if (!src) return cell;
  const img = document.createElement("img");
  img.className = "board-img";
  img.alt = "";
  img.loading = "lazy";
  img.addEventListener("error", () => img.remove());
  img.src = src;
  cell.append(img);
  return cell;
}

// 简介：自己写过就用自己写的；没写过就按类目里的内容自动生成一句概览
// （主要来源 + 最近更新时间），这样每张图板下面都不会空着。
function boardNote(group) {
  const written = (group.note || "").trim();
  if (written) return { text: written, auto: false };
  const list = group.items;
  if (!list.length) return { text: tr("emptyBoardNote"), auto: true };
  const counts = new Map();
  for (const item of list) {
    const source = (item.source || "").trim();
    if (source) counts.set(source, (counts.get(source) || 0) + 1);
  }
  const topSources = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([source]) => source);
  const latest = Math.max(...list.map((item) => Number(item.savedAt) || 0));
  const parts = [];
  if (topSources.length) parts.push(tr("mainlyFrom", { sources: topSources.join(document.documentElement.lang === "en" ? ", " : "、") }));
  if (latest) parts.push(tr("updatedAt", { time: formatTime(latest) }));
  return { text: parts.join(" · ") || tr("itemCount", { n: list.length }), auto: true };
}

function boardMeta(group) {
  const count = group.items.length;
  if (!count) return tr("emptyCollection");
  const unread = group.items.filter((item) => item.status !== "done").length;
  const english = document.documentElement.lang === "en";
  return unread ? (english ? `${count} saves · ${unread} ${tr("notFinished")}` : `${count} 篇 · ${unread} ${tr("notFinished")}`)
    : (english ? `${count} saves · ${tr("allRead")}` : `${count} 篇 · ${tr("allRead")}`);
}

boardGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".board-card");
  if (!card) return;
  const projectId = card.dataset.project;
  if (event.target.closest(".board-edit")) { editBoard(projectId); return; }
  selectProject(projectId);   // 进这个类目看卡片列表
});

// 图板上右键 = 和侧栏里一样的项目菜单（重命名 / 编辑简介 / 删除）。
boardGrid.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".board-card");
  if (!card || card.dataset.project === "unfiled") return;
  event.preventDefault();
  openFolderMenu(card.dataset.project, event.clientX, event.clientY);
});

async function editBoard(projectId) {
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) return;
  // 在图板上点铅笔 = 直接编辑这个项目的「名称 / 简介 / 封面」，
  // 比从前只能写一句简介更顺手。名称/封面留空就维持原样，简介留空则退回自动生成。
  //
  // 封面这里要显示「这个项目现在真正在用的那张」，而不是 project.cover（它常常是空的）：
  //   自己传过 → 显示传的那张；没传过 → 显示挑过的第一张 / 项目里第一篇的封面
  //   （侧栏缩略图也是这张）。显示的不是自定义封面时用 derived 标出来：
  //   那种封面没有「移除」的意义（移除后还是它），所以弹窗里禁用「移除封面」并说明来路。
  const storedCover = project.cover || "";
  const shownCover = projectCoverFor(projectId) || "";

  // 备选封面 = 这个项目里所有「能解析出图」的收藏，最新的排前面。
  // 只给有图的：没图的挑上去也拼不出东西。（最多列 48 张，够挑的了。）
  const candidates = items
    .filter((item) => (item.projectId || "") === projectId && resolveImage(item))
    .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0))
    .slice(0, 48)
    .map((item) => ({ id: item.id, src: resolveImage(item), title: item.title || item.url || "" }));
  // 已经挑过的（按顺序），顺手把已经不存在的收藏剔除——存储里别留着死 id。
  const pickAlive = (list) => (Array.isArray(list) ? list : []).filter((id) => items.some((item) => item.id === id));
  const storedPick = pickAlive(project.coverPick);
  // 当前显示的那张到底是怎么来的，决定封面栏的说明文案。
  const source = storedCover ? "custom" : storedPick.length ? "picked" : shownCover ? "auto" : "none";
  const coverNotes = {
    custom: [tr("coverDefaultNote"), tr("coverRemoved")],
    picked: [tr("coverDefaultNote"), tr("coverReady")],
    auto: [tr("coverDefaultNote"), tr("coverReady")],
    none: [tr("coverDefaultNote"), tr("coverRemoved")]
  }[source];

  const result = await LaterOnDialog.prompt({
    title: tr("editProjectTitle", { name: project.name }),
    fields: [
      {
        name: "name",
        label: tr("projectNameLabel"),
        value: project.name,
        placeholder: tr("projectNamePlaceholder"),
        maxLength: 28
      },
      {
        name: "note",
        label: tr("projectNoteLabel"),
        value: project.note || "",
        placeholder: tr("projectNotePlaceholder"),
        multiline: true,
        rows: 3,
        maxLength: 200
      }
    ],
    cover: {
      name: "cover",
      label: tr("cover"),
      value: shownCover,
      derived: !storedCover,
      note: coverNotes[0],
      removedNote: coverNotes[1],
      // 封面组合：从项目里已抓到的封面里点选最多 3 张，拖拽决定顺序。
      // 传了 candidates 才会出现这一块（收藏条目的编辑弹窗不传，界面不变）。
      candidates,
      picks: storedPick,
      picksName: "coverPick",
      picksLabel: tr("coverPicks"),
      maxPicks: 3,
      picksNote: tr("coverPicksHint")
    },
    confirmText: tr("save")
  });
  if (!result?.ok) return;
  const nextName = (result.values?.name ?? "").trim();
  const nextNote = (result.values?.note ?? "").trim();
  const nextCover = (result.values?.cover ?? "") || "";
  const nameChanged = nextName && nextName !== project.name;
  const noteChanged = nextNote !== (project.note || "").trim();
  // 封面动没动，要跟「打开弹窗时看到的那张」比。关键是别把自动取的那张
  // 顺手写成项目自己的封面 —— 那样它就不再跟着项目里的新收藏变了。
  const coverChanged = nextCover !== shownCover && nextCover !== storedCover;
  // 封面组合：弹窗里给了备选就一定会带回一个数组（可能是空数组 = 全部取消）。
  // 没给备选（比如这个项目里还没有任何封面）时这份结果里没有这个键，那就维持原样。
  const nextPick = pickAlive(result.values?.coverPick ?? storedPick);
  const pickChanged = nextPick.join(",") !== storedPick.join(",");
  if (!nameChanged && !noteChanged && !coverChanged && !pickChanged) return;
  // 名字若清空就沿用原来的，避免类目变成空白。
  const finalName = nameChanged ? nextName : project.name;
  if (nameChanged && projects.some((entry) => entry.id !== projectId && entry.name === finalName)) {
    showToast(tr("duplicateProject"));
    return;
  }
  projects = projects.map((entry) => {
    if (entry.id !== projectId) return entry;
    const updated = {
      ...entry,
      name: finalName,
      note: nextNote,
      // 没动过封面就原样保留（含「没有自定义封面」这个状态）。
      ...(coverChanged ? { cover: nextCover } : {})
    };
    if (pickChanged) {
      // 全部取消 = 回到「按项目内容自动拼封面」，把字段删掉，别在存储里留个空壳。
      if (nextPick.length) updated.coverPick = nextPick;
      else delete updated.coverPick;
    }
    return updated;
  });
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  render();
  // 提示按实际改了什么来写，不啰嗦。
  const changed = [
    nameChanged ? tr("projectUpdateName") : "",
    noteChanged ? tr("projectUpdateNote") : "",
    coverChanged ? tr("projectUpdateCover") : "",
    pickChanged ? tr("projectUpdateCollage") : ""
  ].filter(Boolean).join(" · ");
  showToast(nameChanged ? tr("projectUpdated", { name: finalName, changes: changed }) : tr("projectChangesSaved", { changes: changed }));
}

function nextLibraryRender(fn) {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 250 });
  else window.setTimeout(fn, 16);
}

function renderCards(visible, start, token) {
  if (token !== libraryRenderToken) return;
  const end = Math.min(start + LIBRARY_RENDER_BATCH, visible.length);
  for (let index = start; index < end; index += 1) {
    const item = visible[index];
    let card = cardMap.get(item.id);
    if (!card) { card = createCard(item); cardMap.set(item.id, card); }
    else updateCard(card, item);
    if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] || null);
  }
  applyCurrentHighlight();
  if (end < visible.length) nextLibraryRender(() => renderCards(visible, end, token));
}

// YouTube 的最大分辨率封面（maxresdefault）对部分视频并不存在，
// 加载失败时逐级降到 hq720 / hqdefault / mqdefault，而不是让卡片留下空白。
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

// 把「正在读」那篇标出来（全屏与侧栏都会用到这个共享标记）。
function applyCurrentHighlight() {
  for (const [id, card] of cardMap) {
    card.dataset.currentLabel = tr("currentReading");
    card.classList.toggle("is-current", id === currentItemId);
  }
}

// 把「正在读」的卡片滚进可视区域（只在该页面还活着时调用，比如从侧栏点开、
// 全屏标签页还没跳走时；标签页一旦导航走就别滚了）。
function locateCard(id) {
  if (!id) return;
  const card = cardMap.get(id);
  // jsdom / 极端环境下没有 scrollIntoView，包一层避免报错（真实浏览器里才有用）。
  if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center", behavior: "smooth" });
}

// 卡片是复用的 DOM，封面换了要能同步刷新（用户自己上传/移除封面时尤其明显）。
const coverPlaceholders = new WeakMap();
function applyCover(card, item) {
  const cover = card.querySelector(".cover");
  if (!cover) return;
  // 模板里自带的那块默认占位（LaterOn Logo），封面加载失败或没有封面时就退回它。
  let placeholder = coverPlaceholders.get(card);
  if (!placeholder) {
    placeholder = cover.querySelector(".cover-placeholder");
    if (placeholder) coverPlaceholders.set(card, placeholder);
  }
  const current = cover.querySelector("img.cover-img");
  const src = resolveImage(item);
  if (src) {
    // 封面没变就别动 DOM，省得图片重新加载闪一下。
    if (current && current.getAttribute("src") === src) return;
    const img = document.createElement("img");
    img.className = "cover-img";
    // 小红书等站点的图片 CDN 会拒绝带 chrome-extension:// Referer 的请求（403），
    // 明确声明「不发 Referer」它们才会正常返回图片。
    img.referrerPolicy = "no-referrer";
    img.src = src;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      const fallback = nextCoverFallback(img.src);
      if (fallback) img.src = fallback;
      // 降级链走完仍拿不到图：退回 LaterOn 的 Logo，而不是留一块空白。
      else if (placeholder) cover.replaceChildren(placeholder);
    });
    // 有真实封面就替换掉占位，避免占位与封面上下叠在一起。
    cover.replaceChildren(img);
  } else if (current || (placeholder && !cover.contains(placeholder))) {
    if (placeholder) cover.replaceChildren(placeholder);
    else cover.replaceChildren();
  }
}

function createCard(item) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".card");
  const coverLink = fragment.querySelector(".cover-link");
  const titleLink = fragment.querySelector(".title-link");
  const favicon = fragment.querySelector(".favicon");
  const readToggle = fragment.querySelector(".read-toggle");
  const projectSelect = fragment.querySelector(".project-select");
  card.dataset.id = item.id;
  card.draggable = true;
  // 导入文件属于不可信输入。修饰键点击会绕过 openItem() 的 JS 校验、直接走 href，
  // 因此 DOM 本身也只能放 http/https，不能把 javascript: 等协议留给浏览器执行。
  coverLink.href = titleLink.href = safeTarget(item.url) || "#";
  setText(fragment.querySelector(".title-link h2"), item.title);
  setText(fragment.querySelector(".description"), IS_EMPTY_SUMMARY.test(item.description) ? tr("noDescription") : item.description);
  fragment.querySelector(".source-name").textContent = item.source;
  fragment.querySelector("time").textContent = formatTime(item.savedAt);
  favicon.src = item.favicon;
  favicon.addEventListener("error", () => { favicon.style.visibility = "hidden"; });
  applyCover(card, item);
  card.classList.toggle("is-read", item.status === "done");
  card.classList.toggle("is-reading", item.status === "reading");
  readToggle.textContent = readToggleLabel(item.status);
  readToggle.setAttribute("aria-label", readToggleLabel(item.status));
  fillProjectSelect(projectSelect, item.projectId || "");
  card.classList.toggle("selected", selectedIds.has(item.id));
  const check = card.querySelector(".select-check");
  if (check) check.checked = selectedIds.has(item.id);
  return card;
}

// 给卡片上的「所属项目」下拉填选项：永远先放「待整理」，再放所有项目。
// ensureId/ensureName 用于「刚从浮层里新建了项目」这种边界——那个 id 可能还没进 projects，
// 但卡片 select 需要这个选项才能把 .value 设对，否则卡片上会显示成空白。
function fillProjectSelect(select, ensureId, ensureName) {
  select.replaceChildren();
  select.append(new Option(tr("inbox"), ""));
  projects.forEach((project) => select.append(new Option(project.name, project.id)));
  if (ensureId && !projects.some((project) => project.id === ensureId)) {
    select.append(new Option(ensureName || tr("newProject"), ensureId));
  }
}

function updateCard(card, item) {
  card.classList.toggle("is-read", item.status === "done");
  card.classList.toggle("is-reading", item.status === "reading");
  const readToggle = card.querySelector(".read-toggle");
  if (readToggle) {
    readToggle.textContent = readToggleLabel(item.status);
    readToggle.setAttribute("aria-label", readToggleLabel(item.status));
  }
  // 标题和摘要也能同步跟上：卡片是复用的 DOM（只在第一次出现时新建），
  // 不同步的话，改完标题、或重复收藏抓到更好的信息，卡片上会一直是旧文字。
  setText(card.querySelector(".title-link h2"), item.title);
  setText(card.querySelector(".description"), IS_EMPTY_SUMMARY.test(item.description) ? tr("noDescription") : item.description);
  const target = safeTarget(item.url) || "#";
  const titleLink = card.querySelector(".title-link");
  const coverLink = card.querySelector(".cover-link");
  if (titleLink?.getAttribute("href") !== target) titleLink.href = target;
  if (coverLink?.getAttribute("href") !== target) coverLink.href = target;
  applyCover(card, item);
  const projectSelect = card.querySelector(".project-select");
  if (projectSelect.value !== (item.projectId || "")) projectSelect.value = item.projectId || "";
  card.classList.toggle("selected", selectedIds.has(item.id));
  const check = card.querySelector(".select-check");
  if (check) check.checked = selectedIds.has(item.id);
}

// 只在文字真的变了时才写 DOM —— 避免每次重渲染都惊动浏览器重新排版。
function setText(element, value) {
  if (!element) return;
  const next = value == null ? "" : String(value);
  if (element.textContent !== next) element.textContent = next;
}

// ── 编辑收藏的标题 / 摘要 ──────────────────────────────────
// 没抓到摘要时存的就是「暂无摘要」这几个字，编辑时要把占位当成「空」显示给用户。
const NO_SUMMARY = "暂无摘要";
const IS_EMPTY_SUMMARY = /^\s*(暂无摘要|No summary)?\s*$/i;
// 自动抓取难免有偏差（标题带站名、摘要抓成导航文字），所以允许用户自己改。
// 改过的会被标记为 titleEdited / descriptionEdited，
// 之后再次收藏同一网址时，后台不会再拿自动抓取的结果覆盖掉用户手写的版本。
async function editItem(item) {
  const result = await LaterOnDialog.prompt({
    title: tr("editItem"),
    message: IS_EMPTY_SUMMARY.test(item.description) ? tr("missingSummaryHint") : "",
    // 封面：可以自己上传一张本地图片（自动压缩后保存），也可以移除，显示回 Logo 占位。
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
  // 封面：值是 data URL（用户上传的图）或 ""（移除）。和原来不一样才写，
  // 没动过时 values.cover 就等于传进去的旧值，不会触发无谓的写入。
  // 本体（base64 大图）放进单独的 COVERS_KEY，收藏条目里只记一个 local://<id> 的指针，
  // 这样收藏列表始终是纯文字小数据，页面打开才不会被拖慢。
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
  if (!Object.keys(patch).length) { showToast(tr("noChanges")); return; }
  await updateItem(item.id, patch);
  // 立刻重画一次：存储的变更广播不一定会回到自己这个页面，靠它会显得「改了没反应」。
  render();
  showToast(tr("changesSaved"));
}

function selectProject(projectId) {
  clearSearch();
  activeProject = normalizeProject(projectId);
  renderProjects();
  render();
  chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: activeProject });
}

function normalizeProject(projectId) {
  if (projectId === "all" || projectId === "unfiled") return projectId;
  return projects.some((project) => project.id === projectId) ? projectId : "all";
}

// ── 项目置顶 ────────────────────────────────────────────────
// 置顶（project.pinned）的实现刻意做得很简单：**置顶的项目永远排在数组最前面**。
// 这样「存储里的顺序」就是「侧栏看到的顺序」，拖拽排序按屏幕算出来的下标可以直接用，
// 不用再做一次「显示顺序 ↔ 存储顺序」的换算（多一层换算就多一处会对不上的地方）。
function sortPinnedFirst(list) {
  const pinned = list.filter((project) => project.pinned);
  const rest = list.filter((project) => !project.pinned);
  return [...pinned, ...rest];
}

// 置顶 / 取消置顶（右键菜单和「⋯」菜单里的同一项）。
// 取消时不去猜「它原来在第几个」（没人记得住），只让它从置顶那一拨里退出来，
// 落到最后一个还置顶的项目后面——位置基本不动，用户再拖一下就能微调。
async function toggleProjectPin(id) {
  const project = projects.find((entry) => entry.id === id);
  if (!project) return;
  const next = projects.filter((entry) => entry.id !== id);
  const moved = { ...project };
  // 除了该项目之外，还置顶着几个、普通的有几个——两者夹出它能去的下标范围。
  const plain = next.filter((entry) => !entry.pinned);
  const pins = next.length - plain.length;
  if (project.pinned) {
    // 取消置顶：回到它在普通列表里原来的那个位置（置顶时记下的序号），
    // 落在「还置顶着的那几个」之后。记不住（数据是别的界面写的）就排在置顶区之后。
    const back = Number.isInteger(project.pinFrom) ? Math.max(0, Math.min(project.pinFrom, plain.length)) : 0;
    delete moved.pinned;
    delete moved.pinFrom;
    next.splice(pins + back, 0, moved);
  } else {
    // 置顶：提到置顶那一拨的最后，并记下它原本排第几，取消时才能原样放回去。
    // 序号要在「还没把自己摘出去」的列表上算——摘出去之后 findIndex 永远找不到自己。
    const plainAll = projects.filter((entry) => !entry.pinned);
    moved.pinned = true;
    moved.pinFrom = Math.max(0, plainAll.findIndex((entry) => entry.id === id));
    next.splice(pins, 0, moved);
  }
  projects = next;
  renderProjects();
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  showToast(tr(moved.pinned ? "pinDone" : "unpinDone", { name: project.name }));
}

function renderProjects() {
  const counts = new Map();
  let unfiled = 0;
  for (const item of items) {
    if (item.projectId) counts.set(item.projectId, (counts.get(item.projectId) || 0) + 1);
    else unfiled += 1;
  }
  document.querySelector("#allCount").textContent = items.length;
  document.querySelector("#unfiledCount").textContent = unfiled;
  syncProjectsVisibility();
  // 「待整理」那块：有内容就高亮，并把提示写成一句要去办的事。
  const inbox = document.querySelector(".inbox-card");
  if (inbox) {
    inbox.classList.toggle("has-items", unfiled > 0);
    inbox.querySelector(".inbox-hint").textContent = unfiled
      ? tr("inboxPending", { n: unfiled })
      : tr("noInbox");
  }
  document.querySelectorAll(".project-nav").forEach((button) => button.classList.toggle("active", button.dataset.project === activeProject));

  // 项目列表的 DOM 始终维护完整，但只在具体项目里显示；首页已有图板，
  // 等待整理也保持独立，避免同一批项目在左侧重复出现。
  const projectList = document.querySelector("#projectList");
  // 正在改名时，重建列表会打断输入；先记下焦点是否在改名输入框上，重建后再还回去。
  const hadRenameFocus = !!document.activeElement?.classList?.contains("project-rename");
  projectList.replaceChildren();
  const pinCount = projects.filter((project) => project.pinned).length;
  const divider = document.createElement("div");
  divider.className = "project-pin-sep";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-label", tr("pinnedProjects"));

  projects.forEach((project, index) => {
    const row = document.createElement("div");
    row.className = "project-row";
    row.dataset.id = project.id;
    row.dataset.project = project.id; // 拖拽放下时要读它，缺了会把归属写成 undefined

    row.classList.toggle("is-pinned", !!project.pinned);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `project-nav${activeProject === project.id ? " active" : ""}`;
    button.dataset.project = project.id;
    // 每行左侧不是文件夹图标，而是该项目的缩略图（和选项目浮层里的一样）：
    // 项目自带封面就用封面，否则取项目里某篇的封面，都没有就用名字首字做占位色块。
    const thumb = projectThumb(project.name, projectCoverFor(project.id));
    // 置顶的项目在缩略图右下角挂一枚图钉：一眼能看出「它不是因为名字排第一，是钉住的」。
    if (project.pinned) thumb.append(pinBadge());
    button.append(thumb);

    if (project.id === renamingId) {
      // 改名中：名字位置换成输入框（回车保存、Esc 取消、点到别处自动保存）。
      button.classList.add("is-renaming");
      const input = document.createElement("input");
      input.className = "project-rename";
      input.value = renameDraft;
      input.maxLength = 28;
      input.autocomplete = "off";
      input.setAttribute("aria-label", tr("projectNameLabel"));
      input.addEventListener("input", () => { renameDraft = input.value; });
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("dblclick", (event) => event.stopPropagation());
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); input.blur(); }
        else if (event.key === "Escape") { event.preventDefault(); stopRename(); }
      });
      input.addEventListener("blur", () => commitRename(project.id, input));
      button.append(input);
    } else {
      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = project.name;
      name.title = tr("projectTip", { name: project.name, pinned: project.pinned ? tr("pinnedPrefix") : "" });
      button.append(name);
    }

    const count = document.createElement("strong");
    count.className = "nav-count";   // 和顶部两个入口同一个小圆标样式
    count.textContent = counts.get(project.id) || 0;
    button.append(count);

    button.addEventListener("click", () => { if (project.id !== renamingId) selectProject(project.id); });
    button.addEventListener("dblclick", (event) => {
      if (project.id === renamingId) return;
      event.preventDefault();
      startRename(project.id, project.name);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openFolderMenu(project.id, event.clientX, event.clientY);
    });

    const more = document.createElement("button");
    more.type = "button";
    more.className = "project-more";
    more.title = tr("moreActions");
    more.setAttribute("aria-label", tr("projectAria", { name: project.name }));
    more.textContent = "⋯";
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      const rect = more.getBoundingClientRect();
      openFolderMenu(project.id, rect.right, rect.bottom + 6);
    });

    row.append(button, more);
    // 拖拽排序：整行可拖，抓着上下移动就能换顺序。
    row.draggable = true;
    row.addEventListener("dragstart", (event) => startFolderDrag(event, project.id, row));
    row.addEventListener("dragend", endFolderDrag);
    // 拖拽收藏到项目：监听挂在外层行上，这样右侧「⋯」那一小块也能接收放下。
    enableDropTarget(row);
    projectList.append(row);
    // 置顶区和其余项目之间画一条细线：告诉用户「上面这几个是钉住的，拖下来就是取消置顶」。
    if (pinCount && index === pinCount - 1 && projects.length > pinCount) projectList.append(divider.cloneNode(true));
  });

  const renameInput = projectList.querySelector(".project-rename");
  if (renameInput && (hadRenameFocus || renameFocusPending)) {
    // 第一次进入改名：全选，方便直接输入新名字；重渲染导致焦点丢失：光标放到末尾，接着打。
    const selectAll = renameFocusPending;
    renameFocusPending = false;
    renameInput.focus();
    const end = renameInput.value.length;
    renameInput.setSelectionRange(selectAll ? 0 : end, end);
  }

  refreshCardProjectOptions();
}

// 新建 / 改名 / 删除项目后，让已存在卡片上的「所属项目」下拉同步跟上，
// 否则下拉里会一直显示旧名字、或者找不到刚建好的项目。
function refreshCardProjectOptions() {
  for (const card of cardMap.values()) {
    const select = card.querySelector(".project-select");
    if (!select) continue;
    const current = select.value;
    select.replaceChildren(new Option(tr("inbox"), ""));
    projects.forEach((project) => select.append(new Option(project.name, project.id)));
    if (select.value !== current) select.value = current;
  }
}

function enableDropTarget(target) {
  if (target.dataset.project === "all") return;
  target.addEventListener("dragover", (event) => {
    // 正在拖的是「项目自己」（排序），这不是「把收藏放进项目」，别抢。
    if (isFolderDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropHighlights();
    target.classList.add("drop-target");
  });
  target.addEventListener("dragleave", (event) => {
    if (!isFolderDrag(event) && !target.contains(event.relatedTarget)) target.classList.remove("drop-target");
  });
  target.addEventListener("drop", async (event) => {
    if (isFolderDrag(event)) return; // 交给列表上的排序逻辑处理
    event.preventDefault();
    const itemId = event.dataTransfer.getData("text/plain");
    const destination = target.dataset.project;
    const projectId = destination === "unfiled" ? null : destination;
    const projectName = projectId ? projects.find((project) => project.id === projectId)?.name : tr("inbox");
    clearDropHighlights();
    if (!itemId || !items.some((item) => item.id === itemId)) return;
    await updateItem(itemId, { projectId });
    showToast(tr("movedIntoProject", { name: projectName || tr("genericProject") }));
  });
}

function clearDropHighlights() {
  document.querySelectorAll(".drop-target").forEach((element) => element.classList.remove("drop-target"));
}

// ── 项目排序：按住项目行上下拖，换它在侧栏里的位置 ──────────
// 拖拽用自定义数据类型标记，和「拖收藏卡片进项目」共用一个放下的区域，
// 靠 isFolderDrag() 区分——否则拖项目会被当成「把某篇收藏移进来」。
const FOLDER_DRAG_TYPE = "application/x-lateron-folder";

function isFolderDrag(event) {
  const types = event?.dataTransfer?.types;
  return !!types && Array.from(types).includes(FOLDER_DRAG_TYPE);
}

function startFolderDrag(event, projectId, row) {
  // 从改名输入框或「⋯」按钮上按下的，交给它们自己处理（选文字 / 开菜单）。
  if (folderDragBlocked || renamingId) {
    event.preventDefault();
    return;
  }
  folderDragId = projectId;
  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.effectAllowed = "move";
    try { transfer.setData(FOLDER_DRAG_TYPE, projectId); } catch {}
    if (typeof transfer.setDragImage === "function") {
      // 行本身是透明底，直接用它当拖拽影像会糊；克隆一份实体化的贴在光标上。
      const bounds = row.getBoundingClientRect();
      folderDragPreview = row.cloneNode(true);
      folderDragPreview.removeAttribute("draggable");
      folderDragPreview.classList.remove("is-dragging");
      folderDragPreview.classList.add("folder-drag-preview");
      folderDragPreview.style.width = `${bounds.width || 180}px`;
      document.body.append(folderDragPreview);
      const point = (value, size) => (Number.isFinite(value) ? Math.max(0, Math.min(size, value)) : 0);
      transfer.setDragImage(
        folderDragPreview,
        point(event.clientX - bounds.left, bounds.width || 180),
        point(event.clientY - bounds.top, bounds.height || 36)
      );
    }
  }
  row.classList.add("is-dragging");
  document.querySelector("#projectList")?.classList.add("is-sorting");
}

// 按指针纵向位置，把指示线插到「应该插进去的那两行之间」。
function moveFolderDropLine(pointerY) {
  const projectList = document.querySelector("#projectList");
  if (!projectList || !folderDragId) return;
  const rows = [...projectList.children].filter((element) => element.classList.contains("project-row"));
  let target = null;
  for (const row of rows) {
    if (row.dataset.id === folderDragId) continue; // 被拖的那行不参与比较
    const bounds = row.getBoundingClientRect();
    if (pointerY < bounds.top + bounds.height / 2) { target = row; break; }
  }
  // 先把「插到哪一行前面」换成下标（去掉被拖那项后，它前面还有几行），
  // 夹到允许区间里，再换回行对象——这样指示线本身也只在合法的落点上出现，
  // 用户看到的「会插到这里」和松手后的结果永远一致。
  const others = rows.filter((row) => row.dataset.id !== folderDragId);
  const index = target ? rows.slice(0, rows.indexOf(target)).filter((row) => row.dataset.id !== folderDragId).length : others.length;
  const [min, max] = folderDropRange();
  const before = others[Math.max(min, Math.min(max, index))] || null;
  if (!folderDropLine) {
    folderDropLine = document.createElement("div");
    folderDropLine.className = "folder-drop-line";
  }
  if (folderDropLine.nextSibling === before && folderDropLine.parentNode === projectList) return;
  projectList.insertBefore(folderDropLine, before); // before 为 null 时自动插到末尾
}

// 指示线上面有几行（不算被拖的那行）= 它在新顺序里该待的下标。
function folderDropIndex() {
  const projectList = document.querySelector("#projectList");
  if (!projectList || !folderDropLine?.parentNode) return null;
  const children = [...projectList.children];
  const lineAt = children.indexOf(folderDropLine);
  if (lineAt < 0) return null;
  return children
    .slice(0, lineAt)
    .filter((element) => element.classList.contains("project-row") && element.dataset.id !== folderDragId)
    .length;
}

async function commitFolderOrder() {
  const index = folderDropIndex();
  const dragged = projects.find((project) => project.id === folderDragId);
  if (index == null || !dragged) return;
  const rest = projects.filter((project) => project.id !== dragged.id);
  const [min, max] = folderDropRange();
  const at = Math.max(min, Math.min(max, index));
  rest.splice(at, 0, dragged);
  if (rest.every((project, i) => project.id === projects[i].id)) return; // 位置没变，不用写库
  projects = rest;
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  showToast(tr("movedToPosition", { name: dragged.name, n: rest.indexOf(dragged) + 1 }));
}

// 拖拽排序只在「自己那一区」里发生：置顶的项目只能在置顶那几个之间换位，
// 普通项目只能在其余项目里换位。想把项目挪进 / 挪出置顶区请用右键菜单里的
// 「置顶项目 / 取消置顶」——拖动的时候悄悄改掉置顶状态，会让「拖到第 1 个」
// 这种动作的结果变得不可预测（拖上去就变成置顶，再拖下来就丢掉置顶）。
// 返回值是允许的下标区间 [最小, 最大]，下标按「去掉被拖的那项之后」的列表算。
function folderDropRange() {
  const rest = projects.filter((project) => project.id !== folderDragId);
  const pins = rest.filter((project) => project.pinned).length;
  const dragged = projects.find((project) => project.id === folderDragId);
  return dragged?.pinned ? [0, pins] : [pins, rest.length];
}

function endFolderDrag() {
  folderDragId = null;
  folderDragBlocked = false;
  folderDropLine?.remove();
  folderDropLine = null;
  folderDragPreview?.remove();
  folderDragPreview = null;
  document.querySelectorAll(".project-row.is-dragging").forEach((row) => row.classList.remove("is-dragging"));
  document.querySelector("#projectList")?.classList.remove("is-sorting");
  clearDropHighlights();
}

// ── 项目：图标 / 改名 / 更多菜单 / 删除 ───────────────────

// 项目封面：优先项目自己上传的封面（data URL），其次用户在「编辑项目」里挑的
// 封面组合里的第一张，否则取该项目里某篇的封面。
// 侧栏项目行和卡片上的「所属项目」浮层共用这一个，两处的缩略图才永远一致。
function projectCoverFor(projectId) {
  const project = projects.find((entry) => entry.id === projectId);
  if (project?.cover) return project.cover;
  const inProject = items.filter((entry) => (entry.projectId || "") === projectId);
  // resolveImage 兼容三种来源：本地上传的封面（local://<id> 指针）、旧的 data: 内联、远程 URL。
  // 挑过的就按挑的顺序找第一张能用的——和图板上「第 1 张占大格」保持一致。
  for (const id of (Array.isArray(project?.coverPick) ? project.coverPick : [])) {
    const picked = inProject.find((entry) => entry.id === id);
    const src = picked && resolveImage(picked);
    if (src) return src;
  }
  // 取第一篇「能解析出图」的收藏当这个项目的门面。
  for (const entry of inProject) {
    const src = resolveImage(entry);
    if (src) return src;
  }
  return null;
}

// 图钉图标（置顶 / 取消置顶共用）：slashed = true 时叠一道斜杠表示「取消」。
function pinIconSvg(slashed = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "pin-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PIN_FILL_PATH);
  svg.append(path);
  if (slashed) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", "M4 20 20 4");
    line.setAttribute("class", "pin-slash");
    svg.append(line);
  }
  return svg;
}

// 置顶角标：缩略图右下角的一枚小图钉。
function pinBadge() {
  const badge = document.createElement("span");
  badge.className = "project-pin-badge";
  badge.title = tr("pinned");
  badge.append(pinIconSvg());
  return badge;
}

// 没有封面时的占位：项目名首字 + 一块暖色底，看起来仍是「图板缩略图」。
function projectThumbPlaceholder(name) {
  const placeholder = document.createElement("span");
  placeholder.className = "project-ph";
  placeholder.textContent = (name || "·").trim().slice(0, 1);
  return placeholder;
}

// 项目缩略图（封面 / 首字占位），和「选项目」浮层里每行左侧那张小图同一套外观。
function projectThumb(name, cover) {
  const box = document.createElement("span");
  box.className = "nav-icon project-thumb";
  if (cover) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    // 远程封面被防盗链挡掉时退回占位色块，不留一个破图。
    img.addEventListener("error", () => box.replaceChildren(projectThumbPlaceholder(name)));
    img.src = cover;
    box.append(img);
  } else {
    box.append(projectThumbPlaceholder(name));
  }
  return box;
}

function startRename(id, currentName) {
  closeFolderMenu();
  renamingId = id;
  renameDraft = currentName ?? projects.find((project) => project.id === id)?.name ?? "";
  renameFocusPending = true;
  renderProjects();
}

function stopRename() {
  renamingId = null;
  renameDraft = "";
  renameFocusPending = false;
  renderProjects();
}

async function commitRename(id, input) {
  // 已经取消或提交过了（Esc / 重复触发）就忽略，免得 blur 又把旧值写回去。
  if (renamingId !== id) return;
  const name = input.value.trim();
  const project = projects.find((entry) => entry.id === id);
  renamingId = null;
  renameDraft = "";
  renameFocusPending = false;
  if (!project) { renderProjects(); return; }
  if (!name || name === project.name) { renderProjects(); return; }
  if (projects.some((entry) => entry.id !== id && entry.name === name)) {
    showToast(tr("projectExists", { name }));
    renderProjects();
    return;
  }
  projects = projects.map((entry) => entry.id === id ? { ...entry, name } : entry);
  renderProjects();
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  showToast(tr("renamedTo", { name }));
}

async function deleteProject(id) {
  const project = projects.find((entry) => entry.id === id);
  if (!project) return;
  const affected = items.filter((item) => item.projectId === id).length;
  const confirmed = await LaterOnDialog.confirm({
    tone: "danger",
    title: tr("deleteProjectTitle", { name: project.name }),
    message: affected
      ? tr("deleteProjectMoveItems", { n: affected })
      : tr("deleteEmptyProject"),
    confirmText: tr("deleteProject")
  });
  if (!confirmed) return;
  projects = projects.filter((entry) => entry.id !== id);
  await chrome.storage.local.set({ [PROJECTS_KEY]: projects });
  if (affected) {
    items = items.map((item) => item.projectId === id ? { ...item, projectId: null } : item);
    await chrome.storage.local.set({ [STORAGE_KEY]: items });
  }
  if (activeProject === id) {
    activeProject = "all";
    await chrome.storage.local.set({ [ACTIVE_PROJECT_KEY]: "all" });
  }
  renderProjects();
  render();
  showToast(tr(affected ? "projectDeletedMoved" : "projectDeleted", { name: project.name, n: affected }));
}

function openFolderMenu(projectId, x, y) {
  closeFolderMenu();
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) return;
  const menu = document.createElement("div");
  menu.className = "folder-menu";
  menu.setAttribute("role", "menu");
  const title = document.createElement("p");
  title.className = "folder-menu-title";
  title.textContent = project.name;
  title.title = project.name;
  menu.append(
    title,
    // 置顶放在第一项：这是最常用的一步操作（把常用的项目挪到手边），
    // 也比「双击改名」更安全——点错了再点一次「取消置顶」就回来。
    menuItem(project.pinned ? tr("unpinProject") : tr("pinProject"), project.pinned ? "unpin" : "pin", () => toggleProjectPin(projectId)),
    menuItem(tr("rename"), "pencil", () => startRename(projectId, project.name)),
    menuItem(tr("editNote"), "note", () => editBoard(projectId)),
    menuItem(tr("deleteProject"), "trash", () => deleteProject(projectId), true)
  );
  document.body.append(menu);
  positionMenu(menu, x, y);
  folderMenu = menu;
  requestAnimationFrame(() => menu.classList.add("is-open"));
}

// ── 单篇收藏的右键菜单 ────────────────────────────────────
// 卡片上右键 = 这一篇能做的所有事，样式和图板的「项目菜单」完全一致（同一个 .folder-menu）。
// 这里刻意复用 folderMenu 这个变量：于是「点别处 / Esc / 滚动 / 窗口失焦自动关闭」全都白拿，
// 不用再抄一遍关闭逻辑。
function openItemMenu(itemId, x, y) {
  closeFolderMenu();
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return;
  const card = cardMap.get(itemId) || grid.querySelector(`.card[data-id="${cssEscape(itemId)}"]`);
  const menu = document.createElement("div");
  menu.className = "folder-menu";
  menu.setAttribute("role", "menu");
  const title = document.createElement("p");
  title.className = "folder-menu-title";
  const heading = (item.title || "").trim() || item.source || tr("itemFallback");
  title.textContent = heading.length > 20 ? `${heading.slice(0, 20)}…` : heading;
  title.title = heading;   // 标题被截短了，悬停能看到全名
  const picked = selectMode && selectedIds.has(item.id);
  // 只放「卡片上不方便做 / 做不到」的几项：
  // 「标为已读」和「移动到项目」在卡片上本来就有明显的按钮，不重复占用右键菜单。
  menu.append(
    title,
    menuItem(tr("itemOpen"), "open", () => openItem({ preventDefault() {}, metaKey: false, ctrlKey: false }, item)),
    menuItem(tr("itemEdit"), "pencil", () => editItem(item)),
    menuItem(picked ? tr("itemDeselect") : tr("itemSelect"), picked ? "deselect" : "multi", () => startMultiSelect(item.id, card, !picked)),
    menuItem(tr("delete"), "trash", () => deleteItem(item.id), true)
  );
  document.body.append(menu);
  positionMenu(menu, x, y);
  folderMenu = menu;
  requestAnimationFrame(() => menu.classList.add("is-open"));
}

// 菜单贴边时自动往回收，保证整块完整可见（项目菜单和收藏菜单共用）。
function positionMenu(menu, x, y) {
  const rect = menu.getBoundingClientRect();
  const width = rect.width || 180;
  const height = rect.height || 96;
  const left = Math.min(Math.max(8, x - width), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function cssEscape(value) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

// 从右键菜单里点「多选」：进入多选模式，并把这一篇先勾上（取消则勾掉）。
// 已经选中时这项变成「取消选择」，方便在多选状态里直接反悔。
function startMultiSelect(itemId, card, on) {
  if (!selectMode) setSelectMode(true);
  toggleSelect(itemId, card, on);
}

function menuItem(label, icon, onPick, danger = false) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `folder-menu-item${danger ? " danger" : ""}`;
  item.setAttribute("role", "menuitem");
  // 铅笔（重命名 / 编辑）/ 带字的纸（简介）/ 垃圾桶（删除）——都是描边图标（fill:none）。
  // 置顶用另一套实心图钉（见 pinIconSvg），不在这里。
  const ICON_PATHS = {
    pencil: "M4 20h4L20 8l-4-4L4 16zM14 6l4 4",
    note: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h4",
    trash: "M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m3 0-1 13H7L6 7",
    // 下面几个是「单篇收藏菜单」用的：
    open: "M14 5h5v5M19 5l-8 8M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5",
    multi: "M3.5 6.5h7v7h-7zM13.5 6.5h7v7h-7zM5 10l1.6 1.6L9 8",
    deselect: "M3.5 6.5h7v7h-7zM5.5 8.6l3 2.8M8.5 8.6l-3 2.8M14 10h6"
  };
  const text = document.createElement("span");
  text.textContent = label;
  if (icon === "pin" || icon === "unpin") {
    item.append(pinIconSvg(icon === "unpin"), text);
  } else {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON_PATHS[icon] || ICON_PATHS.trash);
    svg.append(path);
    item.append(svg, text);
  }
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    closeFolderMenu();
    onPick();
  });
  return item;
}

function closeFolderMenu() {
  folderMenu?.remove();
  folderMenu = null;
}

document.addEventListener("pointerdown", (event) => {
  if (folderMenu && !folderMenu.contains(event.target)) closeFolderMenu();
}, true);
window.addEventListener("blur", closeFolderMenu);
window.addEventListener("resize", closeFolderMenu);
document.addEventListener("scroll", closeFolderMenu, true);

// 在全屏收藏库里点一篇收藏：把「全屏」切换成「原文 + 侧栏」的阅读状态——
// 先在这个窗口打开侧栏（侧栏不会随页面跳转消失），再把收藏库自己这个标签页导航到原文。
// 想在新标签页里打开原文、让收藏库留着不动？按住 ⌘（Mac）/ Ctrl 再点即可。
async function openItem(event, item) {
  if (event.metaKey || event.ctrlKey) return;   // 修饰键 = 保留浏览器的默认行为
  event.preventDefault();

  const target = safeTarget(item.url);
  if (!target) { showToast(tr("invalidUrlShort")); return; }

  // 记下「正在读这篇」——侧栏据此高亮并滚动定位到它，两个视图保持一致。
  chrome.storage.local.set({ [CURRENT_ITEM_KEY]: item.id });

  const windowId = await resolveWindowId();
  if (!(await openSidePanel(windowId))) {
    // 侧栏打不开（极少数情况）：至少别让这次点击落空。
    showToast(tr("sidePanelFallback"));
    await chrome.tabs.create({ url: target, openerTabId: libraryTabId || undefined });
    return;
  }

  // 等侧栏脚本就绪后再跳转，避免侧栏刚打开时读到「正在导航」的空页面；超时也照样跳。
  await waitForSidePanelReady(windowId);
  if (autoMarkRead && item.status === "unread") await updateItem(item.id, { status: "reading" });
  if (libraryTabId) await chrome.tabs.update(libraryTabId, { url: target });
  else await chrome.tabs.create({ url: target });
}

// 只放行 http/https，避免收藏里混进 javascript: 之类的地址。
function safeTarget(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? String(url).trim() : "";
  } catch {
    return "";
  }
}

// 认准「收藏库自己在哪个窗口、哪个标签页」。用户可能把收藏库拖到别的窗口，
// 所以每次点击都重新问一次，而不是只信打开页面时缓存的值。
async function resolveWindowId() {
  const self = await chrome.tabs.getCurrent().catch(() => null);
  if (self?.id && self.windowId != null) {
    libraryTabId = self.id;
    libraryWindowId = self.windowId;
    return self.windowId;
  }
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (win?.id != null) { libraryWindowId = win.id; return win.id; }
  return libraryWindowId;
}

// 打开浏览器侧栏。必须在用户点击的手势里调用，所以放在流程最前面。
async function openSidePanel(windowId) {
  if (typeof chrome.sidePanel?.open !== "function") return false;
  if (windowId != null) {
    try { await chrome.sidePanel.open({ windowId }); return true; } catch {}
  }
  // 缓存的窗口 id 过期时（比如刚把收藏库拖到另一个窗口）再刷新一次。
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) { await chrome.sidePanel.open({ windowId: tab.windowId }); return true; }
  } catch {}
  return false;
}

async function waitForSidePanelReady(windowId) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    try {
      const response = await chrome.runtime.sendMessage({ type: "PING_SIDEPANEL", windowId });
      if (response?.ready) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return false;
}

async function updateItem(id, patch) {
  const next = { ...patch };
  if (patch.status) {
    next.read = patch.status === "done";  // 同步 read，兼容旧字段
    // 记下「什么时候标成已读的」——自动清除从这个时刻起算。
    // 本来就已读的（比如改标题时不小心又传了一次 status）保留原时间，别把计时器重置。
    const current = items.find((item) => item.id === id);
    next.doneAt = patch.status === "done"
      ? (current?.status === "done" && Number(current.doneAt) ? current.doneAt : Date.now())
      : null;
  }
  items = items.map((item) => item.id === id ? { ...item, ...next } : item);
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
}

// 卡片上点「所属项目」弹出的浮层：锚定在那个 <select> 按钮旁边。
// 复用 picker-ui.js 的 openFolderPicker（和网页收藏时选「收藏到哪个项目」是同一个窗口），
// 只是这里不弹整屏遮罩，而是贴着按钮出现；选中后直接改这篇的 projectId。
function projectPickerFolders() {
  const counts = new Map();
  let unfiled = 0;
  for (const entry of items) {
    if (entry.projectId) counts.set(entry.projectId, (counts.get(entry.projectId) || 0) + 1);
    else unfiled += 1;
  }
  // 每行左侧的封面缩略图用 projectCoverFor —— 和侧栏项目行是同一份逻辑，两处永远一致。
  return [
    { id: "", name: tr("inbox"), count: unfiled, cover: projectCoverFor("") },
    ...projects.map((project) => ({ id: project.id, name: project.name, count: counts.get(project.id) || 0, cover: projectCoverFor(project.id) }))
  ];
}

async function createProjectFromPicker(name) {
  const response = await chrome.runtime.sendMessage({ type: "CREATE_PROJECT", name }).catch(() => null);
  return response?.project || null;
}

function openCardProjectPicker(card, item, select) {
  window.openFolderPicker({
    anchor: select,
    theme: settings.theme || "system",
    language: document.documentElement.lang,
    folders: projectPickerFolders(),
    selected: item.projectId || "",
    // 新建项目走后台的 CREATE_PROJECT（和网页浮层同一份逻辑），项目会写进存储、
    // 本页的 storage.onChanged 跟着刷新侧栏——这里不用再手动同步。
    // onCreateProject 按约定返回「项目对象 {id,name}」（不是后台那层 {ok,project} 包装）。
    onCreateProject: createProjectFromPicker,
    onPick: async (projectId, name) => {
      // 选中的项目可能刚新建、select 里还没有这一项：先补上选项再更新，
      // 否则 updateCard 设不上 .value（选项不存在时会悄悄失败，卡片上仍是旧项目）。
      if (![...select.options].some((option) => option.value === projectId)) {
        fillProjectSelect(select, projectId, name);
      }
      await updateItem(item.id, { projectId });
      const latest = items.find((entry) => entry.id === item.id);
      clearSearch();
      updateCard(card, latest);
      render();
      showToast(projectId ? tr("movedTo", { name }) : tr("movedToInbox"));
    }
  });
}

async function deleteItem(id) {
  const target = items.find((entry) => entry.id === id);
  if (!target) return;
  // 删除是没法撤销的，删之前一定问一句。标题可能很长，截断免得把弹窗撑成一整段。
  const raw = (target.title || "").trim() || tr("itemFallback");
  const title = raw.length > 26 ? `${raw.slice(0, 26)}…` : raw;
  const confirmed = await LaterOnDialog.confirm({
    tone: "danger",
    title: tr("deleteItemTitle", { title }),
    message: tr("deleteCannotUndo"),
    confirmText: tr("delete")
  });
  if (!confirmed) return;
  items = items.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
  showToast(tr("itemDeleted"));
}

// ── 批量操作 ─────────────────────────────────────────────
function setSelectMode(on) {
  selectMode = on;
  grid.classList.toggle("selecting", on);
  document.querySelector("#selectMode")?.classList.toggle("active", on);
  const bar = document.querySelector("#bulkBar");
  if (bar) bar.classList.toggle("is-open", on);
  if (!on) selectedIds.clear();
  updateSelectionUI();
}

// 多选期间点击卡片以外的页面操作区，视为用户要离开多选；
// 卡片本身、底部批量工具栏和“选择”按钮保留原有交互。
document.addEventListener("pointerdown", (event) => {
  if (!selectMode) return;
  const target = event.target;
  if (target?.closest?.(".card, #bulkBar, #selectMode")) return;
  setSelectMode(false);
}, true);

function toggleSelect(id, card, force) {
  const willSelect = force !== undefined ? force : !selectedIds.has(id);
  if (willSelect) selectedIds.add(id); else selectedIds.delete(id);
  card.classList.toggle("selected", willSelect);
  const check = card.querySelector(".select-check");
  if (check) check.checked = willSelect;
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedIds.size;
  const countEl = document.querySelector("#bulkCount");
  if (countEl) countEl.textContent = tr("selectCount", { count });
  const allBtn = document.querySelector("#bulkSelectAll");
  if (allBtn) allBtn.textContent = count > 0 && count >= grid.children.length ? tr("deselectAll") : tr("selectAll");
}

async function bulkUpdate(patch) {
  if (!selectedIds.size) return;
  for (const id of selectedIds) await updateItem(id, patch);
  finishBulk();
}

async function bulkMove(projectId) {
  if (!selectedIds.size) return;
  for (const id of selectedIds) await updateItem(id, { projectId });
  finishBulk();
}

function openBulkProjectPicker() {
  if (!selectedIds.size || typeof window.openFolderPicker !== "function") return;
  const anchor = document.querySelector("#bulkProject");
  if (!anchor) return;
  const count = selectedIds.size;
  const selectedProjects = new Set(
    items.filter((item) => selectedIds.has(item.id)).map((item) => item.projectId || "")
  );
  window.openFolderPicker({
    anchor,
    theme: settings.theme || "system",
    language: document.documentElement.lang,
    folders: projectPickerFolders(),
    selected: selectedProjects.size === 1 ? [...selectedProjects][0] : "",
    titleText: tr("bulkMoveTitle", { n: count }),
    onCreateProject: createProjectFromPicker,
    onPick: async (projectId, name) => {
      await bulkMove(projectId || null);
      showToast(tr("bulkMoved", { n: count, name: name || tr("inbox") }));
    }
  });
}

async function bulkDelete() {
  if (!selectedIds.size) return;
  const count = selectedIds.size;
  const confirmed = await LaterOnDialog.confirm({
    tone: "danger",
    title: tr("bulkDeleteTitle", { n: count }),
    message: tr("cannotUndo"),
    confirmText: tr("bulkDeleteButton", { n: count })
  });
  if (!confirmed) return;
  const ids = new Set(selectedIds);
  items = items.filter((item) => !ids.has(item.id));
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
  await removeCoversOf(ids);
  finishBulk();
  showToast(tr("bulkDeleted", { n: ids.size }));
}

function finishBulk() {
  selectedIds.clear();
  setSelectMode(false);
}

document.querySelector("#selectMode")?.addEventListener("click", () => setSelectMode(!selectMode));
document.querySelector("#bulkSelectAll")?.addEventListener("click", () => {
  const allSelected = selectedIds.size >= grid.children.length && grid.children.length > 0;
  [...grid.children].forEach((card) => {
    const item = items.find((entry) => entry.id === card.dataset.id);
    if (item) toggleSelect(item.id, card, !allSelected);
  });
  updateSelectionUI();
});
document.querySelector("#bulkRead")?.addEventListener("click", () => bulkUpdate({ status: "done" }));
document.querySelector("#bulkUnread")?.addEventListener("click", () => bulkUpdate({ status: "unread" }));
document.querySelector("#bulkProject")?.addEventListener("click", openBulkProjectPicker);
document.querySelector("#bulkDelete")?.addEventListener("click", bulkDelete);
document.querySelector("#bulkDone")?.addEventListener("click", () => setSelectMode(false));

function formatTime(timestamp) {
  const diff = Date.now() - timestamp;
  const day = 86400000;
  if (diff < 60000) return tr("justNow");
  if (diff < 3600000) return tr("minutesAgo", { n: Math.floor(diff / 60000) });
  if (diff < day) return tr("hoursAgo", { n: Math.floor(diff / 3600000) });
  if (diff < day * 30) return tr("daysAgo", { n: Math.floor(diff / day) });
  return new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en" : "zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

let toastTimer = null;
let toastGeneration = 0;
function showToast(message, duration = 1800, variant = "") {
  const generation = ++toastGeneration;
  toast.classList.toggle("pill-toast", variant === "pill");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (generation !== toastGeneration) return;
    toast.classList.remove("show");
    // 等退出动画播完再卸掉药丸变体，避免元素在淡出途中突然跳回右下角。
    setTimeout(() => {
      if (generation === toastGeneration) toast.classList.remove("pill-toast");
    }, 260);
  }, duration);
}
