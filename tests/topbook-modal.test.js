// 回归测试：topbook.cc 这类「弹窗式文章」站点，必须抓到正确的标题与封面。
//
// 背景（2026-09 用无头 Chrome 实测 topbook.cc）：
//   从首页点开一篇文章是「弹窗」，网址靠 pushState 变成 /article/2018，
//   但 head 里的 og 标签**根本不会更新**，还停留在首页那套：
//     document.title = "Topbook -工具、技术和数字生活"
//     og:title       = "Topbook - 工具、技术和数字生活"
//     og:image       = https://cdn.labs.topbook.cc/icon.png   ← 站点小图标！
//   弹窗内的正文标题是唯一的 h1（CSS-module 哈希类名，但 h1 本身可定位）；
//   视频是 B 站 iframe 播放器，页面上没有 video/poster。
//   而直接向服务器请求 /article/2018，返回的 HTML 里却带着正确的 og 标签（SSR）。
//
// 修复方式（两层）：
//   ① 页面内：弹窗渲染完后，h1 能兜住标题（dom-headline 一路，已有逻辑）；
//   ② 后台兜底：当「封面是图标 / 标题是站点通用值」时，background 重新请求
//      当前网址，用服务器 HTML 里的 og 标签补齐（refetchMetaFromServer）。
//
// 夹具 fixtures/topbook-modal.html 是弹窗打开状态下的完整真实 DOM。
//
// 运行：NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node tests/topbook-modal.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const PAGE_SCRIPT = fs.readFileSync(path.join(ROOT, "content-metadata.js"), "utf8");
const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "topbook-modal.html"), "utf8");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

// 从 background.js 里整段抽出真实函数（依赖「顶层函数闭合括号顶格」的代码风格）。
function grabFunction(source, name) {
  const matched = new RegExp(`^(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?^\\}`, "m").exec(source);
  if (!matched) throw new Error(`没找到函数 ${name}`);
  return matched[0];
}
function grabConst(source, name) {
  const matched = new RegExp(`^const ${name} = [^;]+;`, "m").exec(source);
  if (!matched) throw new Error(`没找到常量 ${name}`);
  return matched[0];
}

const PAGE_SOURCE = grabFunction(PAGE_SCRIPT, "extractPageMetadataForShortcut");
const BACKGROUND_SOURCE = [
  grabConst(BACKGROUND, "EXTRACT_TIMEOUT_MS"),
  grabConst(BACKGROUND, "DOUYIN_SETTLE_MS"),
  grabConst(BACKGROUND, "DOUYIN_POLL_MS"),
  grabConst(BACKGROUND, "SERVER_META_TIMEOUT_MS"),
  grabFunction(BACKGROUND, "withTimeout"),
  grabFunction(BACKGROUND, "safeHostname"),
  grabFunction(BACKGROUND, "isDouyinUrl"),
  grabFunction(BACKGROUND, "douyinVideoIdFromUrl"),
  grabFunction(BACKGROUND, "probeDouyinFreshness"),
  grabFunction(BACKGROUND, "settleDouyinDom"),
  grabFunction(BACKGROUND, "isIconLikeImage"),
  grabFunction(BACKGROUND, "refetchMetaFromServer"),
  grabFunction(BACKGROUND, "applyServerMetaRescue"),
  grabFunction(BACKGROUND, "isPlaceholderText"),
  grabFunction(BACKGROUND, "titleHasSiteNoise"),
  grabFunction(BACKGROUND, "mergeDuplicateMetadata"),
  grabFunction(BACKGROUND, "readTabMetadata"),
  grabFunction(BACKGROUND, "extractTabMetadata")
].join("\n\n");

const ARTICLE_TITLE = "AI 沟通技巧系列 ② 构建启发式 AI #人工智能 #双向费曼 # AI沟通";
const ARTICLE_COVER = "https://cdn.labs.topbook.cc/topbook/img/pic-2014-3.jpg?imageView2/1/w/500/h/400/q/85";
const SITE_ICON = "https://cdn.labs.topbook.cc/icon.png";
const ARTICLE_URL = "https://topbook.cc/article/2018";

// 服务器对 /article/2018 返回的 HTML（curl 实测，节选关键 meta）。
const SERVER_HTML = `<!doctype html>
<html lang="zh-cmn-Hans"><head>
  <title>Topbook – ${ARTICLE_TITLE}</title>
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${ARTICLE_TITLE}" />
  <meta property="og:description" content="这可能是最适合所有人的 AI 沟通框架。" />
  <meta property="og:url" content="${ARTICLE_URL}" />
  <meta property="og:image" content="${ARTICLE_COVER}" />
  <meta name="twitter:card" content="summary_large_image" />
</head><body>…</body></html>`;

// ── 第 1 部分：页面内提取（真实 extractor × 真实弹窗 DOM）──────────
console.log("\n页面内提取（弹窗已渲染完成）");
function runPageExtractor(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const context = dom.getInternalVMContext ? dom.getInternalVMContext() : vm.createContext(dom.window);
  vm.runInContext(PAGE_SOURCE, context);
  return vm.runInContext("extractPageMetadataForShortcut()", context);
}

const pageMeta = runPageExtractor(FIXTURE, ARTICLE_URL);

check("标题来自弹窗里的 h1", pageMeta.title === ARTICLE_TITLE, `titleFrom=${pageMeta.titleFrom}`);
check("og:image 是站点图标（这正是要兜底的问题）", pageMeta.image === SITE_ICON && pageMeta.imageFrom === "share");

// ── 第 2 部分：后台完整链路（真实 extractTabMetadata × 假 chrome）──
function makeBareSandbox(extra = {}) {
  const sandbox = {
    // Service Worker 里有 URL / clearTimeout，裸沙盒里没有，得手动补齐。
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    ...extra
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SOURCE, sandbox);
  return sandbox;
}

function makeSandbox({ injected, serverHtml, tab }) {
  const state = { fetches: [], injections: 0 };
  const chromeStub = {
    scripting: {
      executeScript: async () => {
        state.injections += 1;
        return [{ result: injected }];
      }
    }
  };
  const sandbox = {
    chrome: chromeStub,
    // Service Worker 里有 URL / clearTimeout，裸沙盒里没有，得手动补齐。
    URL,
    URLSearchParams,
    fetch: async (url) => {
      state.fetches.push(String(url));
      return {
        ok: true,
        headers: { get: () => (serverHtml ? "text/html" : "application/json") },
        text: async () => serverHtml || ""
      };
    },
    setTimeout,
    clearTimeout,
    console,
    extractPageMetadataForShortcut() {
      return null; // 仅作为 executeScript 的 func 身份标识，不会真的执行
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SOURCE, sandbox);
  return { sandbox, state };
}

const baseTab = {
  id: 1,
  url: ARTICLE_URL,
  title: "Topbook -工具、技术和数字生活",
  favIconUrl: SITE_ICON
};

async function runExtractTabMetadata(setup) {
  const { sandbox, state } = makeSandbox(setup);
  const result = await vm.runInContext("extractTabMetadata(TAB)", sandbox, { timeout: 10000 });
  return { result, state };
}
// TAB 由各用例放进沙盒；这里统一包一层。
async function extractWith(setup) {
  const { sandbox, state } = makeSandbox(setup);
  sandbox.TAB = setup.tab;
  const result = await vm.runInContext("extractTabMetadata(TAB)", sandbox, { timeout: 10000 });
  return { result, state };
}

(async () => {
  console.log("\n后台兜底：弹窗已渲染（标题已对，封面是图标 → 只补封面）");
  {
    const { result, state } = await extractWith({ injected: pageMeta, serverHtml: SERVER_HTML, tab: baseTab });
    check("封面被服务端 og:image 替换", result.image === ARTICLE_COVER, `imageFrom=${result.imageFrom}`);
    check("imageFrom 标记为 server", result.imageFrom === "server");
    check("标题保持 h1 的结果不被覆盖", result.title === ARTICLE_TITLE && result.titleFrom === "dom-headline");
    check("向当前网址发起了 1 次兜底请求", state.fetches.length === 1 && state.fetches[0] === ARTICLE_URL);
  }

  console.log("\n后台兜底：弹窗还没渲染完（h1 不存在，标题只剩首页那套）");
  {
    const { result } = await extractWith({
      injected: {
        title: "Topbook - 工具、技术和数字生活",
        titleFrom: "share",
        description: "关注数字工具和技术，以及它们如何影响生活。",
        image: SITE_ICON,
        imageFrom: "share",
        favicon: SITE_ICON,
        source: "Topbook",
        url: ARTICLE_URL,
        videoId: ""
      },
      serverHtml: SERVER_HTML,
      tab: baseTab
    });
    check("标题被服务端 og:title 替换", result.title === ARTICLE_TITLE, `titleFrom=${result.titleFrom}`);
    check("titleFrom 标记为 server", result.titleFrom === "server");
    check("封面被服务端 og:image 替换", result.image === ARTICLE_COVER);
  }

  console.log("\n后台兜底：注入完全失败（连标签页标题都是首页的）");
  {
    const { result } = await extractWith({
      injected: null,
      serverHtml: SERVER_HTML,
      tab: baseTab
    });
    // 注入失败走 fallback（titleFrom=tab），但仍然要被服务端 meta 救回来。
    check("标题被服务端 og:title 替换", result.title === ARTICLE_TITLE, `实际=${result.title}`);
    check("封面被服务端 og:image 替换", result.image === ARTICLE_COVER, `实际=${result.image}`);
  }

  console.log("\n信息本来就齐全：不发兜底请求");
  {
    const { state } = await extractWith({
      injected: {
        title: "一篇完全正常的文章标题",
        titleFrom: "share",
        description: "正常的摘要。",
        image: "https://example.com/cover/abc.jpg",
        imageFrom: "share",
        favicon: "https://example.com/favicon.ico",
        source: "示例网",
        url: "https://example.com/post/1",
        videoId: ""
      },
      serverHtml: SERVER_HTML,
      tab: { id: 2, url: "https://example.com/post/1", title: "一篇完全正常的文章标题" }
    });
    check("没有发起任何兜底请求", state.fetches.length === 0, `实际 ${state.fetches.length} 次`);
  }

  console.log("\n重复收藏：旧的图标封面要能被真封面替换");
  {
    const sandbox = makeBareSandbox();
    const changed = vm.runInContext(
      `mergeDuplicateMetadata(
         { title: ${JSON.stringify(ARTICLE_TITLE)}, image: ${JSON.stringify(SITE_ICON)}, description: "旧摘要", url: ${JSON.stringify(ARTICLE_URL)} },
         { title: ${JSON.stringify(ARTICLE_TITLE)}, image: ${JSON.stringify(ARTICLE_COVER)}, description: "旧摘要", url: ${JSON.stringify(ARTICLE_URL)} }
       )`,
      sandbox
    );
    check("图标封面被替换", changed === true);
  }
  {
    const sandbox = makeBareSandbox();
    const changed = vm.runInContext(
      `mergeDuplicateMetadata(
         { title: "旧标题", image: "https://example.com/old-cover.jpg", description: "旧摘要", url: "https://example.com/post/1" },
         { title: "旧标题", image: "https://example.com/new-cover.jpg", description: "旧摘要", url: "https://example.com/post/1" }
       )`,
      sandbox
    );
    check("正常封面不被动", changed === false);
  }

  console.log("\nisIconLikeImage 基本判断");
  {
    const sandbox = makeBareSandbox();
    const cases = [
      ["https://cdn.labs.topbook.cc/icon.png", true],
      ["https://example.com/favicon.ico", true],
      ["https://example.com/apple-touch-icon.png", true],
      ["https://example.com/wp-content/uploads/2024/05/iconic-photo.jpg", false],
      ["https://example.com/topbook/img/pic-2014-3.jpg", false],
      ["", false]
    ];
    for (const [url, expected] of cases) {
      const actual = vm.runInContext(`isIconLikeImage(${JSON.stringify(url)})`, sandbox);
      check(`${url || "(空)"} → ${expected}`, actual === expected);
    }
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
