// 地址栏直接回车后的收藏库落点：搜索词自动填入，并临时搜索全部阅读状态。
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const dom = new JSDOM(read("library.html"), {
  runScripts: "outside-only",
  pretendToBeVisual: true,
  url: "chrome-extension://lateron/library.html?q=design%20system&from=omnibox"
});
const { window } = dom;
const { document } = window;
const store = {
  laterOnItems: [
    { id: "done", title: "Design system handbook", description: "Tokens", source: "design.test", projectId: "p1", url: "https://design.test/handbook", savedAt: 2, status: "done" },
    { id: "other", title: "Another page", description: "Other", source: "other.test", projectId: null, url: "https://other.test/", savedAt: 1, status: "unread" }
  ],
  laterOnProjects: [{ id: "p1", name: "设计" }],
  laterOnActiveProject: "p1",
  laterOnSettings: {},
  laterOnFilter: "unread",
  laterOnFilterChosen: true
};
window.chrome = {
  storage: {
    local: {
      async get(keys) { const out = {}; for (const key of keys) out[key] = store[key]; return out; },
      async set(patch) { Object.assign(store, patch); }
    },
    onChanged: { addListener() {} }
  },
  tabs: {
    query: async () => [{ id: 1, windowId: 1, active: true }],
    getCurrent: async () => ({ id: 1, windowId: 1 }),
    update: async () => ({}),
    create: async () => ({})
  },
  windows: { getCurrent: async () => ({ id: 1 }), create: async () => ({}) },
  runtime: { getURL: (file) => `chrome-extension://lateron/${file}`, sendMessage: async () => ({}), onMessage: { addListener() {} } },
  sidePanel: { open: async () => true }
};
window.scrollTo = () => {};
window.eval(read("i18n.js"));
window.eval(read("dialog.js"));
window.eval(read("picker-ui.js"));
window.eval(read("library.js"));

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? `  → ${extra}` : ""}`);
  if (!ok) failures += 1;
};

(async () => {
  await new Promise((resolve) => window.setTimeout(resolve, 60));
  check("地址栏搜索词自动填进搜索框", document.querySelector("#searchInput").value === "design system", document.querySelector("#searchInput").value);
  check("即使原偏好是未读，也能找到已读匹配项", !!document.querySelector('.card[data-id="done"]'));
  check("顶部临时切到全部状态", document.querySelector('.nav-item[data-filter="all"]').classList.contains("active"));
  check("没有改写用户原来的筛选偏好", store.laterOnFilter === "unread", store.laterOnFilter);
  check("搜索仍然是全局的，不受起始项目限制", document.querySelectorAll("#cardGrid .card").length === 1);
  console.log(failures ? `\n❌ 有 ${failures} 项失败` : "\n🎉 全部通过");
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
