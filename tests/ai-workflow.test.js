const assert=require('node:assert/strict');
const host=require('./helpers/ai-host');
const item={id:'i1',title:'Guide',url:'https://example.com/article',description:'Browser extensions',projectId:null};
(async()=>{
  const h=await host();
  assert.equal(h.local.__access,'TRUSTED_CONTEXTS');
  assert.equal(await h.service.ready(),false);
  await assert.rejects(()=>h.service.message({type:'AI_STATE'},{id:'test',url:'https://evil.example'}),/forbidden/);
  const c=await h.configure();
  assert.equal(await h.service.ready(),false,'saving a channel must not enable it');
  await h.send('AI_ACTIVATE',{extractId:'local',classifyId:c.id,fallback:true});
  assert.equal(await h.service.ready(),true);
  assert.ok(!JSON.stringify(await h.send('AI_STATE')).includes('secret'));
  await h.chrome.storage.local.set({laterOnItems:[item]});
  await h.service.enqueue(item,{id:1,url:item.url}); await h.settle();
  assert.equal(h.local.laterOnItems[0].projectId,'p1');
  assert.equal(h.local.laterOnItems[0].description,item.description);
  assert.equal(h.local.laterOnAITasks[0].status,'applied');
  assert.ok(!Object.keys(h.session).some(k=>k.startsWith('laterOnAIPage:')));
  const calls=h.calls.length; await h.service.enqueue(item,{id:1,url:item.url});await h.settle();assert.equal(h.calls.length,calls);
  await h.send('AI_SET_ENABLED',{enabled:false});assert.equal(await h.service.ready(),false);
  await h.chrome.storage.local.set({laterOnProjects:[{id:'p1',name:'Dev'}]});
  await assert.rejects(()=>h.send('AI_SET_ENABLED',{enabled:true}),/missingNotes/);
  assert.equal(h.local.laterOnSettings.aiEnabled,false);
  await h.chrome.storage.local.set({laterOnProjects:[{id:'p1',name:'Imported',note:{text:'not a description'}}]});
  await assert.rejects(()=>h.send('AI_SET_ENABLED',{enabled:true}),/missingNotes/);
  assert.equal((await h.send('AI_STATE')).missing.length,1,'malformed imported notes cannot enable AI');
  // Test receipt cannot be reused with a different endpoint or key.
  const j=await host(); const raw={name:'custom',provider:'custom',endpoint:'http://localhost:9000/v1',protocol:'openai',model:'m'};
  const receipt=await j.send('AI_TEST_CHANNEL',{channel:raw,key:'one'});
  await assert.rejects(()=>j.send('AI_SAVE_CHANNEL',{channel:raw,key:'two',token:receipt.token}),/testRequired/);
  // A failed default classifier never falls through to another configured channel.
  let fail=false;
  const f=await host({},async(url,options)=> fail?new Response('',{status:500}):host.chatResponse(options));
  const first=await f.configure(), second=await f.configure();
  await f.send('AI_ACTIVATE',{extractId:'local',classifyId:first.id}); fail=true;
  await f.chrome.storage.local.set({laterOnItems:[item]});
  const before=f.calls.length;await f.service.enqueue(item,{id:1,url:item.url});await f.settle();
  assert.equal(f.calls.length,before+1);assert.equal(f.local.laterOnAITasks[0].status,'failed');assert.equal(f.local.laterOnItems[0].projectId,null);
  assert.notEqual(first.id,second.id);
  // User moving to Inbox while a decision is in flight invalidates the late result.
  let hold=false, release;
  const r=await host({},async(url,options)=>{if(hold) await new Promise(resolve=>{release=resolve;});return host.chatResponse(options);});
  const rc=await r.configure();await r.send('AI_ACTIVATE',{extractId:'local',classifyId:rc.id});hold=true;
  await r.chrome.storage.local.set({laterOnItems:[item]});await r.service.enqueue(item,{id:1,url:item.url});
  while(!release) await new Promise(resolve=>setTimeout(resolve,5));
  await r.chrome.storage.local.set({laterOnItems:[{...item,projectRevision:1}]});release();await r.settle();
  assert.equal(r.local.laterOnItems[0].projectId,null);assert.equal(r.local.laterOnAITasks[0].status,'interrupted');
  // Wipe and project deletion run through the same queue, without resurrecting rows.
  await r.data({operation:'wipe'});assert.deepEqual(r.local.laterOnItems,[]);
  // Interrupted paid decision cannot be repeated on worker recovery.
  const oldTask={id:'old',itemId:'i1',status:'classifying',sessionId:'previous-browser',createdAt:Date.now()};
  const recovered=await host({laterOnAITasks:[oldTask]}); assert.equal(recovered.local.laterOnAITasks[0].status,'interrupted');assert.equal(recovered.calls.length,0);
  // Remote extraction failure may fall back locally; classification itself has no fallback.
  for (const fallback of [true,false]) {
    let remoteFail=false;
    const x=await host({},async(url,options)=>url.endsWith('/fetch')
      ? remoteFail ? new Response('',{status:401}) : new Response(JSON.stringify({title:'Page',content:'Browser extension content'}))
      : host.chatResponse(options));
    const ec=await x.configure('deepseek-fetch','extract'), cc=await x.configure();
    await x.send('AI_ACTIVATE',{extractId:ec.id,classifyId:cc.id,fallback});
    remoteFail=true;await x.chrome.storage.local.set({laterOnItems:[item]});const before=x.calls.length;
    await x.service.enqueue(item,{id:1,url:item.url});await x.settle();
    assert.equal(x.local.laterOnAITasks[0].status,fallback?'applied':'failed');
    assert.equal(x.calls.length-before,fallback?2:1);
    if(fallback) assert.equal(x.local.laterOnAITasks[0].fallbackFrom,'deepseek-fetch');
    // Saving an edited channel does not mutate the active configuration snapshot.
    const edited={...cc,model:'replacement'};
    const receipt=await x.send('AI_TEST_CHANNEL',{channel:edited});
    await x.send('AI_SAVE_CHANNEL',{channel:edited,token:receipt.token});
    assert.equal(x.local.laterOnAIConfig.active.classifier.model,cc.model);
    await x.send('AI_DELETE_CHANNEL',{id:cc.id});assert.equal(await x.service.ready(),false);
    assert.equal(x.local.laterOnAIConfig.classifyId,'');
  }
  console.log('PASS AI configuration, task lifecycle, privacy and concurrent user changes');
})().catch(e=>{console.error(e);process.exitCode=1;});
