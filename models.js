(async () => {
  const A = LaterOnAI, { t, apply, send } = LaterOnAIUI;
  await window.LaterOnI18n?.getLanguage(); window.LaterOnI18n?.applyStatic(); apply();
  const $ = id => document.getElementById(id);
  const L = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const icon = '<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7.5 5 5 5-5"/></svg>';
  const local = { id:'local', name:t('local'), kind:'extract', provider:'local', testedAt:1, version:0 };
  const presets = { ...A.presets, custom:{ ...A.presets.custom, label:L('自定义兼容服务', 'Custom compatible service') } };
  let state, picked, selected = null, draft = null, origin = null, baseDraft = '', draftKey = '', keyCleared = false;
  let token = '', testedIdentity = '', testedKey, failedTest = false, testNote = '', formError = '', busy = false, menu = null, toastTimer, refreshId = 0, refreshQueued = false;
  const get = id => id === 'local' ? local : state?.config.channels.find(c => c.id === id);
  const providerName = c => ({ tavily:'Tavily', 'deepseek-fetch':'DeepSeek' }[c.provider] || presets[c.provider]?.label || t('local'));
  const detail = c => c.id === 'local' ? L('从当前浏览器页面提取正文', 'Extract text from the current browser page') : `${providerName(c)}${c.model ? ' · '+c.model : c.provider === 'tavily' ? ' · '+t(c.depth) : ''}`;
  const dirty = () => !!draft && (JSON.stringify(draft) !== baseDraft || !!draftKey || keyCleared);
  const suppliedKey = () => keyCleared ? '' : draftKey || undefined;
  const conflict = () => !!draft?.id && (!get(draft.id) || get(draft.id).version !== origin?.version);
  const validPair = () => !!get(picked?.extract)?.testedAt && !!get(picked?.classify)?.testedAt;
  const hasProjects = () => state?.projects.some(p => !p.archived);
  const blocked = () => !state?.enabled || !!state?.missing.length || !hasProjects();
  function changedPair() {
    const a = state?.config.active;
    return !a || picked.extract !== (a.extract?.id || 'local') || picked.classify !== a.classifier.id
      || get(picked.extract)?.version !== (a.extract?.version || 0) || get(picked.classify)?.version !== a.classifier.version || picked.fallback !== a.fallback;
  }
  function testValid() {
    if (!draft || failedTest || conflict()) return false;
    try {
      const identity = A.requestIdentity(A.channel(draft));
      return !!token && identity === testedIdentity && suppliedKey() === testedKey
        || !!origin?.testedAt && identity === A.requestIdentity(A.channel(origin)) && suppliedKey() === undefined;
    } catch { return false; }
  }
  function toast(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600); }
  function motion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }
  function themeLabel() { $('themeToggle').textContent = document.documentElement.dataset.theme === 'dark' ? L('浅色', 'Light') : L('深色', 'Dark'); }
  $('themeToggle').setAttribute('aria-label', L('切换明暗主题', 'Switch color theme'));
  new MutationObserver(themeLabel).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] }); themeLabel();
  document.title = `LaterOn · ${t('models')}`;
  $('intro').textContent = L('保存多个渠道，为新收藏的网页选择提取方式和归类模型。', 'Save multiple channels and choose how to extract and classify new saves.');
  $('managerTitle').textContent = L('渠道管理', 'Manage channels');
  $('managerHint').textContent = L('同一判断方式或服务商可添加多个端点，每次只使用已应用的组合。', 'Add multiple endpoints for the same decision method or provider. Only the applied combination runs.');
  $('channels').setAttribute('aria-label', L('已保存渠道', 'Saved channels'));
  document.querySelector('[data-action=add]').textContent = '+ '+t('add');
  $('runtimeNote').textContent = L('网页先保存；判断不明确或服务请求失败时，保留在等待整理。', 'Pages are saved first. Uncertain matches and failed requests stay in Inbox.');
  function chooseButton(type, label, sub = '') {
    const names = { 'run-extract':L('选择网页提取渠道','Choose extraction channel'), 'run-classify':L('选择归类判断渠道','Choose classification channel'), provider:t('provider'), protocol:t('protocol'), depth:t('depth') };
    return `<button type="button" class="choose" data-picker="${type}" aria-label="${esc(names[type])}" aria-haspopup="listbox" aria-expanded="false"><span class="choose-text"><strong>${esc(label)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${icon}</button>`;
  }
  function setBusy() {
    $('modelControls').disabled = busy || !state?.enabled;
    $('runtimeControls').disabled = busy || !state?.enabled;
    $('fallback').disabled = busy || !state?.enabled;
  }
  function renderRuntime() {
    if (!state) return;
    const a = state.config.active, pending = changedPair(), ready = validPair();
    $('runtimeTitle').textContent = blocked() ? L('运行组合','Configured combination') : pending && a ? L('选择运行组合','Choose a combination') : L('当前使用','Currently in use');
    const code = !state.enabled ? 'aiDisabled' : state.missing.length ? 'missingNotes' : !hasProjects() ? 'noProjects' : !ready ? 'setupIncomplete' : !a ? 'setupReady' : '';
    $('aiState').textContent = code ? t(code) : pending ? L('有待应用的更改','Unapplied changes') : t('active');
    $('aiState').className = 'status '+(code || pending ? 'pending' : '');
    $('statusSettings').hidden = state.enabled;
    const hints = [];
    if (state.enabled) {
      if (state.missing.length) hints.push(t('missingNotes'));
      else if (!hasProjects()) hints.push(t('setupCreateProjects'));
      if (!get(picked.extract)?.testedAt) hints.push(L('请选择可用的网页提取渠道，本地提取无需 API。','Choose an available extraction channel. Browser extraction needs no API.'));
      if (!get(picked.classify)?.testedAt) hints.push(state.config.channels.some(c => c.kind === 'classify')
        ? L('请选择已通过测试的归类渠道，再保存并启用。','Choose a tested classification channel, then save and enable.')
        : L('请添加并测试一个归类渠道，保存后选入上方组合，再保存并启用。','Add and test a classification channel, save it, select it above, then save and enable.'));
    }
    $('setupGuidance').textContent = hints.join(' '); $('setupGuidance').hidden = !hints.length;
    $('missingNotes').replaceChildren();
    for (const p of state.missing) { const li = document.createElement('li'), link = document.createElement('a'); link.textContent = p.name; link.href = `library.html?editProject=${encodeURIComponent(p.id)}`; li.append(link); $('missingNotes').append(li); }
    $('route').innerHTML = `<div class="field"><span class="field-label">${t('extract')}</span>${chooseButton('run-extract', get(picked.extract)?.name || t('choose'), get(picked.extract) ? detail(get(picked.extract)) : '')}</div><div class="route-arrow" aria-hidden="true">→</div><div class="field"><span class="field-label">${t('classify')}</span>${chooseButton('run-classify', get(picked.classify)?.name || t('choose'), get(picked.classify) ? detail(get(picked.classify)) : L('选择已保存并通过测试的渠道','Select a saved, tested channel'))}</div>`;
    $('applyRow').hidden = !pending;
    const old = a ? `${a.extract?.name || t('local')} → ${a.classifier.name} · ${a.classifier.model}` : '';
    $('applyRow').innerHTML = `<div class="apply-copy"><strong>${a ? L('更改尚未应用','Changes are not applied') : ready ? L('组合已就绪','Combination ready') : L('完成渠道配置后即可启用','Complete channel setup to enable')}</strong><small>${a ? L('正在使用：','Currently using: ')+esc(old) : L('仅对启用后新收藏的网页生效。','Applies only to pages saved after activation.')}</small></div><div class="button-group">${a ? `<button type="button" class="btn ghost" data-action="undo-pair">${L('撤销','Undo')}</button>` : ''}<button type="button" class="btn primary" id="activate" data-action="apply" ${ready && !blocked() ? '' : 'disabled'}>${a ? L('应用更改','Apply changes') : t('save')}</button></div>`;
    $('fallback').checked = picked.fallback; setBusy(); syncForm();
  }
  function renderList() {
    $('channels').innerHTML = ['classify','extract'].map(kind => {
      const list = state.config.channels.filter(c => c.kind === kind); if (kind === 'extract') list.unshift(local);
      return `<div class="group-label"><span>${t(kind)}</span><span>${list.length}</span></div>`+(list.length ? list.map(c => {
        const inUse = !!state.config.active && [state.config.active.extract?.id || 'local', state.config.active.classifier.id].includes(c.id);
        return `<button type="button" class="channel ${selected === c.id ? 'selected' : ''}" data-action="select" data-id="${esc(c.id)}" aria-current="${selected === c.id}"><span class="channel-top"><span class="channel-name">${esc(c.name)}</span>${inUse ? `<span class="current">${state.ready ? L('使用中','In use') : L('已选','Selected')}</span>` : ''}</span><small>${esc(c.id === 'local' ? t('builtin') : c.model || providerName(c))}</small></button>`;
      }).join('') : `<p class="empty-list">${L('还没有归类渠道','No classification channels yet')}</p>`);
    }).join('');
  }
  function renderResults() {
    LaterOnAIRecords.render($('recentResults'), state.tasks, { limit:6, projects:state.projects });
    $('viewHistory').hidden = state.tasks.length <= 6;
    $('historyFooter').hidden = $('viewHistory').hidden;
    const count = Math.min(state.tasks.length, 6);
    $('recentHint').textContent = count ? L(`最近 ${count} 条 · 点击记录查看判断详情`, `Latest ${count} · Select a record to see decision details`) : L('最多显示最近 6 条分类记录', 'Shows up to 6 recent classification records');
  }
  async function refresh() {
    const id = ++refreshId, next = await send('AI_STATE'); if (id !== refreshId) return;
    const layoutChanged = !state || JSON.stringify([state.config,state.enabled,state.missing,state.projects]) !== JSON.stringify([next.config,next.enabled,next.missing,next.projects]);
    const preserve = !!state && changedPair(); state = next;
    // Task progress must not recreate an open picker or steal focus from the editor.
    if (!layoutChanged) { renderResults(); return; }
    if (!picked || !preserve) picked = { extract:state.config.extractId, classify:state.config.classifyId, fallback:state.config.fallback };
    if (picked.extract && !get(picked.extract)) picked.extract = ''; if (picked.classify && !get(picked.classify)) picked.classify = '';
    closePicker(false); renderRuntime(); renderList(); renderResults();
    if (!draft || !dirty() && !busy) edit(get(selected)?.id || state.config.channels.find(c => c.kind === 'classify')?.id || 'local');
  }
  function edit(id) {
    closePicker(false); selected = id; origin = id === 'local' ? null : get(id);
    draft = origin ? { ...origin } : null; baseDraft = JSON.stringify(draft); draftKey = ''; keyCleared = false; token = ''; failedTest = false; testNote = ''; formError = '';
    renderList(); renderEditor();
  }
  function newChannel(kind = 'classify') {
    const provider = kind === 'extract' ? 'tavily' : 'deepseek', p = presets[provider];
    selected = 'new'; origin = null; draft = { id:'', name:'', kind, provider, endpoint:p.endpoint, protocol:p.protocol || 'openai', model:p.model || '', depth:'basic', minScore:.85, minMargin:.15, jsonMode:false };
    baseDraft = JSON.stringify(draft); draftKey = ''; keyCleared = false; token = ''; failedTest = false; testNote = ''; formError = ''; renderList(); renderEditor();
    $('editor').scrollIntoView({ behavior:motion(), block:'nearest' }); document.querySelector('[name=name]')?.focus();
  }
  function renderEditor() {
    const root = $('editor');
    if (!draft) { root.innerHTML = `<div class="local-content"><div class="editor-heading"><div><h3>${t('local')}</h3><p>${t('builtin')}</p></div>${picked.extract !== 'local' ? `<button class="text-button" type="button" data-action="use-local">${L('选为提取渠道','Use for extraction')}</button>` : ''}</div><div class="local-status">✓ ${t('builtin')}</div><p>${L('从已加载页面提取正文；页面关闭或跳转时，使用收藏时保存的标题和描述。内容会发送至选定的归类服务。','Extract text from the loaded page. If it closes or navigates away, use the saved title and description. Content is sent to the selected classification service.')}</p></div>`; return; }
    const c = draft, p = presets[c.provider], isNew = !c.id;
    root.innerHTML = `<form id="channelForm"><div class="editor-heading"><div><h3>${isNew ? t('add') : esc(origin?.name || c.name)}</h3><p>${isNew ? L('每个渠道独立保存地址、凭据和模型。','Each channel has its own URL, credentials and model.') : L('编辑这里的配置，不会立即改变当前运行组合。','Editing does not immediately change the running combination.')}</p></div>${isNew ? '' : '<button type="button" class="text-button" data-action="use"></button>'}</div>
      ${isNew ? `<div class="kind-tabs" role="group" aria-label="${L('渠道用途','Channel purpose')}"><button type="button" data-action="kind" data-kind="classify" aria-pressed="${c.kind === 'classify'}">${t('classify')}</button><button type="button" data-action="kind" data-kind="extract" aria-pressed="${c.kind === 'extract'}">${t('extract')}</button></div>` : ''}
      <div class="form-grid"><label class="field"><span class="field-label">${t('name')}</span><input name="name" id="channelName" type="text" required maxlength="80" value="${esc(c.name)}" placeholder="${L('例如：DeepSeek、团队推理服务','For example: DeepSeek, Team reasoning service')}"></label>
      <div class="field"><span class="field-label">${L('服务商','Provider')}</span>${chooseButton('provider',p.label)}</div>
      ${c.kind === 'classify' ? `<div class="field wide"><label for="modelId" class="field-label">${t('model')}</label><div class="input-combo"><input id="modelId" name="model" type="text" required maxlength="150" value="${esc(c.model)}" autocomplete="off"><button type="button" data-picker="model" aria-label="${L('选择已使用的模型','Choose a previously used model')}" aria-haspopup="listbox" aria-expanded="false">${icon}</button></div><span class="field-note">${['jev','decisions'].includes(c.protocol) ? L('填写此决策端点支持的模型 ID，也可选用已保存的模型。','Enter a model ID supported by this decision endpoint, or choose a saved model.') : L('使用已开启推理能力的模型；可手填 ID，或选用该服务商已保存的模型。','Use a model with reasoning enabled. Enter its ID or choose one saved for this provider.')}</span></div>` : ''}
      <div class="field wide"><div class="key-heading"><label for="apiKey" class="field-label">${t('key')}</label>${origin?.hasKey ? `<button type="button" class="text-button" data-action="clear-key">${t('clearKey')}</button>` : ''}</div>${c.provider === 'custom' ? `<span class="field-note">${L('无鉴权服务可留空','Optional for services without authentication')}</span>` : ''}<input id="apiKey" name="key" type="password" maxlength="4000" autocomplete="off" value="${esc(draftKey)}" placeholder="${!keyCleared && origin?.hasKey && origin.provider === c.provider ? t('keyHint') : ''}"></div>
      ${c.provider === 'tavily' ? `<div class="field wide"><span class="field-label">${t('depth')}</span>${chooseButton('depth',t(c.depth))}</div>` : ''}</div>
      <details class="advanced" ${c.provider === 'custom' ? 'open' : ''}><summary>${L('连接地址与请求选项','Connection and request options')}</summary><div class="form-grid">
      <label class="field wide"><span class="field-label">${t('endpoint')}</span><input id="endpoint" name="endpoint" type="url" required value="${esc(c.endpoint)}" placeholder="https://…"><span class="endpoint" id="endpointPreview"></span></label>
      ${c.provider === 'custom' ? `<div class="field wide"><span class="field-label">${t('protocol')}</span>${chooseButton('protocol',c.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI Chat Completions')}</div>` : ''}
      ${c.kind === 'classify' ? `<label class="field"><span class="field-label">${t('score')}</span><input name="minScore" type="number" min="0" max="1" step=".01" required value="${c.minScore}"></label><label class="field"><span class="field-label">${t('margin')}</span><input name="minMargin" type="number" min="0" max="1" step=".01" required value="${c.minMargin}"></label><p class="field-note wide">${t('scoreHint')}</p>${c.protocol === 'openai' ? `<label class="check wide"><input type="checkbox" name="jsonMode" ${c.jsonMode ? 'checked' : ''}>${t('jsonMode')}</label>` : ''}` : ''}</div></details>
      <p class="field-note" style="margin-top:16px">${t('testHint')}</p><p id="formError" class="error-note" role="alert" hidden></p>
      <div class="editor-footer"><div class="test-area"><button type="button" class="btn ghost" data-action="test" id="testChannel">${t('test')}</button><span id="testResult" class="test-result" role="status"></span></div><div class="button-group">${isNew ? `<button type="button" class="btn ghost" data-action="cancel-edit" id="cancelEdit">${t('cancel')}</button>` : `<button type="button" class="btn danger-outline" data-action="delete">${t('remove')}</button>`}<button type="submit" class="btn primary" id="saveChannel">${t('saveChannel')}</button></div></div></form>`;
    root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter'); syncForm();
  }
  function syncForm() {
    if (!draft || !$('saveChannel')) return;
    const stale = conflict(), tested = testValid();
    $('saveChannel').disabled = busy || stale || !tested || !dirty();
    $('testChannel').disabled = busy || stale;
    const use = document.querySelector('[data-action=use]');
    if (use) { const chosen = picked[draft.kind] === draft.id; use.disabled = busy || stale || dirty() || chosen || !origin?.testedAt; use.textContent = chosen ? !changedPair() ? state.ready ? L('当前使用','Currently in use') : L('已选','Selected') : L('已选，待应用','Selected; not applied') : draft.kind === 'classify' ? L('选为归类渠道','Use for classification') : L('选为提取渠道','Use for extraction'); }
    $('testResult').textContent = testNote || (tested ? '✓ '+t('tested') : t('testRequired'));
    $('testResult').className = 'test-result '+(formError ? 'error' : !tested ? 'waiting' : '');
    $('formError').textContent = stale ? L('这个渠道已在其他页面修改或删除，请从左侧重新选择渠道。','This channel changed or was deleted elsewhere. Select a channel again from the list.') : formError;
    $('formError').hidden = !$('formError').textContent;
    try { $('endpointPreview').textContent = draft.endpoint ? `${t('actualEndpoint')}: ${A.endpoint({ ...presets[draft.provider], ...draft })}` : ''; } catch { $('endpointPreview').textContent = ''; }
  }
  function validateDraft() {
    if (!$('channelForm').reportValidity()) throw new Error(t('missingFields'));
    try { return A.channel(draft); } catch (e) { throw new Error(t(e.message)); }
  }
  async function action(fn, form = false) {
    if (busy || !state?.enabled) return;
    closePicker(false); busy = true; setBusy(); $('actionResult').hidden = true; formError = ''; syncForm();
    try { await fn(); }
    catch (e) { if (form && draft) formError = e.message; else { $('actionResult').textContent = e.message; $('actionResult').hidden = false; } }
    finally { busy = false; setBusy(); syncForm(); if (refreshQueued) { refreshQueued = false; await refresh().catch(showReadError); } }
  }
  async function test() {
    await action(async () => {
      const c = validateDraft(), key = suppliedKey(); token = ''; failedTest = true; testNote = t('testing'); syncForm();
      const result = await send('AI_TEST_CHANNEL', { channel:c, key });
      token = result.token; testedIdentity = A.requestIdentity(c); testedKey = key; failedTest = false; testNote = `✓ ${t('tested')} · ${result.elapsed} ms`;
    }, true);
    if (failedTest) { testNote = t('testRequired'); syncForm(); }
  }
  async function save() {
    await action(async () => {
      if (conflict() || !testValid()) throw new Error(t('testRequired'));
      const saved = await send('AI_SAVE_CHANNEL', { channel:validateDraft(), key:suppliedKey(), token });
      // The returned object contains no secret. Credentials remain exclusively in the background.
      draftKey = ''; keyCleared = false; token = ''; draft = null;
      await refresh(); edit(saved.id); toast(L('渠道已保存。选择并应用组合后才会使用。','Channel saved. Select and apply it to start using it.'));
    }, true);
  }
  function confirmAction(title, text, action, label = L('放弃修改','Discard changes'), danger = false) {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmOK').textContent = label; $('confirmOK').className = 'btn '+(danger ? 'danger' : 'primary'); $('confirmCancel').textContent = t('cancel');
    $('confirmOK').onclick = () => { $('confirm').close(); action(); }; $('confirmCancel').onclick = () => $('confirm').close(); $('confirm').showModal(); $('confirmCancel').focus();
  }
  function leave(fn) { if (busy) return; if (dirty()) confirmAction(L('放弃尚未保存的修改？','Discard unsaved changes?'), L('这次编辑不会保留，当前运行组合不受影响。','Your edits will be discarded. The running combination is unchanged.'), fn); else fn(); }
  function stage(kind, id) { picked[kind] = id; closePicker(false); renderRuntime(); renderEditor(); }
  function useDraft() { if (!draft || dirty() || conflict()) return; stage(draft.kind, draft.id); document.querySelector('.runtime').scrollIntoView({ behavior:motion(), block:'start' }); }
  async function applyPair() {
    if (!validPair() || blocked()) return;
    await action(async () => { await send('AI_ACTIVATE', { extractId:picked.extract, classifyId:picked.classify, fallback:picked.fallback }); await refresh(); toast(L('运行组合已更新，将用于之后的新收藏。','Combination updated for future saves.')); });
  }
  function deleteChannel() {
    const c = get(selected); if (!c || c.id === 'local') return;
    const inUse = [state.config.extractId,state.config.classifyId].includes(c.id);
    const warning = L('渠道配置和密钥将被删除，无法撤销。','The channel configuration and API key will be deleted. This cannot be undone.');
    const impact = inUse ? L('这个渠道正在使用，删除后自动归类将暂停，需重新选择并启用组合。已收藏的网页不受影响。','This channel is in use. Automatic classification will pause until you select and enable a new combination. Saved pages are not affected.') : L('其他渠道、当前运行组合和已收藏的网页不受影响。','Other channels, the running combination and saved pages are not affected.');
    confirmAction(L('删除“','Delete “')+c.name+L('”？','”?'), warning+' '+impact+(dirty() ? L(' 本次未保存的修改也会丢弃。',' Unsaved edits will also be discarded.') : ''), () => action(async () => {
      await send('AI_DELETE_CHANNEL', { id:c.id }); draft = null; selected = 'local'; await refresh(); toast(t('saved'));
    }), L('删除渠道','Delete channel'), true);
  }
  function entries(type) {
    if (type.startsWith('run-')) { const kind = type.slice(4), list = state.config.channels.filter(c => c.kind === kind); if (kind === 'extract') list.unshift(local); return list.map(c => ({ value:c.id, label:c.name, sub:detail(c), disabled:!c.testedAt })); }
    if (type === 'provider') return Object.entries(presets).filter(([,p]) => p.kind === draft.kind).map(([value,p]) => ({ value, label:p.label, sub:value === 'custom' ? L('可选择兼容协议','Choose a compatible protocol') : p.protocol === 'anthropic' ? 'Anthropic Messages' : p.protocol === 'openai' ? 'OpenAI Chat Completions' : p.protocol === 'jev' ? 'Jev' : p.protocol === 'decisions' ? 'OpenAI Decisions' : t('extract'), group:p.kind === 'extract' ? t('extract') : ['jev','decisions'].includes(p.protocol) ? L('决策接口','Decision APIs') : L('推理模型（Chat 接口）','Reasoning models (Chat API)') }));
    if (type === 'model') return [...new Set(state.config.channels.filter(c => c.provider === draft.provider && c.model).map(c => c.model))].map(value => ({ value, label:value, sub:L('已保存渠道中使用过的模型','Used by a saved channel') }));
    if (type === 'protocol') return ['openai','anthropic'].map(value => ({ value, label:value === 'openai' ? 'OpenAI Chat Completions' : 'Anthropic Messages', sub:'' }));
    return ['basic','advanced'].map(value => ({ value, label:t(value), sub:'' }));
  }
  function menuValue(type) { return type.startsWith('run-') ? picked[type.slice(4)] : draft[type]; }
  function openPicker(trigger) {
    if (busy || !state?.enabled) return;
    if (menu?.trigger === trigger) { closePicker(); return; } closePicker(false);
    const type = trigger.dataset.picker; menu = { type, trigger }; trigger.setAttribute('aria-expanded','true'); trigger.setAttribute('aria-controls','pickerOptions');
    const search = !['protocol','depth'].includes(type);
    $('picker').hidden = false; $('picker').innerHTML = `${search ? `<input type="text" id="pickerSearch" placeholder="${L('搜索名称或模型…','Search names or models…')}" aria-label="${L('搜索选项','Search options')}">` : ''}<div class="options" id="pickerOptions" role="listbox" aria-label="${esc(trigger.getAttribute('aria-label'))}"></div>${type === 'model' ? `<p class="popover-note">${L('也可以直接填写任意模型 ID。','You can also enter any model ID directly.')}</p>` : ''}`;
    renderOptions(''); if (search) { $('pickerSearch').addEventListener('input', e => renderOptions(e.target.value)); $('pickerSearch').focus(); } else $('pickerOptions').querySelector('button')?.focus();
  }
  function positionPicker() {
    if (!menu) return; const r = menu.trigger.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, menu.type === 'provider' ? 320 : 270), innerWidth - 28); $('picker').style.width = width+'px'; $('picker').style.left = Math.min(Math.max(14,r.left),innerWidth-width-14)+'px';
    const height = $('picker').offsetHeight; let top = r.bottom + 7; if (top+height > innerHeight-14 && r.top > height+20) top = r.top-height-7; $('picker').style.top = Math.max(10,Math.min(top,innerHeight-height-10))+'px';
  }
  function renderOptions(filter) {
    const list = entries(menu.type).filter(o => (o.label+' '+o.sub).toLowerCase().includes(filter.toLowerCase())); let group = '';
    $('pickerOptions').innerHTML = list.map(o => { const head = o.group && o.group !== group ? `<div class="option-group">${esc(o.group)}</div>` : ''; group = o.group; return head+`<button type="button" class="option" role="option" aria-selected="${o.value === menuValue(menu.type)}" data-value="${esc(o.value)}" ${o.disabled ? 'disabled' : ''}><span><strong>${esc(o.label)}</strong><small>${esc(o.sub)}${o.disabled ? ' · '+t('testRequired') : ''}</small></span>${o.value === menuValue(menu.type) ? '<span class="tick" aria-hidden="true">✓</span>' : ''}</button>`; }).join('') || `<p class="no-options">${filter ? L('没有匹配的选项','No matching options') : menu.type === 'model' ? L('还没有使用记录，可直接填写模型 ID。','No saved models yet. Enter a model ID directly.') : L('还没有保存的渠道。','No saved channels yet.')}</p>`;
    if (!list.length && !filter && menu.type.startsWith('run-')) $('pickerOptions').insertAdjacentHTML('beforeend', `<button type="button" class="option" data-action="add-from-menu">+ ${t('add')}</button>`); positionPicker();
  }
  function closePicker(focus = true) { if (!menu) return; const trigger = menu.trigger; menu = null; $('picker').hidden = true; trigger.setAttribute('aria-expanded','false'); if (focus && trigger.isConnected) trigger.focus(); }
  function pick(value) {
    const type = menu.type; closePicker();
    if (type.startsWith('run-')) { stage(type.slice(4),value); document.querySelector(`[data-picker="${type}"]`)?.focus(); return; }
    if (draft[type] === value) return;
    if (type === 'provider') { const p = presets[value]; Object.assign(draft,{ provider:value, endpoint:p.endpoint, model:p.model || '', protocol:p.protocol || 'openai' }); draftKey = ''; keyCleared = true; }
    else draft[type] = value;
    token = ''; failedTest = false; testNote = t('testRequired'); formError = ''; renderEditor(); document.querySelector(`[data-picker="${type}"]`)?.focus();
  }
  document.addEventListener('click', e => {
    const option = e.target.closest('#picker [data-value]'); if (option && !option.disabled && state?.enabled && !busy) { pick(option.dataset.value); return; }
    const trigger = e.target.closest('[data-picker]'); if (trigger && !trigger.matches(':disabled')) { openPicker(trigger); return; }
    const btn = e.target.closest('[data-action]'); if (!e.target.closest('#picker')) closePicker(false); if (!btn || btn.matches(':disabled') || busy || !state?.enabled) return;
    switch (btn.dataset.action) {
      case 'select': leave(() => edit(btn.dataset.id)); break;
      case 'add': leave(() => newChannel()); break;
      case 'kind': if (btn.dataset.kind !== draft.kind) leave(() => newChannel(btn.dataset.kind)); break;
      case 'add-from-menu': { const kind = menu.type.slice(4); closePicker(false); leave(() => newChannel(kind)); break; }
      case 'test': void test(); break;
      case 'cancel-edit': leave(() => edit(get(draft.id)?.id || 'local')); break;
      case 'clear-key': draftKey = ''; keyCleared = true; token = ''; failedTest = false; testNote = t('testRequired'); renderEditor(); break;
      case 'use': useDraft(); break;
      case 'use-local': stage('extract','local'); break;
      case 'apply': void applyPair(); break;
      case 'undo-pair': { const a = state.config.active; picked = { extract:a.extract?.id || 'local', classify:a.classifier.id, fallback:a.fallback }; renderRuntime(); break; }
      case 'delete': if (!busy) deleteChannel(); break;
    }
  });
  document.addEventListener('input', e => {
    if (!draft || busy || !e.target.closest('#channelForm')) return;
    const { name, value, type, checked } = e.target; if (!name) return;
    if (name === 'key') { draftKey = value; keyCleared = false; } else draft[name] = type === 'checkbox' ? checked : type === 'number' ? value === '' ? NaN : Number(value) : value;
    if (!['name','minScore','minMargin'].includes(name)) { token = ''; failedTest = false; testNote = ''; }
    formError = ''; syncForm();
  });
  document.addEventListener('submit', e => { if (e.target.id === 'channelForm') { e.preventDefault(); void save(); } });
  $('fallback').addEventListener('change', e => { picked.fallback = e.target.checked; renderRuntime(); });
  $('themeToggle').onclick = async () => { await LaterOnSettings.set({ theme:document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); };
  $('back').onclick = e => { if (!e.ctrlKey && !e.metaKey && !e.shiftKey && history.length > 1) { e.preventDefault(); leave(() => { draft = null; history.back(); }); } };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && menu) { e.preventDefault(); closePicker(); return; }
    const trigger = e.target.closest('[data-picker]'); if (!menu && trigger && !trigger.matches(':disabled') && ['ArrowDown','ArrowUp'].includes(e.key)) { e.preventDefault(); openPicker(trigger); return; }
    if (!menu) return; if (e.key === 'Tab') { closePicker(); return; }
    const options = [...$('picker').querySelectorAll('.option:not(:disabled)')]; if (!options.length) return;
    if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); let i = options.indexOf(document.activeElement); i = e.key === 'Home' ? 0 : e.key === 'End' ? options.length-1 : e.key === 'ArrowDown' ? (i+1)%options.length : (i-1+options.length)%options.length; options[i].focus(); }
  });
  addEventListener('resize',positionPicker); addEventListener('scroll',e => { if (menu && !$('picker').contains(e.target)) positionPicker(); },true);
  addEventListener('beforeunload',e => { if (dirty() || busy || state && changedPair() && state.config.active) { e.preventDefault(); e.returnValue = ''; } });
  function showReadError(e) { $('actionResult').textContent = e.message; $('actionResult').hidden = false; }
  chrome.storage.onChanged.addListener((changes,area) => {
    if (area !== 'local' || !['laterOnSettings','laterOnProjects','laterOnAIConfig','laterOnAITasks'].some(k => changes[k])) return;
    if (busy) refreshQueued = true; else refresh().catch(showReadError);
  });
  await refresh().catch(showReadError);
})();
