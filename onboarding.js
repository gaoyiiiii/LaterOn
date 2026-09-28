(function () {
  "use strict";

  const SEEN_KEY = "laterOnOnboardingSeen";

  const t = (key, vars) => window.LaterOnI18n?.t(key, vars) || key;

  function shouldForceOpen() {
    try { return new URLSearchParams(window.location.search).get("guide") === "1"; }
    catch { return false; }
  }

  async function markSeen() {
    try { await chrome.storage.local.set({ [SEEN_KEY]: true }); } catch {}
  }

  function open() {
    document.querySelector(".lon-guide")?.remove();
    let step = 0;
    let closing = false;
    const steps = [
      { icon: "+", title: "guideStepSaveTitle", body: "guideStepSaveBody", hint: "guideStepSaveHint" },
      { icon: "◎", title: "guideStepInboxTitle", body: "guideStepInboxBody", hint: "guideStepInboxHint" },
      { icon: "⛶", title: "guideStepReadTitle", body: "guideStepReadBody", hint: "guideStepReadHint" }
    ];

    const root = document.createElement("div");
    root.className = "lon-guide";
    root.innerHTML = `
      <div class="lon-guide-backdrop"></div>
      <section class="lon-guide-card" role="dialog" aria-modal="true" aria-labelledby="lon-guide-title" tabindex="-1">
        <div class="lon-guide-brand"><img src="icon128.png" alt="" />LaterOn</div>
        <div class="lon-guide-progress" aria-hidden="true"></div>
        <div class="lon-guide-page">
          <div class="lon-guide-icon" aria-hidden="true"></div>
          <h2 id="lon-guide-title"></h2>
          <p class="lon-guide-body"></p>
          <p class="lon-guide-hint"></p>
        </div>
        <footer>
          <button type="button" class="lon-guide-skip"></button>
          <button type="button" class="lon-guide-next"></button>
        </footer>
      </section>`;
    document.body.append(root);

    const card = root.querySelector(".lon-guide-card");
    const page = root.querySelector(".lon-guide-page");
    let transitioning = false;
    const render = () => {
      const current = steps[step];
      root.querySelector(".lon-guide-icon").textContent = current.icon;
      root.querySelector("h2").textContent = t(current.title);
      root.querySelector(".lon-guide-body").textContent = t(current.body);
      root.querySelector(".lon-guide-hint").textContent = t(current.hint);
      root.querySelector(".lon-guide-skip").textContent = t("guideSkip");
      root.querySelector(".lon-guide-next").textContent = step === steps.length - 1 ? t("guideFinish") : t("guideNext");
      root.querySelector(".lon-guide-progress").replaceChildren(...steps.map((_, index) => {
        const dot = document.createElement("span");
        dot.className = index === step ? "active" : "";
        return dot;
      }));
    };
    const close = () => {
      if (closing) return;
      closing = true;
      void markSeen();
      root.classList.add("is-leaving");
      window.setTimeout(() => root.remove(), 180);
    };
    root.querySelector(".lon-guide-skip").addEventListener("click", close);
    root.querySelector(".lon-guide-next").addEventListener("click", () => {
      if (transitioning) return;
      if (step >= steps.length - 1) { close(); return; }
      transitioning = true;
      page.classList.add("is-leaving");
      window.setTimeout(() => {
        step += 1;
        render();
        page.classList.remove("is-leaving");
        page.classList.add("is-entering");
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          page.classList.remove("is-entering");
          transitioning = false;
        }));
      }, 150);
    });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Enter") root.querySelector(".lon-guide-next").click();
    });
    render();
    window.requestAnimationFrame(() => root.classList.add("is-visible"));
    card.focus({ preventScroll: true });
  }

  async function init() {
    await window.LaterOnI18n?.ready;
    let seen = false;
    try { seen = !!(await chrome.storage.local.get(SEEN_KEY))[SEEN_KEY]; } catch {}
    if (!seen || shouldForceOpen()) window.setTimeout(open, 220);
  }

  window.LaterOnOnboarding = { open, markSeen };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
