'use strict';
/**
 * Route require('@mtcute/*') to the ESM builds (Node >= 22 require(esm)).
 *
 * Why: @mtcute 0.32+ deprecated their CJS bundles — index.cjs prints a
 * deprecation warning on every boot and will be removed in an upcoming
 * release. TeleBox-Next stays CJS ("type":"commonjs") because the plugin
 * hot-reload machinery depends on require.cache invalidation, which pure
 * ESM cannot do. Node's require(esm) bridges the gap: our CJS modules
 * require() the mtcute ESM entry points and get the module namespace
 * (named exports work, no default imports exist in this codebase).
 *
 * How: patch Module._resolveFilename so specifier resolution for
 * '@mtcute/*' from PROJECT files (not from inside node_modules) uses the
 * ESM "import" condition set. Internal mtcute cross-imports are ESM
 * already, so there is a single ESM module registry for @mtcute (verified:
 * zero .cjs files enter require.cache).
 *
 * Node < 22 has no require(esm): leave resolution untouched there (CJS
 * bundles still shipped, only deprecated).
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  // Older Node: keep legacy CJS resolution; nothing to do.
} else {
  const origResolve = Module._resolveFilename;
  const PROJECT_ROOT = path.join(__dirname, '..');
  const ESM_CONDITIONS = () => new Set(['node', 'import', 'default']);

  Module._resolveFilename = function (request, parent, isMain, options) {
    if (
      request.startsWith('@mtcute/') &&
      parent &&
      typeof parent.filename === 'string' &&
      !parent.filename.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      try {
        return origResolve.call(this, request, parent, isMain, {
          ...(options || {}),
          conditions: ESM_CONDITIONS(),
        });
      } catch {
        // ESM condition resolution failed (e.g. subpath without "import"
        // export) — fall through to default resolution.
      }
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  // Belt & braces: if some loader resolved a @mtcute CJS bundle anyway
  // (e.g. tsconfig-paths cache), we do nothing — the hook above covers
  // the standard paths used by this codebase.
}
