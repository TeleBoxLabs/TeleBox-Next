'use strict';
// Smoke: require() every plugin/src module through the real runtime chain
// (mtcute-esm-resolve → tsconfig-paths → esbuild-register) and confirm
// zero @mtcute CJS bundles are loaded.
const path = require('node:path');
const fs = require('node:fs');

require('./mtcute-esm-resolve.cjs');
require('tsconfig-paths/register');
require('./esbuild-register.cjs');

const files = [];
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.ts$/.test(f)) files.push(p);
  }
}
walk(path.join(__dirname, '..', 'plugins'));
walk(path.join(__dirname, '..', 'src', 'plugin'));
walk(path.join(__dirname, '..', 'src', 'utils'));
walk(path.join(__dirname, '..', 'src', 'hook'));

let ok = 0, skip = 0;
const fail = [];
for (const f of files) {
  try {
    require(f);
    ok++;
  } catch (e) {
    const s = String((e && e.message) || e);
    if (s.includes('Cannot find module')) skip++;
    else fail.push(f + ': ' + s.slice(0, 110));
  }
}
console.log('required OK:', ok, '| skipped (missing optional deps):', skip, '| failed:', fail.length);
fail.slice(0, 12).forEach((x) => console.log('  FAIL', x));

const cjsLoaded = Object.keys(require.cache).filter((id) => id.includes('@mtcute') && id.endsWith('.cjs'));
console.log('@mtcute .cjs in CJS cache:', cjsLoaded.length, cjsLoaded.slice(0, 3));
