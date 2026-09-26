// 回归测试：抖音「站内滑动切换视频」后，必须抓到新视频的标题与封面。
//
// 背景（实测时间线，无头 Chrome 逐 100ms 采样）：
//   切换前  网址=76595  面板=76595  标题=第181集  封面=旧
//   +102ms  网址=96420  面板=76595 标题=第181集  封面=旧   ← 网址已换，面板还是上一条
//   +318ms  网址=96420  面板=96420 标题=第182集  封面=新   ← 全部对齐
// 也就是「只有网址是瞬时正确的」，标题面板与封面滞后 0.15~0.3 秒。
// 用户滑完立刻按快捷键，旧代码就会把上一条视频的标题和封面存进去。
//
// 修复方式：抓取前先等「面板上的视频 id」与「网址里的视频 id」对齐（最多 1.5 秒）。
// 这个测试用假的 chrome API 把真实的 settleDouyinDom / extractTabMetadata 跑起来，
// 模拟「面板滞后 N 次探测」的场景，验证最终抓到的确实是新视频。
//
// 运行：NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node dev-tests/douyin-spa.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const BACKGROUND = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const PAGE_SCRIPT = fs.readFileSync(path.join(ROOT, "content-metadata.js"), "utf8");

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

const REAL_SOURCE = [
  grabConst(BACKGROUND, "EXTRACT_TIMEOUT_MS"),
  grabConst(BACKGROUND, "DOUYIN_SETTLE_MS"),
  grabConst(BACKGROUND, "DOUYIN_POLL_MS"),
  grabFunction(BACKGROUND, "withTimeout"),
  grabFunction(BACKGROUND, "safeHostname"),
  grabFunction(BACKGROUND, "isDouyinUrl"),
  grabFunction(BACKGROUND, "douyinVideoIdFromUrl"),
  grabFunction(BACKGROUND, "probeDouyinFreshness"),
  grabFunction(BACKGROUND, "settleDouyinDom"),
  grabFunction(BACKGROUND, "isIconLikeImage"),
  grabFunction(BACKGROUND, "refetchMetaFromServer"),
  grabFunction(BACKGROUND, "isPlaceholderText"),
  grabFunction(BACKGROUND, "titleHasSiteNoise"),
  grabFunction(BACKGROUND, "applyServerMetaRescue"),
  grabFunction(BACKGROUND, "readTabMetadata"),
  grabFunction(BACKGROUND, "extractTabMetadata")
].join("\n\n");

// ── 假页面状态 ────────────────────────────────────────────────────
// panelId 代表「标题面板此刻显示的哪条视频」，它滞后于网址。
const OLD_ID = "7534679152504376595";
const NEW_ID = "7534679152504376611";
const NEWEST_ID = "7534679152504376622";

function makePage(overrides = {}) {
  return {
    urlId: OLD_ID,
    panelId: OLD_ID,
    larkId: OLD_ID,
    title: `标题-${OLD_ID.slice(-4)}`,
    cover: `https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/${OLD_ID}~tplv-dy-360p.jpeg?sc=origin_cover&s=PackSourceEnum_AWEME_DETAIL`,
    ...overrides
  };
}

// 页面「最终会稳定到」的那条视频：网址里有 id 就用它，否则用 lark 元数据里的 id。
// （首页推荐流这两种都可能缺失，所以 settleDouyinDom 才需要这个兜底顺序。）
function settledIdOf(page) {
  return page.urlId || page.larkId;
}

// 造一个沙盒：注入真实的 settleDouyinDom / extractTabMetadata，配上假 chrome。
function makeSandbox(page) {
  const stats = { probes: 0, extractions: 0 };
  let lagLeft = 0; // 还要「滞后」几次探测
  let failProbes = 0; // 还要「探测失败」几次（模拟注入超时）

  // 面板按时间自行对齐（更接近真实：对齐发生在某个时刻，而不是某次探测之后）
  const syncPanel = () => {
    if (page.autoAlignAt && Date.now() >= page.autoAlignAt) page.panelId = settledIdOf(page);
  };

  const chrome = {
    scripting: {
      executeScript(options) {
        const name = options?.func?.name;
        if (name === "probeDouyinFreshness") {
          stats.probes += 1;
          // 探测本身失败（注入超时等）——此时 settleDouyinDom 拿不到结论，只能放弃等待。
          // 这正是「事后复核」要兜住的情况。
          if (failProbes > 0) {
            failProbes -= 1;
            return Promise.resolve([{ result: undefined }]);
          }
          syncPanel();
          // 模拟滞后：面板先停留在「上一条」，探测若干次之后才切到当前这条。
          if (lagLeft > 0) {
            lagLeft -= 1;
          } else {
            page.panelId = settledIdOf(page);
          }
          return Promise.resolve([
            { result: { urlId: page.urlId, panelId: page.panelId, larkId: page.larkId } }
          ]);
        }
        if (options?.files?.includes("content-metadata.js")) {
          stats.extractions += 1;
          syncPanel();
          // 抓取时读到的就是「此刻面板上显示的内容」——这正是 bug 的机制：
          // 面板还没跟上，就会抓到上一条视频的标题和封面。
          const live = page.panelId === settledIdOf(page);
          const shownId = live ? settledIdOf(page) : page.panelId;
          return Promise.resolve([
            {
              result: {
                title: live ? page.title : `标题-${page.panelId.slice(-4)}`,
                description: "暂无摘要",
                image: `https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/${shownId}~tplv-dy-360p.jpeg?sc=origin_cover&s=PackSourceEnum_AWEME_DETAIL`,
                imageFrom: "douyin",
                favicon: "https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico",
                source: "抖音",
                url: "https://www.douyin.com/video/" + shownId,
                titleFrom: "douyin",
                // 真实提取脚本会回报「面板上那条视频的 id」——调用方据此复核。
                videoId: shownId
              }
            }
          ]);
        }
        return Promise.reject(new Error("未知的注入函数: " + name));
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Promise
  });
  vm.runInContext(REAL_SOURCE, context);

  return {
    stats,
    run: (fn) => vm.runInContext(fn, context),
    setLag(n) {
      lagLeft = n;
    },
    setFailProbes(n) {
      failProbes = n;
    },
    // 面板会在 ms 毫秒后自行对齐到「当前这条」（更贴近真实的时间线）。
    autoAlignIn(ms) {
      page.autoAlignAt = Date.now() + ms;
    }
  };
}

function task(overrides = {}) {
  return {
    id: 7,
    url: `https://www.douyin.com/video/${overrides.urlId || OLD_ID}`,
    title: "抖音 - 记录美好生活",
    favIconUrl: "",
    status: "complete",
    ...overrides
  };
}

// 在沙盒里调用真实的 extractTabMetadata，返回它解析出的元数据。
const callExtract = (sandbox, tab) => sandbox.run(`extractTabMetadata(${JSON.stringify(tab)})`);

(async () => {
  console.log("=== 一、探测函数本身（真实 DOM）===");
  {
    // 在真实 DOM 上跑真实的 probeDouyinFreshness。
    const probeIn = (html, url) => {
      const dom = new JSDOM(`<!doctype html><html><head>${html.head || ""}</head><body>${html.body || ""}</body></html>`, { url });
      const ctx = vm.createContext({ document: dom.window.document, location: dom.window.location, URL });
      vm.runInContext(grabFunction(BACKGROUND, "probeDouyinFreshness"), ctx);
      return vm.runInContext("probeDouyinFreshness()", ctx);
    };

    const larkMeta = (id) =>
      `<meta name="lark:url:video_iframe_url" content="https://www.douyin.com/aweme/v1/player/?video_id=${id}&ratio=720p" />`;
    const panel = (id, text) => `<div data-e2e="detail-video-info" data-e2e-aweme-id="${id}"><h1>${text}</h1></div>`;

    // ① 已对齐：三路 id 一致
    const fresh = probeIn(
      { head: larkMeta(NEW_ID), body: panel(NEW_ID, "第182集 | 转弯总压线？") },
      `https://www.douyin.com/video/${NEW_ID}`
    );
    check("从网址取到视频 id", fresh.urlId === NEW_ID, fresh.urlId);
    check("从面板的 data-e2e-aweme-id 取到视频 id", fresh.panelId === NEW_ID, fresh.panelId);
    check("从 lark 元数据取到视频 id", fresh.larkId === NEW_ID, fresh.larkId);
    check("因此三路一致 —— 会被判定为「已对齐」", fresh.panelId === fresh.urlId && fresh.panelId === fresh.larkId);

    // ② 面板滞后：网址已是新视频，面板还挂着上一条 —— 这正是用户遇到的现场
    const stale = probeIn(
      { head: larkMeta(NEW_ID), body: panel(OLD_ID, "第181集 | 上一个视频") },
      `https://www.douyin.com/video/${NEW_ID}`
    );
    check("滞后时能识别出「面板 ≠ 网址」", stale.panelId !== stale.urlId, `panel=${stale.panelId.slice(-4)} url=${stale.urlId.slice(-4)}`);
    check("滞后时 lark 已指向新视频（说明它比面板快）", stale.larkId === NEW_ID, stale.larkId.slice(-4));

    // ③ 没有面板 / 没有 lark：两种 id 都要能安全地变成空串（不能抛错）
    const bare = probeIn({}, "https://www.douyin.com/?recommend=1");
    check("没有面板时 panelId 为空串", bare.panelId === "", JSON.stringify(bare.panelId));
    check("首页没有 id 时 urlId 为空串", bare.urlId === "", JSON.stringify(bare.urlId));
    check("没有 lark 元数据时 larkId 为空串", bare.larkId === "", JSON.stringify(bare.larkId));
  }

  console.log("\n=== 二、网址解析（多种抖音地址形态）===");
  {
    const sandbox = makeSandbox(makePage());
    const parse = (url) => sandbox.run(`douyinVideoIdFromUrl(${JSON.stringify(url)})`);
    const isDy = (url) => sandbox.run(`isDouyinUrl(${JSON.stringify(url)})`);

    check("详情页 /video/<id>", parse(`https://www.douyin.com/video/${NEW_ID}`) === NEW_ID);
    check("图文页 /note/<id>", parse(`https://www.douyin.com/note/${NEW_ID}`) === NEW_ID);
    check("首页推荐流 modal_id", parse(`https://www.douyin.com/?recommend=1&modal_id=${NEW_ID}`) === NEW_ID);
    check("用户页带 modal_id", parse(`https://www.douyin.com/user/MS4wLjABAAA?modal_id=${NEW_ID}`) === NEW_ID);

    // 关键：不能把别的网站的 /video/<数字> 当成抖音视频 id。
    check(
      "别的网站的 /video/<数字> 不会被误认",
      parse("https://example.com/video/1234567890") === "",
      JSON.stringify(parse("https://example.com/video/1234567890"))
    );

    // 域名判断要认抖音、也要挡住「看着像」的仿冒域名。
    check("douyin.com 是抖音", isDy("https://www.douyin.com/video/1") === true);
    check("iesdouyin.com 也算抖音", isDy("https://www.iesdouyin.com/share/video/1") === true);
    check("notdouyin.com 不是抖音", isDy("https://notdouyin.com/video/1234567890") === false);
    check("douyin.com.evil.com 不是抖音", isDy("https://douyin.com.evil.com/video/1234567890") === false);
    check("普通网站不是抖音", isDy("https://example.com/") === false);
    check("空网址不会抛错", isDy("") === false);
  }

  console.log("\n=== 三、DOM 已经对齐：不浪费任何等待 ===");
  {
    const page = makePage();
    const sandbox = makeSandbox(page);
    sandbox.setLag(0);
    const t0 = Date.now();
    const meta = await callExtract(sandbox, task());
    const cost = Date.now() - t0;
    check("确实探测过（拿到对齐结论）", sandbox.stats.probes >= 1, `${sandbox.stats.probes} 次探测`);
    check("只探测一次就放行（不无谓空等）", sandbox.stats.probes === 1, `${sandbox.stats.probes} 次`);
    check("耗时很短（<150ms）", cost < 150, `${cost}ms`);
    check("标题是当前视频的", meta.title === `标题-${OLD_ID.slice(-4)}`, meta.title);
  }

  console.log("\n=== 四、复现用户报的问题：网址已换、面板还停在上一集 ===");
  {
    const page = makePage();
    const sandbox = makeSandbox(page);
    sandbox.setLag(3); // 前 3 次探测，面板还显示上一条视频
    page.urlId = NEW_ID; // 用户滑到了下一条：网址立刻变了
    page.title = "第182集 | 转弯总压线？别慌！5个笨招教你稳过弯";
    page.cover = `https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/${NEW_ID}~tplv-dy-360p.jpeg?sc=origin_cover&s=PackSourceEnum_AWEME_DETAIL`;

    const t0 = Date.now();
    const meta = await callExtract(sandbox, task({ urlId: NEW_ID }));
    const cost = Date.now() - t0;

    check("等到了面板对齐才抓（探测 ≥4 次）", sandbox.stats.probes >= 4, `${sandbox.stats.probes} 次探测`);
    check("等待时间在合理范围（150~1500ms）", cost >= 150 && cost < 1500, `${cost}ms`);
    check("抓到的标题是【新】视频的，不是上一集", meta.title.includes("第182集"), meta.title);
    check("抓到的封面是【新】视频的", meta.image.includes(NEW_ID), meta.image.slice(0, 78));
    check("只抓取一次（等待后才抓）", sandbox.stats.extractions === 1, `${sandbox.stats.extractions} 次`);
  }

  console.log("\n=== 五、非抖音网站：一点都不额外打扰 ===");
  {
    const sandbox = makeSandbox(makePage());
    const meta = await callExtract(sandbox, {
      id: 3,
      url: "https://example.com/video/1234567890123",
      title: "普通文章",
      status: "complete"
    });
    check("完全没有探测（不是抖音就不走这条路）", sandbox.stats.probes === 0, `${sandbox.stats.probes} 次探测`);
    check("照常完成抓取", sandbox.stats.extractions === 1, `${sandbox.stats.extractions} 次`);
    check("标题来自注入结果", meta.title === `标题-${OLD_ID.slice(-4)}`, meta.title);
  }

  console.log("\n=== 六、抖音但不是视频详情（首页等）：探测一次就走，不空等 ===");
  {
    // 首页：没有面板、也没有 lark 元数据 → 无从校验，必须立刻放行
    const page = makePage({ panelId: "", larkId: "", urlId: "" });
    const sandbox = makeSandbox(page);
    const t0 = Date.now();
    await callExtract(sandbox, { id: 4, url: "https://www.douyin.com/?recommend=1", title: "抖音", status: "complete" });
    const cost = Date.now() - t0;
    check("探测过，但立刻放行", sandbox.stats.probes === 1, `${sandbox.stats.probes} 次`);
    check("没有白等到超时（<150ms）", cost < 150, `${cost}ms`);
  }

  console.log("\n=== 七、面板一直不跟上：到点就放弃，绝不无限期挂住 ===");
  {
    const page = makePage();
    const sandbox = makeSandbox(page);
    sandbox.setLag(9999); // 永远滞后
    page.urlId = NEW_ID; // 网址指向新视频，但面板永远不会切过来
    const t0 = Date.now();
    const meta = await callExtract(sandbox, task({ urlId: NEW_ID }));
    const cost = Date.now() - t0;
    check("等待时间被 1.5 秒上限卡住", cost >= 1400 && cost < 2600, `${cost}ms`);
    check("仍然返回了结果（尽力而为，不会抛错）", !!meta && typeof meta.title === "string", meta.title);
    check("抓取照常发生", sandbox.stats.extractions === 1, `${sandbox.stats.extractions} 次`);
  }

  console.log("\n=== 八、网址没有 id 时，用 lark 元数据的 id 兜底 ===");
  {
    const page = makePage({ urlId: "", panelId: OLD_ID, larkId: NEW_ID, title: "新视频标题" });
    const sandbox = makeSandbox(page);
    sandbox.setLag(2);
    const t0 = Date.now();
    const meta = await callExtract(sandbox, {
      id: 5,
      url: "https://www.douyin.com/?recommend=1",
      title: "抖音",
      status: "complete"
    });
    const cost = Date.now() - t0;
    check("用 lark 的 id 当作期望值，因此会等面板跟上", sandbox.stats.probes >= 3, `${sandbox.stats.probes} 次`);
    check("确实等到了（>150ms）", cost >= 150, `${cost}ms`);
    check("最终标题是新的", meta.title === "新视频标题", meta.title);
  }

  console.log("\n=== 九、休眠 / 未加载的标签：不探测、直接兜底 ===");
  {
    const sandbox = makeSandbox(makePage());
    const meta = await callExtract(sandbox, {
      id: 6,
      url: `https://www.douyin.com/video/${NEW_ID}`,
      title: "抖音",
      status: "unloaded",
      discarded: true
    });
    check("完全没有探测", sandbox.stats.probes === 0, `${sandbox.stats.probes} 次`);
    check("直接用了浏览器给的标题", meta.title === "抖音", meta.title);
    check("标记了标题来源是标签页", meta.titleFrom === "tab", meta.titleFrom);
  }

  console.log("\n=== 十、安全网：探测失败时，靠「事后复核」也能救回来 ===");
  {
    // 场景：探测那一次注入超时（settleDouyinDom 拿不到结论、立刻放弃），
    // 但随后提取成功了——如果不复核，就会把上一条视频存进去。
    const page = makePage();
    page.urlId = NEW_ID;
    page.title = "第182集 | 转弯总压线？别慌！5个笨招教你稳过弯";
    page.cover = `https://p3-pc-sign.douyinpic.com/tos-cn-p-0015/${NEW_ID}~tplv-dy-360p.jpeg?sc=origin_cover&s=PackSourceEnum_AWEME_DETAIL`;

    const sandbox = makeSandbox(page);
    sandbox.setFailProbes(1); // 第一次探测失败 → settle 直接放弃
    sandbox.autoAlignIn(250); // 面板 250ms 后自己对齐

    const t0 = Date.now();
    const meta = await callExtract(sandbox, task({ urlId: NEW_ID }));
    const cost = Date.now() - t0;

    check("探测确实失败了（没拿到结论）", sandbox.stats.probes === 1, `${sandbox.stats.probes} 次探测`);
    check("因此抓取了不止一次（复核发现对不上，重试）", sandbox.stats.extractions >= 2, `${sandbox.stats.extractions} 次抓取`);
    check("最终标题是【新】视频的", meta.title.includes("第182集"), meta.title);
    check("最终封面是【新】视频的", meta.image.includes(NEW_ID), meta.image.slice(0, 78));
    check("没有耗到上限（在 1.5 秒预算内完成）", cost < 1500, `${cost}ms`);
  }

  console.log("\n=== 十一、代码接线（静态检查）===");
  {
    check(
      "extractTabMetadata 里确实调用了 settleDouyinDom（并共用同一份时间预算）",
      /await settleDouyinDom\(tab, deadline\);/.test(BACKGROUND)
    );
    check("提取前先算好「期望的视频 id」", /const expectedId = isDouyinUrl\(tab\.url\)/.test(BACKGROUND));
    check("抓完会核对「实际读到的视频 id」", /data\.videoId !== expectedId/.test(BACKGROUND));
    check(
      "提取脚本会回报实际读到的视频 id",
      /videoId: douyin\?\.readId/.test(PAGE_SCRIPT) && /readId: document\.querySelector/.test(PAGE_SCRIPT)
    );
    check("quickSave 改为走 extractTabMetadata（快捷键入口也被覆盖）", /const meta = await extractTabMetadata\(tab\);/.test(BACKGROUND));
    const quickSaveBody = BACKGROUND.slice(
      BACKGROUND.indexOf("async function quickSave"),
      BACKGROUND.indexOf("async function toggleTranslation")
    );
    check(
      "quickSave 里不再有「直接注入、无超时」的老写法",
      !/chrome\.scripting\.executeScript\(\{[\s\S]*?func: extractPageMetadataForShortcut/.test(quickSaveBody)
    );
    check(
      "探测函数是自包含的（注入到页面里不依赖外部标识符）",
      !/\b(safeHostname|normalizeUrl|STORAGE_KEY|pillTitle|recordDiag)=?\(/.test(
        grabFunction(BACKGROUND, "probeDouyinFreshness")
      )
    );
    check(
      "抖音封面只认「当前视频」那一张（不拿相关推荐的）",
      /PackSourceEnum_AWEME_DETAIL/.test(PAGE_SCRIPT) || /sc=origin_cover/.test(PAGE_SCRIPT)
    );
  }

  console.log(`\n${failed === 0 ? "全部通过" : "存在失败"}：${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exit(1);
});
