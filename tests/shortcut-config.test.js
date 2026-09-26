const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const settings = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
const settingsHtml = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

assert.strictEqual(
  manifest.commands["save-all-tabs"].suggested_key.default,
  "Alt+Shift+1",
  "收藏当前窗口所有标签页应默认使用 Alt+Shift+1"
);
assert.strictEqual(
  manifest.commands["save-all-tabs"].suggested_key.mac,
  undefined,
  "macOS 不应再覆盖为旧的 Command+Shift+E"
);
assert.match(settings, /默认 Alt\+Shift\+1/);
assert.match(readme, /按 `Alt\+Shift\+1`/);
assert.match(settingsHtml, /关掉后默认收藏进「待整理」/);
assert.doesNotMatch(settingsHtml, /关掉后[^<]*全部文章/);

console.log("PASS 收藏当前窗口所有标签页快捷键统一为 Alt+Shift+1");
