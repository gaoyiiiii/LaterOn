const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.dirname(require.resolve('@mozilla/readability/package.json'));
fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
for (const name of ['Readability.js', 'LICENSE.md']) {
  fs.copyFileSync(path.join(source, name), path.join(root, 'vendor', name));
}
