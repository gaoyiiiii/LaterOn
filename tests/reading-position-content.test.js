// 网页端只保存 scrollY，并由用户点击“继续上次位置”后恢复。
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "..", "content-reading-position.js"), "utf8");
const dom = new JSDOM("<!doctype html><html><body><main style='height:5000px'></main></body></html>", {
  runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.com/article"
});
const { window } = dom;
const messages = [];
const scrollCalls = [];
let listener = null;
let scrollY = 0;
Object.defineProperty(window, "scrollY", { get: () => scrollY });
Object.defineProperty(window, "pageYOffset", { get: () => scrollY });
window.scrollTo = (options) => { scrollCalls.push(options); scrollY = Number(options?.top) || 0; };
window.chrome = {
  runtime: {
    getURL(file) { return `chrome-extension://lateron/${file}`; },
    onMessage: { addListener(fn) { listener = fn; } },
    sendMessage(message) { messages.push(message); return Promise.resolve({ ok: true }); }
  }
};
window.eval(source);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? `  → ${extra}` : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

(async () => {
  listener({ type: "LATERON_READING_POSITION_INIT", itemId: "a", y: 820, language: "zh-CN" });
  const host = window.document.querySelector("#lateron-reading-position");
  check("有历史位置时显示轻量提示", !!host);
  check("提示只说继续上次位置", host?.shadowRoot?.querySelector(".resume")?.textContent === "继续上次位置");
  check("提示固定在网页右侧垂直居中并留出呼吸距离", /right:28px;top:50%;transform:translateY\(-50%\)/.test(host?.shadowRoot?.querySelector("style")?.textContent || ""));
  check("提示使用完整药丸轮廓", /border-radius:999px/.test(host?.shadowRoot?.querySelector("style")?.textContent || ""));
  check("提示使用当前 LaterOn 图标", host?.shadowRoot?.querySelector(".mark")?.getAttribute("src") === "chrome-extension://lateron/icon128.png");
  check("Logo 为圆形，文字热区留出 20px 横向内边距", /\.mark\{[^}]*border-radius:50%/.test(host?.shadowRoot?.querySelector("style")?.textContent || "")
    && /\.resume\{padding:12px 20px/.test(host?.shadowRoot?.querySelector("style")?.textContent || ""));
  check("关闭按钮使用居中的 SVG，而不是字体乘号", !!host?.shadowRoot?.querySelector(".close svg"));
  check("尚未选择时不会用页面顶部覆盖旧位置", messages.length === 0);

  host.shadowRoot.querySelector(".resume").click();
  await tick(1200);
  check("用户确认后滚回保存的位置", scrollCalls.some((call) => call.top === 820), JSON.stringify(scrollCalls));
  check("恢复后继续记录同一个位置", messages.at(-1)?.itemId === "a" && messages.at(-1)?.y === 820, JSON.stringify(messages.at(-1)));

  scrollY = 0;
  listener({ type: "LATERON_READING_POSITION_INIT", itemId: "b", y: 900, language: "zh-CN" });
  check("新页面初始化时先保护旧位置", window.__laterOnReadingPosition.armed === false, String(window.__laterOnReadingPosition.armed));
  window.dispatchEvent(new window.Event("scroll"));
  await tick(550);
  check("只有页面自己滚动、用户未操作时不覆盖历史位置", messages.filter((message) => message.itemId === "b").length === 0, JSON.stringify(messages));

  window.dispatchEvent(new window.WheelEvent("wheel"));
  scrollY = 360;
  window.dispatchEvent(new window.Event("scroll"));
  await tick(550);
  check("用户开始阅读后只保存 scrollY", messages.at(-1)?.itemId === "b" && messages.at(-1)?.y === 360, JSON.stringify(messages.at(-1)));
  check("保存内容没有百分比或时间字段", Object.keys(messages.at(-1) || {}).sort().join(",") === "itemId,type,y", Object.keys(messages.at(-1) || {}).join(","));

  listener({ type: "LATERON_READING_POSITION_INIT", itemId: "c", y: 0, language: "en" });
  check("位置还在顶部时不打扰用户", !window.document.querySelector("#lateron-reading-position"));

  console.log(failures ? `\n❌ 有 ${failures} 项失败` : "\n🎉 全部通过");
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
