'use strict';
/**
 * Lightweight TypeScript loader using esbuild transformSync.
 * Replaces tsx at runtime to cut V8 heap waste:
 *   - No inline source-map data URIs (was 2.7 MB / 243 copies)
 *   - Minimal CJS interop polyfill vs tsx's bloated wrapper (was 2.9 MB / 619 copies)
 *   - Compiled JS is smaller than original TS source retained by tsx (was 10.9 MB / 246 copies)
 *
 * Path aliases (@utils/*, etc.) are resolved by tsconfig-paths/register,
 * which must be loaded via -r BEFORE this module.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// Register ESM loader for dynamic import() with path aliases and .ts files
register(pathToFileURL(path.join(__dirname, 'esbuild-esm-loader.mjs')).href);

// Read target from tsconfig.json once at startup
let target = 'es2020';
try {
  const tsconfig = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'tsconfig.json'), 'utf8')
  );
  if (tsconfig.compilerOptions && tsconfig.compilerOptions.target) {
    target = tsconfig.compilerOptions.target;
  }
} catch {
  // fall back to es2020
}

/**
 * Compile a .ts (or .tsx) file with esbuild and hand the JS to Node's module system.
 * module._compile keeps the compiled JS string for stack traces, but that JS is
 * far smaller than tsx's output (no source map, no heavy polyfill).
 */
function compileTS(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const ext = path.extname(filename);
  const result = esbuild.transformSync(source, {
    loader: ext === '.tsx' ? 'tsx' : 'ts',
    target: target,
    format: 'cjs',
    sourcemap: false,
    sourcefile: filename,
  });
  module._compile(result.code, filename);
}

require.extensions['.ts'] = compileTS;
require.extensions['.tsx'] = compileTS;
