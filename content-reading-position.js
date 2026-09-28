// 注入到“已收藏网页”的轻量脚本：记住 scrollY，并在再次打开时询问是否继续。
// 重复注入是安全的；SPA 切换到另一篇收藏时由 INIT 消息更新目标。
(function () {
  // 扩展更新 / 开发时重新加载后，旧内容脚本不会随网页一起消失，但它持有的
  // chrome.runtime 已经失效。再次注入时先彻底撤掉旧实例，不能仅凭全局标记 return。
  try { globalThis.__laterOnReadingPosition?.dispose?.(); } catch {}

  const state = {
    itemId: null,
    savedY: 0,
    armed: false,
    saveTimer: null,
    prompt: null,
    promptTimer: null,
    generation: 0,
    disposed: false,
    dispose: null
  };
  globalThis.__laterOnReadingPosition = state;

  function removePrompt() {
    clearTimeout(state.promptTimer);
    state.prompt?.remove();
    state.prompt = null;
  }

  function isContextInvalidError(error) {
    return /extension context invalidated|context invalidated/i.test(String(error?.message || error || ""));
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    state.armed = false;
    clearTimeout(state.saveTimer);
    clearTimeout(state.promptTimer);
    removePrompt();
    window.removeEventListener("scroll", scheduleSave);
    window.removeEventListener("wheel", userStartedReading);
    window.removeEventListener("touchstart", userStartedReading);
    window.removeEventListener("pointerdown", userStartedReading);
    window.removeEventListener("keydown", userStartedReading);
    window.removeEventListener("pagehide", sendPosition);
    try { chrome.runtime.onMessage.removeListener(handleInit); } catch {}
  }
  state.dispose = dispose;

  // `chrome.runtime.sendMessage(...).catch(...)` 只处理 Promise 拒绝；扩展上下文失效时
  // sendMessage 本身会在返回 Promise 之前同步 throw。必须把调用也放进 try/catch。
  function safeSendMessage(message) {
    if (state.disposed) return Promise.resolve(null);
    try {
      const pending = chrome.runtime.sendMessage(message);
      return Promise.resolve(pending).catch((error) => {
        if (isContextInvalidError(error)) dispose();
        return null;
      });
    } catch (error) {
      // 同步抛错在内容脚本里基本只会发生于扩展更新 / 重载；直接停掉旧实例，
      // 之后新版本再次注入时会建立一套干净监听。
      dispose();
      return Promise.resolve(null);
    }
  }

  function safeRuntimeUrl(path) {
    if (state.disposed) return "";
    try { return chrome.runtime.getURL(path); }
    catch { dispose(); return ""; }
  }

  function sendPosition() {
    if (state.disposed || !state.armed || !state.itemId) return;
    const y = Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
    safeSendMessage({ type: "SAVE_READING_POSITION", itemId: state.itemId, y });
  }

  function scheduleSave() {
    if (state.disposed || !state.armed || !state.itemId) return;
    clearTimeout(state.saveTimer);
    const generation = state.generation;
    const itemId = state.itemId;
    state.saveTimer = setTimeout(() => {
      if (state.generation === generation && state.itemId === itemId) sendPosition();
    }, 500);
  }

  function userStartedReading(event) {
    if (state.disposed) return;
    if (state.prompt && event?.composedPath?.().includes(state.prompt)) return;
    state.armed = true;
    removePrompt();
    scheduleSave();
  }

  function continueFromSavedPosition() {
    if (state.disposed) return;
    const target = state.savedY;
    const generation = state.generation;
    const itemId = state.itemId;
    removePrompt();
    window.scrollTo({ top: target, behavior: "smooth" });
    // 图片和异步正文可能继续撑高页面；短暂复查两次，仍只恢复同一个 scrollY。
    setTimeout(() => {
      if (state.generation === generation && state.itemId === itemId) window.scrollTo({ top: target, behavior: "auto" });
    }, 450);
    setTimeout(() => {
      if (state.generation !== generation || state.itemId !== itemId) return;
      window.scrollTo({ top: target, behavior: "auto" });
      state.armed = true;
      sendPosition();
    }, 1100);
  }

  function showPrompt(language) {
    if (state.disposed) return;
    removePrompt();
    const host = document.createElement("div");
    host.id = "lateron-reading-position";
    const shadow = host.attachShadow({ mode: "open" });
    const en = language === "en";
    const iconUrl = safeRuntimeUrl("icon128.png");
    if (!iconUrl) return;
    shadow.innerHTML = `
      <style>
        :host{all:initial;position:fixed;right:28px;top:50%;transform:translateY(-50%);z-index:2147483647;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .box{display:flex;align-items:center;gap:8px;padding:10px 12px 10px 10px;border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(24,23,21,.94);box-shadow:0 14px 38px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.06);color:#fff;backdrop-filter:blur(18px);animation:lateron-in .28s cubic-bezier(.22,1,.36,1) both}
        .mark{display:block;width:36px;height:36px;border-radius:50%;object-fit:cover;box-shadow:0 4px 10px rgba(0,0,0,.22)}
        button{all:unset;box-sizing:border-box;cursor:pointer}
        .resume{padding:12px 20px;border-radius:999px;font:650 15px/1.2 inherit;letter-spacing:.01em;white-space:nowrap}
        .resume:hover{background:rgba(255,255,255,.11)}
        .close{display:grid;place-items:center;width:34px;height:34px;margin-left:2px;border-radius:50%;color:rgba(255,255,255,.58)}
        .close svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
        .close:hover{background:rgba(255,255,255,.1);color:#fff}
        @keyframes lateron-in{from{opacity:0;transform:translateX(16px) scale(.96)}to{opacity:1;transform:none}}
        @media(prefers-reduced-motion:reduce){.box{animation:none}}
        @media(max-width:520px){:host{right:12px}.box{max-width:calc(100vw - 24px)}}
      </style>
      <div class="box" role="status">
        <img class="mark" src="${iconUrl}" alt="" />
        <button class="resume" type="button">${en ? "Continue from last position" : "继续上次位置"}</button>
        <button class="close" type="button" aria-label="${en ? "Dismiss" : "关闭"}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9m0-9-9 9"/></svg></button>
      </div>`;
    shadow.querySelector(".resume").addEventListener("click", continueFromSavedPosition);
    shadow.querySelector(".close").addEventListener("click", removePrompt);
    (document.documentElement || document.body).appendChild(host);
    state.prompt = host;
    state.promptTimer = setTimeout(removePrompt, 12000);
  }

  function handleInit(message) {
    if (state.disposed) return;
    if (message?.type !== "LATERON_READING_POSITION_INIT") return;
    clearTimeout(state.saveTimer);
    removePrompt();
    state.generation += 1;
    state.itemId = message.itemId || null;
    state.savedY = Math.max(0, Number(message.y) || 0);
    state.armed = false;
    if (!state.itemId) return;

    const currentY = Math.max(0, window.scrollY || window.pageYOffset || 0);
    if (state.savedY >= 160 && Math.abs(currentY - state.savedY) >= 120) {
      showPrompt(message.language);
    } else {
      state.armed = true;
    }
  }

  try {
    chrome.runtime.onMessage.addListener(handleInit);
    window.addEventListener("scroll", scheduleSave, { passive: true });
    window.addEventListener("wheel", userStartedReading, { passive: true });
    window.addEventListener("touchstart", userStartedReading, { passive: true });
    window.addEventListener("pointerdown", userStartedReading, { passive: true });
    window.addEventListener("keydown", userStartedReading, { passive: true });
    window.addEventListener("pagehide", sendPosition);
  } catch {
    dispose();
  }
})();
