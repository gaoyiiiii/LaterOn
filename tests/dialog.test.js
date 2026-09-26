// 自定义弹窗组件（dialog.js + dialog.css）的行为测试。
// 它是用来取代浏览器原生 confirm / alert 的，所以重点验证：
//  1) 各类交互都能给出正确结果：点确认、点取消、按 Esc、点遮罩、按回车
//  2) 危险操作有红色主题与警示图标
//  3) alert 只有一个按钮
//  4) 同时要求弹两个时不会叠在一起，而是排队依次显示
//  5) dialog.js 用到的类名都和 dialog.css 对得上（拼错类名会没有样式，肉眼很难发现）
//  6) 全程不碰浏览器自带的 confirm / alert
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");
const dialogSource = fs.readFileSync(`${ROOT}/dialog.js`, "utf8");
const dialogCss = fs.readFileSync(`${ROOT}/dialog.css`, "utf8");

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(String(error?.message || error)));

const dom = new JSDOM(
  `<!doctype html><html><head><style>${dialogCss}</style></head><body><button id="other">页面上的其它按钮</button></body></html>`,
  { runScripts: "outside-only", pretendToBeVisual: true, url: "chrome-extension://lateron/library.html", virtualConsole }
);
const { window } = dom;
const { document } = window;

// 兜底：万一哪天又用回浏览器自带弹窗，这里会立刻暴露。
const nativeDialogs = [];
window.confirm = (message) => { nativeDialogs.push(String(message)); return true; };
window.alert = (message) => { nativeDialogs.push(String(message)); };

window.eval(dialogSource);

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? "  → " + extra : ""}`);
  if (!ok) failures += 1;
};
const tick = (ms = 20) => new Promise((resolve) => window.setTimeout(resolve, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const pressKey = (el, key, extra = {}) => el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
const visible = () => document.querySelector(".lod-root:not([hidden])");
const text = (selector) => visible()?.querySelector(selector)?.textContent || "";

(async () => {
  console.log("── 懒创建 ──");
  check("还没用就先不往页面塞东西", !document.querySelector(".lod-root"));
  check("导出了 confirm / alert 两个方法", typeof window.LaterOnDialog?.confirm === "function" && typeof window.LaterOnDialog?.alert === "function");

  console.log("\n── 普通确认框 ──");
  let answer;
  const first = window.LaterOnDialog.confirm({ title: "删除项目「工作」？", message: "里面的 2 篇收藏会移到「等待整理」。", confirmText: "删除项目" });
  first.then((value) => { answer = value; });
  await tick();
  check("弹窗出现在页面上", !!visible());
  check("有 dialog 语义（屏幕阅读器能识别）", visible()?.getAttribute("role") === "dialog" && visible()?.getAttribute("aria-modal") === "true");
  check("标题正确", text(".lod-title") === "删除项目「工作」？", text(".lod-title"));
  check("正文正确", /2 篇收藏会移到/.test(text(".lod-message")), text(".lod-message"));
  check("确认按钮用了自定义文案", text(".lod-ok") === "删除项目", text(".lod-ok"));
  check("取消按钮写「取消」", text(".lod-cancel") === "取消");
  check("提示了键盘操作", /回车确认/.test(text(".lod-hint")) && /Esc 取消/.test(text(".lod-hint")), text(".lod-hint"));
  check("普通确认不标危险色", visible()?.dataset.tone === "default", visible()?.dataset.tone);
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  check("点确认 → true", answer === true, String(answer));
  check("关闭后收起来（不留在页面上挡操作）", !visible());
  check("收起来用的是「隐藏」而不是「禁用按钮」，下次还能正常用", document.querySelector(".lod-root").hidden === true && document.querySelector(".lod-root .lod-ok").disabled === false);

  console.log("\n── 危险操作主题 ──");
  const dangerPromise = window.LaterOnDialog.confirm({ tone: "danger", title: "清空所有收藏？", message: "此操作无法撤销。", confirmText: "全部清空" });
  await tick();
  check("标成了危险主题", visible()?.dataset.tone === "danger", visible()?.dataset.tone);
  check("图标换成了警示三角", /M10.3 3.9/.test(visible().querySelector(".lod-icon").innerHTML));
  click(visible().querySelector(".lod-cancel"));
  await tick(300);
  check("点取消 → false", (await dangerPromise) === false);

  console.log("\n── 键盘操作 ──");
  const escPromise = window.LaterOnDialog.confirm({ title: "按 Esc 试试" });
  await tick();
  pressKey(visible(), "Escape");
  await tick(300);
  check("按 Esc → false", (await escPromise) === false);

  const enterPromise = window.LaterOnDialog.confirm({ title: "按回车试试" });
  await tick();
  pressKey(visible(), "Enter");
  await tick(300);
  check("按回车 → true", (await enterPromise) === true);

  console.log("\n── 点遮罩取消 ──");
  const backdropPromise = window.LaterOnDialog.confirm({ title: "点背景试试" });
  await tick();
  click(visible().querySelector(".lod-backdrop"));
  await tick(300);
  check("点背景 → false", (await backdropPromise) === false);

  console.log("\n── 只告知、不需要选择的提示框 ──");
  const infoPromise = window.LaterOnDialog.alert({ tone: "success", title: "导入完成", message: "当前共 12 篇收藏。" });
  await tick();
  check("只有一个按钮，取消键被藏起来", visible().querySelector(".lod-cancel").hidden === true && !visible().querySelector(".lod-ok").hidden);
  check("按钮文案是「知道了」", text(".lod-ok") === "知道了", text(".lod-ok"));
  check("提示类用对勾图标", /m8.3 12.5/.test(visible().querySelector(".lod-icon").innerHTML));
  check("提示文案不写 Esc 取消", text(".lod-hint") === "回车确认", text(".lod-hint"));
  pressKey(visible(), "Escape");
  await tick(300);
  check("必须点确认才能关（Esc 不生效）", !!visible());
  click(visible().querySelector(".lod-ok"));
  await tick(300);
  await infoPromise;
  check("点确认后关掉", !visible());

  console.log("\n── 同时弹两个：排队而不是叠加 ──");
  let valueA, valueB;
  window.LaterOnDialog.confirm({ title: "第一个", message: "A" }).then((v) => { valueA = v; });
  window.LaterOnDialog.confirm({ title: "第二个", message: "B" }).then((v) => { valueB = v; });
  await tick(40);
  check("页面上只有一个弹窗", document.querySelectorAll(".lod-root").length === 1, `${document.querySelectorAll(".lod-root").length} 个`);
  check("先显示第一个", text(".lod-title") === "第一个", text(".lod-title"));
  click(visible().querySelector(".lod-ok"));
  await tick(320);
  check("第一个先拿到结果 true", valueA === true, String(valueA));
  check("第一个关掉后第二个才出现", text(".lod-title") === "第二个", text(".lod-title"));
  check("第二个此时还没结果", valueB === undefined);
  click(visible().querySelector(".lod-cancel"));
  await tick(320);
  check("第二个拿到结果 false", valueB === false, String(valueB));
  check("都处理完，页面恢复干净", !visible());

  console.log("\n── 样式与脚本对得上（拼错类名会没有样式）──");
  const usedClasses = new Set();
  for (const matched of dialogSource.matchAll(/class="([^"]+)"/g)) matched[1].split(/\s+/).forEach((name) => usedClasses.add(name));
  for (const matched of dialogSource.matchAll(/classList\.(?:add|remove)\("([^"]+)"\)/g)) usedClasses.add(matched[1]);
  for (const matched of dialogSource.matchAll(/querySelector\("\.([\w-]+)"\)/g)) usedClasses.add(matched[1]);
  for (const matched of dialogSource.matchAll(/classList\.(?:add|remove)\(([^)]*)\)/g)) {
    for (const name of matched[1].split(",")) {
      const clean = name.trim().replace(/^["']|["']$/g, "");
      if (/^[\w-]+$/.test(clean)) usedClasses.add(clean);
    }
  }
  const missing = [...usedClasses].filter((name) => name.startsWith("lod-") && !dialogCss.includes(`.${name}`));
  check("脚本里用到的每个 lod- 类名都在 CSS 里定义了", missing.length === 0, missing.join(", "));
  check("危险主题的样式也在 CSS 里", dialogCss.includes('[data-tone="danger"]'));
  check("深色模式有覆盖", dialogCss.includes('[data-theme="dark"]'));
  check("CSS 花括号配对", (dialogCss.match(/{/g) || []).length === (dialogCss.match(/}/g) || []).length);

  console.log("\n── 全项目排查：还有没有用浏览器自带弹窗的地方 ──");
  const offenders = [];
  for (const name of fs.readdirSync(ROOT).filter((entry) => entry.endsWith(".js"))) {
    const source = fs.readFileSync(`${ROOT}/${name}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")     // 去掉块注释
      .replace(/^[ \t]*\/\/.*$/gm, "");     // 去掉行注释
    for (const matched of source.matchAll(/(^|[^.\w$])(window\.)?(confirm|alert|prompt)\s*\(/g)) {
      offenders.push(`${name} → ${matched[3]}(`);
    }
  }
  check("扩展代码里已没有浏览器自带弹窗的调用", offenders.length === 0, offenders.join(" | "));

  console.log("\n── 兜底 ──");
  check("全程没有调用浏览器自带的弹窗", nativeDialogs.length === 0, nativeDialogs.join(" | "));
  check("没有未捕获的错误", errors.length === 0, errors.join(" | "));

  console.log(failures === 0 ? "\n全部检查通过 🎉" : `\n有 ${failures} 项失败`);
  if (failures) process.exitCode = 1;
})().catch((error) => {
  console.error("测试脚本自身出错：", error);
  process.exitCode = 1;
});
