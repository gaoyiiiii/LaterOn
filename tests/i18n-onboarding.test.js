const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

const context = {
  window: { dispatchEvent() {} },
  document: {
    documentElement: { lang: "zh-CN" },
    querySelectorAll() { return []; }
  },
  chrome: { storage: { local: { get: async () => ({}), set: async () => {} } } },
  CustomEvent: function CustomEvent() {}
};
vm.createContext(context);
vm.runInContext(read("i18n.js"), context, { filename: "i18n.js" });

const dictionaries = context.window.LaterOnI18n.dictionaries;
assert.deepStrictEqual(
  Object.keys(dictionaries.en).sort(),
  Object.keys(dictionaries["zh-CN"]).sort(),
  "中英文词典必须包含完全相同的词条"
);
assert.strictEqual(dictionaries["zh-CN"].guideStepSaveTitle, "一键收下，稍后再看");
assert.strictEqual(dictionaries["zh-CN"].guideStepReadTitle, "全屏管理，全屏/侧栏均可阅读");
assert.match(dictionaries["zh-CN"].guideStepReadHint, /30 天后自动清除/);

const libraryHtml = read("library.html");
const sidepanelHtml = read("sidepanel.html");
const settingsHtml = read("settings.html");
assert.match(libraryHtml, /onboarding\.css/);
assert.match(libraryHtml, /onboarding\.js/);
assert.match(sidepanelHtml, /onboarding\.css/);
assert.match(sidepanelHtml, /onboarding\.js/);
assert.match(libraryHtml, /data-i18n="slogan"/);
assert.doesNotMatch(libraryHtml, /id="toggleProjects"/);
assert.match(libraryHtml, /data-i18n="allProjectsOverview"/);
assert.strictEqual(dictionaries["zh-CN"].allProjectsOverview, "全部项目");
assert.strictEqual(dictionaries.en.allProjectsOverview, "All projects");
assert.match(settingsHtml, /id="replayOnboarding"/);
assert.match(read("settings.js"), /getURL\("library\.html"\)[^\n]*\?guide=1/);

const manifest = JSON.parse(read("manifest.json"));
assert.strictEqual(manifest.default_locale, "zh_CN");
assert.match(manifest.name, /^__MSG_/);
for (const locale of ["zh_CN", "en"]) {
  const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
  for (const key of ["extensionName", "extensionDescription", "actionTitle", "commandSavePage", "commandTranslatePage", "commandSaveAllTabs"]) {
    assert.ok(messages[key]?.message, `${locale} 缺少 ${key}`);
  }
}

console.log("PASS 英文词典、扩展清单和可重复新手引导均已接入");
