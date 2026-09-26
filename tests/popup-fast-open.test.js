// 点图标弹出的小窗口「不再等后台」测试。
// 后台（service worker）冷启动可能要好几秒，以前弹窗是等它返回才画界面，
// 用户看到的就是一片空白等十几秒。现在改成两段式：先用标签页自带的信息立刻画出来。
// 覆盖：
//  1) 后台迟迟不回（模拟冷启动）时，标题/来源/收藏按钮照样立刻可用
//  2) 后台稍后返回时，封面和标题会被补上（渐进增强）
//  3) 耗时写进了 laterOnPopupDiag，设置页能看到
// 运行：NODE_PATH=<jsdom 路径> node tests/popup-fast-open.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/popup.html`, "utf8");
const popupSource = fs.readFileSync(`${ROOT}/popup.js`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// sendMessage 的行为由 reply 决定：
//   "never" —— 永远不回（模拟后台冷启动，界面不能跟着一起卡住）
//   function —— 返回一个应答
function boot({ reply = "never", tab = { id: 1, url: "https://example.com/post", title: "原标题", favIconUrl: "" } } = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
  virtualConsole.on("error", (message) => errors.push(String(message)));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/popup.html",
    virtualConsole
  });
  const { window } = dom;
  const { document } = window;

  const store = {};
  const sent = [];
  window.chrome = {
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: async (patch) => { for (const [k, v] of Object.entries(patch)) store[k] = v; }
      }
    },
    tabs: { query: () => Promise.resolve([tab]) },
    runtime: {
      sendMessage: (message) => {
        sent.push(message.type);
        if (reply === "never") return new Promise(() => {});   // 永不 resolve
        return Promise.resolve(reply(message));
      }
    },
    sidePanel: { open: () => Promise.resolve() }
  };

  window.eval(popupSource);
  return { window, document, store, sent, errors };
}

(async () => {
  console.log("── 后台迟迟不回（冷启动）时，界面照样立刻可用 ──");
  const cold = boot({ reply: "never" });
  await tick();
  check("标题用的是标签页自带信息，不用等后台",
    cold.document.querySelector("#previewTitle").textContent === "原标题",
    cold.document.querySelector("#previewTitle").textContent);
  check("来源是网址域名",
    cold.document.querySelector("#previewSource").textContent === "example.com",
    cold.document.querySelector("#previewSource").textContent);
  check("收藏按钮立刻可点（不再灰着等）",
    cold.document.querySelector("#saveButton").disabled === false);
  check("报错提示是空的（没被误判成读不到页面）",
    cold.document.querySelector("#message").textContent === "",
    cold.document.querySelector("#message").textContent);
  check("耗时记进 laterOnPopupDiag", typeof cold.store.laterOnPopupDiag?.ready === "number",
    JSON.stringify(cold.store.laterOnPopupDiag));

  console.log("\n── 后台稍后返回，再补上封面和更准确的标题 ──");
  const warm = boot({
    // 后台拖了 100 毫秒才回，用来验证「第一屏不跟着一起等」。
    reply: (message) => new Promise((resolve) => {
      setTimeout(() => {
        if (message.type !== "EXTRACT_METADATA") resolve({ ok: false });
        else resolve({ ok: true, metadata: { title: "抓到的标题", description: "摘要", image: "https://img.com/a.jpg", favicon: "", source: "example.com" } });
      }, 100);
    })
  });
  await tick();
  check("第一屏先用标签页信息（不等后台那 100 毫秒）",
    warm.document.querySelector("#previewTitle").textContent === "原标题",
    warm.document.querySelector("#previewTitle").textContent);
  check("第一屏收藏按钮已经可点",
    warm.document.querySelector("#saveButton").disabled === false);
  await tick(150);
  check("后台回来后标题被补上",
    warm.document.querySelector("#previewTitle").textContent === "抓到的标题",
    warm.document.querySelector("#previewTitle").textContent);
  check("封面也补上了",
    /img\.com/.test(warm.document.querySelector("#previewImage").style.backgroundImage),
    warm.document.querySelector("#previewImage").style.backgroundImage);
  check("诊断里记下了详情补全成功",
    warm.store.laterOnPopupDiag?.enhanced === true,
    JSON.stringify(warm.store.laterOnPopupDiag));

  console.log("\n── 内部页面（新标签页等）不该卡住，给一句提示即可 ──");
  const internal = boot({ reply: "never", tab: { id: 2, url: "chrome://newtab/", title: "新标签页" } });
  await tick();
  check("提示「这个页面无法收藏」",
    /无法收藏/.test(internal.document.querySelector("#message").textContent),
    internal.document.querySelector("#message").textContent);
  check("收藏按钮保持禁用",
    internal.document.querySelector("#saveButton").disabled === true);

  console.log("\n── 首屏资源：外部文件再慢也先画出弹窗轮廓 ──");
  const headOnly = html.slice(0, html.indexOf("</head>"));
  const noscriptFree = headOnly.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  const cssLinks = [...noscriptFree.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
  check("弹窗首屏关键样式已内联", /<style>[\s\S]*?\.preview[\s\S]*?\.save[\s\S]*?<\/style>/.test(headOnly));
  check("外部 CSS 不再阻塞首屏",
    cssLinks.length > 0 && cssLinks.every((tag) => tag.includes("data-boot-style") && tag.includes('media="print"')));
  check("外部脚本都使用 defer，不阻塞 body 解析",
    ["boot.js", "popup.js"].every((name) => headOnly.includes(`<script src="${name}" defer></script>`)));
  check("弹窗不再加载没有使用的 dialog 组件", !/dialog\.(css|js)/.test(headOnly));

  const allErrors = [...cold.errors, ...warm.errors, ...internal.errors];
  check("没有脚本报错", allErrors.length === 0, allErrors.join(" | "));

  console.log(`\n${failures === 0 ? "🎉 全部通过" : `❌ 有 ${failures} 项没通过`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
