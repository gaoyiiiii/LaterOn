// 后台冷启动体积回归：网页内执行的大函数必须留在独立文件里，不能重新塞回 service worker。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const background = read("background.js");
const metadata = read("content-metadata.js");
const translation = read("content-translation.js");
const picker = read("content-folder-picker.js");

assert.ok(Buffer.byteLength(background) < 80000, `background.js 重新膨胀到 ${Buffer.byteLength(background)} bytes`);
assert.ok(!background.includes("function extractPageMetadataForShortcut"), "网页提取函数不应在后台冷启动时解析");
assert.ok(!background.includes("function togglePageTranslation"), "翻译函数不应在后台冷启动时解析");
assert.ok(!background.includes("function showFolderPickerOverlay"), "批量选择浮层不应在后台冷启动时解析");

assert.ok(metadata.includes("function extractPageMetadataForShortcut"));
assert.ok(translation.includes("function togglePageTranslation"));
assert.ok(picker.includes("function showFolderPickerOverlay"));
assert.match(background, /files:\s*\["content-metadata\.js"\]/);
assert.match(background, /files:\s*\["content-translation\.js"\]/);
assert.match(background, /files:\s*\["picker-ui\.js",\s*"content-folder-picker\.js"\]/);

console.log("PASS background 模块按需注入，冷启动脚本", Buffer.byteLength(background), "bytes");
