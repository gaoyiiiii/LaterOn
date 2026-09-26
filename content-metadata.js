// 在站内点开另一个视频时，og:title / og:image / og:description **根本不会更新**，
// 它们会一直停在「你最开始打开的那一页」——通常就是首页那套通用内容：
// 标题 "YouTube"、封面 youtube.com/img/desktop/yt_1200.png、简介是首页的宣传语。
// 手动刷新页面才会变对。所以对这类站点不能盲信 og，这里改成：
//   ① 从「当前网址」推出视频 id（不依赖任何 meta，永远是最新的）；
//   ② 优先读实时 DOM（站内跳转后 YouTube 会更新它）；
//   ③ og / 页面内嵌数据必须用视频 id 校验，确认它真属于当前这个视频才采用。
function extractPageMetadataForShortcut() {
  const meta = (selector) => document.querySelector(selector)?.content?.trim() || "";
  const absolute = (value) => {
    if (!value) return "";
    try {
      return new URL(value, location.href).href;
    } catch {
      return "";
    }
  };
  const squeeze = (text) => (text || "").replace(/\s+/g, " ").trim();

  const host = location.hostname.replace(/^www\./, "");
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/.test(host) || host === "youtu.be";

  // 当前页面对应的视频 id —— 只从网址推导，不受任何 meta 是否过期影响。
  const youtubeId = (() => {
    if (!isYouTube) return "";
    try {
      const url = new URL(location.href);
      if (host === "youtu.be") return (url.pathname.split("/")[1] || "").trim();
      if (url.pathname === "/watch") return (url.searchParams.get("v") || "").trim();
      const matched = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      return matched ? matched[1] : "";
    } catch {
      return "";
    }
  })();

  // 括号配平地切出一段 JSON（会跳过字符串里的括号），用于从 <script> 里挖数据。
  const sliceBalanced = (text, start, maxLength) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    const end = Math.min(text.length, start + maxLength);
    for (let i = start; i < end; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (!depth) return text.slice(start, i + 1);
      }
    }
    return "";
  };

  // YouTube 会在页面里内嵌一份 ytInitialPlayerResponse（含标题 / 简介 / 缩略图）。
  // 站内跳转后这份数据同样停留在上一个视频，所以必须 videoId 对得上才采用。
  const youtubeEmbedded = () => {
    const scripts = document.scripts;
    const limit = Math.min(scripts.length, 60);
    for (let s = 0; s < limit; s += 1) {
      const text = scripts[s].textContent || "";
      if (!text || text.indexOf("videoDetails") === -1) continue;
      let from = 0;
      for (let round = 0; round < 4; round += 1) {
        const at = text.indexOf('"videoDetails"', from);
        if (at === -1) break;
        from = at + 15;
        const start = text.indexOf("{", at);
        if (start === -1) continue;
        const slice = sliceBalanced(text, start, 20000);
        if (!slice) continue;
        try {
          const details = JSON.parse(slice);
          if (details.videoId !== youtubeId) continue;
          const thumbs = (details.thumbnail && details.thumbnail.thumbnails) || [];
          return {
            title: squeeze(details.title),
            description: squeeze(details.shortDescription),
            image: absolute(thumbs.length ? thumbs[thumbs.length - 1].url : "")
          };
        } catch {}
      }
    }
    return {};
  };

  let youtubeTitle = "";
  let youtubeDescription = "";
  let youtubeImage = "";
  if (youtubeId) {
    const embedded = youtubeEmbedded();
    const domTitle = squeeze(
      document.querySelector("ytd-watch-metadata h1")?.textContent ||
        document.querySelector("ytd-reel-video-renderer[is-active] h2")?.textContent ||
        ""
    );
    // 站内跳转后 YouTube 会实时更新标签页标题，所以它比 meta[name=title] 更可信。
    const docTitle = squeeze(document.title).replace(/\s*[-–—]\s*YouTube\s*$/i, "");
    const metaTitle = squeeze(meta('meta[name="title"]'));
    youtubeTitle =
      [domTitle, embedded.title, docTitle, metaTitle, squeeze(meta('meta[property="og:title"]'))].find(
        (candidate) => candidate && !/^youtube$/i.test(candidate)
      ) || "";

    const domDescription = squeeze(
      document.querySelector("#description-inline-expander")?.textContent ||
        document.querySelector("ytd-watch-metadata #description")?.textContent ||
        document.querySelector("ytd-reel-video-renderer[is-active] #description")?.textContent ||
        ""
    ).replace(/\s*(?:…|\.\.\.)\s*(?:more|更多)\s*$/i, "");
    youtubeDescription =
      [domDescription, embedded.description].find((candidate) => candidate && candidate.length >= 8) || "";
    if (youtubeDescription.length > 300) youtubeDescription = `${youtubeDescription.slice(0, 300).trim()}…`;

    youtubeImage = embedded.image || "";
  }

  // ── 抖音（含 iesdouyin）──────────────────────────────────────────
  // 抖音网页版一个 og 标签都不给（实测 0 个），但它自己藏了一套 `lark:` 元数据，
  // 而且播放器容器里有当前这条视频的封面——两处都是「实时」的，可以放心用。
  //   lark:url:video_title            标题（带「 - 抖音」尾巴）
  //   lark:url:video_brand_name       站点自称（抖音）——正好用来剥上面那个尾巴
  //   lark:url:video_cover_image_url  封面（4:3 裁切版）
  //   lark:url:video_icon_url         站点图标
  const isDouyin = /(^|\.)douyin\.com$/.test(host) || /(^|\.)iesdouyin\.com$/.test(host);
  const lark = (name) => squeeze(meta(`meta[name="lark:url:${name}"]`));
  const douyin = isDouyin
    ? {
        brand: lark("video_brand_name"),
        larkTitle: lark("video_title"),
        larkCover: absolute(lark("video_cover_image_url")),
        icon: absolute(lark("video_icon_url")),
        title: squeeze(document.querySelector('[data-e2e="detail-video-info"] h1')?.textContent || ""),
        // 面板自己带着它对应的视频 id。把它一起回报，调用方就能核对
        // 「这次读到的标题/封面，到底是不是网址上那条视频」——滑动切换时用得上。
        readId: document.querySelector('[data-e2e="detail-video-info"]')?.getAttribute("data-e2e-aweme-id") || ""
      }
    : null;

  const IMAGE_LIMIT = 80;
  const PARAGRAPH_LIMIT = 200;

  // ── 封面 ──────────────────────────────────────────────────────────
  // 按「可信度」分层取，任何一层拿到了就停。为什么要分层：不少站点（小红书、
  // 部分电商与设计站）的分享标签要么没有、要么指向一张平台通用的 logo，
  // 而真正的封面是用 CSS 背景图画出来的、或挂在 video 的 poster 上，
  // 所以只看 og:image 和 <img> 必然抓空。
  const looksGenericImage = (value) => {
    if (!value) return true;
    const path = String(value).toLowerCase().split("?")[0].split("#")[0];
    // 平台级静态资源目录（小红书的 fe-platform 就属于这类路径）
    if (/\/(?:fe-platform|fe-static|og-image-default|default-(?:cover|image|thumb|share))\//.test(path)) return true;
    // 命名上就写着 logo / 占位图 / 头像 / 雪碧图
    if (/(?:^|[/_-])(?:logo|sprite|placeholder|spacer|blank|avatar)(?:[/_.-]|$)/.test(path)) return true;
    // 分享图是矢量图，基本等于 logo
    if (/\.svg$/.test(path)) return true;
    return false;
  };

  // 从 CSS 值里抠出第一个图片地址（背景图可能是 image-set() 或多层渐变叠加）。
  const urlFromCss = (value) => {
    if (!value || value === "none") return "";
    const matched = /url\((['"]?)([^'")]+)\1\)/i.exec(value);
    const raw = matched ? matched[2].trim() : "";
    if (!raw || /^data:/i.test(raw)) return "";
    return absolute(raw);
  };

  // JSON-LD（schema.org 结构化数据）：新闻站、博客、商品页常把封面与摘要放这儿。
  const jsonLd = (() => {
    const out = { image: "", description: "", title: "" };
    const pickImage = (value) => {
      if (!value) return "";
      if (typeof value === "string") return absolute(value);
      if (Array.isArray(value)) return pickImage(value[0]);
      if (typeof value === "object") return absolute(value.url || value.contentUrl || "");
      return "";
    };
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    const limit = Math.min(nodes.length, 8);
    for (let i = 0; i < limit; i += 1) {
      let data;
      try {
        data = JSON.parse(nodes[i].textContent || "");
      } catch {
        continue;
      }
      const list = Array.isArray(data) ? data : Array.isArray(data["@graph"]) ? data["@graph"] : [data];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        if (!out.image) out.image = pickImage(entry.image || entry.thumbnailUrl || entry.primaryImageOfPage);
        if (!out.description) out.description = squeeze(entry.description || entry.abstract);
        if (!out.title) out.title = squeeze(entry.headline || entry.name);
      }
      if (out.image && out.description && out.title) break;
    }
    return out;
  })();

  // video 的 poster（视频笔记、播客页等的封面就在这儿）。
  const posterCover = () => {
    const videos = document.querySelectorAll("video[poster]");
    const limit = Math.min(videos.length, 6);
    for (let i = 0; i < limit; i += 1) {
      const url = absolute(videos[i].getAttribute("poster") || "");
      if (url && !looksGenericImage(url)) return url;
    }
    return "";
  };

  // 行内 CSS 背景图：用属性选择器先筛一遍，比遍历所有元素算 computed style 快几个量级。
  // 只认「占住足够大版面」的（≥200×200），免得把按钮、图标上的背景图当封面。
  const backgroundCover = () => {
    let best = "";
    let bestArea = 0;
    let nodes;
    try {
      nodes = document.querySelectorAll('[style*="background-image"], [style*="background:"]');
    } catch {
      return "";
    }
    const limit = Math.min(nodes.length, 40);
    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      const style = node.style || {};
      const url = urlFromCss(style.backgroundImage || style.background || "");
      if (!url) continue;
      const area = (node.clientWidth || 0) * (node.clientHeight || 0);
      if (area >= 40000 && area > bestArea) {
        bestArea = area;
        best = url;
      }
    }
    return best;
  };

  // 懒加载图：真图常放在 data-src 之类的属性里，src 只是 1px 占位图。
  const lazyImageCover = () => {
    let best = "";
    let bestArea = 0;
    let nodes;
    try {
      nodes = document.querySelectorAll(
        "img[data-src], img[data-original], img[data-lazy-src], img[data-actualsrc], img[data-echo]"
      );
    } catch {
      return "";
    }
    const limit = Math.min(nodes.length, 40);
    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      const raw =
        node.getAttribute("data-src") ||
        node.getAttribute("data-original") ||
        node.getAttribute("data-lazy-src") ||
        node.getAttribute("data-actualsrc") ||
        node.getAttribute("data-echo") ||
        "";
      if (!raw || /^data:/i.test(raw)) continue;
      const url = absolute(raw);
      if (!url) continue;
      const area = (node.clientWidth || 0) * (node.clientHeight || 0);
      if (area > bestArea) {
        bestArea = area;
        best = url;
      }
    }
    return best;
  };

  // 兜底：挑页面里最大的图（分两轮——先看已经下载完的，再看已经占住大版面的）。
  const biggestImageCover = () => {
    let loaded = null;
    let loadedArea = 0;
    let laidOut = null;
    let laidOutArea = 0;
    const images = document.images;
    const count = Math.min(images.length, IMAGE_LIMIT);
    for (let i = 0; i < count; i += 1) {
      const img = images[i];
      const naturalArea = img.naturalWidth * img.naturalHeight;
      if (img.naturalWidth >= 320 && img.naturalHeight >= 160 && naturalArea > loadedArea) {
        loadedArea = naturalArea;
        loaded = img;
      }
      const boxArea = img.clientWidth * img.clientHeight;
      if (img.clientWidth >= 320 && img.clientHeight >= 160 && boxArea > laidOutArea) {
        laidOutArea = boxArea;
        laidOut = img;
      }
    }
    const pick = loaded || laidOut;
    const raw = pick?.currentSrc || pick?.src || "";
    // 懒加载占位图常常是 data: 内联的小图，不能拿它当封面。
    if (/^data:/i.test(raw)) return "";
    return absolute(raw);
  };

  // 抖音播放器容器里的封面。容器里可能有 2 张图：一张是**当前这条视频**的竖版原始封面，
  // 另一张是「合集里下一集」的 4:3 裁切封面——只能靠网址里的来源标记区分：
  // `PackSourceEnum_AWEME_DETAIL` / `sc=origin_cover` 才属于当前视频（实测确认）。
  const douyinPlayerCover = () => {
    let scoped;
    try {
      scoped = document.querySelector('[data-e2e="player-container"]');
    } catch {
      return "";
    }
    if (!scoped) return "";
    const imgs = scoped.querySelectorAll("img");
    const limit = Math.min(imgs.length, 8);
    let fallback = "";
    for (let i = 0; i < limit; i += 1) {
      const url = absolute(imgs[i].currentSrc || imgs[i].getAttribute("src") || "");
      if (!url || /^data:/i.test(url)) continue;
      if (/PackSourceEnum_AWEME_DETAIL/.test(url) || /sc=origin_cover/.test(url)) return url;
      if (!fallback) fallback = url;
    }
    return fallback;
  };

  // imageFrom 只用于「自检」：告诉你封面最终是从哪一层拿到的（设置页会显示），
  // 万一某个站点还是抓不到，看一眼就知道卡在哪一步。
  let image = "";
  let imageFrom = "none";

  // ① 分享标签：最省事、命中率也最高；但明显是平台通用图就跳过，
  //    否则会出现「收藏十篇，封面全是同一个 logo」。
  const shareImage = absolute(meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]'));
  if (shareImage && !looksGenericImage(shareImage)) {
    image = shareImage;
    imageFrom = "share";
  } else if (shareImage) {
    // 有分享图、但它明显是平台 logo：先记下「跳过过它」，
    // 万一后面几层也没命中，自检就能看出是这个原因。
    imageFrom = "generic-skipped";
  }

  // ② 老式的 image_src / itemprop
  if (!image) {
    const imageSrc = absolute(document.querySelector('link[rel~="image_src"]')?.href || "");
    if (imageSrc && !looksGenericImage(imageSrc)) {
      image = imageSrc;
      imageFrom = "image_src";
    }
  }
  if (!image) {
    const itemProp = absolute(document.querySelector('meta[itemprop="image"]')?.content || "");
    if (itemProp && !looksGenericImage(itemProp)) {
      image = itemProp;
      imageFrom = "itemprop";
    }
  }

  // ②b 抖音：它不给任何分享标签，封面得去播放器容器里拿（见 douyinPlayerCover）。
  //     容器里那张竖版原始封面就是用户在抖音上看到的那张，比后面的 4:3 裁切版更贴切。
  if (!image && douyin) {
    const playerCover = douyinPlayerCover();
    if (playerCover && !looksGenericImage(playerCover)) {
      image = playerCover;
      imageFrom = "douyin";
    } else if (douyin.larkCover && !looksGenericImage(douyin.larkCover)) {
      image = douyin.larkCover;
      imageFrom = "douyin-lark";
    }
  }

  // ③ 结构化数据 → ④ 视频封面 → ⑤ 背景图 → ⑥ 懒加载属性 → ⑦ 最大的图
  if (!image && jsonLd.image && !looksGenericImage(jsonLd.image)) {
    image = jsonLd.image;
    imageFrom = "jsonld";
  }
  if (!image) {
    const poster = posterCover();
    if (poster) {
      image = poster;
      imageFrom = "poster";
    }
  }
  if (!image) {
    const background = backgroundCover();
    if (background) {
      image = background;
      imageFrom = "background";
    }
  }
  if (!image) {
    const lazy = lazyImageCover();
    if (lazy) {
      image = lazy;
      imageFrom = "lazy";
    }
  }
  if (!image) {
    const biggest = biggestImageCover();
    if (biggest) {
      image = biggest;
      imageFrom = "biggest";
    }
  }

  // ── 摘要 ──────────────────────────────────────────────────────────
  // 依次尝试：分享标签 → 结构化数据 → 正文第一段 → 常见的「简介容器」，
  // 全程限量扫描、命中即停。
  const metaDescription =
    meta('meta[property="og:description"]') ||
    meta('meta[name="description"]') ||
    meta('meta[name="twitter:description"]');
  // 抖音例外：它的「正文文案」其实就是标题（h1），页面上并不存在独立的简介；
  // 而通用的 `.desc` 选择器实测会命中**合集里下一集**的文案（抓回来是错的），
  // 所以抖音不做正文扫描，宁可如实显示「暂无摘要」，也不填一段别的视频的文案。
  const allowBodyDescription = !isDouyin;
  let description = metaDescription || jsonLd.description || "";
  if (!description && allowBodyDescription) {
    const nodes = document.querySelectorAll("article p, main p, p");
    const count = Math.min(nodes.length, PARAGRAPH_LIMIT);
    for (let i = 0; i < count; i += 1) {
      const text = squeeze(nodes[i].textContent);
      if (text.length >= 60) {
        description = text;
        break;
      }
    }
  }
  if (!description && allowBodyDescription) {
    // 小红书这类站点的正文不用 <p> 承载，只靠段落扫描会抓空，
    // 所以最后再试几个常见的简介容器。
    const containers = [
      "#detail-desc",
      ".note-desc",
      ".desc",
      "[class*='excerpt']",
      "[class*='abstract']",
      "[class*='summary']"
    ];
    for (const selector of containers) {
      const text = squeeze(document.querySelector(selector)?.textContent || "");
      if (text.length >= 20) {
        description = text.length > 300 ? `${text.slice(0, 300).trim()}…` : text;
        break;
      }
    }
  }

  // ── 标题 ──────────────────────────────────────────────────────────
  // 只信 og:title 是不够的，三种情况都会抓空或抓错：
  //   ① 单页应用站内跳转后 og:title 不更新（YouTube 是典型，会一直停在「最开始那一页」）；
  //   ② 站点压根没写 og:title / twitter:title；
  //   ③ 写了，但内容是平台名（比如「小红书」）或带一串「_站点名」后缀。
  // 所以这里先把「明显不像标题」的候选剔掉，再按
  // 「实时 DOM 标题 → 分享标签 → 结构化数据 → 页面标题」的顺序挑一个。
  const siteName = squeeze(meta('meta[property="og:site_name"]'));
  const hostLabel = (host.split(".")[0] || "").toLowerCase();

  const GENERIC_TITLES = new Set([
    "首页", "主页", "登录", "注册", "搜索", "搜索结果", "全部", "分类", "列表",
    "购物车", "loading", "untitled", "无标题", "error", "not found", "404",
    "youtube", "watch", "抖音", "douyin"
  ]);

  // 这段文字是不是「站点名 / 导航词」——也就是不该当标题的东西。
  const looksLikeSiteName = (value) => {
    const text = squeeze(value).toLowerCase();
    if (!text) return true;
    if (text === host.toLowerCase() || text === hostLabel) return true;
    if (siteName && text === siteName.toLowerCase()) return true;
    if (GENERIC_TITLES.has(text)) return true;
    if (/^[a-z0-9-]+(\.[a-z]{2,}){1,2}$/.test(text)) return true; // xxx.com 这类域名
    if (!/[\p{L}\p{N}]/u.test(text)) return true;                 // 纯符号
    return false;
  };

  // 导航 / 页脚这类「非正文」区域里的文字不能当标题。
  // <header> 要区别对待：WordPress 一类主题会把文章标题放在
  // <article><header class="entry-header"> 里，那是合法位置；
  // 只有页面级 header（不在 article / main 内）才算导航区。
  const inJunkArea = (node) => {
    if (node.closest("nav, aside, footer, form, [role='banner'], [role='navigation'], [role='contentinfo']")) return true;
    const header = node.closest("header");
    return !!header && !header.closest("article, main");
  };

  // 实时 DOM 里的主标题：正文区的 h1 最可信（它是实时的，不会像 og 那样过期）。
  const headlineFromDom = () => {
    const groups = ["article h1", "main h1", "h1", "[itemprop='headline']"];
    const seen = new Set();
    for (const selector of groups) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      const limit = Math.min(nodes.length, 10);
      for (let i = 0; i < limit; i += 1) {
        const node = nodes[i];
        if (seen.has(node)) continue;
        seen.add(node);
        if (inJunkArea(node)) continue;
        const text = squeeze(node.innerText || node.textContent || "");
        if (text.length < 2 || text.length > 180) continue;
        if (looksLikeSiteName(text)) continue;
        return text;
      }
    }
    return "";
  };

  // 没有 h1 的站点（不少单页应用）：从常见的标题容器里找。
  // 前半是几个高频站点的专用标识（小红书 / 微信公众号等，它们的标题不在 h1 里），
  // 后半是按类名认的通用写法。
  const headlineFromClass = () => {
    const selectors = [
      "#detail-title", "#activity-name", "#article-title", "[class*='rich_media_title']",
      "[class*='Post-Title']", "[class*='note-title']", "[class*='article-title']",
      "[class*='post-title']", "[class*='entry-title']", "[class*='detail-title']",
      "[class*='video-title']", "[class*='question-title']", "[class*='item-title']",
      "[itemprop='headline']"
    ];
    for (const selector of selectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      const limit = Math.min(nodes.length, 6);
      for (let i = 0; i < limit; i += 1) {
        const node = nodes[i];
        if (inJunkArea(node)) continue;
        const text = squeeze(node.innerText || node.textContent || "");
        if (text.length < 2 || text.length > 180) continue;
        if (looksLikeSiteName(text)) continue;
        return text;
      }
    }
    return "";
  };

  // 页面标题常带「 - 站点名」「_站点名」这样的尾巴，剥掉它。
  // 保守起见：只有尾巴确实等于站点名 / 域名时才剥，而且剥完必须还剩内容，
  // 免得把「React 18 发布 - 前端周刊」这类真标题切坏。
  // 循环几轮是为了处理「标题_哔哩哔哩_bilibili」这种叠了两层后缀的情况。
  // 候选项除 og:site_name 外，还把域名的每一段都算上（en.wikipedia.org → wikipedia），
  // 这样像 Wikipedia 这种既没写 og:site_name、又可能读不到实时标题的站点也能剥干净。
  // 站点自称的名字：除了 og:site_name，还有几个同样可靠的来源。
  // 中文站点（如小红书、哔哩哔哩）往往一个 meta 都不写，所以再补一路：
  // 页头 / 页脚 / logo 这类「品牌区」里反复出现的短词，基本就是站点名。
  // 只读 textContent（不碰布局，不违反性能红线），且限量取值。
  const brandText = (() => {
    let blob = "";
    let nodes;
    try {
      nodes = document.querySelectorAll("header, nav, footer, [class*='logo'], [class*='brand'], [id*='logo']");
    } catch {
      return "";
    }
    const limit = Math.min(nodes.length, 12);
    for (let i = 0; i < limit; i += 1) {
      blob += " " + String(nodes[i].textContent || "").slice(0, 4000);
    }
    return squeeze(blob).toLowerCase();
  })();
  const declaredNames = [
    siteName,
    douyin ? douyin.brand || "抖音" : "",
    meta('meta[name="application-name"]'),
    meta('meta[name="apple-mobile-web-app-title"]'),
    document.querySelector("header img[alt], .logo img[alt], #logo img[alt]")?.getAttribute("alt") || ""
  ];
  const stripSiteSuffix = (value) => {
    let out = squeeze(value);
    if (!out) return out;
    const hostWords = host.split(".").map((word) => word.toLowerCase()).filter((word) => word.length >= 2);
    const names = [...declaredNames, host, ...hostWords]
      .map((name) => squeeze(String(name || "")))
      .filter((name) => name && name.length >= 2);
    if (!names.length) return out;
    for (let round = 0; round < 3; round += 1) {
      let changed = false;
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const next = out.replace(new RegExp(`\\s*[|·•\\-–—_/]\\s*${escaped}\\s*$`, "i"), "").trim();
        if (next && next.length >= 2 && next !== out) {
          out = next;
          changed = true;
        }
      }
      if (!changed) break;
    }

    // 最后一路兜底：尾巴是个「短品牌词」且确实出现在品牌区里，就剥掉它。
    // 例如「富贵少爷…开场名场面 - 小红书」→ 去掉「 - 小红书」。
    // 特意收紧条件：尾巴 ≤ 10 字符、由中文/字母数字构成、不含空格标点；
    // 剥完正文至少还剩 6 个字符——这样「React 18 发布 - 前端周刊」这类
    // 真标题（分隔符两侧都很长）不会被误伤成半句。
    const tailMatch = /^(.*?)\s*[|·•\-–—_/]\s*([\p{Script=Han}A-Za-z0-9]{2,10})$/u.exec(out);
    if (tailMatch && brandText) {
      const head = tailMatch[1].trim();
      const tail = tailMatch[2].trim();
      if (head.length >= 6 && brandText.includes(tail.toLowerCase())) out = head;
    }
    return out;
  };

  const headline = headlineFromDom() || headlineFromClass();
  // 抖音的文案（h1）常常很长——带一堆话题标签和 @提及，卡片上放不下，
  // 所以给它单独限长到 140 字并加省略号。先剥后缀、再截断，避免把「 - 抖音」切一半留着。
  const clipTitle = (text, max) => (max && text.length > max ? `${text.slice(0, max).trim()}…` : text);
  // 每个候选都过一遍「剥站点后缀」——og:title 之类同样常带尾巴。
  const titleCandidates = [
    { text: douyin?.title || "", from: "douyin", max: 140 },
    { text: douyin?.larkTitle || "", from: "douyin-lark", max: 140 },
    { text: headline, from: "dom-headline" },
    { text: meta('meta[property="og:title"]'), from: "share" },
    { text: meta('meta[name="twitter:title"]'), from: "twitter" },
    { text: meta('meta[name="title"]'), from: "meta-title" },
    { text: jsonLd.title, from: "jsonld" },
    { text: document.title, from: "page-title" }
  ].map(({ text, from, max }) => ({ text: clipTitle(stripSiteSuffix(text), max), from }));
  const pickedTitle = titleCandidates.find(
    (candidate) => candidate.text && candidate.text.length <= 300 && !looksLikeSiteName(candidate.text)
  );
  let title = pickedTitle?.text || "";
  let titleFrom = pickedTitle?.from || "none";
  if (!title) {
    // 实在没有像样的标题也别硬凑：**留空**，让调用方改用浏览器标签页的标题。
    // （以前这里会退回域名，结果 JS 渲染站点会被存成「bilibili.com」这种无效标题，
    //   反而把浏览器本来正确的标题盖掉了。）
    title = "";
    titleFrom = "none";
  }
  // 站点自称：抖音不写 og:site_name，但它的 lark 元数据里写明了「抖音」；
  // 首页/合集页没有 lark 元数据，就退回固定的品牌名，免得显示成 douyin.com。
  let source = siteName || (douyin ? douyin.brand || "抖音" : "") || host;

  // 抖音的 meta description 形如：
  //   「<视频文案> - <作者>于<日期>发布在抖音，已经收获了N个喜欢，来抖音，记录美好生活！」
  // 前半段和标题重复、结尾是平台宣传语，真正有增量价值的只有「作者 / 日期 / 热度」，
  // 所以只保留那一段；万一格式变了，就退回去掉宣传语的原文；再不行就留空。
  if (douyin && description) {
    const authorInfo = /[-–—]\s*([^\-–—]{2,24}?于\d{6,8}发布在抖音[^。！!]*)/.exec(description);
    const core = (authorInfo ? authorInfo[1] : description)
      .replace(/[，,]?\s*来抖音[，,]\s*记录美好生活[！!]?/g, "")
      .trim();
    description = core.length >= 8 ? (core.length > 300 ? `${core.slice(0, 300).trim()}…` : core) : "";
  }

  // YouTube：og 常常停在「上一个视频」或首页那套通用内容上，只在确实指向
  // 当前这个视频时才采信；否则按视频 id 自己拼出封面，并改用实时 DOM 里的文案。
  if (isYouTube) {
    source = "YouTube";
    if (youtubeId) {
      const belongsToCurrentVideo = (value) => !!value && value.indexOf(`/vi/${youtubeId}/`) !== -1;
      if (!belongsToCurrentVideo(image)) {
        // 该分辨率不存在时，由展示端（收藏库 / 侧栏）逐级降到 hqdefault、mqdefault。
        image = belongsToCurrentVideo(youtubeImage)
          ? youtubeImage
          : `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
        imageFrom = "youtube";
      }
      if (youtubeTitle) {
        title = youtubeTitle;
        titleFrom = "youtube";
      }
      // 简介宁可留空（后台会补「暂无摘要」），也不拿首页的宣传语冒充这个视频的简介。
      description = youtubeDescription;
    }
  }

  return {
    title,
    titleFrom,
    description,
    image,
    imageFrom,
    favicon:
      absolute(document.querySelector('link[rel~="icon"]')?.href || "") ||
      (douyin?.icon || "") ||
      `${location.origin}/favicon.ico`,
    source,
    url: location.href,
    // 只对抖音有意义：这次实际读到的视频 id（面板上的那个）。
    // 调用方用它核对「读到的内容是否属于网址上那条视频」，以免滑动切换时存成上一条。
    videoId: douyin?.readId || ""
  };
}

extractPageMetadataForShortcut();
