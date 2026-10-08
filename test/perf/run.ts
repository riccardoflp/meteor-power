import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Indexing time on a large generated workspace, in a real VS Code: three apps sharing a symlinked folder,
 * plus build output and node_modules that must be skipped. Prints the extension log.
 *
 *   node esbuild.mjs --tests && node out/test/perf/run.js [files per app]
 */
const PER_APP = Number(process.argv[2] ?? 8000);
const APPS = ['admin', 'web', 'mobile'];

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function js(app: string, i: number): string {
  const ns = `${app}${i}`;
  return `import { Meteor } from 'meteor/meteor';
import { ValidatedMethod } from 'meteor/mdg:validated-method';
import { check } from 'meteor/check';
import { NAMES } from '/imports/shared/names';

export const save${i} = new ValidatedMethod({
  name: '${ns}.save',
  validate: null,
  async run({ id, value }) {
    check(id, String);
    return Items.updateAsync(id, { $set: { value } });
  },
});

Meteor.methods({
${Array.from({ length: 6 }, (_, k) => `  async '${ns}.m${k}'(a, b) {\n    const x = await Meteor.callAsync('${app}${(i + 1) % PER_APP}.m${k}', a);\n    return [x, b].filter(Boolean).map((y) => y.toString());\n  },`).join('\n')}
  [NAMES.M${i % 50}]() {},
});

Template.t${ns}.helpers({
${Array.from({ length: 6 }, (_, k) => `  h${k}() {\n    const inst = Template.instance();\n    return inst.data && inst.data.items ? inst.data.items.length + ${k} : 0;\n  },`).join('\n')}
});

Template.t${ns}.events({
  'click .js-save'(e, t) {
    e.preventDefault();
    save${i}.call({ id: t.data._id, value: e.currentTarget.value });
  },
});
`;
}

function html(app: string, i: number): string {
  const ns = `${app}${i}`;
  return `<template name="t${ns}">
  <div class="card">
${Array.from({ length: 12 }, (_, k) => `    <p class="row-${k}">{{h${k % 6}}} {{#if h1}}<span>{{h2}}</span>{{/if}}</p>`).join('\n')}
    {{> t${app}${(i + 1) % PER_APP}}}
    <button class="js-save">Save</button>
  </div>
</template>
`;
}

function generate(root: string) {
  if (fs.existsSync(path.join(root, '.done'))) return;
  fs.rmSync(root, { recursive: true, force: true });
  const shared = path.join(root, 'shared');
  write(path.join(shared, 'names.js'), `export const NAMES = {\n${Array.from({ length: 50 }, (_, k) => `  M${k}: 'shared.m${k}',`).join('\n')}\n};\n`);
  for (let i = 0; i < PER_APP / 4; i++) write(path.join(shared, `lib/mod${i % 40}/f${i}.js`), js('shared', i));
  for (const app of APPS) {
    const dir = path.join(root, app);
    write(path.join(dir, '.meteor/release'), 'METEOR@3.4\n');
    write(path.join(dir, '.meteor/packages'), 'meteor-base\nblaze-html-templates\n');
    for (let i = 0; i < PER_APP; i++) {
      const sub = `imports/ui/m${i % 60}`;
      if (i % 2) write(path.join(dir, sub, `f${i}.html`), html(app, i));
      else write(path.join(dir, sub, `f${i}.js`), js(app, i));
    }
    // a minified vendor bundle in the sources
    write(path.join(dir, 'client/compatibility/vendor.js'), `!function(){${'var a=function(b){return b.call(this)};'.repeat(30000)}}();`);
    // build output and dependencies: excluded
    for (let i = 0; i < 3000; i++) write(path.join(dir, `.meteor/local/build/programs/web.browser/app/f${i}.js`), js(app, i));
    for (let i = 0; i < 3000; i++) write(path.join(dir, `node_modules/pkg${i % 100}/lib/f${i}.js`), js(app, i));
    fs.symlinkSync(shared, path.join(dir, 'imports/shared'), 'junction');
  }
  write(path.join(root, '.done'), '');
}

async function main() {
  const root = path.resolve(__dirname, '../../..');
  const workspace = path.join(os.tmpdir(), `meteor-power-perf-${PER_APP}`);
  const t0 = Date.now();
  generate(workspace);
  console.log(`workspace ready in ${Date.now() - t0} ms: ${workspace}`);
  const userData = path.join(os.tmpdir(), 'meteor-power-perf-user');
  fs.rmSync(userData, { recursive: true, force: true });
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE ?? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'perf', 'suite.js'),
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', userData],
  });
  // the extension log
  const logs = path.join(userData, 'logs');
  const find = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : e.name.includes('Meteor Power') ? [path.join(d, e.name)] : []));
  for (const f of find(logs)) console.log(fs.readFileSync(f, 'utf8'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
