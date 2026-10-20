// Development-only deterministic service. It never contacts a real AI provider.
const http = require('node:http');
const calls = [];
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  if (req.url === '/article') {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><html><head><title>Browser extension engineering</title><meta name="description" content="Building browser extensions and service workers"></head><body><article><h1>Browser extension engineering</h1>'+Array.from({length:8},()=>'<p>Browser extensions use service workers to handle background messages and local storage. This practical software development guide explains how to design browser extension event handlers, manage saved web pages, and keep user interactions responsive. The implementation validates messages and separates the interface from background storage operations.</p>').join('')+'</article></body></html>');return;
  }
  res.setHeader('Content-Type','application/json');
  if (req.url === '/calls') {res.end(JSON.stringify(calls));return;}
  if (req.url?.startsWith('/fail')) {res.writeHead(500);res.end('{}');return;}
  let data='';for await (const chunk of req) {data+=chunk;if(data.length>1_000_000){res.writeHead(413);res.end('{}');return;}}
  let body;try {body=JSON.parse(data);} catch {res.writeHead(400);res.end('{}');return;}
  calls.push({path:req.url,model:body.model||null});
  if(req.url==='/fetch'){res.end(JSON.stringify({title:'Extension guide',content:'A practical guide to browser extension software development.'}));return;}
  if(req.url==='/extract'){res.end(JSON.stringify({results:[{url:body.urls[0],raw_content:'A practical guide to browser extension software development.'}],failed_results:[]}));return;}
  let keys;
  if(Array.isArray(body.questions)) keys=body.questions[0].choices.map(c=>c.value);
  else if(body.questions) keys=Object.keys(body.questions.route.criteria);
  else {try {keys=Object.keys(JSON.parse(body.messages.at(-1).content).choices);}catch{res.writeHead(400);res.end('{}');return;}}
  const choice=keys.find(k=>k!=='none'), probabilities=Object.fromEntries(keys.map(k=>[k,k===choice?.96:k==='none'?.04:0]));
  const answer={type:'choice',choice,probabilities,confidence:.96};
  const response=Array.isArray(body.questions)?{model:'mock',answers:[{...answer,name:'route',probabilities:keys.map(value=>({value,probability:probabilities[value]}))}]}:
    body.questions?{model:'mock',answers:{route:answer}}:
    req.url?.endsWith('/messages')?{model:'mock',content:[{type:'text',text:JSON.stringify(answer)}],stop_reason:'end_turn'}:
    {model:'mock',choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]};
  res.end(JSON.stringify(response));
});
const port = Number(process.env.LATERON_MOCK_PORT || 9417);
server.listen(port,'127.0.0.1',()=>console.log(`Mock AI service: http://127.0.0.1:${port} (no real model requests)`));
