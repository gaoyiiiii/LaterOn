const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.resolve(__dirname, "..", "url-utils.js"), "utf8");
const context = vm.createContext({ URL, globalThis: {} });
vm.runInContext(source, context, { filename: "url-utils.js" });
const normalize = context.globalThis.LaterOnUrl.normalize;

assert.strictEqual(
  normalize("https://www.Example.com/article/?utm_source=news&b=2&a=1#comments"),
  "https://example.com/article?a=1&b=2"
);
assert.strictEqual(
  normalize("https://example.com/article?a=1&b=2"),
  normalize("https://www.example.com/article/?b=2&a=1")
);

console.log("PASS shared URL normalization");
