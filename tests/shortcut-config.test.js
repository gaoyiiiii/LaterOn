const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const settings = fs.readFileSync(path.join(ROOT, "settings.js"), "utf8");
const settingsHtml = fs.readFileSync(path.join(ROOT, "settings.html"), "utf8");
const theme = fs.readFileSync(path.join(ROOT, "theme.js"), "utf8");
const background = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
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
assert.match(settings, /def:\s*"Alt\+Shift\+1"/);
assert.match(readme, /按 `Alt\+Shift\+1`/);
assert.match(settingsHtml, /默认关闭/);
assert.doesNotMatch(settingsHtml, /默认开启/);
assert.match(theme, /askFolderOnSingle:\s*false/);
assert.match(theme, /askFolderOnSingleOptIn:\s*false/);
assert.match(background, /settings\.askFolderOnSingle\s*===\s*true\s*&&\s*settings\.askFolderOnSingleOptIn\s*===\s*true/);

console.log("PASS 收藏当前窗口所有标签页快捷键统一为 Alt+Shift+1");
