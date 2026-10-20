(async () => {
  const { t, apply, send } = LaterOnAIUI;
  await window.LaterOnI18n?.getLanguage(); window.LaterOnI18n?.applyStatic(); apply();
  const english = document.documentElement.lang === 'en';
  document.title = `LaterOn · ${t('history')}`;
  document.getElementById('historyBack').textContent = english ? 'Back to Models' : '返回模型';
  document.getElementById('historyDescription').textContent = english
    ? 'These are the classification records still saved on this device. They show past results; check the library for a page’s current project.'
    : '这里是本机保留的分类记录，记录的是当时的结果。网页现在在哪个项目，请以收藏库为准。';
  let request = 0;
  async function refresh() {
    const id = ++request, error = document.getElementById('historyError');
    try {
      const tasks = await send('AI_HISTORY');
      if (id !== request) return;
      LaterOnAIRecords.render(document.getElementById('historyRecords'), tasks);
      error.hidden = true;
    } catch (e) { if (id === request) { error.textContent = e.message; error.hidden = false; } }
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.laterOnAITasks) void refresh(); });
  await refresh();
})();
