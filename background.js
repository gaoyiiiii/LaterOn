const STORAGE_KEY = "laterOnItems";
const PROJECTS_KEY = "laterOnProjects";
const SETTINGS_KEY = "laterOnSettings";
// 收藏卡片的自定义顺序（全屏 / 侧栏共用）：清掉收藏时也要把顺序里的 id 一并去掉。
const ORDER_KEY = "laterOnOrder";
// 用户自己上传的封面（体积大）：单独一个键存放 { 收藏 id: dataURL }，
// 收藏条目里只记 local://<id> 指针；清除过期收藏时要把对应封面也删掉。
const COVERS_KEY = "laterOnCovers";
// 「一键收藏」待处理的那一批标签页：临时存在 session 里（关掉浏览器就没了，不占磁盘）。
const PENDING_KEY = "laterOnPendingBatch";
// 上次用过的项目：下次弹窗时默认选中它。
const LAST_PROJECT_KEY = "laterOnLastProjectId";

// translation.css 只需给每个标签页注入一次，避免反复收藏时堆叠重复样式表。
const injectedCssTabs = new Set();
async function ensureTranslationCss(tabId) {
  if (!tabId || injectedCssTabs.has(tabId)) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["translation.css"] });
    injectedCssTabs.add(tabId);
  } catch {
    // 页面受保护或已关闭，忽略即可。
  }
}

// 页面跳转后注入的样式会失效、标签关闭后记录也没意义，这里及时清掉标记，
// 保证下次提示时样式能重新注入（否则药丸会变成没有样式的裸文本）。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") injectedCssTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => injectedCssTabs.delete(tabId));

// ── 诊断记录 ────────────────────────────────────────────────
// 快捷键有可能被 macOS 或其他软件半路截走，导致「按了没反应」。
// 这里把「是否收到按键 / 执行结果 / 报错」记到本地，设置页会展示出来，
// 一眼就能判断到底是按键没到达扩展，还是扩展执行时出错了。
const DIAG_KEY = "laterOnDiag";
async function recordDiag(patch) {
  try {
    const stored = await chrome.storage.local.get(DIAG_KEY);
    await chrome.storage.local.set({ [DIAG_KEY]: { ...(stored[DIAG_KEY] || {}), ...patch } });
  } catch {
    // 诊断信息写不进去不影响主流程。
  }
}

// ── 右键菜单：不依赖快捷键的备用入口 ────────────────────────
// 快捷键只在「扩展首次安装」时由 Chrome 绑定，且可能被系统占用；
// 右键菜单任何时候都能用，作为兜底。
const MENU_SAVE_ALL = "lateron-save-all-tabs";
const MENU_SAVE_PAGE = "lateron-save-page";

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    const create = (options) => {
      try {
        chrome.contextMenus.create(options);
      } catch {
        // 菜单已存在或权限未就绪时忽略。
      }
    };
    create({ id: MENU_SAVE_ALL, title: "收藏本窗口所有标签页到 LaterOn", contexts: ["page", "action"] });
    create({ id: MENU_SAVE_PAGE, title: "收藏此页面到 LaterOn", contexts: ["page", "action"] });
  });
}

// Chrome 与 Edge 共用 Side Panel API。manifest 里不再绑定 default_popup，
// 再显式开启 openPanelOnActionClick，工具栏图标便会在两端直接切换 LaterOn 侧栏。
// 该偏好由浏览器保存；service worker 冷启动、浏览器启动和扩展升级时都重新确认一次，
// 避免 Edge 更新、扩展重新加载或浏览器同步后退回默认的“图标无动作”。
async function setupSidePanelAction() {
  if (typeof chrome.sidePanel?.setPanelBehavior !== "function") return false;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return true;
  } catch {
    return false;
  }
}

setupContextMenus();
setupSidePanelAction();
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  setupSidePanelAction();
});
chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
  setupSidePanelAction();
});

// ── 自动清除过期的「已读」收藏 ────────────────────────────────
// 从「标为已读的那一天」起算，超过设定天数（默认 30 天，30–180 天可调）就自动删掉，
// 免得读完的东西一直堆在收藏库里。
const CLEAN_ALARM = "laterOnAutoClean";
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN_MIN_DAYS = 30;
const CLEAN_MAX_DAYS = 180;
const CLEAN_DEFAULT_DAYS = 30;

function normalizeCleanDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return CLEAN_DEFAULT_DAYS;
  return Math.min(CLEAN_MAX_DAYS, Math.max(CLEAN_MIN_DAYS, Math.round(days)));
}

// 兼容老数据：1.40 之前没有 status 字段，只有 read 布尔。
function isDoneItem(item) {
  if (!item) return false;
  if (item.status) return item.status === "done";
  return item.read === true;
}

async function purgeExpiredItems() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, ORDER_KEY, SETTINGS_KEY, COVERS_KEY]);
    const items = stored[STORAGE_KEY] || [];
    const days = normalizeCleanDays((stored[SETTINGS_KEY] || {}).autoCleanDays);
    const cutoff = Date.now() - days * DAY_MS;
    // 没有 doneAt 的（本版本之前就标成已读的老收藏）一律不动，避免升级后误删一片。
    const expiredIds = new Set(
      items.filter((item) => isDoneItem(item) && Number(item.doneAt) > 0 && Number(item.doneAt) < cutoff)
        .map((item) => item.id)
    );
    if (!expiredIds.size) return 0;
    const kept = items.filter((item) => !expiredIds.has(item.id));
    const orders = stored[ORDER_KEY] || {};
    const nextOrders = {};
    for (const [scope, list] of Object.entries(orders)) {
      nextOrders[scope] = Array.isArray(list) ? list.filter((id) => !expiredIds.has(id)) : list;
    }
    // 过期收藏删掉了，它们自己上传的封面也要跟着删，别在存储里占地方。
    const covers = stored[COVERS_KEY] || {};
    const nextCovers = {};
    for (const [id, data] of Object.entries(covers)) {
      if (!expiredIds.has(id)) nextCovers[id] = data;
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: kept, [ORDER_KEY]: nextOrders, [COVERS_KEY]: nextCovers });
    return expiredIds.size;
  } catch {
    return 0;
  }
}

// 定时跑：服务worker 会被浏览器回收，用 alarms 才能在后台稳定触发。
// 每 12 小时扫一次（粒度足够，删除时间差半天不影响体验）。
if (chrome.alarms) {
  chrome.alarms.onAlarm?.addListener((alarm) => {
    if (alarm?.name === CLEAN_ALARM) purgeExpiredItems().catch(() => {});
  });
  chrome.alarms.create?.(CLEAN_ALARM, { delayInMinutes: 2, periodInMinutes: 720 });
}
// 扩展启动 / service worker 每次被唤醒时也顺手扫一遍。
purgeExpiredItems().catch(() => {});
// 设置里把天数调小了立即生效（不用等下一次定时）。
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) purgeExpiredItems().catch(() => {});
});

// ── 新标签页劫持：把默认新标签（含浏览器启动首页）换成 LaterOn 全屏收藏墙 ──
// 为什么不用 manifest 的 chrome_url_overrides.newtab：那是写死的硬覆盖，平台不允许运行时关闭；
// 这里改为监听 onCreated，配合设置项 newTabPage 实现「可开关的替换新标签」，体验等价且能关。
const NEW_TAB_URL_RE = /^chrome:\/\/(newtab|new-tab-page)\/?/i;
function isNewTabRedirectTarget(tab) {
  const url = tab && (tab.pendingUrl || tab.url || "");
  return NEW_TAB_URL_RE.test(url);
}
async function handleNewTabCreated(tab) {
  if (!isNewTabRedirectTarget(tab)) return;
  if (tab.id == null) return;
  let settings = {};
  try {
    settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  } catch {
    return;
  }
  if (!settings.newTabPage) return;
  const libraryUrl = chrome.runtime.getURL("library.html");
  if (libraryUrl === tab.pendingUrl || libraryUrl === tab.url) return;
  chrome.tabs.update(tab.id, { url: libraryUrl }).catch(() => {});
}
chrome.tabs.onCreated.addListener(handleNewTabCreated);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SAVE_ALL) {
    saveAllTabsInWindow("menu").catch((error) => reportFailure(error));
  } else if (info.menuItemId === MENU_SAVE_PAGE && tab?.id) {
    quickSave(tab, "menu").catch((error) => reportFailure(error));
  }
});

// 工具栏图标的左键行为由上面的 setPanelBehavior 交给浏览器原生处理：
// 点击直接打开 / 聚焦 LaterOn 侧栏，不再经过缩略图 popup。

// 一次性迁移（1.14.0）：清掉旧版本保存的网页正文字段。
// 不依赖 onInstalled —— 因为「重新加载扩展」不会触发 onInstalled，
// 这里放在脚本启动时执行，并用标记位保证只真正清理一次。
ensureLegacyCleanup().catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SAVE_ITEM") {
    saveItem(message.item)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "OPEN_LIBRARY") {
    openLibrary()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  // 「选择项目」窗口点了确认：先回执让它马上关闭，再在后台继续收藏。
  if (message.type === "CONFIRM_BATCH_SAVE") {
    let replied = false;
    const reply = (payload) => {
      if (replied) return;
      replied = true;
      try {
        sendResponse(payload);
      } catch {
        // 窗口已经关掉时端口可能已断开，忽略即可。
      }
    };
    confirmBatchSave(message.projectId || null, reply)
      .then((result) => reply(result && result.ok === false ? result : { ok: true }))
      .catch((error) => reply({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message.type === "CANCEL_BATCH_SAVE") {
    cancelPendingBatch()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  // 网页里的选项目浮层点了「新建」：统一由后台写库，保证数据和收藏库一致。
  if (message.type === "CREATE_PROJECT") {
    createProject(message.name)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  // 弹窗 / 侧栏要显示「当前网页」的标题封面摘要时，统一由后台来抓。
  // 这样全网只有一份提取逻辑，不会出现「改了一处、另一处还是旧行为」。
  if (message.type === "EXTRACT_METADATA") {
    extractTabMetadataById(message.tabId)
      .then((response) => {
        // 记一笔「封面是从哪一层拿到的」，方便在设置页排查抓不到封面的站点。
        if (response?.ok) {
          recordDiag({
            lastCoverFrom: response.metadata?.imageFrom || "none",
            lastTitleFrom: response.metadata?.titleFrom || "none",
            lastCoverTitle: String(response.metadata?.title || "").slice(0, 60),
            lastCoverAt: Date.now()
          });
        }
        sendResponse(response);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  // 侧边栏 / 工具栏小窗口里的「收藏当前网页」按钮。
  // 交给后台统一处理，这样它们和快捷键走的是同一条链路——
  // 设置里打开「收藏单篇前先选项目」时，点按钮同样会先弹浮层，而不是直接收藏。
  if (message.type === "QUICK_SAVE_TAB") {
    (async () => {
      try {
        const tab = message.tabId
          ? await chrome.tabs.get(message.tabId).catch(() => null)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id || !isWebUrl(tab.url)) {
          sendResponse({ ok: false, error: "当前页面无法收藏" });
          return;
        }
        const result = await quickSave(tab, message.source || "panel");
        // result.pending 为真 = 已经弹出选项目浮层，真正的收藏要等用户确认。
        sendResponse({ ok: true, ...(result || {}) });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }
});

// 快捷键触发：先记一笔「确实收到了按键」，再执行。
// 这样即使后面执行失败，也能在设置页看出按键有没有到达扩展。
chrome.commands.onCommand.addListener((command, tab) => {
  (async () => {
    await recordDiag({ lastCommand: command, lastTrigger: "shortcut", lastCommandAt: Date.now() });
    try {
      await handleCommand(command, tab);
    } catch (error) {
      await reportFailure(error);
    }
  })();
});

async function handleCommand(command, commandTab) {
  // 「收藏当前窗口所有标签页」不依赖当前激活页是否为网页，单独处理。
  if (command === "save-all-tabs") {
    await saveAllTabsInWindow();
    return;
  }

  const tab = commandTab?.id
    ? commandTab
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  if (!tab?.id || !isWebUrl(tab.url)) {
    // 在 LaterOn 全屏收藏库里按 Alt+1 时，不能只在工具栏图标上挂一个「!」：
    // 页面本身已有 toast，就把“为什么不能收藏”直接说在人眼正在看的地方。
    // Chrome 设置页等其它受保护页面收不到扩展页消息，仍保留角标兜底。
    const explained = await showLibraryCommandNotice(tab, command);
    if (!explained) await showActionError();
    return;
  }

  if (command === "quick-save") {
    await quickSave(tab);
  } else if (command === "toggle-translation") {
    await toggleTranslation(tab);
  }
}

async function quickSave(tab, source = "shortcut") {
  // 设置里打开了「收藏单篇前先选项目」：跟整窗收藏走同一套流程——
  // 只在当前网页里弹出选项目浮层，用户选好之后再真正开始收藏。
  if (await shouldAskFolderForSingle()) {
    const storedItems = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
    const knownUrls = new Set(storedItems.map((entry) => normalizeUrl(entry.url)));
    const savedCount = knownUrls.has(normalizeUrl(tab.url || "")) ? 1 : 0;
    await recordDiag({
      lastTrigger: source,
      lastStage: "等待选择项目",
      lastStageAt: Date.now(),
      lastRunAt: Date.now(),
      lastTabCount: 1
    });
    return askFolderThenSave({ tabs: [tab], source, activeTab: tab, savedCount });
  }

  // 统一走 extractTabMetadata：它会在抓取前处理抖音「站内切换视频」的滞后问题，
  // 也自带超时兜底（原先直接注入的写法，遇到卡死的页面会一直挂着）。
  const meta = await extractTabMetadata(tab);

  const fallbackUrl = tab.url || "";
  const baseItem = {
    title: meta.title || tab.title || fallbackUrl,
    description: meta.description || "暂无摘要",
    image: meta.image || "",
    favicon: meta.favicon || tab.favIconUrl || "",
    source: meta.source || safeHostname(fallbackUrl),
    url: meta.url || fallbackUrl
  };
  const saved = await saveItem(baseItem);
  // 记一笔封面来源（设置页的「自检」会显示），万一某个站点抓不到封面就知道卡在哪层。
  await recordDiag({
    lastCoverFrom: meta.imageFrom || "none",
    lastTitleFrom: meta.titleFrom || "none",
    lastCoverTitle: String(baseItem.title || "").slice(0, 60),
    lastCoverAt: Date.now()
  });
  const message = saved.refreshed
    ? `已更新信息：${pillTitle(baseItem.title)}`
    : saved.duplicated
      ? "这篇已经收藏过啦"
      : `已收藏：${pillTitle(baseItem.title)}`;
  await showPagePills(tab.id, [message]).catch(() => {});
  // 把结果回传，好让侧边栏 / 工具栏小窗口的按钮显示正确的字样。
  return { ok: true, duplicated: !!saved.duplicated, refreshed: !!saved.refreshed, updated: !!saved.updated };
}

async function toggleTranslation(tab) {
  await ensureTranslationCss(tab.id);
  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    files: ["content-translation.js"]
  });
  if (injection[0]?.result?.ok === false) await showActionError();
}

async function showActionError() {
  await chrome.action.setBadgeText({ text: "!" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d94841" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 2200);
}

// 给全屏收藏库发送页内提示。runtime.sendMessage 能到达扩展自己的页面，
// 消息带 tabId，避免同时开着多个收藏库标签时每一页都弹一次。
async function showLibraryCommandNotice(tab, command) {
  if (!tab?.id) return false;
  const libraryUrl = chrome.runtime.getURL("library.html");
  if (!String(tab.url || "").startsWith(libraryUrl)) return false;
  const message = command === "toggle-translation"
    ? "当前是 LaterOn 收藏库，请打开需要翻译的网页后再按 Alt+2"
    : "当前是 LaterOn 收藏库，请先打开想收藏的网页，再按 Alt+1";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "SHOW_LIBRARY_NOTICE",
      tabId: tab.id,
      message
    });
    return response?.shown === true;
  } catch {
    return false;
  }
}

// 统一处理失败：记录原因（设置页可查）+ 角标提示 + 在页面上弹药丸，
// 避免出现「按了完全没反应、也不知道哪里错了」的情况。
async function reportFailure(error) {
  const message = String(error?.message || error || "未知错误");
  await recordDiag({ lastError: message, lastErrorAt: Date.now() });
  await showActionError();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && isWebUrl(tab.url)) {
      await showPagePills(tab.id, [`操作失败：${pillTitle(message)}`]);
    }
  } catch {
    // 页面不支持注入时只保留角标提示。
  }
}

// 在页面上弹「药丸」通知：显示在右上角（工具栏图标正下方）。
// messages 支持两种写法：纯文本，或 { text, kind }。
// kind="skip" 显示为灰色的次要提示；kind="move" 显示为橙色的「已搬家」提示。
// 逐条收藏时会一次弹一条，这里限制同屏最多 6 条，超出就让最早的先退场。
async function showPagePills(tabId, messages) {
  const list = (messages || [])
    .map((item) => (typeof item === "string" ? { text: item, kind: "" } : item))
    .filter((item) => item && item.text);
  if (!tabId || !list.length) return;

  const MAX_PILLS = 10;
  const shown = list.slice(0, MAX_PILLS);
  const overflow = list.length - shown.length;

  await ensureTranslationCss(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (items, extra) => {
      const hostId = "lateron-pill-stack";
      let host = document.getElementById(hostId);
      if (!host) {
        host = document.createElement("div");
        host.id = hostId;
        document.documentElement.appendChild(host);
      }
      const MAX_STACK = 6;
      const all = extra > 0 ? [...items, { text: `还有 ${extra} 篇已收藏`, kind: "" }] : [...items];
      all.forEach((item, index) => {
        const pill = document.createElement("div");
        pill.className = "lateron-pill";
        if (item.kind) pill.classList.add(`is-${item.kind}`);
        pill.textContent = item.text;
        host.appendChild(pill);
        while (host.childElementCount > MAX_STACK) host.firstElementChild.remove();
        const hide = () => {
          pill.classList.add("is-out");
          window.setTimeout(() => {
            pill.remove();
            if (!host.childElementCount) host.remove();
          }, 260);
        };
        const delay = index * 90;
        window.setTimeout(() => pill.classList.add("is-in"), 30 + delay);
        window.setTimeout(hide, 2800 + delay);
      });
    },
    args: [shown, overflow]
  });
}

// 把一条标题压缩成适合放进药丸的单行短文本。
function pillTitle(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
}

// 判断一条已有收藏的文案是不是「没意义的占位值」——空、或者只是站点通用名
// （例如在 YouTube 首页级别的页面收藏到的标题就是 "YouTube"）。
function isPlaceholderText(value, source) {
  const text = (value || "").trim();
  if (!text) return true;
  if (/^youtube$/i.test(text)) return true;
  if (source && text.toLowerCase() === String(source).trim().toLowerCase()) return true;
  // 标题被存成了网址，说明当初根本没抓到标题（页面还没渲染完等）。
  if (/^https?:\/\//i.test(text)) return true;
  // 标题被存成了域名（example.com 这种兜底值）也算没抓到。
  if (/^[a-z0-9-]+(\.[a-z]{2,}){1,2}$/i.test(text)) return true;
  // 明显的导航词 / 通用词，同样视为「没抓到标题」。
  // 这样重复收藏一次，就会自动把标题补成正确的。
  if (/^(首页|主页|登录|注册|搜索|搜索结果|全部|分类|列表|购物车|loading|untitled|无标题|error|not found|404)$/i.test(text)) return true;
  return false;
}

// 标题里混着站点名（「文章标题 - 某某网」这类）也算「不干净」，
// 允许重复收藏时用新抓到的、更干净的标题替换掉它。
// 两类都算：
//  · 整个站点名出现在标题里（某某网 / example.com）；
//  · 标题尾巴是站点名的某一段（en.wikipedia.org → wikipedia）。
function titleHasSiteNoise(title, source) {
  const text = (title || "").trim();
  const site = (source || "").trim();
  if (!text) return false;
  if (site.length >= 2 && text.toLowerCase().includes(site.toLowerCase())) return true;
  const words = site
    .toLowerCase()
    .split(/[.\s/]+/)
    .filter((word) => word.length >= 3 && word !== "www" && word !== "com");
  if (!words.length) return false;
  const tail = /[|·•\-–—_/]\s*([\p{Script=Han}A-Za-z0-9]{2,10})$/u.exec(text);
  return !!tail && words.includes(tail[1].toLowerCase());
}

// 重复收藏同一条网址时，决定要不要用「新抓到的信息」刷新旧记录。
// · 用户亲手改过的字段（titleEdited / descriptionEdited / imageEdited）一律不碰，优先级最高。
// · YouTube：元数据按视频 id 唯一确定，而且历史上很容易抓到「上一个页面」的错误信息
//   （详见提取函数里的说明），所以一律刷新，这样重新收藏一次就能把旧的错误信息修好。
// · 其它网站：只补「缺的」，不无谓改动你已经看到的内容。
// 返回值表示是否真的改动了内容。
function mergeDuplicateMetadata(existing, meta) {
  const url = meta.url || existing.url || "";
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com\//i.test(url) || /^https?:\/\/youtu\.be\//i.test(url);
  let changed = false;

  // 用户在收藏库里亲手改过的标题 / 摘要一律锁住：哪怕 YouTube 也不覆盖，
  // 否则下次重复收藏同一网址，他改好的内容会被自动抓取的结果顶掉。
  const titleLocked = existing.titleEdited === true;
  const descriptionLocked = existing.descriptionEdited === true;

  // 新标题必须是个「像样的标题」才允许替换，免得把好标题换成 example.com 这种兜底值。
  const nextTitleUsable = !!meta.title && !isPlaceholderText(meta.title, meta.source);
  const existingTitleWeak =
    isPlaceholderText(existing.title, existing.source) || titleHasSiteNoise(existing.title, existing.source);
  // 还有一种情况：新标题正好是老标题「去掉尾巴」的结果
  // （老：「富贵少爷…名场面 - 小红书」→ 新：「富贵少爷…名场面」）。
  // 这时新的一定更干净，可以放心替换。这条能覆盖那些中文站点——
  // 它们在页面上从不声明自己的名字，光靠 source 判断不出来。
  const existingTitleIsNoisier =
    nextTitleUsable &&
    typeof existing.title === "string" &&
    existing.title.length > meta.title.length &&
    existing.title.startsWith(meta.title) &&
    /^[\s|·•\-–—_/]/.test(existing.title.slice(meta.title.length));
  if (!titleLocked && nextTitleUsable && meta.title !== existing.title && (isYouTube || existingTitleWeak || existingTitleIsNoisier)) {
    existing.title = meta.title;
    changed = true;
  }
  // 用户自己上传/移除过的封面一律锁住：重复收藏时不拿自动抓取的图顶掉它。
  const imageLocked = existing.imageEdited === true;
  // 旧封面是「站点图标」（topbook 弹窗类站点的历史遗留）时也允许替换，
  // 否则重复收藏永远修不好那个错误的封面。
  if (!imageLocked && meta.image && meta.image !== existing.image && (isYouTube || !existing.image || isIconLikeImage(existing.image))) {
    existing.image = meta.image;
    changed = true;
  }
  const hasNewDescription = meta.description && meta.description !== "暂无摘要";
  const descriptionIsMissing = !existing.description || existing.description === "暂无摘要";
  if (!descriptionLocked && hasNewDescription && meta.description !== existing.description && (isYouTube || descriptionIsMissing)) {
    existing.description = meta.description;
    changed = true;
  }
  return changed;
}

// 一条收藏的信息是不是「不完整」（缺封面或摘要）。收尾时用它提醒用户哪几篇没抓全。
// 注意是看「最终存下来的状态」，而不是「这次抓取有没有成功」——
// 否则一条本来就有封面摘要的旧收藏，只是这次抓取失败，也会被误报成「没抓全」。
function isIncomplete(record) {
  return !record?.image || !record?.description || record.description === "暂无摘要";
}

// 校验一个项目 id 是否还存在，并取出它的名字。
// 用途：用户可能在浮层开着的时候把项目删了，或上次用过的项目早已被删，
// 这时要退回「待整理」，否则收藏会带上一个指向不存在项目的归属。
async function resolveProject(projectId) {
  if (!projectId) return { id: null, name: "待整理" };
  const projects = (await chrome.storage.local.get(PROJECTS_KEY))[PROJECTS_KEY] || [];
  const matched = projects.find((project) => project.id === projectId);
  return matched ? { id: matched.id, name: matched.name } : { id: null, name: "待整理" };
}

async function saveItem(item, options = {}) {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const items = result[STORAGE_KEY] || [];
  const normalizedUrl = normalizeUrl(item.url);
  const index = items.findIndex((entry) => normalizeUrl(entry.url) === normalizedUrl);

  // 已存在相同网址：视为重复收藏——不新建、不挪动顺序；
  // 但会把「缺的 / 明显过期的」信息补上（YouTube 一律刷新，见 mergeDuplicateMetadata）。
  if (index >= 0) {
    const existing = items[index];
    const refreshed = mergeDuplicateMetadata(existing, item);
    if (refreshed) await chrome.storage.local.set({ [STORAGE_KEY]: items });
    return { ok: true, item: existing, updated: true, duplicated: true, refreshed };
  }

  const normalized = {
    id: crypto.randomUUID(),
    title: item.title || item.url,
    description: item.description || "暂无摘要",
    image: item.image || "",
    favicon: item.favicon || "",
    source: item.source || safeHostname(item.url),
    projectId: null,
    url: item.url,
    savedAt: Date.now(),
    status: "unread"
  };
  items.unshift(normalized);
  await chrome.storage.local.set({ [STORAGE_KEY]: items });

  // 批量收藏（silent）时由调用方统一显示角标，避免角标反复闪动。
  if (!options.silent) {
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: "#111111" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 1600);
  }
  return { ok: true, item: normalized, updated: false, duplicated: false };
}

// ── 一键收藏所有标签 ────────────────────────────────────────
// 入口：快捷键 Alt+Shift+1 或右键菜单。
// 默认先在当前网页里弹出「选择项目」浮层，选好项目后再真正开始收藏，
// 这样收进来的文章直接归到对应项目，不用事后手动整理。
// 若在设置里关掉了「先选项目」，则直接用上次用过的项目开始收藏。
async function saveAllTabsInWindow(source = "shortcut") {
  // 每一步都记一笔：万一中途卡住或失败，去设置页就能看出停在哪一步。
  const stage = (patch) => recordDiag({ lastTrigger: source, lastStageAt: Date.now(), ...patch });

  try {
    await stage({ lastStage: "开始", lastRunAt: Date.now() });

    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targets = tabs.filter((tab) => isWebUrl(tab.url));
    await stage({ lastStage: "读取标签页", lastTabCount: targets.length });

    if (!targets.length) {
      await recordDiag({
        lastStage: "结束（没有可收藏的网页）",
        lastAdded: 0,
        lastDuplicated: 0,
        lastEnriched: 0,
        lastDegraded: 0,
        lastError: "当前窗口没有可收藏的网页",
        lastErrorAt: Date.now(),
        lastResultAt: Date.now()
      });
      await showActionError();
      return { ok: false, added: 0, duplicated: 0 };
    }

    const activeTab = tabs.find((tab) => tab.active) || targets[0];
    const settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
    const savedProject = (await chrome.storage.local.get(LAST_PROJECT_KEY))[LAST_PROJECT_KEY] || "";
    // 上次用过的项目可能已经被删掉了：先校验一次，
    // 免得拿一个不存在的 id 去收藏、或在浮层里默认选中一个已经没了的项目。
    const remembered = await resolveProject(savedProject);

    // 这一批里有多少个网页已经收藏过？
    // 用来在浮层里提前说清楚：「已收藏的会被一起搬过来」，免得用户以为重复的会被跳过、
    // 回头还得手动整理一遍。（按网址去重后统计，同一篇在多个标签页里只算一个。）
    const storedItems = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
    const knownUrls = new Set(storedItems.map((entry) => normalizeUrl(entry.url)));
    const batchUrls = new Set(targets.map((tab) => normalizeUrl(tab.url)));
    let savedCount = 0;
    for (const url of batchUrls) if (knownUrls.has(url)) savedCount += 1;

    // 用户关掉了「先选项目」：直接用上次用过的项目开始。
    if (settings.askFolderOnBatch === false) {
      await stage({ lastStage: "开始收藏（未启用项目选择）" });
      return runBatchSave({
        tabs: targets,
        source,
        notifyTabId: activeTab?.id,
        projectId: remembered.id,
        projectName: remembered.name
      });
    }

    await stage({ lastStage: "等待选择项目", lastTabCount: targets.length });
    return askFolderThenSave({ tabs: targets, source, activeTab, savedCount, remembered });
  } catch (error) {
    await recordDiag({
      lastStage: "失败",
      lastError: String(error?.message || error),
      lastErrorAt: Date.now()
    }).catch(() => {});
    await showActionError();
    return { ok: false, added: 0, duplicated: 0 };
  }
}

// 设置里「收藏单篇前先选项目」有没有打开。
// 默认开：旧设置里还没有这个字段时也先选项目；只有用户明确关掉（false）才直收「待整理」。
async function shouldAskFolderForSingle() {
  const settings = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return settings.askFolderOnSingle !== false;
}

// 把这一批标签页暂存起来，弹出「选项目」浮层，等用户选好再真正收藏。
// 单篇收藏和整窗收藏共用这一段，所以两条路径的体验完全一致：
// 都是先选项目 → 再抓取收藏 → 已收藏过的会被搬进所选项目。
async function askFolderThenSave({ tabs, source = "shortcut", activeTab = null, savedCount = 0, remembered = null }) {
  const targets = tabs || [];
  const last = remembered || (await resolveProject((await chrome.storage.local.get(LAST_PROJECT_KEY))[LAST_PROJECT_KEY] || ""));

  // 先把这一批标签页暂存起来，等用户在浮层里选好项目（或新建一个）再真正开始。
  await chrome.storage.session.set({
    [PENDING_KEY]: {
      createdAt: Date.now(),
      source,
      notifyTabId: activeTab?.id ?? null,
      projectId: last.id || "",
      savedCount,
      tabs: targets.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title || tab.url,
        favIconUrl: tab.favIconUrl || "",
        discarded: !!tab.discarded,
        status: tab.status || "",
        windowId: tab.windowId
      }))
    }
  });

  // 选择项目只允许使用网页内浮层，不再创建任何独立窗口。
  // 首次注入可能正撞上页面跳转，短暂等一下再重试一次；共享 UI 会先移除旧宿主，
  // 因此即使第一次稍后恢复，页面上最终也只会保留一个浮层。
  const pickerPayload = { tabs: targets, projectId: last.id, savedCount };
  let shown = await showPickerOverlay(activeTab, pickerPayload);
  if (!shown && activeTab?.id && isWebUrl(activeTab.url)) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    shown = await showPickerOverlay(activeTab, pickerPayload);
  }
  if (!shown) {
    const message = isWebUrl(activeTab?.url)
      ? "没能打开项目选择框，请等页面加载完成后再试"
      : "当前页面不支持网页内选择框，请切到普通网页后再试";
    await recordDiag({
      lastStage: "网页内选择框未打开",
      lastStageAt: Date.now(),
      lastError: message,
      lastErrorAt: Date.now()
    });
    // 能注入提示时沿用收藏通知药丸；连提示也注入不了时才用工具栏角标示警。
    const explained = activeTab?.id && isWebUrl(activeTab.url)
      ? await withTimeout(
          showPagePills(activeTab.id, [{ text: message, kind: "skip" }]).then(() => true),
          900,
          false
        )
      : false;
    if (!explained) await showActionError();
    return { ok: false, pending: false, tabCount: targets.length, error: message };
  }
  return { ok: true, pending: true, tabCount: targets.length };
}

// 真正执行「一篇一篇收藏」。
// 处理方式：**一篇一篇来**（顺序执行），而不是同时开好几个。原因有三：
//  1. 同时抓取多个页面会互相抢资源，有的页面还没渲染完就被读取，封面/摘要就会抓不到；
//  2. 顺序处理可以「完成一篇就立刻通知一篇」，进度马上看得见，感知上快得多；
//  3. 某一篇卡住（未加载完、被冻结）只影响它自己，不会拖住后面的标签。
// 与单篇收藏一样抓取标题 / 摘要 / 封面 / 图标；不抓取正文；已收藏过的网址自动去重。
async function runBatchSave({ tabs, source = "shortcut", notifyTabId = null, projectId = null, projectName = "" }) {
  // 每一步都记一笔：万一中途卡住或失败，去设置页就能看出停在哪一步。
  const stage = (patch) => recordDiag({ lastTrigger: source, lastStageAt: Date.now(), ...patch });
  // 通知统一发到「按下快捷键那一刻的活动标签页」——因为选择项目的小窗口会抢走焦点，
  // 此时「当前活动标签页」已经变成那个弹窗了。
  const notify = (text, kind = "") => notifyTab(notifyTabId, text, kind);
  // 这一批要存进哪个项目（用于提示文案）。
  const folderLabel = projectName || "待整理";
  // 只收一篇时（设置里打开了「收藏单篇前先选项目」）提示从简：
  // 跟以前「一键收藏」一样只弹一条结果，不再多出「开始收藏」「全部完成」两条。
  const single = (tabs || []).length === 1;

  try {
    const targets = tabs || [];
    if (!targets.length) {
      await recordDiag({
        lastStage: "结束（没有可收藏的网页）",
        lastError: "这一批里没有可收藏的网页",
        lastErrorAt: Date.now(),
        lastResultAt: Date.now()
      });
      await showActionError();
      return { ok: false, added: 0, duplicated: 0 };
    }

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const items = stored[STORAGE_KEY] || [];
    // 网址 → 已有记录（按「引用」保存，回填封面/摘要时直接改这条记录即可）。
    const byUrl = new Map();
    for (const entry of items) {
      const key = normalizeUrl(entry.url);
      if (!byUrl.has(key)) byUrl.set(key, entry);
    }

    // savedAt 用「起始时间 - 序号」，保证收藏库里仍按标签页顺序排列。
    // cursor 指向「下一条新收藏」要插入的位置：按顺序插入，数组原始顺序也与标签页一致。
    const base = Date.now();
    let cursor = 0;
    let added = 0;
    let duplicated = 0;
    let movedCount = 0;
    let enriched = 0;
    let degraded = 0;

    // 收多篇时才播报「开始」；收一篇时静悄悄抓，最后只弹一条结果提示。
    if (!single) await notify(`开始收藏 ${targets.length} 个标签页 → ${folderLabel}`);

    for (let i = 0; i < targets.length; i += 1) {
      const tab = targets[i];
      await stage({
        lastStage: "逐个收藏中",
        lastProgress: `${i + 1}/${targets.length}`,
        lastAdded: added,
        lastDuplicated: duplicated
      });

      // ① 抓取这一篇的标题 / 摘要 / 封面 / 图标（最多等 3 秒）。
      const meta = await extractTabMetadata(tab);

      // 单篇收藏时记一笔封面来源，设置页的「最近一次抓取来源」才不会断更。
      if (single) {
        await recordDiag({
          lastCoverFrom: meta.imageFrom || "none",
          lastTitleFrom: meta.titleFrom || "none",
          lastCoverTitle: String(meta.title || "").slice(0, 60),
          lastCoverAt: Date.now()
        });
      }

      const key = normalizeUrl(meta.url);
      const existing = byUrl.get(key);

      if (existing) {
        duplicated += 1;
        // 已收藏过的网址要做两件事：
        //  ① 以前收藏时没抓到封面 / 摘要的（比如当时页面还没加载完），这次抓到了就补上；
        //     YouTube 则一律刷新，这样重新收藏一次就能修好旧记录里错误的信息。
        //  ② 把它「搬进这次选中的项目」——用户既然为这一批选了项目，
        //     就是希望这批链接都归在那里，而不是留下几条散落在原来的位置。
        const refreshed = mergeDuplicateMetadata(existing, meta);
        const target = projectId || null;
        const moved = (existing.projectId || null) !== target;
        if (moved) existing.projectId = target;
        if (isIncomplete(existing)) degraded += 1;

        if (refreshed || moved) {
          await chrome.storage.local.set({ [STORAGE_KEY]: items });
          if (refreshed) enriched += 1;
          if (moved) movedCount += 1;
          const title = pillTitle(existing.title || meta.title);
          const text = moved
            ? (refreshed ? `已移到「${folderLabel}」并更新信息：${title}` : `已移到「${folderLabel}」：${title}`)
            : `已更新信息：${title}`;
          await notify(text, moved ? "move" : "");
        } else {
          await notify(`已收藏过：${pillTitle(meta.title)}`, "skip");
        }
        continue;
      }

      // ② 立刻写入收藏（一篇一写），这样收藏库那边也能一篇篇地冒出来。
      const record = {
        id: crypto.randomUUID(),
        title: meta.title || meta.url,
        description: meta.description || "暂无摘要",
        image: meta.image || "",
        favicon: meta.favicon || "",
        source: meta.source || safeHostname(meta.url),
        projectId,
        url: meta.url,
        savedAt: base - i,
        status: "unread"
      };
      items.splice(cursor, 0, record);
      cursor += 1;
      byUrl.set(key, record);
      await chrome.storage.local.set({ [STORAGE_KEY]: items });

      added += 1;
      if (isIncomplete(record)) degraded += 1;
      // ③ 成功一篇就通知一篇，并顺手更新角标数字（切到别的标签页也看得到进度）。
      await chrome.action.setBadgeText({ text: `+${added}` });
      await chrome.action.setBadgeBackgroundColor({ color: "#2f9e44" });
      await notify(`已收藏：${pillTitle(record.title)}`);
    }

    // 收尾：角标停一会儿再清掉，页面上再补一条总结。
    await chrome.action.setBadgeText({ text: added > 0 ? `+${added}` : "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: added > 0 ? "#2f9e44" : "#111111" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 2600);

    // 收尾总结：把「新收进来的」和「已收藏过、这次搬了家 / 本来就在这儿」的都说清楚。
    const summary = (() => {
      if (added > 0) {
        const parts = [`新增 ${added} 篇`];
        if (movedCount > 0) parts.push(`${movedCount} 篇已收藏的移入「${folderLabel}」`);
        const stayed = duplicated - movedCount;
        if (stayed > 0) parts.push(`${stayed} 篇本来就在「${folderLabel}」`);
        return `全部完成：${parts.join("，")}`;
      }
      if (movedCount > 0) return `全部完成：把 ${movedCount} 篇已收藏的移入「${folderLabel}」`;
      if (enriched > 0) return `全部完成：更新了 ${enriched} 篇的信息`;
      return "这些网页都收藏过啦";
    })();
    // 收一篇时结果已经在上面那条提示里说清楚了，不再重复播报总结。
    if (!single) {
      await notify(summary);
      if (degraded > 0) {
        await notify(`有 ${degraded} 篇没有封面或摘要`, "skip");
      }
    }

    await stage({
      lastStage: "完成",
      lastAdded: added,
      lastDuplicated: duplicated,
      lastMoved: movedCount,
      lastEnriched: enriched,
      lastDegraded: degraded,
      lastError: "",
      lastResultAt: Date.now()
    });
    return { ok: true, added, duplicated, moved: movedCount, enriched, degraded };
  } catch (error) {
    // 任何一步抛错都要留下痕迹，避免再次出现「按了没反应、也不知道为什么」。
    await recordDiag({
      lastStage: "失败",
      lastError: String(error?.message || error),
      lastErrorAt: Date.now()
    }).catch(() => {});
    await showActionError();
    return { ok: false, added: 0, duplicated: 0 };
  }
}

// ── 网页内的「选择项目」浮层 ──────────────────────────────
// 在用户当前所在的网页里直接弹出一个居中浮层（不新开窗口），选好项目再开始收藏。
// 内容全部放在 Shadow DOM 里，页面自身的 CSS 影响不到它，所以视觉可以和扩展界面
// 完全保持一致（同一套圆角、阴影、渐变按钮、深色模式）。
// 页面正在跳转、冻结或渲染进程短暂无响应时，executeScript 可能一直不返回。
// 选项目浮层不能跟着无限等待：到点就交回 false，让调用方重试网页内浮层。
const PICKER_INJECT_TIMEOUT_MS = 1600;
const PICKER_VERIFY_TIMEOUT_MS = 700;

async function showPickerOverlay(tab, payload) {
  if (!tab?.id || !isWebUrl(tab.url)) return false;
  try {
    const stored = await chrome.storage.local.get([PROJECTS_KEY, STORAGE_KEY, SETTINGS_KEY, COVERS_KEY]);
    const projects = stored[PROJECTS_KEY] || [];
    const items = stored[STORAGE_KEY] || [];
    const settings = stored[SETTINGS_KEY] || {};
    const covers = stored[COVERS_KEY] || {};

    // 每个项目下已有多少篇：给用户一个参考。
    const counts = new Map();
    let unfiled = 0;
    for (const item of items) {
      if (item.projectId) counts.set(item.projectId, (counts.get(item.projectId) || 0) + 1);
      else unfiled += 1;
    }
    // 项目的封面：优先用用户「编辑项目」时上传的自定义封面（data URL，离线也能显示），
    // 没有才取该项目里第一篇「有图」的收藏。浮层里每行左侧就显示这张缩略图——
    // 和全屏左侧栏项目行是同一套逻辑（library.js 的 projectCoverFor），两处永远一致。
    const coverFor = (projectId) => {
      const project = projects.find((p) => p.id === projectId);
      if (project?.cover) return project.cover;
      const inProject = items.filter((it) => (it.projectId || "") === projectId);
      for (const it of inProject) {
        // 条目上存的是 local://<id> 指针，真正的图在 covers 里；老数据可能还是 data: / 远程 URL。
        if (it.id && covers[it.id]) return covers[it.id];
        const image = typeof it.image === "string" ? it.image : "";
        if (image.startsWith("local://")) {
          const data = covers[image.slice(8)];
          if (data) return data;
        } else if (image) {
          return image;
        }
      }
      return null;
    };
    const folders = [
      { id: "", name: "待整理", count: unfiled, cover: coverFor("") },
      ...projects.map((project) => ({ id: project.id, name: project.name, count: counts.get(project.id) || 0, cover: coverFor(project.id) }))
    ];

    // 默认选中上次用过的项目；它如果已被删掉就退回「待整理」。
    let selected = payload?.projectId || "";
    if (selected && !folders.some((folder) => folder.id === selected)) selected = "";

    const pickerPayload = {
      theme: settings.theme || "light",
      selected,
      savedCount: payload?.savedCount || 0,
      folders,
      pages: (payload?.tabs || []).map((entry) => ({ title: entry.title || entry.url, url: entry.url }))
    };
    // files 注入不能直接带 args：先把很小的配置放进一个一次性 JSON 节点，
    // 再执行真正的 UI 文件。用 DOM 传递比依赖两次注入共享全局变量更稳。
    const payloadInjected = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (value) => {
          const id = "lateron-picker-payload-data";
          document.getElementById(id)?.remove();
          const node = document.createElement("script");
          node.id = id;
          node.type = "application/json";
          node.textContent = JSON.stringify(value);
          document.documentElement.appendChild(node);
        },
        args: [pickerPayload]
      }),
      PICKER_INJECT_TIMEOUT_MS,
      null
    );
    if (!Array.isArray(payloadInjected)) return false;

    const uiInjected = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // picker-ui.js 先注入（提供 window.openFolderPicker），content-folder-picker.js 再调用它。
        files: ["picker-ui.js", "content-folder-picker.js"]
      }),
      PICKER_INJECT_TIMEOUT_MS,
      null
    );
    if (!Array.isArray(uiInjected)) return false;

    // executeScript 成功只代表文件执行完，不代表浮层一定留在页面上。
    // 页面恰好导航、DOM 被站点重建、共享 UI 初始化失败时，主动确认宿主确实存在；
    // 看不到就返回 false，由调用方再尝试一次同一种网页内浮层。
    const verified = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!document.getElementById("lateron-folder-picker")?.shadowRoot
      }),
      PICKER_VERIFY_TIMEOUT_MS,
      null
    );
    return Array.isArray(verified) && verified.some((entry) => entry?.result === true);
  } catch {
    // 页面受保护 / 权限不足 / 标签已关闭：返回失败，不创建其它形态的选择窗口。
    return false;
  }
}

// 新建项目（浮层和收藏库共用同一份数据，形状保持一致）。
async function createProject(name) {
  const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 28);
  if (!clean) return { ok: false, error: "项目名称不能为空" };

  const stored = await chrome.storage.local.get(PROJECTS_KEY);
  const projects = stored[PROJECTS_KEY] || [];
  // 同名项目不重复创建，直接选用已有那个，避免列表里出现两个「工作」。
  const existing = projects.find((project) => project.name === clean);
  if (existing) return { ok: true, project: existing, existed: true };

  const project = { id: crypto.randomUUID(), name: clean, createdAt: Date.now() };
  await chrome.storage.local.set({ [PROJECTS_KEY]: [...projects, project] });
  return { ok: true, project, existed: false };
}

// 体积较大的网页执行代码已移到 content-folder-picker.js，仅在实际使用时注入目标网页。

// 取出「等待选择项目」的那一批标签页，并记录用户选的项目。
// 返回 null 表示没有待处理的批次（重复点击 / 已过期）。
async function claimPendingBatch(projectId) {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const pending = stored[PENDING_KEY];
  if (!pending || !pending.tabs?.length) return null;
  if (Date.now() - (pending.createdAt || 0) > 10 * 60 * 1000) {
    await chrome.storage.session.remove(PENDING_KEY);
    return null;
  }
  await chrome.storage.session.remove(PENDING_KEY);

  // 用户选的项目在这段时间里可能被删掉了（浮层最长会停留 10 分钟），
  // 这里再校验一次：不存在就退回「待整理」，不给收藏留下悬空的归属。
  const chosen = await resolveProject(projectId);

  if (chosen.id) await chrome.storage.local.set({ [LAST_PROJECT_KEY]: chosen.id });
  else await chrome.storage.local.remove(LAST_PROJECT_KEY);

  return {
    tabs: pending.tabs,
    source: pending.source || "shortcut",
    notifyTabId: pending.notifyTabId ?? null,
    projectId: chosen.id,
    projectName: chosen.name
  };
}

async function cancelPendingBatch() {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const had = !!stored[PENDING_KEY];
  await chrome.storage.session.remove(PENDING_KEY);
  if (had) await recordDiag({ lastStage: "已取消（没有收藏任何页面）", lastResultAt: Date.now() });
  return { ok: true, cancelled: had };
}

// 确认收藏：先回执（好让选项目的小窗口立刻关闭），再在后台继续一篇一篇地收藏。
async function confirmBatchSave(projectId, onAccepted) {
  const claimed = await claimPendingBatch(projectId);
  if (!claimed) return { ok: false, error: "这一批标签页已经处理过了" };
  if (typeof onAccepted === "function") onAccepted({ ok: true, tabCount: claimed.tabs.length });
  return runBatchSave(claimed);
}

// 把通知发到指定标签页；标签已关闭或不是普通网页时，退回「当前活动标签页」。
function notifyTab(tabId, text, kind = "") {
  if (tabId == null) return notifyOnActiveTab(text, kind);
  return chrome.tabs
    .get(tabId)
    .then((tab) => (tab?.id != null && isWebUrl(tab.url) ? showPagePills(tab.id, [{ text, kind }]) : notifyOnActiveTab(text, kind)))
    .catch(() => notifyOnActiveTab(text, kind));
}

// 在当前窗口的「活动标签页」上弹一条药丸通知。
// 若当前停在 Chrome 内部页面（新标签页 / 设置页等）无法注入，则只保留角标提示。
async function notifyOnActiveTab(text, kind = "") {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && isWebUrl(tab.url)) await showPagePills(tab.id, [{ text, kind }]);
  } catch {
    // 内部页面不允许注入，忽略即可。
  }
}

// 给 Promise 加超时：到点就返回兜底值，绝不让整个流程无限期卡住。
// executeScript 遇到卡死的页面（未加载完、被冻结、渲染进程无响应）可能长时间不返回，
// 批量场景下只要有标签卡住，整个「一键收藏」就会石沉大海（用户看到的就是「没反应」）。
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
    promise.then(
      (value) => finish(value),
      () => finish(fallback)
    );
  });
}

// 读取单个标签页的标题 / 摘要 / 封面 / 图标。
// 顺序处理时每个标签最多等 3 秒（比原来并发时给得更宽松，尽量把封面/摘要抓全）；
// 超时就退回浏览器已有的信息（标题 + 图标），绝不拖住后面的标签。
const EXTRACT_TIMEOUT_MS = 3000;

// 供弹窗 / 侧栏调用：读取指定标签页的标题 / 摘要 / 封面 / 图标。
// 失败时返回 ok:false，调用方自己退回「标签页基础信息」。
async function extractTabMetadataById(tabId) {
  if (!tabId) return { ok: false, error: "缺少标签页" };
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (!tab) return { ok: false, error: "找不到这个标签页" };
  if (!isWebUrl(tab.url)) return { ok: false, error: "这个页面无法收藏，请打开一个普通网页后重试。" };
  const metadata = await extractTabMetadata(tab);
  return { ok: true, metadata: { ...metadata, url: tab.url } };
}

// ── 抖音：滑动切换视频后，先等 DOM「跟上」当前网址再抓 ──────────────
// 抖音是单页应用。实测站内切换视频时各信号的更新时间线（无头 Chrome，逐 100ms 采样）：
//   切换前  网址=76595  面板=76595  标题=第181集  封面=旧
//   +102ms  网址=96420  面板=76595 标题=第181集  封面=旧   ← 网址已换，面板还是上一条
//   +318ms  网址=96420  面板=96420 标题=第182集  封面=新   ← 全部对齐
// 也就是说「只有网址是瞬时正确的」，标题面板与封面滞后 0.15~0.3 秒（网络慢时更久）。
// 用户滑到下一条视频后立刻按快捷键，就会把上一条的标题和封面存进去——
// 这正是「刷新一下页面就好了」的原因（刷新时网址已指向新视频，重渲染后就对了）。
// 所以对抖音先等面板与网址对齐，最多等 1.5 秒；等不到就尽力而为，绝不无限期拖住。
const DOUYIN_SETTLE_MS = 1500;
const DOUYIN_POLL_MS = 100;

function isDouyinUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host);
  } catch {
    return false;
  }
}

// 从网址里取当前视频 id。详情页是 /video/<id> 或 /note/<id>；
// 首页推荐流用 modal_id 参数承载「正在看哪一条」。
// 先验域名：否则任何网站的 /video/<数字> 都会被当成抖音视频 id（那样很危险）。
function douyinVideoIdFromUrl(url) {
  if (!isDouyinUrl(url)) return "";
  const text = String(url || "");
  const matched =
    /\/video\/(\d{10,})/.exec(text) ||
    /\/note\/(\d{10,})/.exec(text) ||
    /[?&]modal_id=(\d{10,})/.exec(text) ||
    /[?&]vid=(\d{10,})/.exec(text);
  return matched ? matched[1] : "";
}

// 注入到页面里执行（必须自包含）：只读两个 id，判断「标题面板是否已经切到当前这条视频」。
// 面板上的 data-e2e-aweme-id 就是它对应的视频 id，拿它跟「网址里的 id / lark 元数据里的 id」
// 一比，就知道画面上的标题到底属于哪一条。
function probeDouyinFreshness() {
  const idOf = (value) => (String(value || "").match(/(\d{10,})/) || [])[1] || "";
  const panel = document.querySelector('[data-e2e="detail-video-info"]');
  const iframe = document.querySelector('meta[name="lark:url:video_iframe_url"]');
  return {
    urlId:
      (/\/video\/(\d{10,})/.exec(location.href) || [])[1] ||
      (/\/note\/(\d{10,})/.exec(location.href) || [])[1] ||
      (/[?&]modal_id=(\d{10,})/.exec(location.href) || [])[1] ||
      "",
    panelId: panel ? panel.getAttribute("data-e2e-aweme-id") || "" : "",
    larkId: iframe ? idOf(iframe.getAttribute("content")) : ""
  };
}

// 等「标题面板」切到当前网址所指向的那条视频。deadline 由调用方给，
// 这样「等待」和「等完再复核」共用同一份时间预算，不会叠加成好几秒。
async function settleDouyinDom(tab, deadline = Date.now() + DOUYIN_SETTLE_MS) {
  if (!isDouyinUrl(tab?.url)) return;
  if (!tab?.id || tab.discarded || tab.status === "unloaded") return;

  const urlId = douyinVideoIdFromUrl(tab.url);

  for (;;) {
    let probe;
    try {
      const out = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probeDouyinFreshness }),
        900,
        null
      );
      probe = out?.[0]?.result;
    } catch {
      return; // 注入失败（受保护页面等）就直接放弃，交给后面的兜底逻辑。
    }
    // 面板没有 id 属性（或页面上根本没有面板）→ 无法校验，不浪费时间。
    if (!probe || !probe.panelId) return;

    // 网址里的 id 最权威；首页推荐流没有 id 时用 lark 元数据里的 id 兜底。
    const expected = urlId || probe.larkId;
    if (!expected || probe.panelId === expected) return; // 已对齐 → DOM 是新鲜的
    if (Date.now() >= deadline) return; // 等不到就尽力而为
    await new Promise((resolve) => setTimeout(resolve, DOUYIN_POLL_MS));
  }
}

// 一眼就能看出是「站点图标」而不是内容封面的图片地址。
// 用于两处：① 触发服务端兜底（见 refetchMetaFromServer）；② 允许重复收藏时
// 用真正的封面把存成图标的旧封面替换掉。
function isIconLikeImage(url) {
  if (!url) return false;
  try {
    const file = new URL(url).pathname.split("/").pop().toLowerCase();
    return /^(favicon|apple-touch-icon|icon|logo)[.\-_@]/.test(file) || /^(favicon|icon|logo)\./.test(file);
  } catch {
    return false;
  }
}

// ── 服务端 meta 兜底 ──────────────────────────────────────────────
// 场景（topbook.cc 实测）：这类站点点开文章是「弹窗」，网址靠 pushState 变化，
// head 里的 og 标签根本不会更新——页面里能看到的还是列表页那一套
// （og:image 是站点 icon、og:title 是首页标题）。但直接向服务器请求「当前网址」，
// 返回的 HTML 里却带着这篇内容正确的 og 标签（SSR 渲染）。
// 所以当「页面里抓到的明显是站点通用值」时，由 background 重新请求一次网址补救。
const SERVER_META_TIMEOUT_MS = 8000;

async function refetchMetaFromServer(url) {
  if (!/^https?:\/\//i.test(url || "")) return null;
  try {
    const response = await withTimeout(fetch(url, { credentials: "omit" }), SERVER_META_TIMEOUT_MS, null);
    if (!response || !response.ok) return null;
    if (!/text\/html/i.test(response.headers.get("content-type") || "")) return null;
    // og 标签都在文档头部，前 200KB 足够。
    const html = (await withTimeout(response.text(), SERVER_META_TIMEOUT_MS, "")) || "";
    const head = html.slice(0, 200000);

    const decode = (text) =>
      (text || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .trim();

    // og 标签的属性顺序不固定（content 可能写在 property 前面），两种写法都试。
    const metaTag = (name) => {
      const forward = new RegExp(
        `<meta[^>]+(?:property|name)=["']${name}["'][^>]*?content=["']([^"']*)["']`,
        "i"
      ).exec(head);
      const reversed = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${name}["']`,
        "i"
      ).exec(head);
      return decode(forward?.[1] || reversed?.[1]);
    };
    const pageTitle = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]);

    // 相对地址（/img/cover.jpg）补全成绝对地址。
    const absolute = (value) => {
      if (!value) return "";
      try {
        return new URL(value, url).href;
      } catch {
        return value;
      }
    };

    return {
      title: metaTag("og:title") || metaTag("twitter:title") || pageTitle,
      description: metaTag("og:description") || metaTag("twitter:description") || metaTag("description"),
      image: absolute(
        metaTag("og:image") || metaTag("og:image:url") || metaTag("og:image:secure_url") || metaTag("twitter:image")
      )
    };
  } catch {
    return null;
  }
}

// 给「明显是站点通用值」的抓取结果做服务端兜底（说明见 refetchMetaFromServer）：
// 标题是标签页/文档标题兜底、或标题里混着站点名（首页 og:title 停在列表页的痕迹）、
// 或封面缺失/是站点图标时，重新请求一次网址，用服务器 HTML 里的 og 标签补齐。
// 原地修改并返回 result。
async function applyServerMetaRescue(result) {
  const titleIsWeak =
    ["tab", "page-title", "none", "page", "meta-title"].includes(result.titleFrom) ||
    (result.titleFrom !== "dom-headline" && titleHasSiteNoise(result.title, result.source));
  const imageIsWeak = !result.image || isIconLikeImage(result.image);
  if (!titleIsWeak && !imageIsWeak) return result;

  const server = await refetchMetaFromServer(result.url);
  if (server) {
    const serverTitleUsable =
      server.title &&
      server.title !== result.title &&
      server.title.toLowerCase() !== String(result.source || "").toLowerCase();
    if (titleIsWeak && serverTitleUsable) {
      result.title = server.title;
      result.titleFrom = "server";
    }
    if (imageIsWeak && server.image && !isIconLikeImage(server.image)) {
      result.image = server.image;
      result.imageFrom = "server";
    }
    if (result.description === "暂无摘要" && server.description) {
      result.description = server.description;
    }
  }
  return result;
}

async function extractTabMetadata(tab) {
  const fallback = {
    title: tab.title || tab.url,
    titleFrom: "tab",
    description: "暂无摘要",
    image: "",
    imageFrom: "none",
    favicon: tab.favIconUrl || "",
    source: safeHostname(tab.url),
    url: tab.url
  };

  // 休眠（内存被回收）或从未加载过的标签，注入脚本注定要等到超时，
  // 这种情况直接用浏览器已有的标题和图标，省下几秒白等。
  // 就算注入失败，服务端兜底也还能补救（弹窗类站点的标签页标题同样是错的）。
  if (tab.discarded || tab.status === "unloaded") return applyServerMetaRescue(fallback);

  // 抖音滑动切换视频后，标题面板与封面会滞后于网址；先等它对齐，否则会抓到上一条视频。
  // 等待 + 事后复核共用同一个截止时间，所以最多只耽搁 DOUYIN_SETTLE_MS。
  const expectedId = isDouyinUrl(tab.url) ? douyinVideoIdFromUrl(tab.url) : "";
  const deadline = Date.now() + DOUYIN_SETTLE_MS;
  if (isDouyinUrl(tab.url)) await settleDouyinDom(tab, deadline);

  for (;;) {
    const data = await readTabMetadata(tab);
    if (!data) return applyServerMetaRescue(fallback);

    // 复核：提取脚本会回报它实际读到的视频 id（面板上的那个）。
    // 跟网址一对，就知道读到的标题/封面是不是这条视频的。对不上就趁剩下的时间再读一次。
    if (expectedId && data.videoId && data.videoId !== expectedId && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DOUYIN_POLL_MS));
      continue;
    }

    const result = {
      title: data.title || fallback.title,
      titleFrom: data.title ? data.titleFrom || "page" : "tab",
      description: data.description || fallback.description,
      image: data.image || "",
      imageFrom: data.imageFrom || "none",
      favicon: data.favicon || fallback.favicon,
      source: data.source || fallback.source,
      url: tab.url
    };
    return applyServerMetaRescue(result);
  }
}

// 往页面注入一次提取脚本，拿回原始结果（注入失败或超时都返回 null）。
async function readTabMetadata(tab) {
  try {
    const injection = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-metadata.js"]
      }),
      EXTRACT_TIMEOUT_MS,
      null
    );
    return injection?.[0]?.result || null;
  } catch {
    return null;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const keep = [...parsed.searchParams.entries()]
      .filter(([key]) => !/^(utm_|fbclid|gclid|mc_|ref|spm|igshid)/i.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    const search = keep.length
      ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    return `${parsed.protocol}//${host}${path}${search}`;
  } catch {
    return (url || "").trim().toLowerCase();
  }
}

async function ensureLegacyCleanup() {
  const flagKey = "laterOnCleanedLegacyContent";
  const stored = await chrome.storage.local.get(flagKey);
  if (stored[flagKey]) return;
  await cleanupLegacyContent();
  await chrome.storage.local.set({ [flagKey]: true });
}

// 一次性迁移清理：1.14.0 起不再保存网页正文，把旧版本可能残留的
// contentHtml / wordCount / byline 字段从已有收藏上移除，释放本地空间。
async function cleanupLegacyContent() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const items = result[STORAGE_KEY] || [];
  let changed = false;
  const cleaned = items.map((item) => {
    if (!("contentHtml" in item) && !("wordCount" in item) && !("byline" in item)) return item;
    const { contentHtml: _contentHtml, wordCount: _wordCount, byline: _byline, ...rest } = item;
    changed = true;
    return rest;
  });
  if (changed) await chrome.storage.local.set({ [STORAGE_KEY]: cleaned });
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "网页";
  }
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

async function openLibrary() {
  const url = chrome.runtime.getURL("library.html");
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

// 在网页里提取标题 / 摘要 / 封面 / 图标（会被注入到页面执行，必须自包含）。
// ⚠️ 性能红线：读 naturalWidth/Height 会触发布局重排，图片多的页面（信息流、图库）
// 若遍历全部图片会把主线程卡到几十秒，进而把整个批量收藏拖死。
// 所以这里一律「限量扫描」：图片最多看前 80 张，段落最多看前 200 个，够用就停。
//
// ⚠️ 单页应用（SPA）陷阱 —— 以 YouTube 为例（已实测确认）：
// 体积较大的网页执行代码已移到 content-metadata.js，仅在实际使用时注入目标网页。

// 体积较大的网页执行代码已移到 content-translation.js，仅在实际使用时注入目标网页。
