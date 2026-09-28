const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "sidepanel.html"), "utf8");
const source = fs.readFileSync(path.join(ROOT, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "sidepanel.css"), "utf8");
const librarySource = fs.readFileSync(path.join(ROOT, "library.js"), "utf8");
const i18n = fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8");

assert.match(html, /<a class="open-item" target="_blank" rel="noreferrer"/);
assert.doesNotMatch(html, /<button class="open-item"/);
assert.match(source, /event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
assert.match(source, /list\.addEventListener\("contextmenu"/);
assert.match(source, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*showItemContextMenu/s);
assert.match(source, /chrome\.tabs\.create\(\{ url: target, active: false \}\)/);
assert.match(source, /sidepanelMenuItem\(tr\("openInNewTab"\).*sidepanelMenuItem\(tr\("itemEdit"\).*sidepanelMenuItem\(tr\("delete"\)/s);
assert.match(css, /\.folder-menu\s*\{/);
assert.match(css, /\.folder-menu-item\.danger\s*\{/);
assert.match(i18n, /openInNewTab: "在新标签页打开"/);
assert.match(i18n, /openInNewTab: "Open in new tab"/);
assert.match(i18n, /itemOpen: "在新标签页打开"/);
assert.match(librarySource, /menuItem\(tr\("itemOpen"\), "open", \(\) => openItemInNewTab\(item\)\)/);
assert.match(librarySource, /chrome\.tabs\.create\(\{ url: target, active: false, openerTabId:/);

console.log("PASS 侧栏支持修饰键新标签与统一的三项右键菜单");
