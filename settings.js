const settings = window.LaterOnSettings;

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
    document.querySelector("#cmdSave").textContent = save?.shortcut ? `${save.shortcut}（默认 Alt+1）` : "未设置（默认 Alt+1）";
    document.querySelector("#cmdTranslate").textContent = translate?.shortcut ? `${translate.shortcut}（默认 Alt+2）` : "未设置（默认 Alt+2）";
    const saveAll = commands.find((c) => c.name === "save-all-tabs");
    document.querySelector("#cmdSaveAll").textContent = saveAll?.shortcut ? `${saveAll.shortcut}（默认 Alt+Shift+1）` : "未设置（默认 Alt+Shift+1）";
  } catch {
    document.querySelector("#cmdSave").textContent = "默认 Alt+1";
    document.querySelector("#cmdTranslate").textContent = "默认 Alt+2";
    document.querySelector("#cmdSaveAll").textContent = "默认 Alt+Shift+1";
  }

  document.querySelector("#openShortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {
      LaterOnDialog.alert({
        title: "没能自动打开快捷键设置",
        message: "请手动在地址栏输入：chrome://extensions/shortcuts"
      });
    });
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
      if (!parsed || !Array.isArray(parsed.items)) throw new Error("文件格式不正确");
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
        title: "导入完成",
        message: `当前共 ${mergedItems.length} 篇收藏。${skipped ? `已跳过 ${skipped} 条无效记录。` : ""}`
      });
    } catch (error) {
      await LaterOnDialog.alert({
        tone: "danger",
        title: "导入失败",
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
      title: "清空所有收藏？",
      message: "所有收藏都会被删除，此操作无法撤销。",
      confirmText: "全部清空"
    });
    if (!confirmed) return;
    await chrome.storage.local.remove(["laterOnCovers", "laterOnOrder", "laterOnCurrentItem"]);
    await chrome.storage.local.set({ laterOnItems: [] });
    try { localStorage.removeItem("laterOnPanelCache"); } catch { /* 清缓存失败不影响清空收藏 */ }
    await LaterOnDialog.alert({
      tone: "success",
      title: "已清空所有收藏",
      message: "收藏列表现在是空的。"
    });
  });
}

// ── 快捷键自检 ──────────────────────────────────────────────
const COMMAND_NAMES = {
  "quick-save": "收藏当前网页",
  "toggle-translation": "翻译当前网页",
  "save-all-tabs": "收藏所有标签"
};
const TRIGGER_NAMES = { shortcut: "快捷键", menu: "右键菜单", panel: "面板按钮" };
// 「封面是从哪一层拿到的」的中文说明（对应提取函数里的 imageFrom）。
const COVER_SOURCE_NAMES = {
  share: "网站自带的分享图",
  image_src: "网页头部的 image_src",
  itemprop: "网页里的 itemprop 封面",
  jsonld: "结构化数据（JSON-LD）",
  poster: "视频封面（poster）",
  background: "页面上的背景图",
  lazy: "懒加载图片",
  biggest: "页面上最大的图片",
  youtube: "按视频 id 拼出的 YouTube 封面",
  "generic-skipped": "网站的分享图是平台通用图，已跳过",
  none: "没找到任何可用的封面图"
};
// 「标题是从哪一层拿到的」的中文说明（对应提取函数里的 titleFrom）。
const TITLE_SOURCE_NAMES = {
  "dom-headline": "页面上的实时标题",
  share: "网站自带的分享标题",
  twitter: "网站自带的 Twitter 标题",
  "meta-title": "网页头部的 meta 标题",
  jsonld: "结构化数据（JSON-LD）",
  "page-title": "浏览器标签页标题",
  youtube: "YouTube 视频数据",
  tab: "浏览器记录的标签页标题",
  fallback: "兜底（没找到像样的标题）",
  none: "没找到任何可用的标题"
};

function relativeTime(timestamp) {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(timestamp).toLocaleString("zh-CN");
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
      popupEl.textContent = "还没有打开过小窗口";
    } else {
      const parts = [relativeTime(popup.at), `就绪 ${popup.ready ?? 0} 毫秒`];
      if (popup.detail != null) parts.push(`详情 ${popup.detail} 毫秒`);
      if (popup.enhanced === false) parts.push("详情没取到（不影响收藏）");
      popupEl.textContent = parts.join(" · ");
    }
  }

  // 侧栏打开速度：分段耗时慢在哪一步，看这一行就知道（排查「打开慢」用）。
  const speedEl = document.querySelector("#diagPanelSpeed");
  if (speedEl) {
    const panel = stored.laterOnPanelDiag;
    if (!panel?.at) {
      speedEl.textContent = "还没有打开过侧栏";
    } else {
      // 各段含义：page = 页面/脚本就绪，cache = 读秒开快照，paint = 画第一屏，
      // data = 等存储返回，migrate = 整理旧封面，other = 没被任何一段认领的剩余时间。
      const segEntries = [
        ["page", "页面"],
        ["cache", "缓存"],
        ["paint", "画屏"],
        ["data", "数据"],
        ["migrate", "搬封面"],
        ["other", "其余"]
      ].filter(([key]) => (panel[key] ?? 0) > 0);
      const parts = [
        relativeTime(panel.at),
        `总 ${(panel.total / 1000).toFixed(1)} 秒`,
        // 给个判断，免得看到数字不知道算快还是算慢。
        panel.total <= 1000 ? "（正常）" : panel.total <= 2000 ? "（略慢）" : "（偏慢）",
        ...segEntries.map(([key, label]) => `${label} ${panel[key]} 毫秒`)
      ];
      if (panel.bytes) parts.push(`数据体积 ${Math.round(panel.bytes / 1024)} KB`);
      if (panel.localStorageSlow) parts.push("本机 localStorage 偏慢（已停用秒开快照）");
      if (panel.cacheHit === false) parts.push("没用上秒开缓存");
      if (panel.cacheHit === true) parts.push("用上了秒开缓存");
      if (panel.items != null) parts.push(`${panel.items} 篇`);
      if (Array.isArray(panel.slow) && panel.slow.length) {
        parts.push(`最慢文件 ${panel.slow.map((entry) => `${entry.name} ${entry.ms} 毫秒`).join("、")}`);
      }
      speedEl.textContent = parts.join(" · ");
    }
  }

  // 侧栏「滚到正在读那篇」的诊断：到底找没找到那张卡、滚没滚、滚完在不在视野里。
  const locateEl = document.querySelector("#diagLocate");
  if (locateEl) {
    const loc = stored.laterOnLocateDiag;
    if (!loc?.at) {
      locateEl.textContent = "还没定位过";
    } else {
      const parts = [relativeTime(loc.at)];
      if (loc.found === false) {
        parts.push("没找到那张卡（可能被筛选/项目挡住了）");
      } else {
        parts.push(loc.inView === false ? "滚完仍不在视野里" : "已在视野里");
        if (loc.scrolled === false) parts.push("判断为不用滚");
        if (loc.attempts != null) parts.push(`试了 ${loc.attempts} 次`);
      }
      if (loc.viewport) parts.push(`视口 ${loc.viewport}px`);
      locateEl.textContent = parts.join(" · ");
    }
  }

  const shortcutEl = document.querySelector("#diagShortcut");
  if (shortcutEl) {
    shortcutEl.textContent = diag.lastCommandAt
      ? `${relativeTime(diag.lastCommandAt)}（${COMMAND_NAMES[diag.lastCommand] || diag.lastCommand}）`
      : "还没触发过";
  }

  const runEl = document.querySelector("#diagRun");
  if (runEl) {
    const at = diag.lastResultAt || diag.lastRunAt;
    if (!at) {
      runEl.textContent = "还没执行过";
    } else {
      const parts = [
        relativeTime(at),
        `来自${TRIGGER_NAMES[diag.lastTrigger] || "快捷键"}`,
        `新增 ${diag.lastAdded ?? 0} 篇`,
        `重复 ${diag.lastDuplicated ?? 0} 篇`
      ];
      if (diag.lastMoved) parts.push(`移入项目 ${diag.lastMoved} 篇`);
      if (diag.lastEnriched) parts.push(`补全封面摘要 ${diag.lastEnriched} 篇`);
      if (diag.lastDegraded) parts.push(`未抓全 ${diag.lastDegraded} 篇`);
      runEl.textContent = parts.join(" · ");
    }
  }

  const errorRow = document.querySelector("#diagErrorRow");
  const errorEl = document.querySelector("#diagError");
  if (errorRow && errorEl) {
    const hasError = !!diag.lastError;
    errorRow.hidden = !hasError;
    if (hasError) errorEl.textContent = `${relativeTime(diag.lastErrorAt)}：${diag.lastError}`;
  }

  const stageEl = document.querySelector("#diagStage");
  if (stageEl) {
    if (!diag.lastStage) {
      stageEl.textContent = "还没执行过";
    } else {
      const parts = [`${diag.lastStage}（${relativeTime(diag.lastStageAt || diag.lastRunAt)}）`];
      if (diag.lastProgress) parts.push(`进度 ${diag.lastProgress}`);
      if (diag.lastTabCount != null) parts.push(`共 ${diag.lastTabCount} 个标签`);
      stageEl.textContent = parts.join(" · ");
    }
  }

  // 标题和封面分别是从哪一层拿到的——抓不全的站点，看一眼这里就知道卡在哪一步。
  const coverEl = document.querySelector("#diagCover");
  if (coverEl) {
    if (!diag.lastCoverAt) {
      coverEl.textContent = "还没有抓取记录";
    } else {
      const titleLabel = TITLE_SOURCE_NAMES[diag.lastTitleFrom] || diag.lastTitleFrom || "未知";
      const coverLabel = COVER_SOURCE_NAMES[diag.lastCoverFrom] || diag.lastCoverFrom || "未知";
      coverEl.textContent = `${relativeTime(diag.lastCoverAt)} · 标题：${titleLabel} · 封面：${coverLabel}${
        diag.lastCoverTitle ? `（${diag.lastCoverTitle}）` : ""
      }`;
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
