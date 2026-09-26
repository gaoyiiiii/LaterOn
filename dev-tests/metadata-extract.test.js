// 回归测试：网页信息提取（重点覆盖 YouTube 这类「单页应用」）
//
// 背景（已实测确认）：YouTube 站内点开另一个视频时，og:title / og:image /
// og:description 根本不会更新，还停在你最开始打开的那一页（通常就是首页那套
// 通用内容："YouTube" + youtube.com/img/desktop/yt_1200.png + 首页宣传语）。
// 只有手动刷新页面才会变对。
//
// 这个测试把「直接加载过 background.js 的真实提取函数」放进假 DOM 里跑，
// 确保各个场景都能抓到正确的内容，而不是把首页的信息当成视频的信息。
//
// 运行：node dev-tests/metadata-extract.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const PAGE_SCRIPT = fs.readFileSync(path.join(ROOT, "content-metadata.js"), "utf8");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `\n       → ${detail}` : ""}`);
  }
}

// ── 把真实的函数从 background.js 里整段取出来 ──────────────────
function extractFunctionSource(source, name) {
  const matched = new RegExp(`^function ${name}\\([^)]*\\)[\\s\\S]*?^}`, "m").exec(source);
  if (!matched) throw new Error(`没找到函数 ${name}`);
  return matched[0];
}

const EXTRACTOR_SOURCE = extractFunctionSource(PAGE_SCRIPT, "extractPageMetadataForShortcut");

// jsdom 不做真实布局，元素的尺寸恒为 0。而「挑最大的背景图 / 最大的懒加载图」
// 这类逻辑恰恰靠尺寸判断，所以这里给元素写 data-size="宽x高" 造一套假尺寸；
// 没写 data-size 的元素仍然是 0，与 jsdom 原生行为一致。
function installFakeSizes(dom) {
  const read = (node) => {
    const raw = node.getAttribute && node.getAttribute("data-size");
    if (!raw) return null;
    const parts = String(raw).split("x").map(Number);
    return { w: parts[0] || 0, h: parts[1] || 0 };
  };
  for (const proto of [dom.window.Element.prototype, dom.window.HTMLElement.prototype]) {
    for (const prop of ["clientWidth", "clientHeight"]) {
      try {
        Object.defineProperty(proto, prop, {
          configurable: true,
          get() {
            const size = read(this);
            if (!size) return 0;
            return prop === "clientWidth" ? size.w : size.h;
          }
        });
      } catch {}
    }
  }
}

// ── 在假 DOM 里执行这段真实代码 ────────────────────────────────
// runScripts 用 "outside-only"：不执行页面自己的脚本（我们只是读 <script> 的文本），
// 但允许我们把真实提取函数放进这个上下文里跑。
function runExtractor(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  installFakeSizes(dom);
  const context = dom.getInternalVMContext ? dom.getInternalVMContext() : vm.createContext(dom.window);
  vm.runInContext(EXTRACTOR_SOURCE, context);
  const result = vm.runInContext("extractPageMetadataForShortcut()", context);
  return { result, dom };
}

// ── 各种 YouTube 页面的假 DOM ──────────────────────────────────

// 场景 A：站内跳转后的真实状态 —— og 全是首页的通用内容，只有 DOM / 标题是新的
const SPA_STALE_HTML = `<!doctype html><html><head>
<title>真实视频标题 - YouTube</title>
<meta property="og:title" content="YouTube">
<meta property="og:image" content="https://www.youtube.com/img/desktop/yt_1200.png">
<meta property="og:description" content="在 YouTube 上畅享你喜爱的视频和音乐，上传原创内容并与亲朋好友和全世界观众分享你的视频。">
<meta property="og:site_name" content="YouTube">
<meta name="title" content="上一个视频的标题">
</head><body>
<ytd-watch-metadata>
  <h1><yt-formatted-string>真实视频标题</yt-formatted-string></h1>
  <div id="description-inline-expander">这是这个视频真实的简介文字，用来验证摘要不再抓到首页口号。</div>
</ytd-watch-metadata>
<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"上一个视频","title":"上一个视频的标题","shortDescription":"上一个视频的简介文字，不应该被采用。","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/上一个视频/hqdefault.jpg"}]}}};</script>
</body></html>`;

// 场景 B：整页直接打开 —— og 和内嵌数据都是对的
const FRESH_HTML = `<!doctype html><html><head>
<title>真实视频标题 - YouTube</title>
<meta property="og:title" content="真实视频标题">
<meta property="og:image" content="https://i.ytimg.com/vi/CURRENT123/maxresdefault.jpg">
<meta property="og:description" content="这是视频自己的简介，整页加载时抓到的是对的。">
<meta property="og:site_name" content="YouTube">
</head><body>
<ytd-watch-metadata>
  <h1><yt-formatted-string>真实视频标题</yt-formatted-string></h1>
  <div id="description-inline-expander">这是视频自己的简介，整页加载时抓到的是对的。</div>
</ytd-watch-metadata>
<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"CURRENT123","title":"真实视频标题","shortDescription":"内嵌数据里的简介","thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/CURRENT123/mqdefault.jpg"},{"url":"https://i.ytimg.com/vi/CURRENT123/maxresdefault.jpg"}]}}};</script>
</body></html>`;

// 场景 C：短视频（/shorts/）
const SHORTS_HTML = SPA_STALE_HTML.replace("<title>真实视频标题 - YouTube</title>", "<title>一个竖屏短视频 #shorts - YouTube</title>");

// 场景 D：YouTube 首页（没有视频 id，保持原样）
const HOME_HTML = `<!doctype html><html><head>
<title>YouTube</title>
<meta property="og:title" content="YouTube">
<meta property="og:image" content="https://www.youtube.com/img/desktop/yt_1200.png">
<meta property="og:description" content="在 YouTube 上畅享你喜爱的视频和音乐。">
<meta property="og:site_name" content="YouTube">
</head><body></body></html>`;

// 场景 E：普通网站（回归：行为必须和以前一致）
const NORMAL_HTML = `<!doctype html><html><head>
<title>文章标题 - 某博客</title>
<meta property="og:title" content="文章标题">
<meta property="og:image" content="https://blog.example.com/cover.png">
<meta property="og:description" content="这是一篇文章的摘要。">
<meta property="og:site_name" content="某博客">
</head><body><article><p>${"正文内容。".repeat(20)}</p></article></body></html>`;

console.log("=== 一、YouTube 站内跳转（og 停留在首页的通用内容）===");
{
  const { result } = runExtractor(SPA_STALE_HTML, "https://www.youtube.com/watch?v=CURRENT123");
  check("标题取到当前视频的真实标题", result.title === "真实视频标题", JSON.stringify(result.title));
  check(
    "封面按当前视频 id 重新拼出（而不是首页那张通用横幅）",
    result.image === "https://i.ytimg.com/vi/CURRENT123/maxresdefault.jpg",
    JSON.stringify(result.image)
  );
  check("简介取到视频自己的简介，而不是首页口号", result.description.includes("真实的简介"), JSON.stringify(result.description));
  check("没有把首页的通用标题「YouTube」当标题", !/^YouTube$/i.test(result.title), JSON.stringify(result.title));
  check("没有把上一个视频的内嵌数据当成当前视频", !/上一个视频/.test(JSON.stringify(result)), JSON.stringify(result).slice(0, 160));
  check("来源显示为 YouTube", result.source === "YouTube", JSON.stringify(result.source));
}

console.log("\n=== 二、整页直接打开（og 和内嵌数据都是对的）===");
{
  const { result } = runExtractor(FRESH_HTML, "https://www.youtube.com/watch?v=CURRENT123");
  check("标题正确", result.title === "真实视频标题", JSON.stringify(result.title));
  check("封面采用网站自己给的 maxresdefault", result.image.includes("/vi/CURRENT123/maxresdefault.jpg"), JSON.stringify(result.image));
  check("简介正确", /整页加载时抓到的是对的|内嵌数据里的简介/.test(result.description), JSON.stringify(result.description));
}

console.log("\n=== 三、短视频 /shorts/ ===");
{
  const { result } = runExtractor(SHORTS_HTML, "https://www.youtube.com/shorts/SHORT123");
  check("封面按 shorts 的 id 拼出", result.image === "https://i.ytimg.com/vi/SHORT123/maxresdefault.jpg", JSON.stringify(result.image));
  check("标题不再是被首页覆盖的「YouTube」", !/^YouTube$/i.test(result.title), JSON.stringify(result.title));
}

console.log("\n=== 四、youtu.be 短链 ===");
{
  const { result } = runExtractor(FRESH_HTML, "https://youtu.be/ABC123");
  check("能从短链里取出视频 id 并拼出封面", result.image.includes("/vi/ABC123/"), JSON.stringify(result.image));
}

console.log("\n=== 五、YouTube 首页（没有具体视频，保持原样）===");
{
  const { result } = runExtractor(HOME_HTML, "https://www.youtube.com/");
  // 「YouTube」是平台通用名、不含任何信息，提取层不再采信它；
  // 留空后由调用方改用浏览器标签页标题，用户看到的结果不变。
  check("平台通用名不再当作标题（留给浏览器标签页标题）", result.title === "", JSON.stringify(result.title));
  check("封面仍是网站提供的通用图（不做多余改动）", result.image.includes("yt_1200.png"), JSON.stringify(result.image));
}

console.log("\n=== 六、普通网站（回归：行为不变）===");
{
  const { result } = runExtractor(NORMAL_HTML, "https://blog.example.com/post-1");
  check("标题来自 og:title", result.title === "文章标题", JSON.stringify(result.title));
  check("封面来自 og:image", result.image === "https://blog.example.com/cover.png", JSON.stringify(result.image));
  check("摘要来自 og:description", result.description === "这是一篇文章的摘要。", JSON.stringify(result.description));
  check("来源来自 og:site_name", result.source === "某博客", JSON.stringify(result.source));
}

console.log("\n=== 七、封面降级链（maxresdefault 不存在时逐级降级）===");
{
  const librarySource = fs.readFileSync(path.join(ROOT, "library.js"), "utf8");
  const constPart = /^const COVER_CHAIN = \[[^\]]*\];/m.exec(librarySource)[0];
  const fnPart = /^function nextCoverFallback\(currentSrc\) \{[\s\S]*?^}/m.exec(librarySource)[0];
  const nextCoverFallback = new Function(`${constPart}\n${fnPart}\nreturn nextCoverFallback;`)();

  const yt = (file) => `https://i.ytimg.com/vi/ABC123/${file}`;
  check("maxresdefault → hq720", nextCoverFallback(yt("maxresdefault.jpg")) === yt("hq720.jpg"));
  check("hq720 → hqdefault", nextCoverFallback(yt("hq720.jpg")) === yt("hqdefault.jpg"));
  check("hqdefault → mqdefault", nextCoverFallback(yt("hqdefault.jpg")) === yt("mqdefault.jpg"));
  check("mqdefault 到底了就停（不再重试）", nextCoverFallback(yt("mqdefault.jpg")) === "");
  check("非 YouTube 的图不折腾", nextCoverFallback("https://blog.example.com/cover.png") === "");
  check("非标准文件名不误判", nextCoverFallback(yt("weird.jpg")) === "");
  check(
    "降级时去掉多余的查询参数",
    nextCoverFallback("https://i.ytimg.com/vi/ABC123/maxresdefault.jpg?sqp=xyz") === yt("hq720.jpg"),
    nextCoverFallback("https://i.ytimg.com/vi/ABC123/maxresdefault.jpg?sqp=xyz")
  );

  // 三个展示入口都要有这套降级，否则某一处仍会留白
  for (const file of ["library.js", "sidepanel.js", "popup.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    check(`${file} 里接了封面降级`, /COVER_CHAIN/.test(src) && /i\.ytimg\.com/.test(src));
  }
}

console.log("\n=== 八、只保留一份提取逻辑（不再各处复制）===");
{
  for (const file of ["popup.js", "sidepanel.js"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    check(`${file} 不再自带旧版提取函数`, !/function extractPageMetadata\s*\(/.test(src));
    check(`${file} 改为向后台请求提取`, /EXTRACT_METADATA/.test(src));
  }
  const handlerCount = (BACKGROUND.match(/message\.type === "EXTRACT_METADATA"/g) || []).length;
  check("后台只注册一处提取消息处理", handlerCount === 1, `出现 ${handlerCount} 次`);
  check("后台提供了 extractTabMetadataById", /^async function extractTabMetadataById\(tabId\)/m.test(BACKGROUND));
}

console.log("\n=== 九、重复收藏时会不会修好坏掉的旧记录 ===");
{
  const constFree = ["isPlaceholderText", "titleHasSiteNoise", "isIconLikeImage", "mergeDuplicateMetadata"]
    .map((name) => extractFunctionSource(BACKGROUND, name))
    .join("\n");
  const { mergeDuplicateMetadata, isPlaceholderText, titleHasSiteNoise } = new Function(
    `${constFree}\nreturn { mergeDuplicateMetadata, isPlaceholderText, titleHasSiteNoise };`
  )();

  const staleYouTube = {
    title: "YouTube",
    description: "在 YouTube 上畅享你喜爱的视频和音乐，上传原创内容并与亲朋好友和全世界观众分享你的视频。",
    image: "https://www.youtube.com/img/desktop/yt_1200.png",
    source: "YouTube",
    url: "https://www.youtube.com/watch?v=CURRENT123"
  };
  const freshMeta = {
    title: "真实视频标题",
    description: "这个视频真正的简介。",
    image: "https://i.ytimg.com/vi/CURRENT123/maxresdefault.jpg",
    source: "YouTube",
    url: "https://www.youtube.com/watch?v=CURRENT123"
  };
  const changed = mergeDuplicateMetadata(staleYouTube, freshMeta);
  check("YouTube 的旧记录会被刷新（标题/封面/摘要全部修好）", changed === true);
  check("  标题修好了", staleYouTube.title === "真实视频标题", staleYouTube.title);
  check("  封面修好了", staleYouTube.image.includes("/vi/CURRENT123/"), staleYouTube.image);
  check("  摘要修好了", staleYouTube.description === "这个视频真正的简介。", staleYouTube.description);

  const goodArticle = {
    title: "一篇文章",
    description: "原本的摘要",
    image: "https://blog.example.com/a.png",
    source: "某博客",
    url: "https://blog.example.com/post"
  };
  const untouched = JSON.parse(JSON.stringify(goodArticle));
  const changed2 = mergeDuplicateMetadata(goodArticle, {
    title: "网站上改了名的新标题",
    description: "网站上改了的新摘要",
    image: "https://blog.example.com/new.png",
    url: "https://blog.example.com/post"
  });
  check("普通网站信息齐全时不乱改（尊重你已看到的内容）", changed2 === false && JSON.stringify(goodArticle) === JSON.stringify(untouched), JSON.stringify(goodArticle));

  const missingImage = { title: "一篇文章", description: "摘要", image: "", source: "某博客", url: "https://blog.example.com/post" };
  check(
    "普通网站缺封面时会补上",
    mergeDuplicateMetadata(missingImage, { image: "https://blog.example.com/new.png", url: missingImage.url }) === true &&
      missingImage.image === "https://blog.example.com/new.png"
  );

  const placeholderTitle = { title: "某博客", description: "摘要", image: "x.png", source: "某博客", url: "https://blog.example.com/post" };
  check("标题只是站点通用名时会换成真实标题", isPlaceholderText("某博客", "某博客") === true);
  check(
    "  并且确实被替换",
    mergeDuplicateMetadata(placeholderTitle, { title: "真正的文章标题", url: placeholderTitle.url }) === true &&
      placeholderTitle.title === "真正的文章标题"
  );

  // 真实收藏里见过这种：标题尾巴上挂着站点名（「Frame analysis - Wikipedia」、
  // 「标题_哔哩哔哩_bilibili」）。重复收藏一次就该被换成干净的标题。
  const noisyTitle = { title: "深入理解闭包 - 某某网", description: "摘要", image: "a.png", source: "某某网", url: "https://blog.example.com/post" };
  check(
    "标题混着站点名时，重新收藏会换成干净的标题",
    mergeDuplicateMetadata(noisyTitle, { title: "深入理解闭包", source: "某某网", url: noisyTitle.url }) === true &&
      noisyTitle.title === "深入理解闭包",
    noisyTitle.title
  );

  // 反过来的保护：新标题只是域名/网址这种兜底值时，不能把好标题换掉。
  const goodKeep = { title: "一篇好文章", description: "摘要", image: "a.png", source: "某博客", url: "https://blog.example.com/post" };
  check(
    "新标题是域名兜底值时不会覆盖好标题",
    mergeDuplicateMetadata(goodKeep, { title: "blog.example.com", source: "某博客", url: goodKeep.url }) === false &&
      goodKeep.title === "一篇好文章",
    goodKeep.title
  );

  const keepDescription = { title: "标题", description: "原本好好的摘要", image: "a.png", source: "站", url: "https://blog.example.com/post" };
  check(
    "新抓到的摘要是「暂无摘要」时不会覆盖已有的好摘要",
    mergeDuplicateMetadata(keepDescription, { description: "暂无摘要", url: keepDescription.url }) === false &&
      keepDescription.description === "原本好好的摘要"
  );
  const keepTitle = { title: "好标题", description: "摘要", image: "a.png", source: "站", url: "https://www.youtube.com/watch?v=X" };
  check(
    "新抓到空标题时不会把原标题抹掉",
    mergeDuplicateMetadata(keepTitle, { title: "", url: keepTitle.url }) === false && keepTitle.title === "好标题"
  );
}

console.log("\n=== 十、特殊页面：内容图是 CSS 背景图的站点（小红书型）===");
{
  // 已实测确认：小红书不提供分享标签（og:image 只是平台 logo），
  // 真正的笔记封面是用 CSS 背景图画出来的，正文也不在 <p> 里。
  const XHS_NOTE_HTML = `<!doctype html><html><head>
<title>富贵少爷万剑穿心，开大名场面 - 小红书</title>
<meta property="og:image" content="//picasso-static.xiaohongshu.com/fe-platform/e6214e4fbfae2cf14d634d4296916e8a5eaefdf4.png">
</head><body>
<div class="note-detail">
  <div class="media-container">
    <div class="slider-img" data-size="600x800" style="background-image: url(&quot;https://sns-webpic-qc.xhscdn.com/2026091712/abc/notes_pre_post/1040g3k031abc!nd_dft_wlteh_webp_3&quot;); background-size: cover;"></div>
  </div>
  <div class="author">
    <div class="avatar" data-size="40x40" style="background-image: url('https://sns-avatar-qc.xhscdn.com/avatar/xyz.jpg')"></div>
  </div>
  <div id="detail-desc" class="desc">今天终于把这个片子剪完了，分享一下我的制作思路和踩过的坑，希望对大家有帮助。</div>
</div>
</body></html>`;

  const { result } = runExtractor(XHS_NOTE_HTML, "https://www.xiaohongshu.com/explore/6aaa741800000000260236fc");
  check(
    "封面取到笔记的真实图片（背景图），而不是平台 logo",
    result.image === "https://sns-webpic-qc.xhscdn.com/2026091712/abc/notes_pre_post/1040g3k031abc!nd_dft_wlteh_webp_3",
    JSON.stringify(result.image)
  );
  check("没把背景里的头像小图当封面", !/avatar/.test(result.image), JSON.stringify(result.image));
  check("摘要取到笔记正文（正文不在 <p> 里，靠容器兜底）", /剪完了/.test(result.description), JSON.stringify(result.description));
  check("标题仍取页面标题", /富贵少爷/.test(result.title), JSON.stringify(result.title));
  check("来源是该站域名", result.source === "xiaohongshu.com", JSON.stringify(result.source));
  check("自检能看出封面来自「背景图」这一层", result.imageFrom === "background", JSON.stringify(result.imageFrom));
}

console.log("\n=== 十一、视频笔记：封面挂在 video 的 poster 上 ===");
{
  const VIDEO_HTML = `<!doctype html><html><head>
<title>一个视频笔记 - 小红书</title>
<meta property="og:image" content="https://picasso-static.xiaohongshu.com/fe-platform/logo.png">
</head><body>
<video poster="https://sns-video-qc.xhscdn.com/stream/def!nd_dft_wlteh_webp_3" data-size="600x400"></video>
<div id="detail-desc">视频笔记的正文描述文字，长度足够被取作摘要。</div>
</body></html>`;
  const { result } = runExtractor(VIDEO_HTML, "https://www.xiaohongshu.com/explore/video-note-1");
  check(
    "封面取到 poster",
    result.image === "https://sns-video-qc.xhscdn.com/stream/def!nd_dft_wlteh_webp_3",
    JSON.stringify(result.image)
  );
  check("摘要取到视频笔记的正文", /视频笔记的正文/.test(result.description), JSON.stringify(result.description));
}

console.log("\n=== 十二、懒加载站点：真图藏在 data-src 里 ===");
{
  const LAZY_HTML = `<!doctype html><html><head>
<title>懒加载站点</title>
</head><body>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example.com/real-cover.jpg" data-size="640x360" alt="">
<img src="https://cdn.example.com/small-icon.png" data-size="32x32" alt="">
</body></html>`;
  const { result } = runExtractor(LAZY_HTML, "https://lazy.example.com/post");
  check("从 data-src 里拿到真封面（而不是 data: 占位图）", result.image === "https://cdn.example.com/real-cover.jpg", JSON.stringify(result.image));
}

console.log("\n=== 十三、结构化数据（JSON-LD）===");
{
  const JSONLD_HTML = `<!doctype html><html><head>
<title>新闻标题 - 某新闻站</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"结构化数据里的标题","description":"结构化数据里的摘要文字，用来说明发生了什么。","image":{"@type":"ImageObject","url":"https://news.example.com/photo.jpg"}}</script>
</head><body><main><p>短正文。</p></main></body></html>`;
  const { result } = runExtractor(JSONLD_HTML, "https://news.example.com/2026/story");
  check("封面来自 JSON-LD", result.image === "https://news.example.com/photo.jpg", JSON.stringify(result.image));
  check("摘要来自 JSON-LD", /结构化数据里的摘要/.test(result.description), JSON.stringify(result.description));
  check("标题来自 JSON-LD（比页面标题干净）", result.title === "结构化数据里的标题", JSON.stringify(result.title));
}

console.log("\n=== 十四、老式的 image_src / itemprop ===");
{
  const OLD_HTML = `<!doctype html><html><head>
<title>老站点</title>
<link rel="image_src" href="https://old.example.com/share.jpg">
<meta itemprop="image" content="https://old.example.com/itemprop.jpg">
</head><body></body></html>`;
  const { result } = runExtractor(OLD_HTML, "https://old.example.com/page");
  check("用 link[rel=image_src] 兜底", result.image === "https://old.example.com/share.jpg", JSON.stringify(result.image));
}

console.log("\n=== 十五、不把平台 logo / 占位图 / 雪碧图当封面 ===");
{
  const cases = [
    ["平台静态资源目录（小红书的 fe-platform）", "https://picasso-static.xiaohongshu.com/fe-platform/abc.png"],
    ["文件名就是 logo", "https://example.com/assets/logo.png"],
    ["占位图", "https://cdn.example.com/images/placeholder-1200x630.png"],
    ["矢量分享图", "https://example.com/share-card.svg"]
  ];
  for (const [label, url] of cases) {
    const html = `<!doctype html><html><head><title>某页面</title><meta property="og:image" content="${url}"></head><body></body></html>`;
    const { result } = runExtractor(html, "https://example.com/page");
    check(`${label} → 宁可不显示，也不当封面`, result.image === "", JSON.stringify(result.image));
    check(`   自检说明原因是「分享图是平台通用图」`, result.imageFrom === "generic-skipped", JSON.stringify(result.imageFrom));
  }

  const BOTH_HTML = `<!doctype html><html><head>
<title>某文章</title>
<meta property="og:image" content="https://blog.example.com/cover.png">
</head><body>
<div class="hero" data-size="1200x600" style="background-image: url('https://blog.example.com/background.png')"></div>
</body></html>`;
  const { result } = runExtractor(BOTH_HTML, "https://blog.example.com/post");
  check("分享标签正常时仍然优先用它（不被背景图抢走）", result.image === "https://blog.example.com/cover.png", JSON.stringify(result.image));
}

console.log("\n=== 十六、显示端：跨站图片防盗链（Referer）===");
{
  // 已实测：小红书图片 CDN 对 Referer: chrome-extension:// 返回 403、不带 Referer 返回 200。
  // 所以收藏库 / 侧栏 / 弹窗 / 设置页必须声明「不发 Referer」，否则封面抓到了也显示不出来。
  for (const page of ["library.html", "sidepanel.html", "popup.html", "settings.html"]) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    check(`${page} 声明了整页不发 Referer`, /<meta name="referrer" content="no-referrer"/.test(html));
  }
  const libSource = fs.readFileSync(path.join(ROOT, "library.js"), "utf8");
  const sideSource = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
  check("收藏库的封面图声明了 referrerPolicy", /img\.referrerPolicy = "no-referrer"/.test(libSource));
  check("侧栏的封面图声明了 referrerPolicy", /image\.referrerPolicy = "no-referrer"/.test(sideSource));
  check(
    "卡片模板里的站点图标也声明了（favicon 同样在 CDN 上）",
    /class="favicon" alt="" referrerpolicy="no-referrer"/.test(fs.readFileSync(path.join(ROOT, "library.html"), "utf8"))
  );
}

console.log("\n=== 十七、标题抓取（og 缺失 / 陈旧 / 写成平台名时也要抓到）===");
{
  // ① 平台把 og:title 写成了自己的名字（小红书这类）——应该改用页面上的实时标题。
  const SITE_NAME_OG_HTML = `<!doctype html><html><head>
<title>如何做好红烧肉</title>
<meta property="og:title" content="小红书">
<meta property="og:site_name" content="小红书">
</head><body>
<article><h1>如何做好红烧肉</h1></article>
</body></html>`;
  const a = runExtractor(SITE_NAME_OG_HTML, "https://www.xiaohongshu.com/explore/abc").result;
  check("og:title 就是平台名时，改用页面实时标题", a.title === "如何做好红烧肉", JSON.stringify(a.title));
  check("   自检标明「标题来自页面实时标题」", a.titleFrom === "dom-headline", JSON.stringify(a.titleFrom));

  // ② 单页应用站内跳转后 og:title 不更新（不只是 YouTube，很多站都这样）。
  const STALE_OG_HTML = `<!doctype html><html><head>
<title>文章标题 A</title>
<meta property="og:title" content="某某平台的首页">
</head><body>
<article><h1>文章标题 A</h1></article>
</body></html>`;
  const b = runExtractor(STALE_OG_HTML, "https://spa.example.com/posts/a").result;
  check("og:title 是陈旧的（还停在上个页面）时，优先用实时标题", b.title === "文章标题 A", JSON.stringify(b.title));

  // ③ 没有 og:title，只有带「站点名尾巴」的浏览器标题：把尾巴剥掉。
  const SUFFIX_HTML = `<!doctype html><html><head>
<title>深入理解 JavaScript 闭包 - 某某网</title>
<meta property="og:site_name" content="某某网">
</head><body><p>正文。</p></body></html>`;
  const c = runExtractor(SUFFIX_HTML, "https://www.example.com/post").result;
  check("剥掉「 - 站点名」后缀", c.title === "深入理解 JavaScript 闭包", JSON.stringify(c.title));
  check("   自检标明来自浏览器标签页标题", c.titleFrom === "page-title", JSON.stringify(c.titleFrom));

  // ④ 叠了两层后缀（B 站那种「标题_哔哩哔哩_bilibili」）。
  const DOUBLE_SUFFIX_HTML = `<!doctype html><html><head>
<title>深入理解 JavaScript 闭包_哔哩哔哩_bilibili</title>
<meta property="og:site_name" content="哔哩哔哩">
</head><body><p>正文。</p></body></html>`;
  const d = runExtractor(DOUBLE_SUFFIX_HTML, "https://www.bilibili.com/video/BV1").result;
  check("叠了两层的站点后缀也能剥干净", d.title === "深入理解 JavaScript 闭包", JSON.stringify(d.title));

  // ⑤ 真标题不能切坏：分隔符后面不是站点名时保持原样。
  const KEEP_HTML = `<!doctype html><html><head>
<title>React 18 发布 - 前端周刊</title>
</head><body><p>正文。</p></body></html>`;
  const e = runExtractor(KEEP_HTML, "https://www.example.com/post").result;
  check("分隔符后面不是站点名时，保持原样", e.title === "React 18 发布 - 前端周刊", JSON.stringify(e.title));

  // ⑥ WordPress 一类主题把标题放在 <article><header><h1>：这是合法位置，不能当导航区跳过。
  const WP_HTML = `<!doctype html><html><head><title>某某网</title></head><body>
<article>
  <header class="entry-header"><h1 class="entry-title">WordPress 型文章标题</h1></header>
  <p>正文。</p>
</article>
</body></html>`;
  const f = runExtractor(WP_HTML, "https://www.example.com/post").result;
  check("采纳 <article><header><h1> 里的标题", f.title === "WordPress 型文章标题", JSON.stringify(f.title));

  // ⑦ 页面级 header 里的 h1（通常是站点 logo 文字）要跳过，改用真正的页面标题。
  const NAV_HTML = `<!doctype html><html><head><title>真正的文章标题</title></head><body>
<header><h1>我的站点名字</h1></header>
<main><p>正文。</p></main>
</body></html>`;
  const g = runExtractor(NAV_HTML, "https://www.example.com/post").result;
  check("跳过页面级 header 里的 h1", g.title === "真正的文章标题", JSON.stringify(g.title));

  // ⑧ 没有 h1 的站点：从常见的标题类名里找。
  const CLASS_HTML = `<!doctype html><html><head><title>某某平台</title></head><body>
<div class="note-title">来自类名的笔记标题</div>
<p>正文。</p>
</body></html>`;
  const h = runExtractor(CLASS_HTML, "https://www.example.com/note/1").result;
  check("没有 h1 时从标题类名里找", h.title === "来自类名的笔记标题", JSON.stringify(h.title));

  // ⑨ 纯符号的 h1 不能当标题。
  const SYMBOL_HTML = `<!doctype html><html><head><title>正常标题</title></head><body>
<h1>···</h1>
</body></html>`;
  const i = runExtractor(SYMBOL_HTML, "https://www.example.com/post").result;
  check("纯符号的 h1 被跳过", i.title === "正常标题", JSON.stringify(i.title));

  // ⑩ 标题全空时**留空**，绝不拿域名硬凑。
  //    理由：「bilibili.com」这种「标题」没有信息量，而且它非空会盖掉
  //    浏览器本来正确的标签页标题——JS 渲染站点上这是个真会踩的坑。
  const EMPTY_HTML = `<!doctype html><html><head><title></title></head><body><p>正文。</p></body></html>`;
  const j = runExtractor(EMPTY_HTML, "https://www.example.com/post").result;
  check("实在没有标题时留空（不拿域名硬凑）", j.title === "", JSON.stringify(j.title));
  check("   自检标明「提取不到」（调用方据此改用标签页标题）", j.titleFrom === "none", JSON.stringify(j.titleFrom));

  // 页面标题本身就是域名时，同样不能当标题（否则也会盖掉标签页标题）。
  const DOMAIN_TITLE_HTML = `<!doctype html><html><head><title>bilibili.com</title></head><body><p>正文。</p></body></html>`;
  const dt = runExtractor(DOMAIN_TITLE_HTML, "https://www.bilibili.com/video/BV1uQ8E6LE6G/").result;
  check("页面标题只是个域名 → 也留空", dt.title === "", JSON.stringify(dt.title));

  // ⑪ YouTube 的标题仍然走视频数据。
  const yt = runExtractor(SPA_STALE_HTML, "https://www.youtube.com/watch?v=abcdefghijk").result;
  check("YouTube 的标题来源标记为「视频数据」", yt.titleFrom === "youtube", JSON.stringify(yt.titleFrom));

  // ⑫ 真实样本：Wikipedia 页面既没写 og:site_name、也可能读不到实时标题，
  //    这种情况下靠「域名的每一段」把后缀剥掉（en.wikipedia.org → wikipedia）。
  const NO_H1_HTML = `<!doctype html><html><head>
<title>Frame analysis - Wikipedia</title>
</head><body><p>正文。</p></body></html>`;
  const k = runExtractor(NO_H1_HTML, "https://en.wikipedia.org/wiki/Frame_analysis").result;
  check("没写 og:site_name 时靠域名剥后缀（Wikipedia 真实样本）", k.title === "Frame analysis", JSON.stringify(k.title));

  // ⑬ 真实站点的高频写法：小红书把标题放在 #detail-title 里、B 站放在 .video-title 里，
  //    这两个标题都取自用户真实收藏过的记录。
  const XHS_HTML = `<!doctype html><html><head>
<title>富贵少爷万剑穿心，开大名场面 - 小红书</title>
</head><body><div id="detail-title">富贵少爷万剑穿心，开大名场面</div></body></html>`;
  const l = runExtractor(XHS_HTML, "https://www.xiaohongshu.com/explore/abc").result;
  check(
    "小红书型页面：用 #detail-title 拿到干净标题",
    l.title === "富贵少爷万剑穿心，开大名场面",
    JSON.stringify(l.title)
  );

  const BILI_HTML = `<!doctype html><html><head>
<title>为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能_哔哩哔哩_bilibili</title>
<meta property="og:site_name" content="哔哩哔哩">
</head><body><h1 class="video-title">为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能</h1></body></html>`;
  const m = runExtractor(BILI_HTML, "https://www.bilibili.com/video/BV1").result;
  check(
    "B 站型页面：用 h1.video-title 拿到干净标题",
    m.title === "为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能",
    JSON.stringify(m.title)
  );

  // ⑭ 中文站点一个 meta 都不写自己的名字，只在页头页脚里反复出现品牌词——
  //    这路兜底专门对付「小红书」「某某网」这类尾巴。
  const BRAND_HTML = `<!doctype html><html><head>
<title>富贵少爷万剑穿心，开大名场面 - 小红书</title>
</head><body>
<header><a class="logo">小红书</a></header>
<footer>小红书 · 沪ICP备00000000号</footer>
<p>正文。</p></body></html>`;
  const brand = runExtractor(BRAND_HTML, "https://www.xiaohongshu.com/explore/abcdef").result;
  check(
    "中文站点：靠品牌区里反复出现的短词剥掉尾巴",
    brand.title === "富贵少爷万剑穿心，开大名场面",
    JSON.stringify(brand.title)
  );

  // ⑮ 反向保护：尾巴不品牌时就别乱切，否则会把真标题切掉半句。
  const SUFFIX_KEEP_HTML = `<!doctype html><html><head>
<title>React 18 发布 - 前端周刊</title>
</head><body><header>某技术站</header><p>正文。</p></body></html>`;
  const suffixKeep = runExtractor(SUFFIX_KEEP_HTML, "https://tech.example.com/post").result;
  check(
    "尾巴不是站点品牌时保留完整标题（不误伤）",
    suffixKeep.title === "React 18 发布 - 前端周刊",
    JSON.stringify(suffixKeep.title)
  );

  const SUFFIX_SHORT_HTML = `<!doctype html><html><head>
<title>写在前面 - 某某网</title>
</head><body><header>某某网</header><p>正文。</p></body></html>`;
  const suffixShort = runExtractor(SUFFIX_SHORT_HTML, "https://mou.example.com/post").result;
  check("剥完只剩很短时宁可保留原样", suffixShort.title === "写在前面 - 某某网", JSON.stringify(suffixShort.title));
}

console.log("\n=== 十八、判断「标题其实没抓到 / 抓得不干净」的规则 ===");
{
  const helpers = ["isPlaceholderText", "titleHasSiteNoise"]
    .map((name) => extractFunctionSource(BACKGROUND, name))
    .join("\n");
  const { isPlaceholderText, titleHasSiteNoise } = new Function(
    `${helpers}\nreturn { isPlaceholderText, titleHasSiteNoise };`
  )();

  const cases = [
    ["https://example.com/page", "example.com", true, "标题被存成了网址"],
    ["example.com", "example.com", true, "标题被存成了域名（兜底值）"],
    ["首页", "某某网", true, "标题是导航词"],
    ["Loading", "某某网", true, "标题是加载中"],
    ["", "某某网", true, "标题是空的"],
    ["如何做好红烧肉", "小红书", false, "正常中文标题"]
  ];
  for (const [title, source, expected, label] of cases) {
    check(`${label} → ${expected ? "算占位" : "不算占位"}`, isPlaceholderText(title, source) === expected, JSON.stringify(title));
  }

  // 带站点名的标题虽然不算「空」，但算「不干净」，同样允许被新抓到的标题替换。
  check(
    "「深入理解闭包 - 某某网」被识别为混了站点名",
    titleHasSiteNoise("深入理解闭包 - 某某网", "某某网") === true
  );
  check(
    "   英文站点同样识别（对应真实收藏里的「Frame analysis - Wikipedia」）",
    titleHasSiteNoise("Frame analysis - Wikipedia", "Wikipedia") === true
  );
  check(
    "   叠了两层后缀的也识别（「某视频标题_哔哩哔哩_bilibili」）",
    titleHasSiteNoise("某视频标题_哔哩哔哩_bilibili", "哔哩哔哩") === true
  );
  check("标题里没有站点名时不动它", titleHasSiteNoise("如何做好红烧肉", "小红书") === false);

  // 站点名只在域名里的情况（source 常是 example.com，标题尾巴是 Wikipedia）。
  check(
    "尾巴是域名里的某一段时也算不干净",
    titleHasSiteNoise("Frame analysis - Wikipedia", "en.wikipedia.org") === true
  );
  check(
    "   这里也是（「某文章_哔哩哔哩_bilibili」+ bilibili.com）",
    titleHasSiteNoise("某文章_哔哩哔哩_bilibili", "bilibili.com") === true
  );
  check("   但 tail 跟域名无关时不误判", titleHasSiteNoise("React 18 发布 - 前端周刊", "tech.example.com") === false);
}

console.log("\n=== 十九、重复收藏时自动把「带尾巴的旧标题」修干净 ===");
{
  const helpers = ["isPlaceholderText", "titleHasSiteNoise", "isIconLikeImage", "mergeDuplicateMetadata"]
    .map((name) => extractFunctionSource(BACKGROUND, name))
    .join("\n");
  const { mergeDuplicateMetadata } = new Function(`${helpers}\nreturn { mergeDuplicateMetadata };`)();

  const refresh = (oldTitle, newTitle, url = "https://www.xiaohongshu.com/explore/abc", source = "xiaohongshu.com") => {
    const existing = { url, title: oldTitle, source, image: "cover.png", description: "已有摘要" };
    const meta = { url, title: newTitle, source, image: "cover.png", description: "已有摘要" };
    return { changed: mergeDuplicateMetadata(existing, meta), title: existing.title };
  };

  // 中文站点（小红书）从不声明自己的名字，靠「新标题正好是老标题去掉尾巴」判定。
  const xhs = refresh("富贵少爷万剑穿心，开大名场面 - 小红书", "富贵少爷万剑穿心，开大名场面");
  check("带「- 小红书」尾巴的旧标题被换成干净的", xhs.changed === true && xhs.title === "富贵少爷万剑穿心，开大名场面", xhs.title);

  const bili = refresh(
    "为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能_哔哩哔哩_bilibili",
    "为什么 AI 写的东西一眼就能看出来？我做了个去AI味技能",
    "https://www.bilibili.com/video/BV1uQ8E6LE6G/",
    "bilibili.com"
  );
  check("B 站那条叠了两层后缀的旧标题也修干净", bili.changed === true && !bili.title.includes("哔哩哔哩"), bili.title);

  const wiki = refresh("Frame analysis - Wikipedia", "Frame analysis", "https://en.wikipedia.org/wiki/Frame_analysis", "en.wikipedia.org");
  check("Wikipedia 那条同样被修干净", wiki.changed === true && wiki.title === "Frame analysis", wiki.title);

  // 反向保护：标题变短但**不是**「去尾巴」时，不许动（避免把好标题换成残句）。
  const shorter = refresh("如何做好红烧肉的关键步骤", "烧肉");
  check("新标题只是变短、并不是去尾巴时不替换", shorter.changed === false && shorter.title === "如何做好红烧肉的关键步骤", shorter.title);

  const different = refresh("深入理解 JavaScript 闭包", "JavaScript 闭包详解");
  check("两个都是好标题时保留用户已看到的那个", different.changed === false && different.title === "深入理解 JavaScript 闭包", different.title);
}

// ── 抖音：不给分享标签、封面藏在播放器里、摘要格式特殊 ──────────────
// 下面这些 fixture 的结构，是按**真实抓下来的抖音视频页 DOM** 一比一还原的：
//   · 完全没有 og:* 标签
//   · 标题在 [data-e2e="detail-video-info"] h1，容器带 data-e2e-aweme-id
//   · 封面在 [data-e2e="player-container"] 里，URL 带 PackSourceEnum_AWEME_DETAIL / sc=origin_cover
//   · 平台信息藏在自家的 lark:* 元数据里（name 属性，不是 property）
//   · meta[name=description] 形如「<文案> - <作者>于<日期>发布在抖音，…来抖音，记录美好生活！」
const DY_TITLE_CORE =
  "雨天开车秒变“睁眼瞎”？玻璃起雾别慌！3步极速除雾法， 新手必存#雨天开车除雾正确方法 #新手司机 #新手开车 #青年创作者成长计划 @抖音汽车";
const DY_COVER_ORIGIN =
  "https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/ocbIabgfFElxsCPoAKCMQHQhf2As5BACvDg9kF~tplv-dy-360p.jpeg" +
  "?biz_tag=pcweb_cover&from=327834062&s=PackSourceEnum_AWEME_DETAIL&sc=origin_cover&se=false&x-expires=1790866800";
const DY_COVER_RELATED =
  "https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/relatedonly~tplv-dy-resize-origshort-autoq-75:330.jpeg" +
  "?biz_tag=pcweb_cover&s=PackSourceEnum_RELATED_AWEME&sc=cover";
const DY_COVER_LARK =
  "https://p3-pc-sign.douyinpic.com/image-cut-tos-priv/97f22017abd5625233a0b10a2bf04109~tplv-dy-resize-origshort-autoq-75:330.jpeg" +
  "?biz_tag=pcweb_cover&from=327834062&s=PackSourceEnum_AWEME_DETAIL&sc=cover";

const DOUYIN_VIDEO_HTML = `<!doctype html><html><head>
<title>${DY_TITLE_CORE} - 抖音</title>
<meta name="description" content="${DY_TITLE_CORE} - 懂车小彬于20250804发布在抖音，已经收获了381.1万个喜欢，来抖音，记录美好生活！" />
<meta name="lark:url:video_title" content="${DY_TITLE_CORE} - 抖音" />
<meta name="lark:url:video_cover_image_url" content="${DY_COVER_LARK}" />
<meta name="lark:url:video_brand_name" content="抖音" />
<meta name="lark:url:video_icon_url" content="https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico" />
</head><body>
<div data-e2e="player-container" data-size="640x360">
  <img src="${DY_COVER_ORIGIN}" />
  <img src="${DY_COVER_RELATED}" />
</div>
<div data-e2e="detail-video-info" data-e2e-aweme-id="7534679152504376595">
  <h1>第181集 | ${DY_TITLE_CORE}</h1>
</div>
<div class="C2IJlZK_">第182集 | 转弯总压线？老司机教你一招看懂后视镜 #驾驶技巧</div>
</body></html>`;

// 同样的页面，但**没有** meta description —— 用来验证「宁可留空，也不拿合集里下一集的文案充数」。
const DOUYIN_NO_DESC_HTML = DOUYIN_VIDEO_HTML.replace(
  /<meta name="description"[^>]*>\n/,
  ""
).replace('<div class="C2IJlZK_">', '<div class="desc">');

// 首页 / 精选 feed：没有具体视频，不该乱抓。
const DOUYIN_FEED_HTML = `<!doctype html><html><head>
<title>抖音精选电脑版 - 抖音旗下优质视频平台</title>
</head><body>
<header>抖音</header>
<a href="/video/7372484719360744996">某个视频</a>
</body></html>`;

const NORMAL_SITE_HTML = `<!doctype html><html><head>
<title>如何做好红烧肉 - 某某美食网</title>
<meta property="og:title" content="如何做好红烧肉" />
<meta property="og:image" content="https://img.example.com/braised.jpg" />
<meta name="description" content="一步一步教你在家做出软糯入味的红烧肉。" />
<meta property="og:site_name" content="某某美食网" />
</head><body><p>正文。</p></body></html>`;

console.log("\n=== 二十、抖音：不给分享标签时也要抓到标题与封面 ===");
{
  const { result } = runExtractor(DOUYIN_VIDEO_HTML, "https://www.douyin.com/video/7534679152504376595");
  console.log("  结果:", JSON.stringify(result, null, 0).slice(0, 300));

  check("抓到了标题（不再落空）", !!result.title, JSON.stringify(result.title));
  check("标题来自抖音专用容器（而不是 og / 页面标题兜底）", result.titleFrom === "douyin", result.titleFrom);
  check("标题是这条视频的文案", result.title.includes("雨天开车"), result.title.slice(0, 40));
  check("标题已剥掉「 - 抖音」尾巴", !result.title.trim().endsWith("抖音"), result.title.slice(-16));
  check("长文案被截到 140 字以内（卡片放得下）", result.title.length <= 140, `${result.title.length} 字`);

  check("抓到了封面", !!result.image, result.image.slice(0, 90));
  check("封面来自播放器容器（不走 og，因为根本没有）", result.imageFrom === "douyin", result.imageFrom);
  check("封面是**当前视频**的（原图标记 origin_cover）", /sc=origin_cover/.test(result.image), result.image.slice(0, 90));
  check("没有误选「相关推荐」那张封面", !/RELATED_AWEME/.test(result.image), result.image.slice(0, 90));
  check("没有复用 lark 里的 4:3 裁切版（播放器原图优先）", result.image !== DY_COVER_LARK, result.image.slice(0, 90));

  check("站点名显示为「抖音」（不显示成 douyin.com）", result.source === "抖音", result.source);
  check("站点图标不为空", !!result.favicon, result.favicon.slice(0, 80));
  check("摘要去掉了与标题重复的文案、只留作者/日期/热度", /懂车小彬于20250804发布在抖音/.test(result.description), JSON.stringify(result.description));
  check("摘要里不再出现平台宣传语", !/记录美好生活/.test(result.description), JSON.stringify(result.description));
}

console.log("\n=== 二十一、抖音没有简介时，宁可留空也不填别的视频的文案 ===");
{
  const { result } = runExtractor(DOUYIN_NO_DESC_HTML, "https://www.douyin.com/video/7534679152504376595");
  check("标题与封面照样抓到", result.titleFrom === "douyin" && result.imageFrom === "douyin", `${result.titleFrom} / ${result.imageFrom}`);
  check(
    "没有把「合集里下一集」的文案当摘要（这条专门防串集）",
    !/转弯总压线/.test(result.description),
    JSON.stringify(result.description)
  );
  check("摘要如实留空，而不是编一个", result.description === "", JSON.stringify(result.description));
}

console.log("\n=== 二十二、抖音首页/feed：没有具体视频时不乱抓 ===");
{
  const { result } = runExtractor(DOUYIN_FEED_HTML, "https://www.douyin.com/");
  check("站点名仍是「抖音」", result.source === "抖音", result.source);
  check("标题不是空、也不是域名这种垃圾值", !!result.title && !/^https?:/.test(result.title), JSON.stringify(result.title));
  check("不进播放器层乱抓封面", result.imageFrom !== "douyin", result.imageFrom);
}

console.log("\n=== 二十三、回归：普通网站不受抖音专用逻辑影响 ===");
{
  const { result } = runExtractor(NORMAL_SITE_HTML, "https://www.example.com/braised-pork");
  check("标题正常（并剥掉站点尾巴）", result.title === "如何做好红烧肉", JSON.stringify(result.title));
  check("封面仍走分享标签", result.imageFrom === "share", result.imageFrom);
  check("摘要仍在", result.description.includes("软糯入味"), JSON.stringify(result.description));
  check("站点名正常", result.source === "某某美食网", result.source);
}

console.log(`\n${failed === 0 ? "全部通过" : "存在失败"}：${passed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
