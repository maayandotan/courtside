// Syntax-checks every JS file, including the renderer's inline <script>,
// without needing Electron installed. Run with `npm run check`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['src/main.js', 'src/preload.js', 'src/lib/skip-heuristics.js', 'src/lib/names.js'];
for (const f of files) execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'inherit' });

const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/);
if (!script) throw new Error('no inline <script> found in src/renderer/index.html');
const tmp = path.join(os.tmpdir(), 'courtside-renderer-check.js');
fs.writeFileSync(tmp, script[1]);
execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
console.log(`syntax OK (${files.length + 1} scripts)`);
