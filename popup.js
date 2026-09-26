let currentItem = null;

const elements = {
  image: document.querySelector("#previewImage"),
  source: document.querySelector("#previewSource"),
  title: document.querySelector("#previewTitle"),
  save: document.querySelector("#saveButton"),
  label: document.querySelector("#saveLabel"),
  icon: document.querySelector("#saveIcon"),
  library: document.querySelector("#libraryButton"),
  message: document.querySelector("#message")
};

// 扩展后台（service worker）在浏览器闲置时会被 Chrome 回收，再次唤醒可能要好几秒。
// 以前这个弹窗是「等后台把网页信息抓回来才画界面」，于是偶尔会白着等十几秒。
// 现在改成两段式：先用标签页自带的信息（浏览器本地就有，不用唤醒后台）立刻画出来、
// 收藏按钮也立刻能点；封面 / 摘要这类细节交给后台慢慢补，最多等这么多毫秒，
// 超时就维持现状——界面绝不会卡在空白。
const METADATA_TIMEOUT_MS = 4000;
const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
const elapsed = () => Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0);

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

// 把这次弹窗的耗时记下来：设置页「自检信息」里能看到，方便判断慢在哪一步。
function savePopupDiag(patch) {
  try { chrome.storage.local.set({ laterOnPopupDiag: patch }); } catch { /* 记不下来也不影响界面 */ }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "网页"; }
}

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    elements.source.textContent = "无法读取";
    elements.message.textContent = "这个页面无法收藏，请打开一个普通网页后重试。";
    window.LaterOnBoot?.done?.();
    return;
  }
  // 第一屏：标题 / 来源用标签页自带的信息，收藏按钮立刻可用。
  // 真正的收藏动作由后台自己再去抓详情，不影响把这一页存下来。
  currentItem = {
    url: tab.url,
    title: tab.title || tab.url,
    source: hostOf(tab.url),
    image: "",
    favicon: tab.favIconUrl || ""
  };
  renderPreview(currentItem);
  elements.save.disabled = false;
  // 第一屏已经可见，结束 boot.js 的慢加载计时器；详情补全继续在后台跑。
  window.LaterOnBoot?.done?.();
  const ready = elapsed();
  savePopupDiag({ at: Date.now(), ready, detail: null, enhanced: false });

  // 第二屏：封面 / 摘要由后台补，补到了就刷新预览；补不到（超时或后台忙）也无所谓。
  const response = await withTimeout(
    chrome.runtime.sendMessage({ type: "EXTRACT_METADATA", tabId: tab.id }).catch(() => null),
    METADATA_TIMEOUT_MS,
    null
  );
  if (!response?.ok || !response.metadata) {
    savePopupDiag({ at: Date.now(), ready, detail: elapsed(), enhanced: false });
    return;
  }
  currentItem = {
    ...currentItem,
    ...response.metadata,
    url: tab.url,
    title: response.metadata.title || currentItem.title
  };
  renderPreview(currentItem);
  savePopupDiag({ at: Date.now(), ready, detail: elapsed(), enhanced: true });
}

elements.save.addEventListener("click", async () => {
  if (!currentItem) return;
  elements.save.disabled = true;
  elements.label.textContent = "正在收藏…";
  try {
    // 统一交给后台处理（和快捷键、右键菜单同一条链路）：
    // 设置里打开「收藏单篇前先选项目」时，点这里同样会先在网页里弹出选项目浮层。
    const response = await chrome.runtime.sendMessage({ type: "QUICK_SAVE_TAB", source: "panel" });
    // 弹出浮层了就把这个小窗口关掉，否则它会把网页里的浮层挡住。
    if (response?.ok && response.pending) {
      window.close();
      return;
    }
    if (!response?.ok) throw new Error(response?.error || "保存失败");
    elements.save.classList.add("done");
    elements.icon.textContent = "✓";
    elements.label.textContent = response.duplicated
      ? (response.refreshed ? "已更新信息" : "已收藏过")
      : (response.updated ? "已更新收藏" : "收藏成功");
  } catch (error) {
    elements.message.textContent = error.message || "保存失败，请重试。";
    elements.save.disabled = false;
    elements.label.textContent = "重新收藏";
  }
});

elements.library.addEventListener("click", () => chrome.runtime.sendMessage({ type: "OPEN_LIBRARY" }));

document.querySelector("#sidePanelButton").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  window.close();
});

function renderPreview(item) {
  elements.title.textContent = item.title;
  elements.source.textContent = item.source;
  if (item.image) applyPreviewImage(item.image);
}

// 封面若加载失败（YouTube 的 maxresdefault 对部分视频并不存在），
// 逐级降到 hq720 / hqdefault / mqdefault 重试，而不是留一片空白。
const COVER_CHAIN = ["maxresdefault.jpg", "hq720.jpg", "hqdefault.jpg", "mqdefault.jpg"];
function applyPreviewImage(src) {
  elements.image.style.backgroundImage = `url("${src.replace(/"/g, "%22")}")`;
  const probe = new Image();
  probe.addEventListener("error", () => {
    let url;
    try {
      url = new URL(src);
    } catch {
      return;
    }
    const matched = /^\/vi\/([^/]+)\/([^/]+\.jpg)$/.exec(url.pathname);
    if (!matched || url.hostname !== "i.ytimg.com") return;
    const index = COVER_CHAIN.indexOf(matched[2]);
    if (index === -1) return;
    const next = COVER_CHAIN[index + 1];
    if (!next) return;
    url.pathname = `/vi/${matched[1]}/${next}`;
    url.search = "";
    applyPreviewImage(url.href);
  });
  probe.src = src;
}
