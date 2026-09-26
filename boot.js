// 启动阶段的小助手：页面文档一进来就把「正在打开…」的骨架屏守在那里，
// 让任何情况下都不是一块白屏；顺带把各阶段耗时记下来，方便排查「打开慢」到底慢在哪一步。
// 必须放在 <head> 里最先加载（早于 body 解析），这样计时从页面一开始就算起。
(function () {
  // 本脚本使用 defer，让 HTML 里的骨架能先被解析、先画出来。计时仍从导航
  // 开始算（performance.now() 的 0 点），不能从脚本终于执行时才开始算。
  const t0 = (window.performance && performance.now) ? 0 : Date.now();
  const elapsed = () => Math.round((((window.performance && performance.now) ? performance.now() : Date.now()) - t0));
  const marks = [];
  let revealed = false;

  function textOf(id) {
    return document.getElementById(id);
  }

  // ── 异步样式表 ────────────────────────────────────────────
  // <head> 里的样式表是 media="print"（先不生效），这样它们不阻塞首屏渲染：
  // 浏览器可以先把内联样式支撑的骨架屏画出来。这里等它们一下载好就切换成生效。
  function activateStyles() {
    const links = document.querySelectorAll("link[data-boot-style]");
    for (const link of links) {
      if (link.media === "all") continue;
      // link.sheet 有值 = 这份样式表已经下载并解析好了。
      if (link.sheet) link.media = "all";
      else link.addEventListener("load", activateStyles, { once: true });
    }
  }
  // 多打几个时间点：样式表可能在脚本跑之前就OK了，也可能慢一点。
  activateStyles();
  document.addEventListener("DOMContentLoaded", activateStyles);
  [300, 1200, 4000].forEach((ms) => setTimeout(activateStyles, ms));

  // 收工：撤掉骨架屏，让真界面露面。重复调用无副作用。
  function reveal() {
    revealed = true;
    clearInterval(timer);
    const skeleton = textOf("bootSkeleton");
    if (skeleton) skeleton.remove();
    const tip = textOf("bootTip");
    if (tip) tip.remove();
    if (document.body) document.body.classList.remove("booting");
  }

  const timer = setInterval(() => {
    if (revealed) { clearInterval(timer); return; }
    const ms = elapsed();
    const tip = textOf("bootTip");
    // 快的时候（1.2 秒内）界面保持干净，只有确实等住了才把提示条亮出来。
    if (ms > 1200 && tip) tip.hidden = false;
    if (tip && !tip.hidden) {
      const time = textOf("bootTipTime");
      if (time) time.textContent = `${(ms / 1000).toFixed(1)} 秒`;
      // 等太久了给一句实话 + 一个可操作的建议，而不是让人干瞪眼。
      if (ms > 6000) {
        const hint = textOf("bootTipHint");
        if (hint) hint.textContent = "加载比平时慢，可以先试试关掉侧栏再打开；一直这样就在扩展页点一下「重新加载」。";
      }
    }
    // 兜底：万一页面脚本整个没跑起来（极端异常），也不能让用户永远盯着骨架屏。
    if (ms > 12000) reveal();
  }, 200);

  window.LaterOnBoot = {
    t0,
    // 切换提示语：告诉用户现在卡在读数据还是画界面。
    stage(label) {
      marks.push([label, elapsed()]);
      try { console.info(`[LaterOn] ${label} +${elapsed()}ms`); } catch {}
      const el = textOf("bootTipText");
      if (el) el.textContent = label;
    },
    // 各阶段耗时（毫秒），以后排查用。
    timings() {
      return { total: elapsed(), marks: marks.slice() };
    },
    // 内容画出来了，收工。
    done: reveal,
    reveal
  };
})();
