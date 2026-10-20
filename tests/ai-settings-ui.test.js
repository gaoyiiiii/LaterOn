const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

(async () => {
  for (const language of ['zh-CN', 'en']) {
    const dom = new JSDOM(fs.readFileSync('settings.html', 'utf8'), { runScripts: 'outside-only' });
    const w = dom.window;
    w.document.documentElement.lang = language;
    let state, changed;
    w.chrome = { runtime: { sendMessage: async () => ({ ok: true, data: state }) },
      storage: { onChanged: { addListener: fn => { changed = fn; } } } };
    w.LaterOnI18n = { getLanguage: async () => {} };
    const config = { channels: [], extractId: 'local', classifyId: '', active: null };
    state = { enabled: false, ready: false, reason: 'aiDisabled', missing: [], config };
    w.eval(fs.readFileSync('ai-text.js', 'utf8'));
    w.eval(fs.readFileSync('ai-settings.js', 'utf8'));
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await settle();
    const message = w.document.getElementById('aiSettingsState');
    const check = key => {
      assert.equal(message.hidden, false);
      assert.equal(message.textContent, w.LaterOnAIUI.t(key));
    };
    check('settingsIncompleteOff');
    assert.equal(message.parentElement.querySelector('a').getAttribute('href'), 'models.html');
    const refresh = async patch => {
      Object.assign(state, patch);
      changed({ laterOnAIConfig: {} }, 'local');
      await settle();
    };
    await refresh({ enabled: true, reason: 'notConfigured' });
    check('settingsIncomplete');
    config.channels = [{ id: 'chat', kind: 'classify', testedAt: 1 }];
    config.classifyId = 'chat';
    await refresh({});
    check('settingsReady');
    config.active = { classifier: { id: 'chat' } };
    await refresh({ ready: true, reason: '' });
    check('settingsActive');
    await refresh({ enabled: false, ready: false, reason: 'aiDisabled' });
    check('settingsOff');
    await refresh({ enabled: true, reason: 'missingNotes', missing: [{ id: 'a b', name: 'Project' }] });
    assert.equal(message.textContent, w.LaterOnAIUI.t('settingsConfigured') + w.LaterOnAIUI.t('settingsMissingNotes'));
    assert.equal(w.document.querySelector('#aiMissingNotes a').getAttribute('href'), 'library.html?editProject=a%20b');
    await refresh({ reason: 'noProjects', missing: [] });
    assert.equal(message.textContent, w.LaterOnAIUI.t('settingsConfigured') + w.LaterOnAIUI.t('settingsNoProjects'));
    dom.window.close();
  }
  console.log('PASS bilingual AI settings status and live configuration updates');
})().catch(error => { console.error(error); process.exitCode = 1; });
