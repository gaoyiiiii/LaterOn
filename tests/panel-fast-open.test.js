// 侧栏「秒开」相关行为测试。用 jsdom 加载真实的 sidepanel.html + sidepanel.js，覆盖：
//  1) 秒开缓存：chrome.storage 还没返回时，列表先用 localStorage 里的快照画出来（不等白屏）
//  2) 骨架屏：没有缓存时先显示占位卡片，第一次 render 后撤掉
//  3) 封面搬家：旧数据里 base64 大图自动挪到单独的 laterOnCovers 键，条目只留 local://<id> 指针
//  4) 删除收藏时，它自己上传的封面也一并删掉
// 运行：NODE_PATH=<jsdom 路径> node tests/panel-fast-open.test.js
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(`${ROOT}/sidepanel.html`, "utf8");
const sidepanelSource = fs.readFileSync(`${ROOT}/sidepanel.js`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const now = Date.now();
const DATA_URL = "data:image/jpeg;base64,BIGCOVERDATA";

function makeItem(overrides = {}) {
  return {
    id: "x", title: "标题", description: "摘要", image: "", favicon: "",
    source: "x.com", projectId: null, url: "https://x.com", savedAt: now, status: "unread",
    ...overrides
  };
}

// 建一个页面环境。pendingGet=true 时 storage.get 会一直挂着，
// 直到手动调 releaseGet()——用来模拟「存储读得特别慢」。
// cache 传入数组时，会在脚本运行前往 localStorage 里种一份秒开缓存。
function boot({ store, pendingGet = false, cache = null, bootStartOffsetMs = 0, slowCacheMs = 0, getError = null }) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));
  virtualConsole.on("error", (message) => errors.push(String(message)));

  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "chrome-extension://lateron/sidepanel.html",
    virtualConsole
  });
  const { window } = dom;
  const { document } = window;

  // jsdom 在 chrome-extension:// 来源下不提供 localStorage（真实 Chrome 扩展页面有），
  // 用一个内存版替身，行为一致：同步读写。
  const memStore = new Map();
  // 记录「读存储」和「读本地缓存」谁先发生：这两件事必须并行，
  // 排队的话谁慢整条链就卡在谁后面（曾经因此白等十几秒）。
  const callOrder = [];
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => {
        if (key === "laterOnPanelCache") {
          callOrder.push("cache");
          // 模拟「本机 localStorage 本身就慢」：同步卡住若干毫秒。
          if (slowCacheMs) {
            const until = Date.now() + slowCacheMs;
            while (Date.now() < until) { /* 同步阻塞 */ }
          }
        }
        return memStore.has(key) ? memStore.get(key) : null;
      },
      setItem: (key, value) => memStore.set(key, String(value)),
      removeItem: (key) => memStore.delete(key)
    }
  });

  let releaseGet = null;
  const getPromise = getError
    ? Promise.reject(new Error(getError))
    : pendingGet
    ? new Promise((resolve) => { releaseGet = resolve; })
    : Promise.resolve(store);
  const changeListeners = [];

  window.chrome = {
    storage: {
      local: {
        get: () => {
          callOrder.push("storage");
          return getPromise;
        },
        set: async (patch) => {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: store[key], newValue: JSON.parse(JSON.stringify(value)) };
            store[key] = JSON.parse(JSON.stringify(value));
          }
          // 真实 Chrome 里自己的写入也会广播 onChanged（界面靠它重画）。
          window.setTimeout(() => changeListeners.forEach((fn) => fn(changes, "local")), 0);
        }
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "https://current.com" }]),
      update: () => Promise.resolve({}),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
    runtime: {
      getURL: (path) => `chrome-extension://lateron/${path}`,
      sendMessage: () => Promise.resolve({ ok: false }),
      onMessage: { addListener() {} }
    }
  };

  if (cache) window.localStorage.setItem("laterOnPanelCache", JSON.stringify(cache));
  // 模拟「页面准备阶段就花掉了很多秒」（boot.js 记的起点往前推），用来验证慢的时候会给出结论。
  if (bootStartOffsetMs) {
    const nowPerf = window.performance?.now ? window.performance.now() : Date.now();
    window.LaterOnBoot = { t0: nowPerf - bootStartOffsetMs };
  }
  // 侧栏页面里 dialog.js 是 defer 加载的，删除确认要用到它：这里同样先跑一遍真实实现。
  window.eval(fs.readFileSync(`${ROOT}/dialog.js`, "utf8"));
  window.eval(sidepanelSource);

  return {
    window,
    document,
    store,
    errors,
    releaseGet: () => releaseGet && releaseGet(store),
    callOrder,
    itemOf: (id) => document.querySelector(`.item[data-id="${id}"]`),
    coverSrc: (id) => document.querySelector(`.item[data-id="${id}"] .thumb img.thumb-img`)?.getAttribute("src") || ""
  };
}

(async () => {
  // ═══ ① 秒开缓存：storage 慢，先画缓存 ═══
  console.log("── ① 秒开缓存：storage 迟迟不返回时，先用缓存把列表画出来 ──");
  const slowStore = {
    laterOnItems: [makeItem({ id: "fresh", title: "存储里的新标题" })],
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {}
  };
  const envA = boot({ store: slowStore, pendingGet: true, cache: [makeItem({ id: "cached", title: "缓存里的旧标题" })] });

  check("storage 没返回时列表已经画出来（用的是缓存）", !!envA.itemOf("cached"), `${envA.document.querySelectorAll("#items .item").length} 张可见`);
  check("缓存渲染是同步完成的（eval 完立刻可见）", envA.document.querySelectorAll("#items .item").length === 1);
  check("骨架屏已被撤掉", !envA.document.querySelector("#bootSkeleton"));

  envA.releaseGet();
  await tick(30);
  check("存储返回后按真数据重画", !!envA.itemOf("fresh") && !envA.itemOf("cached"));
  // 写快照是「给下一次打开用的」，所以故意推迟到下一轮事件循环再写，
  // 不让它挡住眼前这一次绘制 —— 这里多等一下再验。
  await tick(400);
  const cacheAfter = JSON.parse(envA.window.localStorage.getItem("laterOnPanelCache") || "[]");
  check("最新数据已写回秒开缓存", cacheAfter.some((it) => it.id === "fresh"), JSON.stringify(cacheAfter.map((it) => it.id)));

  // ═══ ② 骨架屏：无缓存、storage 慢时先占位 ═══
  console.log("\n── ② 骨架屏：无缓存时先显示占位，数据到了撤掉 ──");
  const envB = boot({ store: slowStore, pendingGet: true });
  check("storage 没返回时显示骨架屏", !!envB.document.querySelector("#bootSkeleton") && envB.document.querySelectorAll("#bootSkeleton .skel-item").length >= 2);
  check("此时还没有真卡片", envB.document.querySelectorAll("#items .item").length === 0);
  envB.releaseGet();
  await tick(30);
  check("数据到了骨架屏撤掉、真卡片出现", !envB.document.querySelector("#bootSkeleton") && !!envB.itemOf("fresh"));

  // ═══ ③ 封面搬家：旧 base64 大图挪去单独的键 ═══
  console.log("\n── ③ 封面搬家：base64 大图挪进 laterOnCovers，条目只留指针 ──");
  const legacyStore = {
    laterOnItems: [
      makeItem({ id: "old-1", title: "老封面收藏", image: DATA_URL }),
      makeItem({ id: "old-2", title: "远程封面收藏", image: "https://site.com/a.jpg" })
    ],
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {}
  };
  const envC = boot({ store: legacyStore });
  await tick(30);
  const migrated = legacyStore.laterOnItems.find((it) => it.id === "old-1");
  check("条目里的 base64 换成了 local:// 指针", migrated?.image === "local://old-1", String(migrated?.image).slice(0, 40));
  check("封面本体进了 laterOnCovers 键", legacyStore.laterOnCovers?.["old-1"] === DATA_URL);
  check("远程封面不被搬动", legacyStore.laterOnItems.find((it) => it.id === "old-2")?.image === "https://site.com/a.jpg");
  check("老封面在卡片上照常显示", envC.coverSrc("old-1") === DATA_URL, envC.coverSrc("old-1").slice(0, 40));
  check("搬完家没有 jsdom 报错", envC.errors.length === 0, envC.errors.slice(0, 2).join(" | "));

  // ═══ ④ 删除收藏时，自己上传的封面跟着删 ═══
  console.log("\n── ④ 删除收藏时封面本体一并清除 ──");
  const coverStore = {
    laterOnItems: [makeItem({ id: "has-cover", image: "local://has-cover" })],
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: { "has-cover": DATA_URL }
  };
  const envD = boot({ store: coverStore });
  await tick(30);
  const clickDelete = () => envD.itemOf("has-cover").querySelector(".delete")
    .dispatchEvent(new envD.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  clickDelete();
  await tick(30);
  // 删除前先弹确认（危险操作，不能一点就没）
  check("点删除先弹确认弹窗", !!envD.document.querySelector(".lod-root:not([hidden])"));
  envD.document.querySelector(".lod-root:not([hidden]) .lod-cancel")
    .dispatchEvent(new envD.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(320);   // 弹窗有一段关闭动画，等它真正 resolve
  check("点「取消」不会删除", !!envD.itemOf("has-cover"));
  clickDelete();
  await tick(30);
  envD.document.querySelector(".lod-root:not([hidden]) .lod-ok")
    .dispatchEvent(new envD.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick(320);
  check("确认后收藏被删掉", !envD.itemOf("has-cover"));
  check("封面本体也删掉了", !("has-cover" in (coverStore.laterOnCovers || {})), JSON.stringify(coverStore.laterOnCovers));

  // ═══ ⑤ 收藏很多时分批画：先出第一屏，剩下不阻塞 ═══
  console.log("\n── ⑤ 收藏很多时分批画：第一批立刻可见，其余空闲时段续画 ──");
  const many = Array.from({ length: 500 }, (_, i) => makeItem({ id: `n-${i}`, title: `第 ${i} 篇`, savedAt: now - i * 1000 }));
  const bigStore = {
    laterOnItems: many,
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {}
  };
  const envE = boot({ store: bigStore, pendingGet: true });
  check("数据还没到时不画任何卡片（也不占位）", envE.document.querySelectorAll("#items .item").length === 0);
  envE.releaseGet();
  await tick(1);
  const firstBatch = envE.document.querySelectorAll("#items .item").length;
  check("第一批只画 8 张（覆盖一屏，不一次性铺满）", firstBatch === 8, `${firstBatch} 张`);
  check("篇数统计仍然显示全部 500 篇", envE.document.querySelector("#itemCount")?.textContent === "500 篇", envE.document.querySelector("#itemCount")?.textContent);
  // jsdom 比真实浏览器慢很多，给足时间把剩余批次跑完（机器卡一下 3 秒可能不够，放宽到 5 秒；
  // 这里测的是「剩余批次最终会补上」，不是「必须在几秒内补完」）。
  await tick(5000);
  const afterIdle = envE.document.querySelectorAll("#items .item").length;
  check("空闲时段把剩下的补齐", afterIdle === 500, `${afterIdle} 张`);

  // ═══ ⑥ 打开速度会被记进存储（设置页能看到）═══
  console.log("\n── ⑥ 每次打开都把分段耗时记进 laterOnPanelDiag ──");
  const diagStore = {
    laterOnItems: [makeItem({ id: "d-1" })],
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {}
  };
  const envF = boot({ store: diagStore });
  await tick(40);
  const record = diagStore.laterOnPanelDiag;
  check("写入了侧栏打开耗时记录", !!record && typeof record.total === "number", JSON.stringify(record));
  check("记录了「页面准备」用时", typeof record?.page === "number");
  check("记录了「读数据」用时", typeof record?.data === "number");
  check("记下了是否命中秒开缓存", typeof record?.cacheHit === "boolean", String(record?.cacheHit));
  check("记下了收藏篇数", record?.items === 1, String(record?.items));
  check("记下了 localStorage 能不能用", typeof record?.localStorageOk === "boolean", String(record?.localStorageOk));

  // ═══ ⑥ 打开慢时，结论直接写在界面上 ═══
  console.log("\n── ⑥ 打开慢时，侧栏顶部直接写出「慢在哪一步」 ──");
  const slowOpen = boot({ store: slowStore, bootStartOffsetMs: 9000 });
  await tick(30);
  const banner = slowOpen.document.querySelector("#slowBanner");
  check("慢的时候横幅显示出来了", banner && banner.hidden === false);
  check("横幅里写明了总耗时", /9\.9|10\.0|9\.\d 秒/.test(banner?.textContent || ""), (banner?.textContent || "").split("\n")[0]);
  check("横幅里点明是「准备页面」慢（不是数据慢）",
    /准备页面/.test(banner?.textContent || "") && /Chrome 打开侧边栏/.test(banner?.textContent || ""),
    (banner?.textContent || "").split("\n").slice(-1)[0]);
  check("慢的文件也记进了诊断", Array.isArray(slowOpen.store.laterOnPanelDiag?.slow), JSON.stringify(slowOpen.store.laterOnPanelDiag?.slow));

  const fastOpen = boot({ store: slowStore });
  await tick(30);
  check("快的时候不显示横幅（界面保持干净）",
    fastOpen.document.querySelector("#slowBanner")?.hidden === true);

  // 0.8 秒左右是正常水平（冷启动时读一次本地存储本来就要几百毫秒），
  // 不该弹横幅——弹出来反而像在报错。诊断照记，去设置页能翻。
  const normalOpen = boot({ store: slowStore, bootStartOffsetMs: 850 });
  await tick(30);
  check("0.8 秒这种正常速度不弹横幅",
    normalOpen.document.querySelector("#slowBanner")?.hidden === true);
  check("但耗时照旧记进诊断（设置页能看到）",
    typeof normalOpen.store.laterOnPanelDiag?.total === "number",
    JSON.stringify(normalOpen.store.laterOnPanelDiag?.total));

  const twoSecOpen = boot({ store: slowStore, bootStartOffsetMs: 2500 });
  await tick(30);
  check("超过 2 秒才弹横幅", twoSecOpen.document.querySelector("#slowBanner")?.hidden === false);

  // ═══ ⑦ 骨架屏：覆盖整个界面轮廓，真界面此时不占位 ═══
  console.log("\n── ⑦ 骨架屏：整屏轮廓占位，真内容一来就整体换掉 ──");
  const css = fs.readFileSync(`${ROOT}/sidepanel.css`, "utf8");
  const envG = boot({ store: slowStore, pendingGet: true });
  const skel = envG.document.querySelector("#bootSkeleton");
  check("没数据时显示骨架屏", !!skel);
  check("骨架屏里有「收藏当前网页」那一栏的轮廓", !!skel?.querySelector(".skel-save"));
  check("骨架屏里有搜索框的轮廓", !!skel?.querySelector(".sk-search"));
  check("骨架屏里有筛选按钮的轮廓", skel?.querySelectorAll(".skel-filters .sk-pill").length === 3);
  check("骨架屏里有项目的轮廓", skel?.querySelectorAll(".skel-chips .sk-chip").length === 3);
  check("骨架屏里有 5 张卡片的轮廓", skel?.querySelectorAll(".skel-item").length === 5, `${skel?.querySelectorAll(".skel-item").length} 张`);
  check("卡片轮廓跟真卡片一样是 92px 封面 + 文字行", !!skel?.querySelector(".skel-item .sk-thumb"));
  check("真内容整块包在 #appBody 里（骨架屏在场时不占位）",
    !!envG.document.querySelector("#appBody #items") && !!envG.document.querySelector("#appBody .save-panel"));
  check("CSS 里写了「骨架屏在场就隐藏真界面」", /body\.booting\s+#appBody\s*\{\s*display:\s*none/.test(css));
  check("页面一开始带 .booting 标记", envG.document.body.classList.contains("booting"));

  envG.releaseGet();
  await tick(30);
  // ═══ ⑦b 封面上下铺满（只有真浏览器能看出来，这里用静态断言钉住）═══
  // 卡片的实际高度由右边的文字决定（标题、摘要各两行时约 106px），缩略图写死 92px
  // 就会在封面底下露出一截白。jsdom 没有排版，量不出来，只能盯 CSS 写法。
  console.log("\n── ⑦b 封面必须上下铺满，且不能反过来把卡片顶高 ──");
  check("缩略图高度交给拉伸（height:auto + min-height，不再写死）",
    /\.thumb\s*\{[^}]*height:\s*auto[^}]*min-height:\s*92px/.test(css));
  check("缩略图是定位容器", /\.thumb\s*\{[^}]*position:\s*relative/.test(css));
  check("占位绝对定位铺满（不再参与卡片高度计算）",
    /\.thumb-placeholder\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0/.test(css));
  check("真实封面盖在占位之上（z-index，否则被占位挡住）",
    /\.thumb\s+\.thumb-img\s*\{[^}]*z-index:\s*1/.test(css));

  check("数据到了：骨架屏撤掉", !envG.document.querySelector("#bootSkeleton"));
  check("数据到了：.booting 标记去掉（真界面露面）", !envG.document.body.classList.contains("booting"));
  check("数据到了：真卡片画出来", !!envG.itemOf("fresh"));

  // ═══ ⑧ 久等才提示：快的时候界面保持干净 ═══
  console.log("\n── ⑧ 提示条：快时不出现，等超过 1.2 秒才亮出来 ──");
  const bootSource = fs.readFileSync(`${ROOT}/boot.js`, "utf8");
  const domH = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "chrome-extension://lateron/sidepanel.html" });
  domH.window.eval(bootSource);
  const tip = domH.window.document.querySelector("#bootTip");
  check("刚打开时提示条是隐藏的（界面干净）", tip?.hidden === true);
  check("boot.js 提供了「内容就绪就撤占位」的出口", typeof domH.window.LaterOnBoot?.done === "function");
  await tick(1500);
  check("等超过 1.2 秒后提示条亮出来", tip?.hidden === false);
  check("提示条上带实时秒数", /秒$/.test(domH.window.document.querySelector("#bootTipTime")?.textContent || ""),
    domH.window.document.querySelector("#bootTipTime")?.textContent);
  domH.window.LaterOnBoot.done();
  check("调用 done() 后提示条和骨架屏都被撤掉",
    !domH.window.document.querySelector("#bootTip") && !domH.window.document.querySelector("#bootSkeleton"));
  check("调用 done() 后 .booting 去掉", !domH.window.document.body.classList.contains("booting"));

  // ═══ ⑨ 兜底：脚本万一整个没跑起来，也不能永远停在骨架屏 ═══
  console.log("\n── ⑨ 兜底：超过 12 秒强制露出真界面 ──");
  check("boot.js 里有「超时兜底」逻辑", /12000/.test(bootSource) && /reveal\(\)/.test(bootSource));

  // ═══ ⑩ 打开过程：各段分别计时，且读存储与读缓存并行（不排队）═══
  console.log("\n── ⑩ 分段计时：读存储先发出去，和读本地缓存并行，不排队 ──");
  const segStore = {
    laterOnItems: [makeItem({ id: "s-1" })],
    laterOnProjects: [],
    laterOnActiveProject: "all",
    laterOnSettings: {},
    laterOnCovers: {}
  };
  const envSeg = boot({ store: segStore, cache: [makeItem({ id: "cached" })] });
  await tick(60);
  check("读存储先发出去，再读本地缓存（两步并行，不是先缓存后存储）",
    envSeg.callOrder[0] === "storage" && envSeg.callOrder[1] === "cache",
    envSeg.callOrder.join(" → "));
  const seg = segStore.laterOnPanelDiag || {};
  check("每一段耗时都单独记下来了（页面/缓存/画屏/数据/搬封面/其余）",
    ["page", "cache", "paint", "data", "migrate", "other"].every((key) => typeof seg[key] === "number"),
    JSON.stringify({ page: seg.page, cache: seg.cache, paint: seg.paint, data: seg.data, migrate: seg.migrate, other: seg.other }));
  check("用上了秒开缓存这件事也记下来了", seg.cacheHit === true, String(seg.cacheHit));
  check("单独记录了首屏可见时间（不和后台校准完成混在一起）",
    typeof seg.firstPaint === "number" && seg.firstPaint <= seg.total,
    `首屏 ${seg.firstPaint} / 总计 ${seg.total} 毫秒`);

  await tick(400);
  const previewCache = JSON.parse(envE.window.localStorage.getItem("laterOnPanelCache") || "[]");
  check("秒开快照最多只存 12 条（一屏预览，不复制整座数据库）",
    previewCache.length <= 12, `${previewCache.length} 条`);

  // 本机 localStorage 本身慢 → 记下来，并且后续不再反复读写它。
  const envSlowLs = boot({ store: segStore, cache: [makeItem({ id: "cached" })], slowCacheMs: 500 });
  await tick(60);
  check("本地缓存读得慢会被识别出来（之后停用秒开快照）",
    envSlowLs.store.laterOnPanelDiag?.localStorageSlow === true,
    `cache ${envSlowLs.store.laterOnPanelDiag?.cache} 毫秒`);
  check("识别为慢之后不再往 localStorage 写快照",
    (() => {
      const before = envSlowLs.window.localStorage.getItem("laterOnPanelCache") || "";
      return !before.includes("s-1");
    })(),
    (envSlowLs.window.localStorage.getItem("laterOnPanelCache") || "").slice(0, 60));

  // ═══ ⑪ 首屏「零依赖」：不加载任何外部 CSS/JS 也能画出骨架屏 ═══
  console.log("\n── ⑪ 首屏不依赖外部文件：外部样式表改为异步，骨架屏样式内联在 HTML 里 ──");
  // 外部样式表是「阻塞渲染」的：浏览器要等它们全部到齐才画第一个像素。
  // 只要还有一个漏网的（没有 data-boot-style），慢起来就又会是一整块白。
  const headOnly = html.slice(0, html.indexOf("</head>"));
  const noscriptFree = headOnly.replace(/<noscript>[\s\S]*?<\/noscript>/g, "");
  const cssLinks = [...noscriptFree.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map((m) => m[0]);
  check("head 里的外部样式表全部改成异步（data-boot-style + media=print）",
    cssLinks.length > 0 && cssLinks.every((tag) => tag.includes("data-boot-style") && tag.includes('media="print"')),
    cssLinks.map((t) => (t.match(/href="([^"]+)"/) || [])[1]).join("、"));
  check("内联了首屏兜底样式（不依赖外部 CSS 也能画出骨架屏）",
    /<style id="bootCriticalStyle">[\s\S]*?#bootSkeleton[\s\S]*?\.sk-line[\s\S]*?<\/style>/.test(headOnly));
  check("兜底样式里包含深浅两套配色（跟随系统）",
    /prefers-color-scheme: dark/.test(headOnly));
  check("[hidden] 的隐藏规则显式写出来了（否则 .boot-tip 的 display 会盖掉它）",
    /#bootTip\[hidden\]\s*{\s*display:\s*none/.test(headOnly));
  check("theme.js / dialog.js 改成 defer（不再卡住 body 解析）",
    /<script src="theme\.js" defer>/.test(headOnly) && /<script src="dialog\.js" defer>/.test(headOnly));
  check("boot.js / sidepanel.js 也使用 defer（外部脚本变慢时 body 和骨架仍能先解析）",
    /<script src="boot\.js" defer>/.test(headOnly) && /<script src="sidepanel\.js" defer>/.test(headOnly));
  check("boot.js 会把异步样式表切换成生效",
    /activateStyles/.test(bootSource) && /link\.media = "all"/.test(bootSource));
  // 兜底样式给 body 留了 12px/16px 的空（骨架屏期好看），正式样式必须显式清零，
  // 否则吸顶导航栏够不到面板两缘（毛玻璃块两头缺一截）。这个坑 1.43.5 修过。
  check("正式样式把 body 的 padding 清零（导航栏才能通栏）",
    /body\s*{[^}]*padding:\s*0/.test(css));
  check("导航栏自己的 margin 也清零（不被兜底样式的 margin-bottom 顶出一条缝）",
    /header\s*{[^}]*margin:\s*0/.test(css));

  // ═══ ⑫ 存储偶发失败：保留快照，不把它误覆盖成空列表 ═══
  console.log("\n── ⑫ 存储失败时保留上次快照，并给出可恢复提示 ──");
  const cachedItem = makeItem({ id: "still-here", title: "上次打开的内容" });
  const envError = boot({ store: {}, cache: [cachedItem], getError: "storage unavailable" });
  await tick(30);
  check("存储失败时仍显示上次快照", !!envError.itemOf("still-here"));
  check("界面明确说明正在显示上次内容", /显示上次打开的内容/.test(envError.document.querySelector("#status")?.textContent || ""));
  await tick(400);
  check("失败不会把快照覆盖成空数组",
    JSON.parse(envError.window.localStorage.getItem("laterOnPanelCache") || "[]").some((item) => item.id === "still-here"));

  console.log(`\n${failures === 0 ? "🎉 全部通过" : `❌ 有 ${failures} 项没通过`}`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("测试跑挂了：", error);
  process.exit(1);
});
