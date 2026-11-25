const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "theme.js"), "utf8");
const KEY = "laterOnSettings";

// Only storage and the theme's DOM boundary are substituted; the actual
// settings get/set/watch implementation runs unchanged in each VM.
function loadSettings(initial) {
  let stored = initial;
  const listeners = [];
  const local = {
    async get(key) { return { [key]: stored }; },
    async set(patch) {
      const previous = stored;
      stored = patch[KEY];
      for (const listener of listeners) {
        listener({ [KEY]: { oldValue: previous, newValue: stored } }, "local");
      }
    }
  };
  const context = {
    window: {},
    document: { documentElement: { dataset: {} } },
    chrome: { storage: { local, onChanged: { addListener(fn) { listeners.push(fn); } } } }
  };
  vm.runInNewContext(source, context, { filename: "theme.js" });
  return { settings: context.window.LaterOnSettings, local, stored: () => stored };
}

for (const [label, stored, expected] of [
  ["fresh install", undefined, true],
  ["legacy false", { askFolderOnSingle: false }, true],
  ["legacy marker", { askFolderOnSingle: false, askFolderOnSingleOptIn: false }, true],
  ["legacy true", { askFolderOnSingle: true }, true],
  ["explicit opt-out", { askFolderOnSingle: false, askFolderOnSingleOptIn: true }, false],
  ["explicit opt-in", { askFolderOnSingle: true, askFolderOnSingleOptIn: true }, true],
  ["missing value after restore", { askFolderOnSingleOptIn: true }, true]
]) {
  test(`${label}: read and watch agree on the single-save picker`, async () => {
    const fixture = loadSettings(stored);
    assert.equal((await fixture.settings.get()).askFolderOnSingle, expected);
    let watched;
    fixture.settings.watch(value => { watched = value; });
    await fixture.local.set({ [KEY]: stored });
    assert.equal(watched.askFolderOnSingle, expected);
  });
}

test("saving an unrelated setting does not convert a legacy false into an opt-out", async () => {
  const fixture = loadSettings({ askFolderOnSingle: false, language: "en" });
  await fixture.settings.set({ theme: "dark" });
  assert.equal((await fixture.settings.get()).askFolderOnSingle, true);
  assert.notEqual(fixture.stored().askFolderOnSingleOptIn, true);
  assert.equal(fixture.stored().language, "en");
  assert.equal(fixture.stored().theme, "dark");
});

test("explicitly turning the picker off survives unrelated setting changes, and can be re-enabled", async () => {
  const fixture = loadSettings({ language: "en", theme: "dark" });
  await fixture.settings.set({ askFolderOnSingle: false });
  assert.equal(fixture.stored().askFolderOnSingleOptIn, true);
  await fixture.settings.set({ defaultSort: "oldest" });
  assert.equal((await fixture.settings.get()).askFolderOnSingle, false);
  assert.equal(fixture.stored().language, "en");
  assert.equal(fixture.stored().theme, "dark");
  await fixture.settings.set({ askFolderOnSingle: true });
  assert.equal((await fixture.settings.get()).askFolderOnSingle, true);
});
