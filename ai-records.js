// Read-only presentation shared by the six recent records and the history page.
(function () {
  const { t } = LaterOnAIUI;
  const L = (zh, en) => document.documentElement.lang === 'en' ? en : zh;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function candidates(task) {
    return (Array.isArray(task.answer?.candidates) ? task.answer.candidates : [])
      .filter(c => c && Number.isFinite(c.score)).slice().sort((a, b) => b.score - a.score);
  }
  function projectName(id, task, projects) {
    return candidates(task).find(c => c.projectId === id)?.name
      || projects.find(p => p.id === id)?.name || L('原项目', 'the original project');
  }
  function outcome(task, projects) {
    if (task.status === 'applied') return task.projectId
      ? L(`已归入「${projectName(task.projectId, task, projects)}」`, `Filed in “${projectName(task.projectId, task, projects)}”`)
      : L('已完成归类', 'Classification completed');
    return ({
      unmatched:L('留在等待整理', 'Left in Inbox'),
      failed:L('分类失败，网页已保留', 'Classification failed; page kept'),
      interrupted:L('分类已停止', 'Classification stopped'),
      queued:L('等候分类', 'Waiting to classify'),
      extracting:L('正在读取网页', 'Reading the page'),
      read:L('网页已读取，等候判断', 'Page read; waiting for a decision'),
      classifying:L('正在判断归属', 'Choosing a project'),
      answered:L('正在保存分类结果', 'Saving the result')
    })[task.status] || t(task.status);
  }
  function explanation(task) {
    if (task.status === 'interrupted') return task.error === 'contextChanged'
      ? L('网页、项目或配置已经变了，这次结果没有应用。', 'The page, projects or settings changed, so this result was not applied.')
      : L('这次分类已停止，没有应用结果。', 'Classification stopped without applying a result.');
    return ({
      matched:L('匹配结果达到了自动归类的要求。', 'The match met the requirements for automatic classification.'),
      unmatched:L('这次没找到合适的项目，留给你手动整理。', 'No suitable project was found. You can sort this page manually.'),
      lowScore:L('匹配分数还不够高，暂时留在等待整理。', 'The match score was too low, so the page stayed in Inbox.'),
      lowMargin:L('前两个候选的分数太接近，暂时留在等待整理。', 'The top two candidates were too close, so the page stayed in Inbox.')
    })[task.reason] || '';
  }
  function sourceName(value) {
    return ({
      local:t('local'), metadata:L('收藏时保存的标题和描述', 'Saved title and description'),
      'deepseek-fetch':'DeepSeek Fetch', tavily:'Tavily Extract'
    })[value] || value || '';
  }
  function errorText(code) {
    if (/^http_5\d\d$/.test(code || '')) return L(`服务返回错误（HTTP ${code.slice(5)}）`, `Service returned an error (HTTP ${code.slice(5)})`);
    const message = t(code);
    return /^http_\d+$/.test(code || '') && message !== `HTTP ${code.slice(5)}`
      ? L(`${message}（HTTP ${code.slice(5)}）`, `${message} (HTTP ${code.slice(5)})`) : message;
  }
  function extraction(task) {
    const provider = task.fallbackFrom || (['deepseek-fetch','tavily'].includes(task.source) ? task.source : '');
    const service = sourceName(provider), name = task.extractName;
    const brand = { 'deepseek-fetch':'DeepSeek', tavily:'Tavily' }[provider];
    const origin = service && name && ![provider,service,brand].includes(name)
      ? L(`${name}（${service}）`, `${name} (${service})`) : service || sourceName(name);
    const actual = sourceName(task.source), notes = [];
    let route = actual || origin || L('未记录', 'Not recorded');
    if (task.fallbackFrom) {
      route = `${origin} → ${actual || L('来源未记录', 'Source not recorded')}`;
      notes.push(task.source === 'local'
        ? L(`${service} 提取失败，已改用浏览器中的正文。`, `${service} extraction failed; text from the browser was used instead.`)
        : L(`${service} 提取失败，已尝试本地提取。`, `${service} extraction failed; local extraction was attempted.`));
      if (task.fallbackReason) notes.push(L('原因：', 'Reason: ')+errorText(task.fallbackReason));
    } else if (provider) route = origin;
    else if (task.source === 'metadata' && origin && origin !== actual) route = `${origin} → ${actual}`;
    if (task.source === 'metadata') notes.push(L('未取得网页正文，本次仅使用收藏时的标题和描述。', 'No page text was available; only the saved title and description were used.'));
    else if (task.warning) notes.push(t(task.warning));
    if (task.status === 'failed' && !task.source && !task.answer) {
      notes.push(L('提取失败，未进行归类判断。', 'Extraction failed; classification was not run.'));
      if (task.error) notes.push(L('原因：', 'Reason: ')+errorText(task.error));
    } else if (!task.source && !task.answer && ['queued','extracting'].includes(task.status)) {
      notes.push(task.status === 'queued' ? L('等待提取网页内容。', 'Waiting to extract page content.') : L('正在提取网页内容。', 'Extracting page content.'));
    }
    if (task.truncated || task.answer?.truncated) notes.push(L('网页较长，本次只使用了其中一部分内容。', 'The page was long, so only part of its content was used.'));
    return { route, notes };
  }
  function record(task, projects) {
    const root = element('details', 'ai-record'); root.dataset.taskId = task.id;
    const summary = element('summary');
    summary.append(element('span', 'record-title', task.title || L('未命名网页', 'Untitled page')));
    const meta = element('span', 'record-meta');
    meta.append(element('span', 'record-outcome', outcome(task, projects)));
    const timestamp = task.completedAt || task.createdAt;
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const date = new Date(timestamp);
      if (Number.isFinite(date.getTime())) {
        const time = element('time', '', new Intl.DateTimeFormat(document.documentElement.lang === 'en' ? 'en' : 'zh-CN',
          { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }).format(date));
        time.dateTime = date.toISOString(); time.title = date.toLocaleString(); meta.append(time);
      }
    }
    summary.append(meta); root.append(summary);
    const body = element('div', 'record-body'), fields = element('dl', 'record-fields');
    const row = (label, value) => { if (value) fields.append(element('dt', '', label), element('dd', '', value)); };
    const extracted = extraction(task), content = element('dd', 'record-extraction');
    content.append(element('span', 'record-route', extracted.route));
    for (const note of extracted.notes) content.append(element('p', 'record-extraction-note', note));
    fields.append(element('dt', '', L('网页提取', 'Page extraction')), content);
    const extractionFailed = task.status === 'failed' && !task.source && !task.answer;
    const waiting = ['queued','extracting','read'].includes(task.status);
    row(L('归类判断', 'Classification'), extractionFailed ? L('未进行', 'Not run')
      : [task.classifyName, task.answer?.model, waiting ? L('尚未开始', 'Not started') : ''].filter(Boolean).join(' · '));
    if (!extractionFailed) row(L('归类说明', 'Classification details'), task.status === 'failed'
      ? (task.answer ? L('分类结果未能保存：', 'The classification result could not be saved: ') : L('归类请求失败：', 'Classification request failed: '))+(task.error ? errorText(task.error) : L('原因未记录', 'Reason not recorded'))
      : explanation(task));
    body.append(fields);
    const scores = candidates(task);
    if (scores.length) {
      const table = element('table', 'record-scores');
      const source = task.answer?.scoreSource;
      table.append(element('caption', '', source === 'llm_estimate' ? L('模型给出的匹配分数', 'Model match scores')
        : source === 'decision_probability' ? L('决策接口返回的概率', 'Probabilities from the decision API') : L('候选分数', 'Candidate scores')));
      const head = element('thead'), heading = element('tr');
      for (const label of [L('候选项目', 'Candidate'), L('分数', 'Score')]) { const cell = element('th', '', label); cell.scope = 'col'; heading.append(cell); }
      head.append(heading); table.append(head);
      const rows = element('tbody');
      for (const candidate of scores) {
        const tr = element('tr');
        tr.append(element('td', '', candidate.projectId ? candidate.name || projectName(candidate.projectId,task,projects) : L('没有合适的项目', 'No suitable project')),
          element('td', '', `${(candidate.score * 100).toFixed(1)}%`));
        rows.append(tr);
      }
      table.append(rows); body.append(table, element('p', 'record-score-note', L('这些分数反映这次判断，不代表分类正确率。', 'These scores describe this decision; they are not verified accuracy rates.')));
    }
    root.append(body); return root;
  }
  function render(host, tasks, { limit = Infinity, projects = [] } = {}) {
    const opened = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.taskId));
    host.replaceChildren();
    const sorted = tasks.slice().sort((a,b) => (b.createdAt || b.completedAt || 0) - (a.createdAt || a.completedAt || 0));
    if (!sorted.length) host.append(element('p', 'records-empty', t('empty')));
    for (const task of sorted.slice(0,limit)) { const node = record(task, projects); node.open = opened.has(task.id); host.append(node); }
  }
  window.LaterOnAIRecords = { render };
})();
