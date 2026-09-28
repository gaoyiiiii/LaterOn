// 注入到“已收藏网页”的轻量脚本：记住 scrollY，并在再次打开时询问是否继续。
// 重复注入是安全的；SPA 切换到另一篇收藏时由 INIT 消息更新目标。
(function () {
  if (globalThis.__laterOnReadingPosition) return;

  const state = {
    itemId: null,
    savedY: 0,
    armed: false,
    saveTimer: null,
    prompt: null,
    promptTimer: null,
    generation: 0
  };
  globalThis.__laterOnReadingPosition = state;

  function removePrompt() {
    clearTimeout(state.promptTimer);
    state.prompt?.remove();
    state.prompt = null;
  }

  function sendPosition() {
    if (!state.armed || !state.itemId) return;
    const y = Math.max(0, Math.round(window.scrollY || window.pageYOffset || 0));
    chrome.runtime.sendMessage({ type: "SAVE_READING_POSITION", itemId: state.itemId, y }).catch(() => {});
  }

  function scheduleSave() {
    if (!state.armed || !state.itemId) return;
    clearTimeout(state.saveTimer);
    const generation = state.generation;
    const itemId = state.itemId;
    state.saveTimer = setTimeout(() => {
      if (state.generation === generation && state.itemId === itemId) sendPosition();
    }, 500);
  }

  function userStartedReading(event) {
    if (state.prompt && event?.composedPath?.().includes(state.prompt)) return;
    state.armed = true;
    removePrompt();
    scheduleSave();
  }

  function continueFromSavedPosition() {
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
    removePrompt();
    const host = document.createElement("div");
    host.id = "lateron-reading-position";
    const shadow = host.attachShadow({ mode: "open" });
    const en = language === "en";
    const iconUrl = chrome.runtime.getURL("icon128.png");
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

  chrome.runtime.onMessage.addListener((message) => {
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
  });

  window.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("wheel", userStartedReading, { passive: true });
  window.addEventListener("touchstart", userStartedReading, { passive: true });
  window.addEventListener("pointerdown", userStartedReading, { passive: true });
  window.addEventListener("keydown", userStartedReading, { passive: true });
  window.addEventListener("pagehide", sendPosition);
})();
