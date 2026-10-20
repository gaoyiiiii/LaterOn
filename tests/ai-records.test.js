const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const host = require('./helpers/ai-host');
const tick = () => new Promise(resolve => setImmediate(resolve));
const tasks = Array.from({length:108}, (_, i) => ({
  id:'t'+i, itemId:'i'+i, title:'Page '+i, status:i % 2 ? 'applied' : 'unmatched',
  reason:i % 2 ? 'matched' : 'unmatched', projectId:i % 2 ? 'p1' : null,
  createdAt:Date.now()+i, completedAt:Date.now()+i,
  extractName:'local', source:'local', classifyName:'My classifier',
  description:'Do not expose saved page content', projects:[{id:'p1',note:'Do not expose project definitions'}],
  answer:{model:'test-model',scoreSource:'llm_estimate',candidates:[
    {projectId:'p1',name:'Development',score:i % 2 ? .96 : .01},
    {projectId:null,name:'',score:i % 2 ? .04 : .99}
  ]}
}));
(async () => {
  const h = await host({laterOnAITasks:tasks,laterOnAICredentials:{token:'private-secret'}});
  const sender = {id:'test',url:'chrome-extension://test/ai-history.html'};
  const before = JSON.stringify(h.local.laterOnAITasks);
  const history = await h.service.message({type:'AI_HISTORY'},sender);
  assert.equal(history.length,108,'history includes records beyond the 100-item settings response');
  assert.equal((await h.send('AI_STATE')).tasks.length,100);
  assert.ok(!JSON.stringify(history).includes('private-secret'));
  assert.ok(history.every(t => !('description' in t) && !('projects' in t)));
  assert.equal(JSON.stringify(h.local.laterOnAITasks),before,'viewing history cannot rewrite stored tasks');
  for (const type of ['AI_STATE','AI_SET_ENABLED','AI_SAVE_CHANNEL']) await assert.rejects(() => h.service.message({type},sender),/forbidden/);
  await assert.rejects(() => h.service.message({type:'AI_HISTORY'},{id:'test',url:'https://example.com/ai-history.html'}),/forbidden/);
  for (const language of ['zh-CN','en']) {
    const dom = new JSDOM('<html><body><div id="records" class="ai-records"></div></body></html>',{runScripts:'outside-only'});
    const w = dom.window, target = w.document.getElementById('records'); w.document.documentElement.lang = language;
    for (const file of ['ai-text.js','ai-records.js']) w.eval(fs.readFileSync(file,'utf8'));
    w.LaterOnAIRecords.render(target,history,{limit:6});
    assert.equal(target.querySelectorAll('details').length,6);
    assert.equal(target.firstChild.dataset.taskId,'t107');
    target.firstChild.open = true;
    w.LaterOnAIRecords.render(target,history,{limit:6});
    assert.equal(target.firstChild.open,true,'live updates preserve open details');
    const unmatched = target.children[1];
    assert.match(unmatched.querySelector('tbody tr').textContent,language === 'en' ? /No suitable project.*99.0%/ : /没有合适的项目.*99.0%/);
    assert.match(target.firstChild.querySelector('.record-outcome').textContent,/Development/);
    assert.equal(target.firstChild.querySelectorAll('table').length,1);
    const renderTask = patch => {
      w.LaterOnAIRecords.render(target,[{...tasks[1],...patch}]);
      return target.querySelector('.record-fields');
    };
    let fields = renderTask({extractName:'研究网页',source:'deepseek-fetch'});
    assert.match(fields.querySelector('.record-route').textContent,/研究网页.*DeepSeek Fetch/);
    assert.equal(fields.querySelectorAll('dt').length,3,'extraction, classifier and explanation are grouped');
    assert.match(fields.querySelectorAll('dd')[1].textContent,/My classifier · test-model/);
    fields = renderTask({extractName:'DeepSeek',source:'local',fallbackFrom:'deepseek-fetch',fallbackReason:'http_500'});
    assert.match(fields.querySelector('.record-route').textContent,/DeepSeek Fetch → /);
    assert.match(fields.querySelector('.record-extraction').textContent,language === 'en' ? /text from the browser/ : /浏览器中的正文/);
    assert.match(fields.querySelector('.record-extraction').textContent,/HTTP 500/);
    assert.doesNotMatch(fields.textContent,language === 'en' ? /Classification request failed/ : /归类请求失败/);
    fields = renderTask({extractName:'研究网页',source:'metadata',warning:'metadataOnly',fallbackFrom:'tavily',fallbackReason:'emptyContent'});
    assert.match(fields.querySelector('.record-route').textContent,/研究网页.*Tavily Extract.*→/);
    assert.match(fields.textContent,language === 'en' ? /No page text was available/ : /未取得网页正文/);
    assert.doesNotMatch(fields.textContent,language === 'en' ? /text from the browser was used/ : /已改用浏览器中的正文/);
    fields = renderTask({extractName:'local',source:'metadata',warning:'metadataOnly'});
    assert.match(fields.querySelector('.record-route').textContent,language === 'en' ? /→ Saved title and description/ : /→ 收藏时保存的标题和描述/);
    fields = renderTask({status:'failed',extractName:'研究网页',source:undefined,answer:undefined,error:'http_500'});
    assert.match(fields.textContent,language === 'en' ? /classification was not run/ : /未进行归类判断/);
    assert.doesNotMatch(fields.textContent,/My classifier/,'do not present an unused classifier as having run');
    fields = renderTask({status:'failed',source:'local',answer:undefined,error:'http_401'});
    assert.match(fields.textContent,language === 'en' ? /Classification request failed/ : /归类请求失败/);
    assert.doesNotMatch(fields.textContent,language === 'en' ? /Extraction failed/ : /提取失败/);
    fields = renderTask({extractName:'<img src=x onerror=alert(1)>',source:'local',fallbackFrom:'tavily',fallbackReason:'http_500'});
    assert.equal(fields.querySelector('img'),null,'channel names are rendered as text');
    fields = renderTask({source:undefined,answer:undefined,status:'queued'});
    assert.match(fields.textContent,language === 'en' ? /Not started/ : /尚未开始/);
    w.LaterOnAIRecords.render(target,[{...tasks[0],title:'<img src=x onerror=alert(1)>',status:'interrupted',error:'contextChanged'}]);
    assert.equal(target.querySelector('img'),null);
    assert.match(target.textContent,language === 'en' ? /not applied/ : /没有应用/);
    w.LaterOnAIRecords.render(target,[]);
    assert.equal(target.querySelectorAll('details').length,0);
    dom.window.close();
  }
  const page = new JSDOM(fs.readFileSync('ai-history.html','utf8'),{runScripts:'outside-only',url:sender.url});
  page.window.LaterOnI18n = {getLanguage:async()=>{},applyStatic(){}};
  page.window.chrome = {runtime:{sendMessage:async msg => ({ok:true,data:await h.service.message(msg,sender)})},storage:{onChanged:{addListener(){}}}};
  for (const file of ['ai-text.js','ai-records.js','ai-history.js']) page.window.eval(fs.readFileSync(file,'utf8'));
  for (let i=0;i<20 && page.window.document.querySelectorAll('.ai-record').length!==108;i++) await tick();
  assert.equal(page.window.document.querySelectorAll('.ai-record').length,108);
  assert.equal(page.window.document.getElementById('historyBack').getAttribute('href'),'models.html#recentSection');
  page.window.close();
  const cards = new JSDOM('<button id="openModels"></button><article data-id="i1"><p class="description">Summary</p></article>',{runScripts:'outside-only'});
  let navigated = '';
  cards.window.LaterOnAIUI = {apply(){}};
  cards.window.LaterOnI18n = {getLanguage:async()=>{}};
  cards.window.chrome = {runtime:{getURL:p=>'chrome-extension://test/'+p},tabs:{getCurrent:async()=>({id:1}),update:async(id,{url})=>{navigated=url;}}};
  cards.window.eval(fs.readFileSync('ai-status.js','utf8')); await tick();
  assert.equal(cards.window.document.querySelector('.ai-item-status'),null);
  assert.equal(cards.window.document.querySelector('article').textContent,'Summary');
  cards.window.document.getElementById('openModels').click(); await tick();
  assert.equal(navigated,'chrome-extension://test/models.html');
  cards.window.close();
  console.log('PASS record presentation, full read-only history, bilingual scores including none, and minimal cards');
})().catch(error => {console.error(error);process.exitCode=1;});
