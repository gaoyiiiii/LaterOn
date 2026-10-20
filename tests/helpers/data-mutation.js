// Use the real serialized data service behind existing DOM tests' Chrome mocks.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../../data-background.js'), 'utf8');
const background = fs.readFileSync(path.join(__dirname, '../../background.js'), 'utf8');
const start = background.indexOf('async function createProject(');
const create = background.slice(start, background.indexOf('// 体积较大的网页执行代码', start));
module.exports = function install(window) {
  if (window.LaterOnData || !window.chrome) return;
  const context = vm.createContext({ chrome: window.chrome, crypto: webcrypto, Date, Set, Map, URL, usesEnglish: async () => window.document.documentElement.lang === 'en', PROJECTS_KEY: 'laterOnProjects' });
  vm.runInContext(`let queue=Promise.resolve(); function queueItemWrite(task){const next=queue.then(task);queue=next.catch(()=>{});return next;}\n${source}\n${create}\nconst mutateData=createLaterOnData({queueItemWrite,normalizeUrl:url=>url});`, context);
  const original = window.chrome.runtime?.sendMessage;
  window.chrome.runtime ||= {};
  window.chrome.runtime.sendMessage = async function(message, ...args) {
    try {
      if (message.type === 'DATA_MUTATION') return await vm.runInContext('mutateData', context)(message);
      if (message.type === 'CREATE_PROJECT') return await context.createProject(message.name, message.note);
      return original?.call(this, message, ...args);
    } catch (error) { return { ok: false, error: error.message }; }
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../../data-client.js'), 'utf8'));
};
