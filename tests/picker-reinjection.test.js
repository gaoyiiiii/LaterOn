const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "content-folder-picker.js"), "utf8");
const opened = [];
let payload = null;

const context = vm.createContext({
  window: {
    openFolderPicker(options) {
      opened.push(options);
    }
  },
  document: {
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      if (id !== "lateron-picker-payload-data" || !payload) return null;
      const node = {
        textContent: JSON.stringify(payload),
        remove() { payload = null; }
      };
      return node;
    }
  },
  chrome: {
    runtime: {
      sendMessage() { return Promise.resolve({ ok: true }); }
    }
  }
});

payload = { theme: "light", selected: "first", folders: [], pages: [] };
vm.runInContext(source, context, { filename: "content-folder-picker.js" });

payload = { theme: "dark", selected: "second", folders: [], pages: [] };
assert.doesNotThrow(
  () => vm.runInContext(source, context, { filename: "content-folder-picker.js" }),
  "同一个网页第二次注入项目选择脚本不应重复声明顶层变量"
);

assert.strictEqual(opened.length, 2, "每次注入都应打开项目选择框");
assert.strictEqual(opened[0].selected, "first");
assert.strictEqual(opened[1].selected, "second");
assert.strictEqual(opened[1].theme, "dark");

console.log("PASS 项目选择脚本可在同一网页连续注入两次");
