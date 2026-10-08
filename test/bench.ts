// Rough indexing benchmark on a synthetic project: `node esbuild.mjs --tests && node out/test/bench.js`
import { parseHtml } from '../src/core/htmlParser';
import { MeteorIndex } from '../src/core/index';
import { parseJs } from '../src/core/jsParser';

const N = 2000;
const range = (n: number) => Array.from({ length: n }, (_, k) => k);

const js = (i: number) =>
  `import { Meteor } from 'meteor/meteor';
Meteor.methods({
${range(10).map((k) => `  async 'mod${i}.m${k}'(a, b) { await Meteor.callAsync('mod${(i + 1) % N}.m${k}', a); return a + b; },`).join('\n')}
});
Template.t${i}.helpers({
${range(8).map((k) => `  h${k}() { return ${k}; },`).join('\n')}
});
`.repeat(3);

const html = (i: number) =>
  `<template name="t${i}">
${range(30).map((k) => `  <div class="a b">{{h${k % 8}}} {{> t${(i + 1) % N}}} {{#each x in h1}}{{x.y}}{{/each}}</div>`).join('\n')}
</template>`;

const index = new MeteorIndex();
let bytes = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const a = js(i);
  const b = html(i);
  bytes += a.length + b.length;
  index.update(parseJs(`f${i}.js`, a)!);
  index.update(parseHtml(`f${i}.html`, b));
}
const t1 = Date.now();
const agg = index.a;
const t2 = Date.now();
index.update(parseJs('f5.js', js(5))!);
const t3 = Date.now();
void index.a;
const t4 = Date.now();

console.log(`${N * 2} file, ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`  full parse:         ${t1 - t0} ms`);
console.log(`  aggregation:        ${t2 - t1} ms (${agg.methods.size} methods, ${agg.templateNames.size} templates)`);
console.log(`  edit 1 file:        ${t3 - t2} ms parse + ${t4 - t3} ms re-aggregation`);
