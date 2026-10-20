const assert=require('node:assert/strict');
const A=require('../ai-core.js');
const projects=[{id:'a',name:'Development',note:'Browser extension engineering'},{id:'b',name:'Travel',note:'Trip planning'}];
const page=A.pageInput({title:'Extension guide',url:'https://example.com/article',description:'Guide'},'Content','local');
const answer={choice:'project_0',probabilities:{project_0:.93,project_1:.03,none:.04}};
const option=A.choices(projects);
function mockResponse(provider,body) {
  if(provider==='deepseek-fetch') return {title:'Page',content:'Extracted content'};
  if(provider==='tavily') return {results:[{url:body.urls[0],raw_content:'Extracted content'}],failed_results:[]};
  if(['jev','openrouter-jev'].includes(provider)) return {model:'test',answers:{route:{type:'choice',...answer}}};
  if(provider==='decisions') return {model:'test',answers:[{type:'choice',name:'route',choice:answer.choice,probabilities:Object.entries(answer.probabilities).map(([value,probability])=>({value,probability}))}]};
  if(provider==='anthropic') return {model:'test',content:[{type:'text',text:JSON.stringify(answer)}],stop_reason:'end_turn'};
  return {model:'test',choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]};
}
(async()=>{
  assert.equal(A.cleanUrl('https://u:p@a.com/p?token=secret&q=cat#x'),'https://a.com/p?q=cat');
  for(const url of ['http://localhost/x','http://127.1/x','http://192.168.0.1','http://10.0.0.1','http://[::1]','http://foo.local','file:///x']) assert.equal(A.publicUrl(url),false,url);
  assert.equal(A.publicUrl('https://example.com/article'),true);
  assert.throws(()=>A.channel({provider:'custom',endpoint:'https://a.com?key=x',name:'a',model:'m',protocol:'openai'}));
  for(const bad of [{...answer,choice:'unknown'},{...answer,probabilities:{project_0:1}},{...answer,probabilities:{project_0:.2,project_1:.8,none:0}},{...answer,probabilities:{project_0:NaN,project_1:0,none:0}}]) assert.throws(()=>A.validateAnswer(bad,option,'m','llm_estimate'));
  const result=A.validateAnswer(answer,option,'m','llm_estimate');
  assert.equal(A.decide(result,{minScore:.85,minMargin:.15}).projectId,'a');
  assert.equal(A.decide(result,{minScore:.99,minMargin:.15}).reason,'lowScore');
  assert.equal(A.decide(result,{minScore:.5,minMargin:.99}).reason,'lowMargin');
  let combinations=0;
  for(const extraction of ['local','deepseek-fetch','tavily']) {
    for(const provider of ['openai','anthropic','jev','openrouter-jev','decisions']) {
      const calls=[];
      const classifier=A.channel({...A.presets[provider],provider,name:'Test',model:A.presets[provider].model||'test'});
      const fetcher=async(url,opts)=>{const body=JSON.parse(opts.body); calls.push({url,opts,body}); const kind=url.includes('/extract')?'tavily':url.includes('/fetch')?'deepseek-fetch':provider;return new Response(JSON.stringify(mockResponse(kind,body)));};
      let input=page;
      if(extraction!=='local') input=await A.extractRemote(A.channel({...A.presets[extraction],provider:extraction,name:'Extract'}),'key',page,undefined,fetcher);
      const classified=await A.classify(classifier,'key',input,projects,undefined,fetcher);
      assert.equal(classified.choice,'a');
      const wire=calls.at(-1); assert.equal(wire.opts.credentials,'omit'); assert.equal(wire.opts.redirect,'error');
      if(provider==='decisions') {assert.ok(Array.isArray(wire.body.questions));assert.equal(typeof wire.body.input,'string');}
      if(provider==='jev'||provider==='openrouter-jev') assert.equal(wire.body.questions.route.type,'choice');
      if(provider==='anthropic') assert.equal(wire.opts.headers['x-api-key'],'key');
      if(extraction==='tavily') {assert.equal(calls[0].body.query,undefined);assert.equal(calls[0].body.include_images,false);}
      combinations++;
    }
  }
  let count=0;
  await assert.rejects(()=>A.classify(A.channel({...A.presets.openai,provider:'openai',name:'x',model:'m'}),'key',page,projects,undefined,async()=>{count++;return new Response('',{status:500});}),/http_500/);
  assert.equal(count,1,'classification must not retry');
  await assert.rejects(()=>A.extractRemote(A.channel({...A.presets.tavily,provider:'tavily',name:'x'}),'key',page,undefined,async()=>new Response(JSON.stringify({results:[],failed_results:[{url:page.url,error:'bad'}]}))),/extractionFailed/);
  const truncated=A.pageInput(page,'x'.repeat(15000));assert.equal(truncated.content.length,12000);assert.equal(truncated.truncated,true);
  console.log(`PASS AI adapters, validation and ${combinations} extractor/classifier combinations`);
})().catch(e=>{console.error(e);process.exitCode=1;});
