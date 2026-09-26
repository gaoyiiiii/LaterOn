// 生成「网页内选项目浮层」的设计预览页。
// 背景：预览面板是把单个 HTML 放进快照目录里打开的，页面里的相对路径（../picker-ui.js）加载不到，
// 所以这里把真实的实现**内联**进预览页：
//   • picker-ui.js 的 openFolderPicker（整屏弹窗和卡片浮层共用的那一份）
//   • content-folder-picker.js 的 showFolderPickerOverlay 入口（接上收藏流程的消息）
// 这样预览看到的永远是当前那份实现，不会和代码脱节（改完实现重跑一次本脚本即可）。
//
// 用法：node tests/build-preview.js
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const PICKER_UI = path.join(dir, "..", "picker-ui.js");
const PICKER_WRAPPER = path.join(dir, "..", "content-folder-picker.js");
const TEMPLATE = path.join(dir, "picker-preview.template.html");
const OUTPUT = path.join(dir, "picker-preview.html");
const PLACEHOLDER = "<!--INLINE_OVERLAY_IMPLEMENTATION-->";

const uiSource = fs.readFileSync(PICKER_UI, "utf8");
const wrapperSource = fs.readFileSync(PICKER_WRAPPER, "utf8");

const template = fs.readFileSync(TEMPLATE, "utf8");
if (!template.includes(PLACEHOLDER)) throw new Error(`模板里缺占位符 ${PLACEHOLDER}`);

const banner = `// ⚠️ 本文件由 tests/build-preview.js 自动生成，请勿直接编辑。
// 下面是真实的选项目面板实现（picker-ui.js + content-folder-picker.js），预览用的就是上线那份。`;

const html = template.replace(
  PLACEHOLDER,
  `<script>\n${banner}\n${uiSource}\n${wrapperSource}\n</script>`
);
fs.writeFileSync(OUTPUT, html);

console.log(`已生成 ${path.relative(process.cwd(), OUTPUT)}`);
console.log(`  内联的实现：${uiSource.split("\n").length} 行（picker-ui.js）+ ${wrapperSource.split("\n").length} 行（content-folder-picker.js）`);
