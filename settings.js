const settings = window.LaterOnSettings;
// 翻译助手：设置页的动态文字（拼出来的句子、对话框、诊断行）统一走 i18n 词典。
// 兜底：个别环境（如测试）没加载 i18n.js 时，直接返回词条 key，不让页面崩掉。
const t = (...args) => (window.LaterOnI18n ? window.LaterOnI18n.t(...args) : String(args[0] ?? ""));
// 当前是不是英文界面（影响标点全角/半角和日期格式这类细节）。
const isEn = () => document.documentElement.lang === "en";

// 「已读收藏自动清除」的天数：最短 30 天、最长 180 天，默认 30 天。
// 用户手打的数字可能是 5 或 999，这里统一夹回合法区间再存。
const MIN_CLEAN_DAYS = 30;
const MAX_CLEAN_DAYS = 180;
function clampDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) return MIN_CLEAN_DAYS;
  return Math.min(MAX_CLEAN_DAYS, Math.max(MIN_CLEAN_DAYS, Math.round(days)));
}

async function init() {
  await window.LaterOnI18n?.getLanguage();
  window.LaterOnI18n?.applyStatic();
  // 浏览器标签页的标题也跟着语言走（HTML 里的 <title> 只是中文默认值）。
  document.title = `LaterOn · ${t("settings")}`;
  const current = await settings.get();

  // 还原控件当前值
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const value = current[el.dataset.setting];
    if (el.type === "checkbox") el.checked = !!value;
    else if (el.type === "number") el.value = clampDays(value);
    else if (el.tagName === "SELECT") el.value = value;
    else if (el.classList.contains("segmented")) {
      el.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
    }
  });

  // 开关 / 下拉：改动即保存
  document.querySelectorAll("[data-setting]").forEach((el) => {
    if (el.classList.contains("segmented")) return;
    const handler = () => {
      if (el.type === "number") {
        // 天数输入：非数字或超出 30–180 就夹回合法范围，并把框里的数改回夹过的值。
        const clamped = clampDays(el.value);
        el.value = clamped;
        settings.set({ [el.dataset.setting]: clamped });
        return;
      }
      const value = el.type === "checkbox" ? el.checked : el.value;
      settings.set({ [el.dataset.setting]: value });
    };
    el.addEventListener("change", handler);
  });

  // 分段按钮（主题 / 字号）
  document.querySelectorAll(".segmented").forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        seg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        button.classList.add("active");
        await settings.set({ [key]: button.dataset.value });
        if (key === "language") {
          await window.LaterOnI18n?.setLanguage(button.dataset.value);
          window.setTimeout(() => window.location.reload(), 0);
        }
      });
    });
  });

  // 快捷键：展示当前绑定
  try {
    const commands = await chrome.commands.getAll();
    const save = commands.find((c) => c.name === "quick-save");
    const translate = commands.find((c) => c.name === "toggle-translation");
    const saveAll = commands.find((c) => c.name === "save-all-tabs");
    document.querySelector("#cmdSave").textContent = save?.shortcut ? t("shortcutDefault", { shortcut: save.shortcut, def: "Alt+1" }) : t("shortcutNotSet", { def: "Alt+1" });
    document.querySelector("#cmdTranslate").textContent = translate?.shortcut ? t("shortcutDefault", { shortcut: translate.shortcut, def: "Alt+2" }) : t("shortcutNotSet", { def: "Alt+2" });
    document.querySelector("#cmdSaveAll").textContent = saveAll?.shortcut ? t("shortcutDefault", { shortcut: saveAll.shortcut, def: "Alt+Shift+1" }) : t("shortcutNotSet", { def: "Alt+Shift+1" });
  } catch {
    document.querySelector("#cmdSave").textContent = t("shortcutNotSet", { def: "Alt+1" });
    document.querySelector("#cmdTranslate").textContent = t("shortcutNotSet", { def: "Alt+2" });
    document.querySelector("#cmdSaveAll").textContent = t("shortcutNotSet", { def: "Alt+Shift+1" });
  }

  document.querySelector("#openShortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {
      LaterOnDialog.alert({
        title: t("openShortcutsFailTitle"),
        message: t("openShortcutsFailMsg")
      });
    });
  });

  document.querySelector("#replayOnboarding")?.addEventListener("click", async () => {
    const url = `${chrome.runtime.getURL("library.html")}?guide=1`;
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
    else window.location.href = url;
  });

  // 快捷键自检：实时刷新「最近一次触发」，方便判断按键有没有到达扩展。
  await renderDiag();
  setInterval(() => { renderDiag().catch(() => {}); }, 2000);

  // 返回：回到全屏收藏墙。
  // 优先走「真正的后退」——从收藏墙切过来的话，退回上一步就是刚才那面墙（滚动位置也保留）。
  // 如果设置页是单独打开的（比如从扩展的选项进来），没有上一步可退，就直接打开全屏页。
  document.querySelector("#back").addEventListener("click", (event) => {
    event.preventDefault();
    const libraryUrl = chrome.runtime.getURL("library.html");
    const goToLibrary = () => { window.location.href = libraryUrl; };
    if (window.history.length > 1) {
      window.history.back();
      // 页面真跳走了，这个定时器会跟着页面一起消失；它还能跑说明没退成，兜底跳过去。
      window.setTimeout(goToLibrary, 300);
      return;
    }
    goToLibrary();
  });

  // 点左上角的品牌标识 = 回全屏首页。
  // 和右边那个「返回收藏」刻意做得不一样：返回是「退回上一步」（可能是某个项目、某个滚动位置），
  // 品牌标识是「回首页」——所以先把「当前项目」复位成全部项目再跳过去，
  // 无论刚才钻在哪个项目里，过去都是首页那一屏。
  document.querySelector("#settingsHome").addEventListener("click", async (event) => {
    event.preventDefault();
    const url = chrome.runtime.getURL("library.html");
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      chrome.tabs.create({ url });
      return;
    }
    try {
      await chrome.storage.local.set({ laterOnActiveProject: "all" });
    } catch {
      // 存不下也得让人回得去：跳过去就是了，大不了还是上次那个项目。
    }
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.update(tab.id, { url });
    else window.location.href = url;
  });

  // 导出收藏
  document.querySelector("#exportBtn").addEventListener("click", async () => {
    const data = await chrome.storage.local.get(["laterOnItems", "laterOnProjects", "laterOnCovers", "laterOnOrder"]);
    const payload = {
      type: "lateron-backup",
      version: 2,
      exportedAt: Date.now(),
      items: data.laterOnItems || [],
      projects: data.laterOnProjects || [],
      // 自定义封面本体不在 items 里；不导出它，恢复后 local:// 指针会全部变成坏图。
      covers: data.laterOnCovers || {},
      order: data.laterOnOrder || {}
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lateron-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    // 给浏览器一次事件循环去接管下载，再释放 URL；同步释放在部分环境会取消下载。
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  // 导入收藏（按网址去重合并）
  const fileInput = document.querySelector("#importFile");
  document.querySelector("#importBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.items)) throw new Error(t("importBadFile"));
      const existing = await chrome.storage.local.get(["laterOnItems", "laterOnProjects", "laterOnCovers", "laterOnOrder"]);
      const byUrl = new Map((existing.laterOnItems || []).map((it) => [normalizeUrl(it.url), it]));
      let skipped = 0;
      for (const it of parsed.items) {
        // 备份文件可以被手工修改，不能把任意协议塞进收藏链接。
        if (!isImportableItem(it)) { skipped += 1; continue; }
        const key = normalizeUrl(it.url);
        if (!byUrl.has(key)) byUrl.set(key, it);
      }
      const mergedItems = [...byUrl.values()];
      const projById = new Map((existing.laterOnProjects || []).map((p) => [p.id, p]));
      (parsed.projects || []).forEach((p) => { if (!projById.has(p.id)) projById.set(p.id, p); });
      await chrome.storage.local.set({
        laterOnItems: mergedItems,
        laterOnProjects: [...projById.values()],
        laterOnCovers: { ...(existing.laterOnCovers || {}), ...(parsed.covers || {}) },
        laterOnOrder: { ...(existing.laterOnOrder || {}), ...(parsed.order || {}) }
      });
      await LaterOnDialog.alert({
        tone: "success",
        title: t("importDoneTitle"),
        message: t("importDoneMsg", { n: mergedItems.length, skipped: skipped ? t("skippedCount", { n: skipped }) : "" })
      });
    } catch (error) {
      await LaterOnDialog.alert({
        tone: "danger",
        title: t("importFailTitle"),
        message: String(error?.message || error)
      });
    } finally {
      fileInput.value = "";
    }
  });

  // 清空所有收藏
  document.querySelector("#wipeBtn").addEventListener("click", async () => {
    const confirmed = await LaterOnDialog.confirm({
      tone: "danger",
      title: t("wipeConfirmTitle"),
      message: t("wipeConfirmMsg"),
      confirmText: t("wipeConfirmBtn")
    });
    if (!confirmed) return;
    await chrome.storage.local.remove(["laterOnCovers", "laterOnOrder", "laterOnCurrentItem"]);
    await chrome.storage.local.set({ laterOnItems: [] });
    try { localStorage.removeItem("laterOnPanelCache"); } catch { /* 清缓存失败不影响清空收藏 */ }
    await LaterOnDialog.alert({
      tone: "success",
      title: t("wipeDoneTitle"),
      message: t("wipeDoneMsg")
    });
  });
}

// ── 快捷键自检 ──────────────────────────────────────────────
// 这些映射存的是 i18n 词条 key，显示时用 t() 按当前语言取词。
const COMMAND_KEYS = {
  "quick-save": "cmdSavePage",
  "toggle-translation": "cmdTranslatePage",
  "save-all-tabs": "cmdSaveAllTabs"
};
const TRIGGER_KEYS = { shortcut: "triggerShortcut", menu: "triggerMenu", panel: "triggerPanel" };
// 「封面是从哪一层拿到的」的词条 key（对应提取函数里的 imageFrom）。
const COVER_SOURCE_KEYS = {
  share: "coverShare",
  image_src: "coverImageSrc",
  itemprop: "coverItemprop",
  jsonld: "coverJsonld",
  poster: "coverPoster",
  background: "coverBackground",
  lazy: "coverLazy",
  biggest: "coverBiggest",
  youtube: "coverYoutube",
  "generic-skipped": "coverGenericSkipped",
  none: "coverNone"
};
// 「标题是从哪一层拿到的」的词条 key（对应提取函数里的 titleFrom）。
const TITLE_SOURCE_KEYS = {
  "dom-headline": "titleDomHeadline",
  share: "titleShare",
  twitter: "titleTwitter",
  "meta-title": "titleMetaTitle",
  jsonld: "coverJsonld",
  "page-title": "titlePageTitle",
  youtube: "titleYoutube",
  tab: "titleTab",
  fallback: "titleFallback",
  none: "titleNone"
};

function relativeTime(timestamp) {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60000) return t("justNow");
  if (diff < 3600000) return t("minutesAgo", { n: Math.floor(diff / 60000) });
  if (diff < 86400000) return t("hoursAgo", { n: Math.floor(diff / 3600000) });
  return new Date(timestamp).toLocaleString(isEn() ? "en-US" : "zh-CN");
}

async function renderDiag() {
  const stored = await chrome.storage.local.get(["laterOnDiag", "laterOnPanelDiag", "laterOnPopupDiag", "laterOnLocateDiag"]);
  const diag = stored.laterOnDiag || {};

  // 点图标弹出的小窗口：「就绪」= 界面画出来用了多久（现在应该几十毫秒），
  // 「详情」= 后台把封面摘要补回来用了多久（这段慢不影响用，只是封面晚点出现）。
  const popupEl = document.querySelector("#diagPopupSpeed");
  if (popupEl) {
    const popup = stored.laterOnPopupDiag;
    if (!popup?.at) {
      popupEl.textContent = t("popupNever");
    } else {
      const parts = [relativeTime(popup.at), t("readyMs", { n: popup.ready ?? 0 })];
      if (popup.detail != null) parts.push(t("detailMs", { n: popup.detail }));
      if (popup.enhanced === false) parts.push(t("detailMissed"));
      popupEl.textContent = parts.join(" · ");
    }
  }

  // 侧栏打开速度：分段耗时慢在哪一步，看这一行就知道（排查「打开慢」用）。
  const speedEl = document.querySelector("#diagPanelSpeed");
  if (speedEl) {
    const panel = stored.laterOnPanelDiag;
    if (!panel?.at) {
      speedEl.textContent = t("panelNever");
    } else {
      // 各段含义：page = 页面/脚本就绪，cache = 读秒开快照，paint = 画第一屏，
      // data = 等存储返回，migrate = 整理旧封面，other = 没被任何一段认领的剩余时间。
      const segEntries = [
        ["page", "segPage"],
        ["cache", "segCache"],
        ["paint", "segPaint"],
        ["data", "segData"],
        ["migrate", "segMigrate"],
        ["other", "segOther"]
      ].filter(([key]) => (panel[key] ?? 0) > 0);
      const parts = [
        relativeTime(panel.at),
        t("totalSeconds", { n: (panel.total / 1000).toFixed(1) }),
        // 给个判断，免得看到数字不知道算快还是算慢。
        panel.total <= 1000 ? t("speedOk") : panel.total <= 2000 ? t("speedSlowish") : t("speedSlow"),
        ...segEntries.map(([key, label]) => `${t(label)} ${t("msUnit", { n: panel[key] })}`)
      ];
      if (panel.bytes) parts.push(t("dataSizeKB", { n: Math.round(panel.bytes / 1024) }));
      if (panel.localStorageSlow) parts.push(t("localStorageSlow"));
      if (panel.cacheHit === false) parts.push(t("cacheOff"));
      if (panel.cacheHit === true) parts.push(t("cacheOn"));
      if (panel.items != null) parts.push(t("itemsCount", { n: panel.items }));
      if (Array.isArray(panel.slow) && panel.slow.length) {
        parts.push(t("slowestFiles", { list: panel.slow.map((entry) => `${entry.name} ${t("msUnit", { n: entry.ms })}`).join(isEn() ? ", " : "、") }));
      }
      speedEl.textContent = parts.join(" · ");
    }
  }

  // 侧栏「滚到正在读那篇」的诊断：到底找没找到那张卡、滚没滚、滚完在不在视野里。
  const locateEl = document.querySelector("#diagLocate");
  if (locateEl) {
    const loc = stored.laterOnLocateDiag;
    if (!loc?.at) {
      locateEl.textContent = t("locateNever");
    } else {
      const parts = [relativeTime(loc.at)];
      if (loc.found === false) {
        parts.push(t("locateNotFound"));
      } else {
        parts.push(loc.inView === false ? t("locateOutOfView") : t("locateInView"));
        if (loc.scrolled === false) parts.push(t("locateNoScroll"));
        if (loc.attempts != null) parts.push(t("locateAttempts", { n: loc.attempts }));
      }
      if (loc.viewport) parts.push(t("viewportPx", { n: loc.viewport }));
      locateEl.textContent = parts.join(" · ");
    }
  }

  const shortcutEl = document.querySelector("#diagShortcut");
  if (shortcutEl) {
    shortcutEl.textContent = diag.lastCommandAt
      ? t("shortcutLine", { time: relativeTime(diag.lastCommandAt), cmd: COMMAND_KEYS[diag.lastCommand] ? t(COMMAND_KEYS[diag.lastCommand]) : diag.lastCommand })
      : t("neverTriggered");
  }

  const runEl = document.querySelector("#diagRun");
  if (runEl) {
    const at = diag.lastResultAt || diag.lastRunAt;
    if (!at) {
      runEl.textContent = t("neverRan");
    } else {
      const triggerLabel = TRIGGER_KEYS[diag.lastTrigger] ? t(TRIGGER_KEYS[diag.lastTrigger]) : (diag.lastTrigger || t("triggerShortcut"));
      const parts = [
        relativeTime(at),
        t("fromTrigger", { trigger: triggerLabel }),
        t("addedCount", { n: diag.lastAdded ?? 0 }),
        t("duplicateCount", { n: diag.lastDuplicated ?? 0 })
      ];
      if (diag.lastMoved) parts.push(t("movedCount", { n: diag.lastMoved }));
      if (diag.lastEnriched) parts.push(t("enrichedCount", { n: diag.lastEnriched }));
      if (diag.lastDegraded) parts.push(t("degradedCount", { n: diag.lastDegraded }));
      runEl.textContent = parts.join(" · ");
    }
  }

  const errorRow = document.querySelector("#diagErrorRow");
  const errorEl = document.querySelector("#diagError");
  if (errorRow && errorEl) {
    const hasError = !!diag.lastError;
    errorRow.hidden = !hasError;
    if (hasError) errorEl.textContent = t("errorLine", { time: relativeTime(diag.lastErrorAt), msg: diag.lastError });
  }

  const stageEl = document.querySelector("#diagStage");
  if (stageEl) {
    if (!diag.lastStage) {
      stageEl.textContent = t("neverRan");
    } else {
      const parts = [t("stageLine", { stage: diag.lastStage, time: relativeTime(diag.lastStageAt || diag.lastRunAt) })];
      if (diag.lastProgress) parts.push(t("progressLabel", { p: diag.lastProgress }));
      if (diag.lastTabCount != null) parts.push(t("tabCount", { n: diag.lastTabCount }));
      stageEl.textContent = parts.join(" · ");
    }
  }

  // 标题和封面分别是从哪一层拿到的——抓不全的站点，看一眼这里就知道卡在哪一步。
  const coverEl = document.querySelector("#diagCover");
  if (coverEl) {
    if (!diag.lastCoverAt) {
      coverEl.textContent = t("coverNever");
    } else {
      const titleLabel = TITLE_SOURCE_KEYS[diag.lastTitleFrom] ? t(TITLE_SOURCE_KEYS[diag.lastTitleFrom]) : (diag.lastTitleFrom || t("unknown"));
      const coverLabel = COVER_SOURCE_KEYS[diag.lastCoverFrom] ? t(COVER_SOURCE_KEYS[diag.lastCoverFrom]) : (diag.lastCoverFrom || t("unknown"));
      const extra = diag.lastCoverTitle ? (isEn() ? ` (${diag.lastCoverTitle})` : `（${diag.lastCoverTitle}）`) : "";
      coverEl.textContent = [relativeTime(diag.lastCoverAt), t("coverLine", { title: titleLabel, cover: coverLabel }) + extra].join(" · ");
    }
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const param of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      u.searchParams.delete(param);
    }
    u.host = u.host.replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function isImportableItem(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

init();
