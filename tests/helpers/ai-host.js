const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
module.exports = async function host(initial = {}, fetcher, initialSession = {}) {
  const listeners = [], calls = [], alarms = new Map();
  const local = { laterOnSettings: { aiEnabled: true }, laterOnProjects: [{ id: 'p1', name: 'Development', note: 'Browser extensions and software engineering' }], laterOnItems: [], ...structuredClone(initial) };
  const session = structuredClone(initialSession), extractions = [];
  const area = (data, name) => ({
    async get(keys) { if (keys === null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(patch) { const changes={}; for (const [k,v] of Object.entries(patch)) { changes[k]={oldValue:structuredClone(data[k]),newValue:structuredClone(v)};data[k]=structuredClone(v); } for (const fn of listeners) fn(changes,name); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
    async setAccessLevel(options) { data.__access = options.accessLevel; }
  });
  const chrome = {
    runtime: { id:'test', getURL:p=>`chrome-extension://test/${p}` },
    storage: { local:area(local,'local'), session:area(session,'session'), onChanged:{ addListener:fn=>listeners.push(fn) } },
    alarms: { create:async(name,value)=>alarms.set(name,value), clear:async name=>alarms.delete(name), onAlarm:{addListener(){}} },
    tabs: { get:async id=>({id,url:'https://example.com/article'}) },
    scripting: { executeScript:async options=>{extractions.push(options);return [{ result:{url:'https://example.com/article', content:'Browser extension engineering',source:'local'} }];} }
  };
  const context=vm.createContext({chrome, crypto:webcrypto, URL, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout, console,
    fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return fetcher?fetcher(url,options):chatResponse(options);} });
  for(const file of ['ai-core.js','ai-background.js','data-background.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'../..',file),'utf8'),context);
  vm.runInContext('let queue=Promise.resolve(); function queueItemWrite(fn){const p=queue.then(fn);queue=p.catch(()=>{});return p;} globalThis.service=createLaterOnAI({queueItemWrite}); globalThis.data=createLaterOnData({queueItemWrite,normalizeUrl:x=>x});',context);
  await context.service.init;
  const sender={id:'test',url:'chrome-extension://test/models.html'};
  async function send(type, data={}) {return context.service.message({type,...data},sender);}
  async function configure(provider='custom', kind='classify') {
    const preset=context.LaterOnAI.presets[provider];
    const channel={provider,name:'Test '+provider,endpoint:preset.endpoint || 'http://localhost:9000/v1',protocol:preset.protocol || 'openai',model:preset.model || 'test-model',kind};
    const tested=await send('AI_TEST_CHANNEL',{channel,key:provider==='custom'?'':'secret'});
    return send('AI_SAVE_CHANNEL',{channel,key:provider==='custom'?'':'secret',token:tested.token});
  }
  async function settle() {
    for(let n=0;n<200;n++) {
      await new Promise(r=>setTimeout(r,5));
      if((local.laterOnAITasks||[]).every(t=>['applied','failed','unmatched','interrupted'].includes(t.status))) return;
    }
    throw new Error('Tasks did not settle');
  }
  return {local,session,chrome,calls,extractions,send,configure,settle,service:context.service,data:context.data,context};
};
function chatResponse(options) {
  const body=JSON.parse(options.body), keys=Object.keys(JSON.parse(body.messages.at(-1).content).choices);
  const probabilities=Object.fromEntries(keys.map(k=>[k,k==='project_0'?.95:k==='none'?.05:0]));
  return new Response(JSON.stringify({model:'test',choices:[{message:{content:JSON.stringify({choice:'project_0',probabilities})},finish_reason:'stop'}]}));
}
module.exports.chatResponse=chatResponse;
