const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let failed = 0;
for (const name of fs.readdirSync(path.join(__dirname, '../tests')).filter(n => n.endsWith('.test.js'))) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../tests', name)], { stdio: 'inherit', timeout: 60000 });
  if (result.status !== 0) { failed++; console.error('FAILED:', name); }
}
process.exitCode = failed ? 1 : 0;
