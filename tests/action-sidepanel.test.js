const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

assert.ok(manifest.action, "manifest 必须保留工具栏 action");
assert.strictEqual(manifest.action.default_popup, undefined, "工具栏图标不能再绑定缩略图 popup");
assert.strictEqual(manifest.side_panel?.default_path, "sidepanel.html", "侧栏入口必须指向真实侧栏页面");
assert.match(
  background,
  /setPanelBehavior\(\{\s*openPanelOnActionClick:\s*true\s*\}\)/,
  "后台必须启用点击图标打开侧栏"
);
assert.match(background, /setupSidePanelAction\(\);[\s\S]*onInstalled/);
assert.match(background, /onInstalled[\s\S]*setupSidePanelAction\(\)/);
assert.match(background, /onStartup[\s\S]*setupSidePanelAction\(\)/);

console.log("PASS Chrome / Edge 工具栏图标统一直接打开侧栏");
