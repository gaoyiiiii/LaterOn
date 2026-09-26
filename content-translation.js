async function togglePageTranslation() {
  const translationClass = "lateron-inline-translation";
  const statusId = "lateron-translation-status";
  const stateKey = "__laterOnTranslationRun";
  const previousRun = window[stateKey];
  const existing = [...document.querySelectorAll(`.${translationClass}`)];

  const status = (text, autoHide = false) => {
    let element = document.getElementById(statusId);
    if (!element) {
      element = document.createElement("div");
      element.id = statusId;
      document.documentElement.appendChild(element);
    }
    element.classList.remove("lateron-status-leaving");
    element.textContent = text;
    if (autoHide) {
      window.setTimeout(() => {
        element.classList.add("lateron-status-leaving");
        window.setTimeout(() => element.remove(), 220);
      }, 2200);
    }
    return element;
  };

  if (existing.length || previousRun?.active) {
    if (previousRun) previousRun.cancelled = true;
    existing.forEach((element) => element.remove());
    document.getElementById(statusId)?.remove();
    status("已恢复原文", true);
    window[stateKey] = { active: false, cancelled: true };
    return { ok: true, removed: true };
  }

  const run = { active: true, cancelled: false };
  window[stateKey] = run;

  try {
    if (!("Translator" in self)) throw new Error("当前 Chrome 不支持本机网页翻译，请升级浏览器");

    const roots = [document.querySelector("article"), document.querySelector("main"), document.body].filter(Boolean);
    const root = roots.find((candidate) => candidate.querySelectorAll("p").length >= 3) || roots[0];
    if (!root) throw new Error("没有识别到可翻译的正文");

    const selector = "p, h1, h2, h3, h4, blockquote, figcaption";
    const excluded = "nav, header, footer, aside, form, pre, code, script, style, noscript, [contenteditable='true']";
    const candidates = [...root.querySelectorAll(selector)];
    const blocks = candidates.filter((element) => {
      if (element.closest(excluded) || element.closest(`.${translationClass}`) || element.querySelector(selector)) return false;
      const text = element.innerText?.replace(/\s+/g, " ").trim() || "";
      if (text.length < 8 || text.length > 1800) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 40 && rect.height > 5 && style.display !== "none" && style.visibility !== "hidden";
    }).slice(0, 160);
    if (!blocks.length) throw new Error("没有识别到可翻译的正文");

    const sample = blocks.slice(0, 24).map((element) => element.innerText.trim()).join("\n").slice(0, 6000);
    const compactSample = sample.replace(/\s/g, "");
    const hanRatio = (compactSample.match(/[\u3400-\u9fff]/g) || []).length / Math.max(1, compactSample.length);
    if (hanRatio > 0.35) throw new Error("当前网页正文已经是中文");

    let sourceLanguage = (root.lang || document.documentElement.lang || "").trim().toLowerCase().split(/[-_]/)[0];
    if (!sourceLanguage || sourceLanguage === "zh") {
      if ("LanguageDetector" in self && (await LanguageDetector.availability()) !== "unavailable") {
        const detector = await LanguageDetector.create({
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              status(`正在准备语言识别… ${Math.round(event.loaded * 100)}%`);
            });
          }
        });
        const detected = await detector.detect(sample);
        sourceLanguage = detected[0]?.detectedLanguage?.split(/[-_]/)[0] || "";
        detector.destroy?.();
      }
    }
    if (!sourceLanguage || sourceLanguage === "und") sourceLanguage = "en";
    if (sourceLanguage === "zh") throw new Error("当前网页正文已经是中文");

    const options = { sourceLanguage, targetLanguage: "zh" };
    if (await Translator.availability(options) === "unavailable") {
      throw new Error(`暂不支持从 ${sourceLanguage} 翻译为中文`);
    }

    const translator = await Translator.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          status(`首次使用，正在下载本机翻译模型… ${Math.round(event.loaded * 100)}%`);
        });
      }
    });

    const typographyProperties = [
      "color",
      "direction",
      "font-family",
      "font-size",
      "font-style",
      "font-weight",
      "letter-spacing",
      "line-height",
      "margin-bottom",
      "margin-left",
      "margin-right",
      "margin-top",
      "text-align",
      "text-decoration",
      "text-indent",
      "white-space"
    ];

    const buildTranslationElement = (block, translated) => {
      const element = document.createElement("div");
      element.className = translationClass;
      element.lang = "zh-CN";
      element.setAttribute("aria-label", "中文译文");
      const originalStyle = getComputedStyle(block);
      typographyProperties.forEach((property) => {
        const value = originalStyle.getPropertyValue(property);
        if (value) element.style.setProperty(property, value, "important");
      });
      element.textContent = translated;
      return element;
    };

    let translatedCount = 0;
    let cursor = 0;
    const CONCURRENCY = 6;
    const worker = async () => {
      while (cursor < blocks.length && !run.cancelled) {
        const block = blocks[cursor++];
        status(`正在翻译网页… ${Math.min(cursor, blocks.length)}/${blocks.length}`);
        const original = block.innerText.replace(/\s+/g, " ").trim();
        try {
          const translated = (await translator.translate(original)).trim();
          if (!translated || run.cancelled || translated === original) continue;
          block.insertAdjacentElement("afterend", buildTranslationElement(block, translated));
          translatedCount += 1;
        } catch {
          // 单个段落出错不应中断整页翻译。
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));

    translator.destroy?.();
    run.active = false;

    if (run.cancelled) return { ok: true, removed: true };
    if (!translatedCount) throw new Error("没有生成可显示的译文");
    status(`已翻译 ${translatedCount} 段 · 再按 Alt+2 恢复原文`, true);
    return { ok: true, translatedCount, sourceLanguage };
  } catch (error) {
    run.active = false;
    status(error?.message || "网页翻译失败", true);
    return { ok: false, error: error?.message || "网页翻译失败" };
  }
}

togglePageTranslation();
