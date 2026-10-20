// Shared Models navigation for the library and side panel.
(async () => {
  const { apply } = LaterOnAIUI;
  await window.LaterOnI18n?.getLanguage(); apply();
  document.getElementById('openModels')?.addEventListener('click', async event => {
    const url = chrome.runtime.getURL('models.html');
    if (event.metaKey || event.ctrlKey || event.shiftKey) { await chrome.tabs.create({ url }); return; }
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.update(tab.id, { url }); else await chrome.tabs.create({ url });
  });
})();
