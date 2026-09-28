// 注入到网页里执行的「选项目浮层」——整屏模态用法。
// 真正的面板 UI / 交互在 picker-ui.js 的 openFolderPicker 里（和全屏卡片上那个浮层是同一份）。
// 本文件只负责把后台传来的 payload 翻译成 openFolderPicker 的调用，并接上收藏流程的消息。
//
// ⚠️ 必须自包含地被注入：不依赖任何外部变量，只靠 window.openFolderPicker
//    （由先于本文件注入的 picker-ui.js 提供）。
// 整个入口包在函数作用域里：chrome.scripting.executeScript 可能在同一网页反复注入本文件，
// 顶层 const / let 会留在同一个脚本世界里，第二次声明就会直接抛 SyntaxError。
(() => {
// 同一网页再次注入前，撤掉上一个实例还在等 payload 的一次性监听。
// 扩展重载后旧监听若继续响应，会拿着失效的 runtime 再执行一遍浮层逻辑。
try { window.__laterOnPickerPayloadCleanup?.(); } catch {}

function showFolderPickerOverlay(payload) {
  // 这个浮层可能在扩展更新后仍留在旧网页里；此时 sendMessage 会在返回 Promise
  // 之前同步抛错，所以安全包装必须同时覆盖同步 throw 与异步 reject。
  function safeRuntimeMessage(message) {
    try { return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null); }
    catch { return Promise.resolve(null); }
  }

  const data = payload || {};

  // 主题：跟着扩展设置走；设置为「跟随系统」时看系统偏好。
  const theme = data.theme || "light";
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const savedCount = Number(data.savedCount) || 0;
  const selected = typeof data.selected === "string" ? data.selected : "";

  if (typeof window.openFolderPicker !== "function") {
    // picker-ui.js 没先于本文件注入：收藏流程没法继续，安静退出；后台会重试网页内浮层。
    return;
  }

  window.openFolderPicker({
    theme,
    language: data.language || "zh-CN",
    folders,
    selected,
    pages,
    savedCount,
    // 新建项目 / 确认收藏 / 取消收藏：都走后台那一套，行为和以前完全一致。
    // onCreateProject 按约定返回「项目对象 {id,name}」（不是后台那层 {ok,project} 包装），
    // 所以这里把响应拆开再交出去。
    onCreateProject: async (name) => {
      const response = await safeRuntimeMessage({ type: "CREATE_PROJECT", name });
      return response?.project || null;
    },
    onPick: (projectId) => safeRuntimeMessage({ type: "CONFIRM_BATCH_SAVE", projectId }),
    onCancel: () => safeRuntimeMessage({ type: "CANCEL_BATCH_SAVE" })
  });
}

  // 后台把配置放进一个一次性 JSON 节点再执行本文件：从这里读出 payload。
  // 配置和本文件可能并行注入，所以既检查现有节点，也监听后台发出的就绪事件。
  const consumePickerPayload = () => {
    const node = document.getElementById("lateron-picker-payload-data");
    let payload = null;
    try { payload = JSON.parse(node?.textContent || "null"); } catch {}
    node?.remove();
    if (!payload) return false;
    cleanupPayloadListener();
    showFolderPickerOverlay(payload);
    return true;
  };

  const onPayloadReady = () => consumePickerPayload();
  const cleanupPayloadListener = () => {
    document.removeEventListener("lateron-picker-payload-ready", onPayloadReady);
    if (window.__laterOnPickerPayloadCleanup === cleanupPayloadListener) delete window.__laterOnPickerPayloadCleanup;
  };

  // 预览页会直接调用这个入口；重复注入时覆盖同名属性是安全的。
  window.showFolderPickerOverlay = showFolderPickerOverlay;
  window.__laterOnPickerPayloadCleanup = cleanupPayloadListener;
  document.addEventListener("lateron-picker-payload-ready", onPayloadReady, { once: true });
  consumePickerPayload();
})();
