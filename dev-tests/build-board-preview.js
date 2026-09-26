// 生成「图板视图」的设计预览页：真实的 library.html + 真实的 library.js，
// 只把 chrome.storage 换成一份假数据（几个类目、带封面的收藏），打开就是图板视图。
// 这样预览看到的就是当前那份实现，不会和代码脱节（改完重跑一次本脚本即可）。
//
// 用法：node dev-tests/build-board-preview.js
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const ROOT = path.join(dir, "..");
const OUTPUT = path.join(dir, "board-preview.html");

const mock = () => {
  // 预览用的假封面：直接用 SVG data URI，不依赖网络，离线也能看到拼图效果。
  const svgCover = (from, to, label) =>
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
      `<rect width="600" height="400" fill="url(#g)"/>` +
      `<text x="300" y="225" font-size="70" text-anchor="middle" fill="rgba(255,255,255,.92)" ` +
      `font-family="system-ui, sans-serif">${label}</text></svg>`
    );
  const now = Date.now();
  const day = 86400000;
  const item = (id, extra) => ({
    id, title: `标题 ${id}`, description: "这是自动抓取来的一段摘要，用来看看排版长什么样。",
    image: "", favicon: "", source: "少数派", url: `https://example.com/${id}`,
    savedAt: now, read: false, ...extra
  });
  window.chrome = {
    storage: {
      local: {
        get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return Promise.resolve(out);
        },
        set(patch) {
          const changes = {};
          for (const [key, value] of Object.entries(patch)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          window.setTimeout(() => listeners.forEach((fn) => fn(changes, "local")), 0);
          return Promise.resolve();
        }
      },
      onChanged: { addListener(fn) { listeners.push(fn); } }
    },
    tabs: { query: () => Promise.resolve([{ id: 1, windowId: 1 }]) },
    runtime: { getURL: (p) => `chrome-extension://lateron/${p}` }
  };
  const listeners = [];
  const store = {
    laterOnItems: [
      item("e1", { title: "把一天切成三块：我用了半年的时间管理法", source: "少数派", projectId: "eff", image: svgCover("#ff9a6c", "#ff5c35", "1") }),
      item("e2", { title: "为什么你的待办清单总是做不完", source: "知乎", projectId: "eff", savedAt: now - day, image: svgCover("#6cc4ff", "#2f6bff", "2") }),
      item("e3", { title: "深度工作的四个前提", source: "少数派", projectId: "eff", savedAt: now - 2 * day, image: svgCover("#8ad6a5", "#1f9c63", "3") }),
      item("e4", { title: "会议减半之后发生了什么", source: "虎嗅", projectId: "eff", savedAt: now - 3 * day, read: true }),
      item("i1", { title: "2026 年的界面设计趋势", source: "站酷", projectId: "insp", image: svgCover("#c58bff", "#7b3fe4", "4") }),
      item("i2", { title: "一套好用的配色方法", source: "Dribbble", projectId: "insp", savedAt: now - day, image: svgCover("#ffd36c", "#ff8a3d", "5") }),
      item("i3", { title: "留白不是偷懒", source: "站酷", projectId: "insp", savedAt: now - 4 * day, image: svgCover("#7ef0e0", "#1aa39a", "6") }),
      item("l1", { title: "一篇两万字的长报道", source: "三联生活周刊", projectId: "long", image: svgCover("#ff8fa8", "#e0366b", "7") }),
      item("u1", { title: "还没归类的收藏", source: "B站", projectId: null, image: svgCover("#9aa4ff", "#4b56d6", "8") }),
      item("u2", { title: "另一篇还没归类的", source: "豆瓣", projectId: null, savedAt: now - 5 * day })
    ],
    laterOnProjects: [
      { id: "eff", name: "工作效率", note: "关于怎么把时间花在真正重要的事上。", createdAt: 1 },
      { id: "insp", name: "设计灵感", createdAt: 2 },
      { id: "long", name: "读不完的长文", createdAt: 3 },
      { id: "later", name: "稍后整理", createdAt: 4 }
    ],
    laterOnActiveProject: "all",
    // 打开就落在图板视图；深色背景看拼图更清楚（theme.js 会读这份设置）
    laterOnSettings: { libraryView: "boards", theme: "dark" }
  };
  window.__laterOnPreview = { store, svgCover };
};

const script = `<script>
// ⚠️ 本文件由 dev-tests/build-board-preview.js 自动生成，请勿直接编辑。
// 下面是一份假数据（代替扩展的本地存储），页面本身用的是真实的 library.html + library.js。
(${mock.toString()})();
<\/script>`;

// 样式和脚本全部内联成单文件：预览面板（以及 file:// 打开）不一定会去取同目录的
// CSS/JS，之前踩过「只送 HTML、相对路径全 404 → 页面等于没样式」的坑。
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const inlineStyle = (name) => `<style>\n/* ${name} */\n${read(name)}\n</style>`;
// 脚本里如果出现 </script> 会提前闭合标签，转义掉。
const inlineScript = (name) => `<script>\n/* ${name} */\n${read(name).replace(/<\/script>/g, "<\\/script>")}\n<\/script>`;
const iconDataUri = () =>
  "data:image/svg+xml;charset=utf-8," + encodeURIComponent(read("icon.svg"));

const html = read("library.html");
// ⚠️ 替换串一律用「函数」返回：直接传字符串时，被替换内容里的 $& / $` / $' 会被当成
// 特殊模式展开（library.js 里就含这类序列），结果整段 HTML 被塞进 <script> 里，页面直接语法错。
const out = html
  .replace(/<link rel="stylesheet" href="theme-vars\.css" \/>/, () => inlineStyle("theme-vars.css"))
  .replace(/<link rel="stylesheet" href="dialog\.css" \/>/, () => inlineStyle("dialog.css"))
  .replace(/<link rel="stylesheet" href="library\.css" \/>/, () => inlineStyle("library.css"))
  .replace(/src="icon\.svg"/g, () => `src="${iconDataUri()}"`)
  .replace(/href="icon\.svg"/g, () => `href="${iconDataUri()}"`)
  // 假数据要赶在 theme.js 之前：theme.js 自己也会读存储（它比 library.js 先跑）。
  .replace('<script src="theme.js"></script>', () => `${script}\n    ${inlineScript("theme.js")}`)
  .replace('<script src="dialog.js"></script>', () => inlineScript("dialog.js"))
  // 选项目浮层（卡片上点「所属项目」弹的那一个）也来自 picker-ui.js：
  // 不内联的话 file:// 下相对路径取不到，点卡片上的下拉毫无反应，浮层就没法在预览里看。
  .replace('<script src="picker-ui.js"></script>', () => inlineScript("picker-ui.js"))
  .replace('<script src="library.js"></script>', () => inlineScript("library.js"));

if (!out.includes("laterOnPreview")) throw new Error("假数据没有注入成功，检查 library.html 里的 script 标签是否变了");
if (/<link rel="stylesheet"/.test(out)) throw new Error("还有样式表没内联");
fs.writeFileSync(OUTPUT, out);
console.log(`已生成 ${path.relative(process.cwd(), OUTPUT)}`);
