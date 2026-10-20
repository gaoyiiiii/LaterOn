(function () {
  window.LaterOnData = async function (operation, payload = {}) {
    const reply = await chrome.runtime.sendMessage({ type: 'DATA_MUTATION', operation, ...payload });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not save changes');
    return reply;
  };
})();
