const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const host = require('./helpers/ai-host');
const A = require('../ai-core');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  // Use the bundled parser and actual injection, including sensitive DOM exclusions.
  const body = '<article><h1>Browser extension guide</h1>' + '<p>Browser extensions use service workers and message passing to organize saved pages. This engineering guide explains browser APIs, local storage and interface events in detail.</p>'.repeat(15) + '</article>';
  const dom = new JSDOM(body + '<form>PRIVATE_FORM<textarea>PRIVATE_INPUT</textarea></form><div contenteditable>PRIVATE_EDITOR</div><div hidden>PRIVATE_HIDDEN</div>', { url: 'https://example.com/article', runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync('vendor/Readability.js', 'utf8'));
  const extracted = dom.window.eval(fs.readFileSync('content-ai-extract.js', 'utf8'));
  assert.equal(extracted.source, 'local');
  assert.ok(extracted.content.includes('service workers'));
  assert.ok(!extracted.content.includes('PRIVATE_'));
  assert.ok(dom.window.document.querySelector('form'), 'live DOM remains unchanged');
  dom.window.close();

  const base = await host();
  const channel = await base.configure();
  await base.send('AI_ACTIVATE', { extractId: 'local', classifyId: channel.id });
  const item = { id: 'resume-item', url: 'https://example.com/article', title: 'Guide', description: 'Original summary', projectId: null };
  const projects = base.local.laterOnProjects;
  const task = { id: 'resume-task', itemId: item.id, url: item.url, title: item.title, tabId: 1, tabUrl: item.url, sessionId: base.session.laterOnAISession, projectRevision: 0, revision: base.local.laterOnAIConfig.active.revision, projects, status: 'read', createdAt: Date.now() };
  const local = { ...base.local, laterOnItems: [item], laterOnAITasks: [task] };
  const session = { ...base.session, 'laterOnAIPage:resume-task': A.pageInput(item, 'Persisted extracted content', 'local') };
  const read = await host(local, undefined, session);
  await read.settle();
  assert.equal(read.local.laterOnAITasks[0].status, 'applied');
  assert.equal(read.extractions.length, 0, 'persisted extraction is reused after worker restart');
  assert.equal(read.calls.length, 1);
  assert.equal(read.local.laterOnItems[0].description, item.description);

  const answer = A.validateAnswer({ choice: 'project_0', probabilities: { project_0: .96, none: .04 } }, A.choices(projects), 'mock', 'llm_estimate');
  const answered = await host({ ...local, laterOnAITasks: [{ ...task, status: 'answered', answer }] }, undefined, session);
  await answered.settle();
  assert.equal(answered.local.laterOnAITasks[0].status, 'applied');
  assert.equal(answered.calls.length, 0, 'persisted decision is never charged again');
  assert.equal(answered.extractions.length, 0);
  const ambiguous = await host({ ...local, laterOnAITasks: [{ ...task, status: 'classifying' }] }, undefined, session);
  await ambiguous.settle();
  assert.equal(ambiguous.local.laterOnAITasks[0].status, 'interrupted');
  assert.equal(ambiguous.calls.length, 0, 'ambiguous in-flight decision is never repeated');

  let hold = false, concurrent = 0, maximum = 0;
  const releases = [];
  const queue = await host({}, async (_url, options) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    if (hold) await new Promise(resolve => releases.push(resolve));
    concurrent--; return host.chatResponse(options);
  });
  const qc = await queue.configure();
  await queue.send('AI_ACTIVATE', { extractId: 'local', classifyId: qc.id });
  hold = true;
  const items = Array.from({ length: 6 }, (_, i) => ({ ...item, id: 'queue-' + i, url: item.url + '?n=' + i }));
  await queue.chrome.storage.local.set({ laterOnItems: items });
  for (const entry of items) await queue.service.enqueue(entry, { id: 1, url: entry.url });
  for (let i = 0; i < 100 && releases.length < 2; i++) await wait(5);
  assert.equal(releases.length, 2);
  assert.equal(queue.local.laterOnAITasks.filter(t => t.status === 'queued').length, 4);
  hold = false; releases.forEach(resolve => resolve());
  await queue.settle();
  assert.equal(maximum, 2);
  assert.ok(queue.local.laterOnAITasks.every(t => t.status === 'applied'));
  assert.ok(!Object.keys(queue.session).some(k => k.startsWith('laterOnAIPage:')));
  console.log('PASS bundled local extraction, private DOM exclusions, restart reuse and two-task concurrency');
})().catch(error => { console.error(error); process.exitCode = 1; });
