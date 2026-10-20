(async () => {
  const { t, apply, send } = LaterOnAIUI;
  await window.LaterOnI18n?.getLanguage(); apply();
  const checkbox = document.getElementById('aiEnabled'), message = document.getElementById('aiSettingsState'), missing = document.getElementById('aiMissingNotes');
  checkbox.setAttribute('aria-label', t('enable'));
  async function refresh() {
    const s = await send('AI_STATE'); checkbox.checked = s.enabled;
    const config = s.config, channels = config.channels;
    const channelsReady = (config.extractId === 'local' || channels.some(c => c.id === config.extractId && c.kind === 'extract' && c.testedAt))
      && channels.some(c => c.id === config.classifyId && c.kind === 'classify' && c.testedAt);
    const configured = !!config.active;
    const status = s.ready ? 'settingsActive' : !s.enabled
      ? (configured || channelsReady ? 'settingsOff' : 'settingsIncompleteOff')
      : configured ? 'settingsActive' : channelsReady ? 'settingsReady' : 'settingsIncomplete';
    if (s.enabled && (s.reason === 'missingNotes' || s.reason === 'noProjects')) {
      message.textContent = `${t(configured ? 'settingsConfigured' : 'settingsUnconfigured')}${t(s.reason === 'missingNotes' ? 'settingsMissingNotes' : 'settingsNoProjects')}`;
    } else message.textContent = t(status);
    message.hidden = false;
    missing.replaceChildren();
    for (const p of s.missing) {
      const li = document.createElement('li'), a = document.createElement('a'); a.textContent = p.name; a.href = `library.html?editProject=${encodeURIComponent(p.id)}`; li.append(a); missing.append(li);
    }
    missing.hidden = !s.enabled || !s.missing.length;
  }
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    try { await send('AI_SET_ENABLED', { enabled: checkbox.checked }); await refresh(); }
    catch (error) { await refresh().catch(() => {}); message.textContent = error.message; message.hidden = false; missing.hidden = !missing.children.length; }
    finally { checkbox.disabled = false; }
  });
  chrome.storage.onChanged.addListener((c,a) => { if (a === 'local' && (c.laterOnProjects || c.laterOnSettings || c.laterOnAIConfig)) refresh().catch(() => {}); });
  await refresh().catch(e => { message.textContent = e.message; message.hidden = false; });
})();
