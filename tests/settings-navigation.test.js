// 「打开设置」和「从设置返回」的导航行为测试。覆盖：
//  1) 在收藏墙点「设置」→ 在「当前标签页」切过去，不再多开一个标签
//  2) 按住 ⌘ / Ctrl / Shift 点 → 仍在新标签页打开（保留老习惯）
//  3) 设置页点「返回」→ 回到全屏收藏墙，而不是把当前标签页关掉
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const libraryHtml = fs.readFileSync(`${ROOT}/library.html`, "utf8");
const librarySource = fs.readFileSync(`${ROOT}/library.js`, "utf8");
const settingsHtml = fs.readFileSync(`${ROOT}/settings.html`, "utf8");
const settingsSource = fs.readFileSync(`${ROOT}/settings.js`, "utf8");
const settingsCss = fs.readFileSync(`${ROOT}/settings.css`, "utf8");
const themeSource = fs.readFileSync(`${ROOT}/theme.js`, "utf8");

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
// jsdom 不真的实现导航，改地址时会报「Not implemented: navigation」，这类噪音要滤掉。
const realErrors = (list) => list.filter((e) => !/Not implemented: navigation/.test(e));

function makeVirtualConsole(sink) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", (error) => sink.push(String(error?.message || error)));
  vc.on("error", (message) => sink.push(String(message)));
  return vc;
}

function makeChrome(window, store, extra = {}) {
  return {
    storage: {
      local: {
        get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return Promise.resolve(out);
        },
        set(patch) { Object.assign(store, patch); return Promise.resolve(); }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      getCurrent: () => Promise.resolve({ id: 1, windowId: 7 }),
      get: (id) => Promise.resolve({ id }),
      query: () => Promise.resolve([{ id: 1, windowId: 7, active: true, url: "chrome-extension://lateron/library.html" }]),
      update: (id, options) => { extra.updated.push({ id, ...options }); return Promise.resolve({ id }); },
      create: (options) => { extra.created.push(options); return Promise.resolve({ id: 9 }); },
      remove: (id) => { extra.removed.push(id); return Promise.resolve(); },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onCreated: { addListener() {} }
    },
    windows: { getCurrent: () => Promise.resolve({ id: 7 }) },
    sidePanel: { open: () => Promise.resolve() },
    commands: { getAll: () => Promise.resolve([]) },
    runtime: {
      getURL: (path) => `chrome-extension://lateron/${path}`,
      sendMessage: () => Promise.resolve({ ok: false, ready: true }),
      onMessage: { addListener() {} }
    }
  };
}

(async () => {
  console.log("── 第 1 步：收藏墙点「设置」→ 在当前标签页切过去 ──");
  {
    const errors = [];
    const dom = new JSDOM(libraryHtml, {
      runScripts: "outside-only", pretendToBeVisual: true,
      url: "chrome-extension://lateron/library.html",
      virtualConsole: makeVirtualConsole(errors)
    });
    const { window } = dom;
    const logs = { updated: [], created: [], removed: [] };
    window.chrome = makeChrome(window, { laterOnItems: [], laterOnProjects: [], laterOnSettings: {} }, logs);
    if (typeof window.crypto?.randomUUID !== "function") {
      Object.defineProperty(window, "crypto", { configurable: true, value: { randomUUID: () => "fake-" + Math.random().toString(36).slice(2) } });
    }
    window.eval(librarySource);
    await tick();

    const settingsButton = window.document.querySelector("#openSettings");
    check("收藏墙上有「设置」入口", !!settingsButton);
    settingsButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();

    check("没有新开标签页", logs.created.length === 0, `新开了 ${logs.created.length} 个`);
    check("当前标签页被切到设置页", logs.updated.length === 1 && /settings\.html$/.test(logs.updated[0].url || ""), JSON.stringify(logs.updated));
    check("全程没有报错", realErrors(errors).length === 0, realErrors(errors).slice(0, 2).join(" | "));
    dom.window.close();
  }

  console.log("\n── 第 2 步：按住 ⌘ / Ctrl / Shift 点 → 仍在新标签页打开 ──");
  {
    const errors = [];
    const dom = new JSDOM(libraryHtml, {
      runScripts: "outside-only", pretendToBeVisual: true,
      url: "chrome-extension://lateron/library.html",
      virtualConsole: makeVirtualConsole(errors)
    });
    const { window } = dom;
    const logs = { updated: [], created: [], removed: [] };
    window.chrome = makeChrome(window, { laterOnItems: [], laterOnProjects: [], laterOnSettings: {} }, logs);
    if (typeof window.crypto?.randomUUID !== "function") {
      Object.defineProperty(window, "crypto", { configurable: true, value: { randomUUID: () => "fake-" + Math.random().toString(36).slice(2) } });
    }
    window.eval(librarySource);
    await tick();

    window.document.querySelector("#openSettings")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    await tick();
    check("新开了一个标签页到设置页", logs.created.length === 1 && /settings\.html$/.test(logs.created[0].url || ""), JSON.stringify(logs.created));
    check("当前标签页没被切走", logs.updated.length === 0);
    check("全程没有报错", realErrors(errors).length === 0, realErrors(errors).slice(0, 2).join(" | "));
    dom.window.close();
  }

  console.log("\n── 第 3 步：设置页点「返回」→ 回到全屏页，而不是关掉标签页 ──");
  {
    const errors = [];
    const dom = new JSDOM(settingsHtml, {
      runScripts: "outside-only", pretendToBeVisual: true,
      url: "chrome-extension://lateron/settings.html",
      virtualConsole: makeVirtualConsole(errors)
    });
    const { window } = dom;
    const logs = { updated: [], created: [], removed: [] };
    window.chrome = makeChrome(window, { laterOnSettings: { theme: "light" }, laterOnItems: [], laterOnProjects: [] }, logs);
    window.eval(themeSource);

    // 记录「是不是走了浏览器后退」：jsdom 不会真的导航，所以这里替身 Tracking。
    let backCalls = 0;
    Object.defineProperty(window.history, "back", { configurable: true, value: () => { backCalls += 1; } });
    // 模拟「从收藏墙切过来」：地址栏里有历史可以退。
    //（jsdom 里 chrome-extension:// 是不透明源，pushState 会被拒绝，只能直接伪造长度。）
    Object.defineProperty(window.history, "length", { configurable: true, value: 2 });

    window.eval(settingsSource);
    await tick();

    window.document.querySelector("#back")
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();

    check("走的是浏览器后退（回到刚才那面收藏墙）", backCalls === 1, `后退了 ${backCalls} 次`);
    check("没有把当前标签页关掉", logs.removed.length === 0, `关了 ${logs.removed.length} 个`);
    await tick(420);   // 兜底定时器本该随页面卸载消失；这里页面没真走，跑一下确认不报错
    check("全程没有报错（导航类报错除外）", realErrors(errors).length === 0, realErrors(errors).slice(0, 2).join(" | "));
    dom.window.close();
  }

  console.log("\n── 第 4 步：设置页点左上角品牌标识 → 回全屏首页 ──");
  {
    const errors = [];
    const dom = new JSDOM(settingsHtml, {
      runScripts: "outside-only", pretendToBeVisual: true,
      url: "chrome-extension://lateron/settings.html",
      virtualConsole: makeVirtualConsole(errors)
    });
    const { window } = dom;
    const logs = { updated: [], created: [], removed: [] };
    // 上一次进来时钻在某个项目里：点品牌标识要把它复位，否则「首页」还是那个项目。
    const store = { laterOnSettings: { theme: "light" }, laterOnItems: [], laterOnProjects: [], laterOnActiveProject: "work" };
    window.chrome = makeChrome(window, store, logs);
    window.eval(themeSource);
    window.eval(settingsSource);
    await tick();

    const brand = window.document.querySelector("#settingsHome");
    check("设置页左上角的品牌标识是个链接", brand?.tagName === "A", brand?.outerHTML?.slice(0, 60));
    check("它的 href 指向全屏页", /library\.html$/.test(brand?.getAttribute("href") || ""), brand?.getAttribute("href"));

    // 它从 <span> 变成了 <a>：浏览器默认会给链接加下划线，样式表里必须显式去掉，
    // 否则顶栏会突然多出一条线（纯视觉，只能静态锁）。
    const brandRule = /^\.settings-brand\s*\{[^}]*\}/m.exec(settingsCss)?.[0] || "";
    check("品牌标识没有链接下划线", /text-decoration:\s*none/.test(brandRule), brandRule.replace(/\s+/g, " ").slice(0, 120));

    brand.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick();

    check("「当前项目」被复位成全部项目", store.laterOnActiveProject === "all", String(store.laterOnActiveProject));
    check("当前标签页切到了全屏页", logs.updated.length === 1 && /library\.html$/.test(logs.updated[0].url || ""), JSON.stringify(logs.updated));
    check("没有多开标签页", logs.created.length === 0, JSON.stringify(logs.created));
    check("全程没有报错（导航类报错除外）", realErrors(errors).length === 0, realErrors(errors).slice(0, 2).join(" | "));
    dom.window.close();
  }

  console.log("\n── 第 5 步：代码里不再有关掉标签页的旧逻辑 ──");
  check("设置页不再 chrome.tabs.remove 自己", !/tabs\.remove/.test(settingsSource));

  console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${failures === 0 ? "没有失败项" : failures + " 项失败"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
