// Background-only configuration, credentials and resumable classification tasks.
function createLaterOnAI({ queueItemWrite }) {
  const A = globalThis.LaterOnAI;
  const CONFIG = 'laterOnAIConfig', SECRETS = 'laterOnAICredentials', TASKS = 'laterOnAITasks', SESSION = 'laterOnAISession';
  const ITEMS = 'laterOnItems', PROJECTS = 'laterOnProjects', SETTINGS = 'laterOnSettings';
  const pending = new Map();
  let pumping = false, sessionId;
  const defaults = () => ({ channels: [], extractId: 'local', classifyId: '', fallback: true, revision: 0, active: null });
  const definitions = projects => projects.filter(p => !p.archived).map(p => ({ id: p.id, name: p.name, note: p.note || '' })).sort((a,b) => a.id.localeCompare(b.id));
  const errorCode = error => /^(http_\d+|[a-zA-Z]+)$/.test(error?.message || '') ? error.message : 'internalError';
  const terminal = t => ['applied', 'unmatched', 'failed', 'interrupted'].includes(t.status);
  const missingNote = p => !p.archived && (typeof p.note !== 'string' || !p.note.trim());
  const init = (async () => {
    // Every content script was audited: it uses messages, not direct storage reads.
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const session = (await chrome.storage.session.get(SESSION))[SESSION];
    sessionId = session || crypto.randomUUID();
    if (!session) await chrome.storage.session.set({ [SESSION]: sessionId });
    await queueItemWrite(async () => {
      const tasks = (await chrome.storage.local.get(TASKS))[TASKS] || [];
      for (const task of tasks) {
        if (terminal(task)) continue;
        if (task.sessionId !== sessionId || task.status === 'classifying') {
          task.status = 'interrupted'; task.error = 'interrupted';
        } else if (task.status === 'extracting') task.status = 'queued';
      }
      await chrome.storage.local.set({ [TASKS]: tasks });
      const stored = await chrome.storage.session.get(null);
      for (const key of Object.keys(stored)) if (key.startsWith('laterOnAIPage:') && !tasks.some(t => !terminal(t) && key === pageKey(t.id))) await chrome.storage.session.remove(key);
    });
  })();
  function pageKey(id) { return `laterOnAIPage:${id}`; }
  async function snapshot() {
    await init;
    const stored = await chrome.storage.local.get([CONFIG, PROJECTS, SETTINGS]);
    const config = { ...defaults(), ...stored[CONFIG] };
    const projects = stored[PROJECTS] || [];
    const missing = projects.filter(missingNote);
    const enabled = stored[SETTINGS]?.aiEnabled === true;
    let reason = !enabled ? 'aiDisabled' : missing.length ? 'missingNotes' : !config.active ? 'notConfigured' : '';
    if (!reason && !projects.some(p => !p.archived)) reason = 'noProjects';
    return { config, projects, missing: missing.map(p => ({ id: p.id, name: p.name })), enabled, ready: !reason, reason };
  }
  async function state() {
    const s = await snapshot();
    const stored = await chrome.storage.local.get([SECRETS, TASKS]);
    const credentials = stored[SECRETS] || {};
    return { ...s, config: { ...s.config, channels: s.config.channels.map(c => ({ ...c, hasKey: !!credentials[c.id] })) },
      tasks: (stored[TASKS] || []).slice(-100).reverse() };
  }
  async function history() {
    await init;
    const stored = await chrome.storage.local.get(TASKS);
    // History exposes only display fields, not saved page content or project definitions.
    const fields = ['id','itemId','title','status','createdAt','completedAt','projectId','extractName','classifyName','source','fallbackFrom','fallbackReason','warning','truncated','error','reason','answer'];
    return (stored[TASKS] || []).slice().reverse().map(task => Object.fromEntries(fields.filter(key => key in task).map(key => [key, task[key]])));
  }
  const ready = async () => (await snapshot()).ready;
  async function setEnabled(enabled) {
    await init;
    return queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([SETTINGS, PROJECTS, CONFIG]);
      if (enabled && (stored[PROJECTS] || []).some(missingNote)) throw new Error('missingNotes');
      const patch = { [SETTINGS]: { ...stored[SETTINGS], aiEnabled: enabled === true } };
      if (!enabled && stored[SETTINGS]?.aiEnabled) {
        // Invalidate queued as well as in-flight work, even if AI is re-enabled immediately.
        // Keep the active combination usable for future saves without reviving old tasks.
        const config = { ...defaults(), ...stored[CONFIG] };
        config.revision++;
        if (config.active) config.active = { ...config.active, revision:config.revision };
        patch[CONFIG] = config;
      }
      await chrome.storage.local.set(patch);
      if (!enabled) abortAll();
    });
  }
  async function enabledRequired() {
    const s = await snapshot(); if (!s.enabled) throw new Error('aiDisabled'); return s;
  }
  async function keyFor(c, supplied) {
    const stored = await chrome.storage.local.get([SECRETS, CONFIG]);
    const secrets = stored[SECRETS] || {};
    const old = stored[CONFIG]?.channels?.find(entry => entry.id === c.id);
    if (old && old.provider !== c.provider && supplied === undefined) throw new Error('missingKey');
    const key = typeof supplied === 'string' ? supplied.trim() : (secrets[c.id] || '');
    if (key.length > 4000 || (!key && c.provider !== 'custom')) throw new Error('missingKey');
    return key;
  }
  async function testChannel(raw, supplied) {
    await enabledRequired();
    const c = A.channel(raw), key = await keyFor(c, supplied), started = Date.now();
    if (c.kind === 'extract') await A.extractRemote(c, key, { url: 'https://example.com/', title: 'Example Domain', description: '' });
    else await A.classify(c, key, A.pageInput({ url: 'https://example.com/browser-extension', title: 'Building a browser extension', description: 'A tutorial on extension service workers and message passing.' }), [
      { id: 'test-development', name: 'Development', note: 'Software development, browser extensions and programming.' },
      { id: 'test-travel', name: 'Travel', note: 'Travel destinations, hotels and itinerary planning.' }
    ]);
    const token = crypto.randomUUID();
    // Receipts are private to trusted extension contexts, expire, and bind exact credentials + request fields.
    await chrome.storage.session.set({ [`laterOnAITest:${token}`]: { identity: A.requestIdentity(c), key, at: Date.now() } });
    return { token, elapsed: Date.now() - started };
  }
  async function saveChannel(raw, supplied, token) {
    await enabledRequired();
    const c = A.channel(raw);
    return queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([CONFIG, SECRETS, SETTINGS]);
      if (!stored[SETTINGS]?.aiEnabled) throw new Error('aiDisabled');
      const config = { ...defaults(), ...stored[CONFIG] }, credentials = stored[SECRETS] || {};
      const old = config.channels.find(entry => entry.id === c.id);
      const key = typeof supplied === 'string' ? supplied.trim() : credentials[c.id] || '';
      if ((!key && c.provider !== 'custom') || key.length > 4000) throw new Error('missingKey');
      const unchanged = old?.testedAt && A.requestIdentity(old) === A.requestIdentity(c) && key === (credentials[c.id] || '');
      if (!unchanged) {
        const receipt = (await chrome.storage.session.get(`laterOnAITest:${token}`))[`laterOnAITest:${token}`];
        if (!receipt || Date.now() - receipt.at > 15 * 60 * 1000 || receipt.identity !== A.requestIdentity(c) || receipt.key !== key) throw new Error('testRequired');
      }
      if (!old) c.id = crypto.randomUUID();
      c.testedAt = unchanged ? old.testedAt : Date.now();
      c.version = (old?.version || 0) + 1;
      config.channels = [...config.channels.filter(entry => entry.id !== c.id), c];
      credentials[c.id] = key;
      await chrome.storage.local.set({ [CONFIG]: config, [SECRETS]: credentials });
      if (token) await chrome.storage.session.remove(`laterOnAITest:${token}`);
      return c;
    });
  }
  async function activate({ extractId, classifyId, fallback }) {
    await enabledRequired();
    await queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([CONFIG, SECRETS, PROJECTS, SETTINGS]);
      if (!stored[SETTINGS]?.aiEnabled) throw new Error('aiDisabled');
      if ((stored[PROJECTS] || []).some(missingNote)) throw new Error('missingNotes');
      const config = { ...defaults(), ...stored[CONFIG] }, keys = stored[SECRETS] || {};
      const extract = extractId === 'local' ? null : config.channels.find(c => c.id === extractId && c.kind === 'extract');
      const classifier = config.channels.find(c => c.id === classifyId && c.kind === 'classify');
      if ((extractId !== 'local' && !extract?.testedAt) || !classifier?.testedAt) throw new Error('testRequired');
      config.extractId = extractId; config.classifyId = classifyId; config.fallback = fallback !== false;
      config.revision++;
      // Active snapshots keep edited, saved channels from silently changing a running combination.
      config.active = { extract: extract ? { ...extract } : null, classifier: { ...classifier }, fallback: config.fallback, revision: config.revision };
      keys.active = { extract: extract ? keys[extract.id] : '', classify: keys[classifier.id] || '' };
      await chrome.storage.local.set({ [CONFIG]: config, [SECRETS]: keys });
      abortAll();
    });
  }
  async function deleteChannel(id) {
    await enabledRequired();
    await queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([CONFIG, SECRETS]);
      const config = { ...defaults(), ...stored[CONFIG] }, keys = stored[SECRETS] || {};
      config.channels = config.channels.filter(c => c.id !== id); delete keys[id];
      if ([config.extractId, config.classifyId].includes(id)) {
        if (config.extractId === id) config.extractId = '';
        if (config.classifyId === id) config.classifyId = '';
        config.active = null; config.revision++; delete keys.active; abortAll();
      }
      await chrome.storage.local.set({ [CONFIG]: config, [SECRETS]: keys });
    });
  }
  function abortAll() { for (const controller of pending.values()) controller.abort(); }
  async function enqueue(item, tab) {
    const s = await snapshot(); if (!s.ready) return;
    await queueItemWrite(async () => {
      const stored = await chrome.storage.local.get([TASKS, ITEMS]);
      const current = (stored[ITEMS] || []).find(i => i.id === item.id);
      if (!current || current.projectId || (current.projectRevision || 0) !== (item.projectRevision || 0)) return;
      let tasks = stored[TASKS] || [];
      if (tasks.some(t => t.itemId === item.id)) return;
      tasks = tasks.filter(t => !terminal(t) || Date.now() - t.createdAt < 7 * 86400000);
      tasks.push({ id: crypto.randomUUID(), itemId: item.id, title: item.title, url: item.url, description: item.description,
        tabId: tab?.id, tabUrl: tab?.url, status: 'queued', sessionId, createdAt: Date.now(),
        revision: s.config.active.revision, projectRevision: item.projectRevision || 0,
        projects: definitions(s.projects), extractName: s.config.active.extract?.name || 'local', classifyName: s.config.active.classifier.name });
      await chrome.storage.local.set({ [TASKS]: tasks });
      await chrome.alarms.create('lateron-ai-resume', { periodInMinutes: .5 });
    });
    void pump();
  }
  async function updateTask(id, patch) {
    await queueItemWrite(async () => {
      const tasks = (await chrome.storage.local.get(TASKS))[TASKS] || [];
      const task = tasks.find(t => t.id === id);
      if (task) Object.assign(task, patch);
      await chrome.storage.local.set({ [TASKS]: tasks });
    });
  }
  async function localExtract(task, signal) {
    signal.throwIfAborted();
    try {
      const tab = await chrome.tabs.get(task.tabId);
      if (!tab || tab.url !== task.tabUrl || tab.pendingUrl) throw new Error('pageChanged');
      const response = await chrome.scripting.executeScript({ target: { tabId: task.tabId }, files: ['vendor/Readability.js', 'content-ai-extract.js'] });
      signal.throwIfAborted();
      const result = response?.[0]?.result;
      const latest = await chrome.tabs.get(task.tabId);
      if (result?.url !== task.tabUrl || latest.url !== task.tabUrl || latest.pendingUrl) throw new Error('pageChanged');
      return A.pageInput(task, result.content || '', result.source || 'metadata', result.content ? '' : 'metadataOnly');
    } catch (error) {
      signal.throwIfAborted();
      return A.pageInput(task, '', 'metadata', 'metadataOnly');
    }
  }
  async function extract(task, active, keys, signal) {
    if (!active.extract) return localExtract(task, signal);
    try { return await A.extractRemote(active.extract, keys.extract, task, signal); }
    catch (error) {
      signal.throwIfAborted();
      if (!active.fallback) throw error;
      const page = await localExtract(task, signal);
      return { ...page, fallbackFrom: active.extract.provider, fallbackReason: errorCode(error) };
    }
  }
  async function valid(task) {
    const s = await snapshot();
    if (!s.ready || s.config.active.revision !== task.revision || JSON.stringify(definitions(s.projects)) !== JSON.stringify(task.projects)) throw new Error('contextChanged');
    const item = ((await chrome.storage.local.get(ITEMS))[ITEMS] || []).find(i => i.id === task.itemId);
    if (!item || item.projectId || (item.projectRevision || 0) !== task.projectRevision || item.url !== task.url) throw new Error('contextChanged');
    return s;
  }
  async function run(task, controller) {
    const signal = controller.signal;
    try {
      const s = await valid(task), active = s.config.active;
      const keys = (await chrome.storage.local.get(SECRETS))[SECRETS]?.active || {};
      let page = (await chrome.storage.session.get(pageKey(task.id)))[pageKey(task.id)];
      let answer = task.answer;
      if (!answer) {
        if (!page) {
          await updateTask(task.id, { status: 'extracting' });
          page = await extract(task, active, keys, signal);
          signal.throwIfAborted();
          await chrome.storage.session.set({ [pageKey(task.id)]: page });
        }
        await updateTask(task.id, { status: 'read', source: page.source, truncated: page.truncated,
          warning: page.warning, fallbackFrom: page.fallbackFrom || '', fallbackReason: page.fallbackReason || '' });
        await valid(task); signal.throwIfAborted();
        // Persist intent before the paid decision request. Recovery never repeats an ambiguous request.
        await updateTask(task.id, { status: 'classifying' });
        answer = await A.classify(active.classifier, keys.classify, page, task.projects, signal);
        signal.throwIfAborted();
        await updateTask(task.id, { status: 'answered', answer });
      }
      const decision = A.decide(answer, active.classifier);
      await queueItemWrite(async () => {
        await valid(task); signal.throwIfAborted();
        const stored = await chrome.storage.local.get([ITEMS, TASKS]);
        const items = stored[ITEMS] || [], tasks = stored[TASKS] || [];
        const item = items.find(i => i.id === task.itemId), record = tasks.find(t => t.id === task.id);
        if (!record || !item || item.projectId || (item.projectRevision || 0) !== task.projectRevision) throw new Error('contextChanged');
        if (decision.projectId) { item.projectId = decision.projectId; item.projectRevision = (item.projectRevision || 0) + 1; }
        Object.assign(record, { status: decision.projectId ? 'applied' : 'unmatched', reason: decision.reason, projectId: decision.projectId, completedAt: Date.now(), answer });
        delete record.projects; delete record.description;
        await chrome.storage.local.set({ [ITEMS]: items, [TASKS]: tasks });
      });
    } catch (error) {
      await updateTask(task.id, { status: signal.aborted || error.message === 'contextChanged' ? 'interrupted' : 'failed', error: signal.aborted ? 'cancelled' : errorCode(error), completedAt: Date.now() });
    } finally {
      await chrome.storage.session.remove(pageKey(task.id));
      pending.delete(task.id);
      void pump();
    }
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      await init;
      const tasks = (await chrome.storage.local.get(TASKS))[TASKS] || [];
      for (const task of tasks) {
        if (pending.size >= 2) break;
        if (terminal(task) || pending.has(task.id)) continue;
        const controller = new AbortController(); pending.set(task.id, controller);
        void run(task, controller).catch(() => { pending.delete(task.id); });
      }
      if (!pending.size && tasks.every(terminal)) await chrome.alarms.clear('lateron-ai-resume');
    } finally { pumping = false; }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const configChanged = changes[CONFIG] && changes[CONFIG].oldValue?.revision !== changes[CONFIG].newValue?.revision;
    const disabled = changes[SETTINGS] && changes[SETTINGS].newValue?.aiEnabled !== true;
    const projectsChanged = changes[PROJECTS] && JSON.stringify(definitions(changes[PROJECTS].oldValue || [])) !== JSON.stringify(definitions(changes[PROJECTS].newValue || []));
    if (configChanged || disabled || projectsChanged) { abortAll(); void pump(); }
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'lateron-ai-resume') void pump(); });
  init.then(pump).catch(() => {});
  function trusted(sender) {
    const url = sender?.url?.split(/[?#]/)[0];
    return sender?.id === chrome.runtime.id && ['models.html', 'settings.html', 'library.html', 'sidepanel.html'].some(p => url === chrome.runtime.getURL(p));
  }
  async function message(msg, sender) {
    if (msg.type === 'AI_HISTORY') {
      const historyPage = sender?.id === chrome.runtime.id && sender?.url?.split(/[?#]/)[0] === chrome.runtime.getURL('ai-history.html');
      if (!historyPage && !trusted(sender)) throw new Error('forbidden');
      return history();
    }
    if (!trusted(sender)) throw new Error('forbidden');
    switch (msg.type) {
      case 'AI_STATE': return state();
      case 'AI_SET_ENABLED': await setEnabled(msg.enabled); return state();
      case 'AI_TEST_CHANNEL': return testChannel(msg.channel, msg.key);
      case 'AI_SAVE_CHANNEL': return saveChannel(msg.channel, msg.key, msg.token);
      case 'AI_DELETE_CHANNEL': await deleteChannel(msg.id); return state();
      case 'AI_ACTIVATE': await activate(msg); return state();
      default: throw new Error('invalidCommand');
    }
  }
  return { ready, enqueue, message, trusted, init };
}
