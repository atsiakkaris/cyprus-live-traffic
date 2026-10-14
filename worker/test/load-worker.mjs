// Loads worker/worker.js for tests without changing it.
//
// The Worker only has a default export. Adding named exports "for tests"
// would change what actually gets deployed, and whether Cloudflare's build
// accepts them can't be checked without deploying. So this reads the source,
// appends an `export { ... }` of every top-level function/const/let, and
// imports the result from a data: URL. The file on disk — and so what ships —
// stays exactly as written.
//
// Relies on worker.js declaring its top-level names at column 0 and having no
// `import` statements (a data: module cannot resolve relative specifiers);
// both are checked below so a future change fails loudly, not subtly.
import { readFile } from 'node:fs/promises';

const WORKER_URL = new URL('../worker.js', import.meta.url);

export function topLevelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
  return [...names];
}

let counter = 0;

// `fresh: true` appends a unique comment so the import is a brand-new module
// instance (own module-level state) instead of the cached one.
export async function loadWorker({ fresh = false } = {}) {
  const src = await readFile(WORKER_URL, 'utf8');
  if (/^import\s/m.test(src)) {
    throw new Error('worker.js now has import statements; load-worker.mjs cannot handle that');
  }
  const names = topLevelNames(src);
  if (names.length < 20) {
    throw new Error(`only found ${names.length} top-level names in worker.js; the loader's pattern no longer matches`);
  }
  const nonce = fresh ? `\n// fresh-${++counter}-${Math.random()}` : '';
  const full = `${src}\nexport { ${names.join(', ')} };${nonce}\n`;
  return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(full));
}
