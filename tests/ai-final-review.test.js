const assert = require('node:assert/strict');
const host = require('./helpers/ai-host');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  let hold = false;
  const releases = [];
  const h = await host({}, async (_url, options) => {
    if (hold) await new Promise(resolve => releases.push(resolve));
    return host.chatResponse(options);
  });
  const channel = await h.configure();
  await h.send('AI_ACTIVATE', { extractId:'local', classifyId:channel.id });
  const items = Array.from({length:6}, (_,i) => ({
    id:'toggle-'+i, url:'https://example.com/article', title:'Guide '+i, projectId:null
  }));
  await h.chrome.storage.local.set({laterOnItems:items});
  hold = true;
  const before = h.calls.length;
  for (const item of items) await h.service.enqueue(item, {id:1, url:item.url});
  for (let n=0;n<100 && releases.length<2;n++) await wait(5);
  assert.equal(releases.length,2);
  await h.send('AI_SET_ENABLED',{enabled:false});
  await h.send('AI_SET_ENABLED',{enabled:true});
  hold = false;
  releases.forEach(resolve=>resolve());
  await h.settle();
  assert.equal(h.calls.length-before,2,'turning AI back on must not start queued tasks from before it was disabled');
  assert.ok(h.local.laterOnAITasks.every(t=>t.status==='interrupted'));
  assert.ok(h.local.laterOnItems.every(i=>i.projectId===null));
  assert.equal(await h.service.ready(),true,'the saved combination is available for future saves');
  const fresh={id:'after-toggle',url:'https://example.com/article',title:'New save',projectId:null};
  await h.chrome.storage.local.set({laterOnItems:[...h.local.laterOnItems,fresh]});
  await h.service.enqueue(fresh,{id:1,url:fresh.url});await h.settle();
  assert.equal(h.local.laterOnItems.find(i=>i.id===fresh.id).projectId,'p1');
  // A picker opened while AI was available must still allow manual saving after AI is disabled.
  const source=fs.readFileSync(path.join(__dirname,'../background.js'),'utf8');
  const claim=source.slice(source.indexOf('async function claimPendingBatch('),source.indexOf('async function cancelPendingBatch('));
  await h.send('AI_SET_ENABLED',{enabled:false});
  await h.chrome.storage.session.set({laterOnPendingBatch:{tabs:[{id:1,url:fresh.url}],createdAt:Date.now()}});
  const context=vm.createContext({chrome:h.chrome,Date,PENDING_KEY:'laterOnPendingBatch',LAST_PROJECT_KEY:'laterOnLastProjectId',
    laterOnAI:h.service,resolveProject:async id=>({id:id||null,name:'Inbox'})});
  vm.runInContext(claim,context);
  await assert.rejects(()=>context.claimPendingBatch(null,'ai'),/AI.*not ready/);
  assert.ok(h.session.laterOnPendingBatch,'unavailable AI must not consume the pending save');
  const manual=await context.claimPendingBatch(null,'manual');
  assert.equal(manual.tabs.length,1);
  assert.equal(manual.mode,'manual');
  assert.equal(h.session.laterOnPendingBatch,undefined);
  console.log('PASS AI toggle cancels old tasks and unavailable AI preserves manual picker retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
