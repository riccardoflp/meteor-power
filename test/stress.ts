// Parses every file of a folder like the indexer does and reports the slowest ones:
// `node esbuild.mjs --tests && node out/test/stress.js <folder>`
import * as fs from 'fs';
import * as path from 'path';
import { parseHtml } from '../src/core/htmlParser';
import { MeteorIndex } from '../src/core/index';
import { parseJs } from '../src/core/jsParser';
import { problems } from '../src/core/queries';

const SUPPORTED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|html)$/i;
const MAX_SIZE = 1_500_000;

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (SUPPORTED.test(e.name)) yield p;
  }
}

const root = process.argv[2] ?? '.';
const index = new MeteorIndex();
const times: { file: string; ms: number; size: number }[] = [];
let bytes = 0;
const t0 = Date.now();
for (const file of walk(root)) {
  const size = fs.statSync(file).size;
  if (size > MAX_SIZE) continue;
  const text = fs.readFileSync(file, 'utf8');
  bytes += size;
  const s = performance.now();
  const facts = file.toLowerCase().endsWith('.html') ? parseHtml(file, text) : parseJs(file, text);
  times.push({ file, ms: performance.now() - s, size });
  if (facts) index.update(facts);
}
const t1 = Date.now();
void index.a;
const t2 = Date.now();
let count = 0;
for (const f of index.allFacts()) count += problems(index, f.file, { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] }).length;
const t3 = Date.now();
console.log(`diagnostics: ${count} problems in ${t3 - t2} ms`);
times.sort((a, b) => b.ms - a.ms);
console.log(`${times.length} files, ${(bytes / 1e6).toFixed(1)} MB: parse ${t1 - t0} ms, aggregation ${t2 - t1} ms`);
for (const t of times.slice(0, 15)) console.log(`  ${t.ms.toFixed(0).padStart(7)} ms  ${(t.size / 1000).toFixed(0).padStart(5)} KB  ${path.relative(root, t.file)}`);
