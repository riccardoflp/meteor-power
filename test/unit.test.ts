import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseJs } from '../src/core/jsParser';
import { parseHtml } from '../src/core/htmlParser';
import { MeteorIndex } from '../src/core/index';
import { definitions, enclosingTemplate, hasConflict, helperOwner, problems, references, targetAt, Target, templateUsages } from '../src/core/queries';
import { Loc, Pos } from '../src/core/model';
import { globToRegExp, LineMap, wildcardMatch } from '../src/core/text';
import { renameEdits, renameInfo, TextEdit } from '../src/core/rename';
import { isMinified, parseFile } from '../src/core/parseFile';
import { PathFilter, togglePath } from '../src/core/pathFilter';
import { AppLayout, AppRoot, normPath, PackageRoot, parseMeteorPackages, parsePackageJs } from '../src/core/apps';

const ROOT = path.resolve(__dirname, '../../test/fixtures/app');

// same defaults as the extension (package.json) and the fixture's .vscode/settings.json
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const slash = (p: string) => p.replace(/\\/g, '/');
// the fixture is a Meteor app: its public/ and private/ are excluded by convention
const FILTER = new PathFilter(manifest.contributes.configuration.properties['meteorPower.exclude'].default, [slash(ROOT)]);
const excluded = (file: string) => FILTER.excluded(slash(file), slash(path.relative(ROOT, file)));
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.vscode', 'settings.json'), 'utf8'));
const OPTIONS = {
  methodDefiners: settings['meteorPower.methods.defineFunctions'],
  methodCallers: settings['meteorPower.methods.callFunctions'],
  publicationDefiners: settings['meteorPower.publications.defineFunctions'],
  subscribeCallers: settings['meteorPower.publications.subscribeFunctions'],
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return []; // links created by the integration run
    return e.isDirectory() ? walk(p) : [p];
  });
}

const index = new MeteorIndex();
const sources = new Map<string, string>();
for (const file of walk(ROOT)) {
  if (excluded(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  sources.set(file, text);
  const facts = file.endsWith('.html') ? parseHtml(file, text) : /\.(js|ts)$/.test(file) ? parseJs(file, text, OPTIONS) : undefined;
  if (facts) index.update(facts);
}

const F = (rel: string) => path.join(ROOT, rel);

/** Position of the `nth` occurrence of `needle` in a fixture file, shifted by `delta` characters. */
function posOf(rel: string, needle: string, delta = 1, nth = 0): Pos {
  const text = fs.readFileSync(F(rel), 'utf8');
  let at = -1;
  for (let i = 0; i <= nth; i++) {
    at = text.indexOf(needle, at + 1);
    assert.ok(at >= 0, `"${needle}" not found in ${rel}`);
  }
  return new LineMap(text).pos(at + delta);
}

function at(rel: string, needle: string, delta = 1, nth = 0): Target {
  const t = targetAt(index, F(rel), posOf(rel, needle, delta, nth));
  assert.ok(t, `no target at "${needle}" in ${rel}`);
  return t!;
}

function textAt(loc: Loc): string {
  const text = fs.readFileSync(loc.file, 'utf8');
  const lm = text.split(/\r?\n/);
  return lm[loc.range.start.line].slice(loc.range.start.character, loc.range.start.line === loc.range.end.line ? loc.range.end.character : undefined);
}

function where(locs: { file: string }[]) {
  return locs.map((l) => path.relative(ROOT, l.file).replace(/\\/g, '/')).sort();
}

test('indexes methods with literal, constant, nested-constant and ValidatedMethod names', () => {
  const names = [...index.a.methods.keys()].sort();
  assert.deepEqual(names, [
    'orders.archive',
    'orders.cancel',
    'orders.create',
    'orders.restore',
    'orders.ship',
    'ping',
    'shared.ping',
    'tasks.insert', 'tasks.serverOnly', 'tasks.toggle', 'users.profile.save', 'users.remove', 'users.reset', 'users.update']);
  assert.equal(index.a.methods.get('tasks.serverOnly')![0].env, 'server');
  assert.equal(index.a.methods.get('tasks.insert')![0].kind, 'validated');
  const update = index.a.methods.get('users.update')![0];
  assert.deepEqual(update.params, ['userId', 'data']);
  assert.equal(update.isAsync, true);
  assert.match(update.doc!, /Updates the user profile/);
  assert.deepEqual(index.a.methods.get('users.reset')![0].params, ['id', '{ force = false } = {}']);
});

test('indexes publications (string, object form, constant key) and skips null publications', () => {
  assert.deepEqual([...index.a.publications.keys()].sort(), ['orders.mine', 'shared.items', 'users.list', 'users.one']);
  assert.deepEqual([...index.a.subscriptions.keys()].sort(), ['orders.mine', 'shared.items', 'users.list', 'users.unknownPub']);
});

test('Ctrl+click on a Meteor.callAsync string goes to the method definition', () => {
  const t = at('client/legacy/logic/userCard.js', "'users.update'", 3);
  assert.equal(t.type, 'method');
  const defs = definitions(index, t);
  assert.equal(defs.length, 1);
  assert.deepEqual(where(defs.map((d) => d.loc)), ['imports/api/users/methods.js']);
  assert.equal(textAt(defs[0].loc), 'users.update');
});

test('constant references resolve across files, including namespace imports', () => {
  const t = at('imports/ui/layouts/layout.ts', 'C.USERS_METHODS.RESET', 5);
  assert.deepEqual(t.type === 'method' && t.name, 'users.reset');
  const defs = definitions(index, t);
  assert.equal(textAt(defs[0].loc), 'USERS_METHODS.RESET');

  const tpl = at('imports/ui/layouts/layout.ts', '`users.profile.save`', 2);
  assert.equal(tpl.type === 'method' && tpl.name, 'users.profile.save');
});

test('on a definition, go-to-definition returns itself and references list every call', () => {
  const t = at('imports/api/users/methods.js', 'USERS_METHODS.RESET]', 2);
  assert.equal(t.type === 'method' && t.isDef, true);
  assert.deepEqual(definitions(index, t)[0].loc, t.loc);
  // client/orders.js calls it twice: through an import alias (UM.RESET) and a destructured constant (RESET)
  assert.deepEqual(where(references(index, t, false)), ['client/orders.js', 'client/orders.js', 'imports/api/users/methods.js', 'imports/ui/layouts/layout.ts']);
});

test('subscribe → publication', () => {
  const t = at('client/legacy/logic/userCard.js', "'users.list'", 2);
  assert.equal(t.type, 'publication');
  assert.deepEqual(where(definitions(index, t).map((d) => d.loc)), ['server/publications.js']);
});

test('diagnostics flag unknown methods, publications and templates only', () => {
  const js = problems(index, F('client/legacy/logic/userCard.js'), { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] });
  assert.deepEqual(js.map((p) => p.code).sort(), ['unknown-method', 'unknown-publication']);
  const html = problems(index, F('imports/ui/components/userCard.html'), { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] });
  assert.deepEqual(html.map((p) => p.message), ["Template 'missingTemplate' is not defined in the workspace."]);
  const ignored = problems(index, F('client/legacy/logic/userCard.js'), { ignoreMethods: ['users.*'], ignorePublications: ['users.unknownPub'], ignoreTemplates: [] });
  assert.equal(ignored.length, 0);
});

test('Blaze: template helper in HTML → helper in a JS file elsewhere', () => {
  const t = at('imports/ui/components/userCard.html', '{{fullName}}', 3);
  assert.deepEqual(t, { ...t, type: 'helper', name: 'fullName', template: 'userCard' });
  const defs = definitions(index, t);
  assert.deepEqual(where(defs.map((d) => d.loc)), ['client/legacy/logic/userCard.js']);
  assert.equal(textAt(defs[0].loc), 'fullName');
});

test('Blaze: global helpers, locals, data context fields, block helpers', () => {
  const fmt = at('imports/ui/components/userCard.html', 'formatDate', 1);
  assert.deepEqual(where(definitions(index, fmt).map((d) => d.loc)), ['client/helpers.js']);

  const empty = at('imports/ui/components/userCard.html', 'emptyText', 1);
  assert.deepEqual(where(definitions(index, empty).map((d) => d.loc)), ['client/helpers.js']);

  // `item` is a local of {{#each item in items}}
  assert.equal(targetAt(index, F('imports/ui/components/userCard.html'), posOf('imports/ui/components/userCard.html', '{{item.name}}', 3)), undefined);
  // `items` is a helper
  assert.equal(at('imports/ui/components/userCard.html', 'in items', 4).type, 'helper');
  // data-context field without helper: a target, but no definitions
  const field = at('imports/ui/components/userCard.html', 'modalTitle', 1);
  assert.equal(definitions(index, field).length, 0);
  // commented out
  assert.ok(!index.a.usagesByTemplate.get('userCard')!.some((u) => u.name === 'commentedHelper'));
});

test('Blaze: inclusions and block inclusions → template HTML', () => {
  const avatar = at('imports/ui/components/userCard.html', '{{> avatar', 5);
  assert.equal(avatar.type, 'template');
  const d = definitions(index, avatar);
  assert.equal(textAt(d[0].loc), 'avatar');

  const modal = at('imports/ui/components/userCard.html', '{{#modal', 4);
  assert.deepEqual(where(definitions(index, modal).map((x) => x.loc)), ['imports/ui/layouts/layout.html']);

  const dyn = at('imports/ui/layouts/layout.html', 'template="userCard"', 11);
  assert.equal(dyn.type === 'template' && dyn.name, 'userCard');
});

test('Blaze: JS Template.foo → HTML, HTML template name → JS parts', () => {
  const js = at('client/legacy/logic/userCard.js', 'Template.userCard.helpers', 10);
  assert.equal(js.type, 'template');
  assert.deepEqual(where(definitions(index, js).map((d) => d.loc)), ['imports/ui/components/userCard.html']);

  const html = at('imports/ui/components/userCard.html', 'name="userCard"', 7);
  const parts = definitions(index, html);
  assert.equal(parts.length, 3);
  assert.deepEqual([...new Set(where(parts.map((p) => p.loc)))], ['client/legacy/logic/userCard.js']);

  const refs = references(index, html, false);
  assert.deepEqual(where(refs), ['imports/startup/client/routes.js', 'imports/ui/layouts/layout.html']);
});

test('helper definition → usages in HTML; global helper → all templates', () => {
  const t = at('client/legacy/logic/userCard.js', 'fullName()', 1);
  assert.deepEqual(where(references(index, t, false)), ['imports/ui/components/userCard.html']);
  const g = at('client/helpers.js', "'formatDate'", 2);
  assert.equal(g.type === 'helper' && g.template, null);
  assert.equal(references(index, g, false).length, 1);
});

test('event map selectors → matching elements in the template HTML', () => {
  const t = at('client/legacy/logic/userCard.js', "'click .js-save", 2);
  assert.equal(t.type, 'event');
  const defs = definitions(index, t).map((d) => textAt(d.loc)).sort();
  assert.deepEqual(defs, ['card-main', 'js-save']);
});

test('enclosing template and env detection', () => {
  assert.equal(enclosingTemplate(index, F('imports/ui/components/userCard.html'), posOf('imports/ui/components/userCard.html', 'Save<')), 'userCard');
  assert.equal(enclosingTemplate(index, F('client/legacy/logic/userCard.js'), posOf('client/legacy/logic/userCard.js', "return 'John")), 'userCard');
  assert.equal(index.a.calls.get('users.update')![0].env, 'client');
});

test('glob and wildcard helpers', () => {
  assert.ok(globToRegExp('**/node_modules/**').test('c:/x/node_modules/a/b.js'));
  assert.ok(!globToRegExp('**/node_modules/**').test('c:/x/src/a.js'));
  assert.ok(globToRegExp('**/*.min.js').test('c:/x/a.min.js'));
  assert.ok(globToRegExp('**/.meteor/local/**').test('/p/.meteor/local/build/x.js'));
  assert.ok(wildcardMatch('accounts.*', 'accounts.login'));
  assert.ok(!wildcardMatch('accounts.*', 'users.login'));
});

test('exclude patterns: order, ! to include again, relative globs anchored at the workspace folder', () => {
  const ws = '/w/app';
  const st = (f: PathFilter, rel: string) => f.status(`${ws}/${rel}`, rel);
  const f = new PathFilter(['**/build/**', '!imports/ui/build/**', 'imports/legacy/**', './scripts/', '**/*.min.js']);
  assert.deepEqual(st(f, 'client/build/a.js'), { excluded: true, by: '**/build/**' });
  assert.deepEqual(st(f, 'imports/ui/build/a.js'), { excluded: false, by: '!imports/ui/build/**' });
  assert.equal(st(f, 'imports/ui/build/a.min.js').excluded, true);
  assert.equal(st(f, 'imports/legacy/x/a.js').excluded, true);
  // relative globs only match from the workspace folder, and never outside of it
  assert.equal(st(f, 'packages/p/imports/legacy/a.js').excluded, false);
  assert.equal(f.excluded('/elsewhere/imports/legacy/a.js'), false);
  assert.equal(st(f, 'scripts/run.js').excluded, true);
  assert.deepEqual(st(new PathFilter(['!**/node_modules/**']), 'node_modules/a/b.js'), { excluded: true, always: true });
  assert.deepEqual(f.excludes, ['**/build/**', 'imports/legacy/**', './scripts/', '**/*.min.js']);
  assert.deepEqual(f.reincluded, ['imports/ui/build/**']);
});

test('Explorer exclude / include: the rules written in meteorPower.exclude', () => {
  const ws = '/w/app';
  const toggle = (list: string[], rel: string, isDir: boolean, exclude: boolean) => togglePath(list, `${ws}/${rel}`, rel, isDir, exclude);
  const defaults = ['**/node_modules/**', '**/build/**', '**/public/**'];
  // exclude a folder, then include it again: back to the defaults
  const excluded = toggle(defaults, 'private', true, true)!;
  assert.deepEqual(excluded, [...defaults, 'private/**']);
  assert.deepEqual(toggle(excluded, 'private', true, false), defaults);
  // a folder hidden by a default glob: included with `!`, excluded again by dropping it
  const included = toggle(defaults, 'imports/ui/build', true, false)!;
  assert.deepEqual(included, [...defaults, '!imports/ui/build/**']);
  assert.deepEqual(toggle(included, 'imports/ui/build', true, true), defaults);
  // a single file inside an excluded folder
  assert.deepEqual(toggle(excluded, 'private/keep.js', false, false), [...excluded, '!private/keep.js']);
  // excluding a folder replaces the rules about what it contains
  assert.deepEqual(toggle([...defaults, 'imports/a/old/**', '!imports/a/b.js'], 'imports/a', true, true), [...defaults, 'imports/a/**']);
  // nothing to do
  assert.equal(toggle(defaults, 'client/build', true, true), undefined);
  assert.equal(toggle(defaults, 'client', true, false), undefined);
});

test('parser keeps going on broken files and returns null only when hopeless', () => {
  const partial = parseJs('x.js', "Meteor.methods({ 'a.b'() {} });\nMeteor.callAsync('a.b'");
  assert.ok(partial === null || partial.methods.length === 1);
  const html = parseHtml('x.html', '<template name="t">{{foo</template>');
  assert.equal(html.templates.length, 1);
});

test('custom wrappers: define and call methods/publications through project functions', () => {
  const a = index.a;
  const create = a.methods.get('orders.create')![0];
  assert.deepEqual([create.params, create.isAsync], [['order'], true]);
  assert.deepEqual(a.methods.get('orders.cancel')![0].params, ['{ orderId }']); // createMethod({ name, run })
  assert.ok(a.methods.get('orders.archive')); // defineMethods({ ... })
  assert.deepEqual(a.methods.get('orders.restore')![0].params, ['id']); // new Method('x', { run })
  // the wrappers' own implementation (Meteor.methods({ [name]: handler })) does not produce fake definitions
  const lib = index.facts(F('imports/lib/methods.js'))!;
  assert.deepEqual(lib.methods.map((m) => a.resolve(m)).filter(Boolean), []);
  assert.deepEqual(lib.calls.map((c) => a.resolve(c)).filter(Boolean), []);

  const call = at('client/orders.js', "callMethod('orders.create'", 13);
  assert.deepEqual(where(definitions(index, call).map((d) => d.loc)), ['imports/api/orders/methods.js']);
  const sub = at('client/orders.js', "useSubscribe('orders.mine'", 15);
  assert.equal(sub.type, 'publication');
  assert.deepEqual(where(definitions(index, sub).map((d) => d.loc)), ['imports/api/orders/methods.js']);
});

test('aliases: import { X as Y }, destructuring, default imports (relative and /imports/...)', () => {
  const name = (needle: string) => {
    const t = at('client/orders.js', needle, 1);
    return t.type === 'method' ? t.name : undefined;
  };
  assert.equal(name('UM.RESET'), 'users.reset');
  assert.equal(name('RESET);'), 'users.reset');
  assert.equal(name('OrderNames.CANCEL'), 'orders.cancel');
  assert.equal(name('OrderNames.SHIP'), 'orders.ship');
  // default import inside the definition file too: createMethod({ name: ORDERS.CANCEL }) and [ORDERS.SHIP]() {}
  assert.equal(index.a.methods.get('orders.ship')!.length, 1);
  assert.equal(index.a.methods.get('orders.cancel')!.length, 1);
  assert.deepEqual(problems(index, F('client/orders.js'), { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] }), []);
});

test('public/ of the app is excluded by convention: static HTML is not Blaze', () => {
  assert.deepEqual(FILTER.status(slash(F('public/landing.html')), 'public/landing.html'), { excluded: true, by: 'public/ of a Meteor app' });
  assert.ok(!index.a.templateNames.has('notBlaze'));
});

// ------------------------------------------------------------------------------------------- rename

/** Applies the edits to the fixture sources in memory (the files on disk are untouched). */
function applyEdits(edits: TextEdit[]): Map<string, string> {
  const out = new Map(sources);
  const byFile = new Map<string, TextEdit[]>();
  for (const e of edits) byFile.set(e.loc.file, [...(byFile.get(e.loc.file) ?? []), e]);
  for (const [file, list] of byFile) {
    const text = out.get(file)!;
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const off = (p: Pos) => starts[p.line] + p.character;
    let result = text;
    for (const e of [...list].sort((x, y) => off(y.loc.range.start) - off(x.loc.range.start))) {
      result = result.slice(0, off(e.loc.range.start)) + e.newText + result.slice(off(e.loc.range.end));
    }
    out.set(file, result);
  }
  return out;
}

function reindex(texts: Map<string, string>): MeteorIndex {
  const idx = new MeteorIndex();
  for (const [file, text] of texts) {
    const facts = file.endsWith('.html') ? parseHtml(file, text) : parseJs(file, text, OPTIONS);
    if (facts) idx.update(facts);
  }
  return idx;
}

function doRename(rel: string, needle: string, delta: number, newName: string) {
  const r = renameEdits(index, at(rel, needle, delta), newName);
  assert.ok('edits' in r, 'error' in r ? r.error : '');
  const edits = (r as { edits: TextEdit[] }).edits;
  return { edits, files: where(edits.map((e) => e.loc)), after: reindex(applyEdits(edits)) };
}

const noProblems = (idx: MeteorIndex, rel: string) =>
  problems(idx, F(rel), { ignoreMethods: [], ignorePublications: [], ignoreTemplates: ['missingTemplate'] }).map((p) => p.message);

test('rename method written as string literals: definition and calls', () => {
  const { files, after } = doRename('client/legacy/logic/userCard.js', "'users.update'", 2, 'users.edit');
  assert.deepEqual(files, ['client/legacy/logic/userCard.js', 'imports/api/users/methods.js']);
  assert.ok(!after.a.methods.has('users.update'));
  assert.equal(after.a.methods.get('users.edit')!.length, 1);
  assert.equal(after.a.calls.get('users.edit')!.length, 1);
});

test('rename method defined through a constant: the constant string is renamed, references keep working', () => {
  const { files, after } = doRename('imports/api/users/methods.js', 'USERS_METHODS.RESET]', 2, 'users.wipe');
  // constants.js (RESET: '...') + the literal Meteor.callAsync('users.reset') in methods.js; UM.RESET / C.USERS_METHODS.RESET are untouched
  assert.deepEqual(files, ['imports/api/users/constants.js', 'imports/api/users/methods.js']);
  assert.ok(!after.a.methods.has('users.reset'));
  assert.equal(after.a.methods.get('users.wipe')!.length, 1);
  assert.equal(after.a.calls.get('users.wipe')!.length, 4);
  assert.deepEqual(noProblems(after, 'client/orders.js'), []);
});

test('rename method from a default-export constant', () => {
  const { files, after } = doRename('client/orders.js', 'OrderNames.CANCEL', 1, 'orders.abort');
  assert.deepEqual(files, ['imports/api/orders/names.js']);
  assert.equal(after.a.methods.get('orders.abort')!.length, 1);
  assert.equal(after.a.calls.get('orders.abort')!.length, 1);
});

test('rename identifier method key to a dotted name adds quotes', () => {
  const { edits, after } = doRename('imports/api/tasks/tasks.js', 'ping()', 1, 'tasks.ping');
  assert.deepEqual(edits.map((e) => e.newText), ["'tasks.ping'"]);
  assert.equal(after.a.methods.get('tasks.ping')!.length, 1);
});

test('rename template helper: JS key + HTML usages', () => {
  const { files, after } = doRename('imports/ui/components/userCard.html', '{{fullName}}', 3, 'displayName');
  assert.deepEqual(files, ['client/legacy/logic/userCard.js', 'imports/ui/components/userCard.html']);
  assert.ok(after.a.helpers.get('userCard')!.has('displayName'));
  assert.ok(after.a.usagesByTemplate.get('userCard')!.some((u) => u.name === 'displayName'));
  assert.ok(!after.a.usagesByTemplate.get('userCard')!.some((u) => u.name === 'fullName'));
});

test('rename global helper: registerHelper string + usages in every template', () => {
  const { files } = doRename('client/helpers.js', "'formatDate'", 2, 'fmtDate');
  assert.deepEqual(files, ['client/helpers.js', 'imports/ui/components/userCard.html']);
});

test('rename block template: <template name>, {{#x}} and {{/x}}', () => {
  const { files, after } = doRename('imports/ui/components/userCard.html', '{{#modal', 4, 'dialog');
  assert.deepEqual(files, ['imports/ui/components/userCard.html', 'imports/ui/components/userCard.html', 'imports/ui/layouts/layout.html']);
  assert.ok(after.a.templateNames.has('dialog') && !after.a.templateNames.has('modal'));
  assert.deepEqual(after.a.closes.get('userCard')!.map((c) => c.name), ['dialog']);
});

test('rename template used from HTML, JS (Template.x), BlazeLayout and Template.dynamic', () => {
  const { files, after } = doRename('imports/ui/components/userCard.html', 'name="userCard"', 7, 'memberCard');
  assert.deepEqual(files, [
    'client/legacy/logic/userCard.js',
    'client/legacy/logic/userCard.js',
    'client/legacy/logic/userCard.js',
    'imports/startup/client/routes.js',
    'imports/ui/components/userCard.html',
    'imports/ui/layouts/layout.html',
  ]);
  assert.ok(!after.a.templateNames.has('userCard'));
  assert.equal(after.a.parts.get('memberCard')!.length, 3);
  assert.equal(after.a.inclusions.get('memberCard')!.length, 1);
});

test('rename refuses invalid or conflicting names', () => {
  const err = (rel: string, needle: string, delta: number, name: string) => {
    const r = renameEdits(index, at(rel, needle, delta), name);
    return 'error' in r ? r.error : undefined;
  };
  assert.match(err('imports/ui/components/userCard.html', '{{> avatar', 5, 'my-avatar')!, /valid identifiers/);
  assert.match(err('imports/ui/components/userCard.html', '{{> avatar', 5, 'modal')!, /already exists/);
  assert.match(err('client/legacy/logic/userCard.js', "'users.update'", 2, 'users.remove')!, /already exists/);
  assert.match(err('client/legacy/logic/userCard.js', "'users.update'", 2, "it's")!, /quotes/);
  assert.match(err('imports/ui/components/userCard.html', 'modalTitle', 1, 'x')!, /data context/);
  const ev = renameInfo(at('client/legacy/logic/userCard.js', "'click .js-save", 2));
  assert.ok('error' in ev);
});

// ------------------------------------------------------------------------------ template-extension

test('inheritsHelpersFrom: inherited helpers resolve from the HTML of the child template', () => {
  const t = at('imports/ui/components/cards.html', '{{title}} {{subtitle}}', 3);
  assert.equal(t.type, 'helper');
  const defs = definitions(index, t);
  assert.deepEqual(where(defs.map((d) => d.loc)), ['imports/ui/components/cards.js']);
  assert.equal(textAt(defs[0].loc), 'title');
  assert.equal(helperOwner(index, 'fancyCard', 'title', null), 'baseCard');
  assert.equal(helperOwner(index, 'fancyCard', 'subtitle', null), 'fancyCard');
  // the parent's helper is used in both templates
  const refs = references(index, at('imports/ui/components/cards.js', 'title()', 1), false);
  assert.deepEqual(where(refs), ['imports/ui/components/cards.html', 'imports/ui/components/cards.html']);
});

test('inheritsEventsFrom, copyAs and template names in template-extension calls', () => {
  // the parent's event map matches elements of the child too
  const ev = definitions(index, at('imports/ui/components/cards.js', "'click .js-open'", 2));
  assert.equal(ev.length, 2);
  // {{> plainCard}} → the copyAs call that creates it, and no diagnostic
  const copy = definitions(index, at('imports/ui/components/cards.html', '{{> plainCard', 5));
  assert.deepEqual(copy.map((d) => textAt(d.loc)), ['plainCard']);
  assert.deepEqual(noProblems(index, 'imports/ui/components/cards.html'), []);
  // 'baseCard' inside inheritsHelpersFrom(...) → the template
  const base = definitions(index, at('imports/ui/components/cards.js', "inheritsHelpersFrom('baseCard", 21));
  assert.deepEqual(where(base.map((d) => d.loc)), ['imports/ui/components/cards.html']);
  // Template.fancyCard.inheritsHelpersFrom is not a usage of fancyCard
  assert.equal(templateUsages(index, 'fancyCard').length, 1);
});

test('rename inherited helper and template linked through template-extension', () => {
  const helper = doRename('imports/ui/components/cards.html', '{{title}} {{subtitle}}', 3, 'heading');
  assert.deepEqual(helper.files, ['imports/ui/components/cards.html', 'imports/ui/components/cards.html', 'imports/ui/components/cards.js']);
  const tpl = doRename('imports/ui/components/cards.html', 'name="baseCard"', 7, 'cardBase');
  // <template name>, Template.baseCard ×3, 'baseCard' in inheritsHelpersFrom and inheritsEventsFrom
  assert.equal(tpl.edits.length, 6);
  assert.ok(tpl.after.a.helperParents.get('fancyCard')!.every((p) => p.from === 'cardBase'));
});

// ---------------------------------------------------------------------------------------- apps

const MULTI = path.resolve(__dirname, '../../test/fixtures/multi');
const M = (rel: string) => path.join(MULTI, rel);

test('apps: .meteor/packages and package.js parsing', () => {
  assert.deepEqual(parseMeteorPackages('# comment\n\nmeteor-base@1.5.2\nacme:audit # local\n  blaze  \n'), ['meteor-base', 'acme:audit', 'blaze']);
  const pkg = parsePackageJs(fs.readFileSync(M('packages/audit/package.js'), 'utf8'), 'audit');
  assert.deepEqual(pkg, { name: 'acme:audit', uses: ['ecmascript', 'acme:logger'] });
  assert.deepEqual(parsePackageJs("Package.describe({ summary: 'x' });", 'my-pkg'), { name: 'my-pkg', uses: [] });
  assert.equal(parsePackageJs('export const x = 1;', 'x'), undefined);
});

/** The multi-app fixture: shared/ is reachable as admin/imports/shared and web/imports/shared (symlinks in the real run). */
function buildMulti() {
  const all = walk(MULTI);
  const apps: AppRoot[] = all
    .filter((f) => slash(f).endsWith('.meteor/release'))
    .map((f) => {
      const dir = path.dirname(path.dirname(f));
      return { id: normPath(dir), name: path.basename(dir), packages: parseMeteorPackages(fs.readFileSync(path.join(dir, '.meteor', 'packages'), 'utf8')) };
    });
  const packages: PackageRoot[] = all
    .filter((f) => path.basename(f) === 'package.js')
    .map((f) => ({ dir: normPath(path.dirname(f)), ...parsePackageJs(fs.readFileSync(f, 'utf8'), path.basename(path.dirname(f)))! }));
  const layout = new AppLayout(apps, packages);
  const idx = new MeteorIndex();
  idx.setApps(new Map(apps.map((a) => [a.id, a.name])));
  for (const file of all) {
    if (!/\.(js|html)$/.test(file) || path.basename(file) === 'package.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    const facts = file.endsWith('.html') ? parseHtml(file, text) : parseJs(file, text);
    if (facts) idx.update(facts);
    const rel = slash(path.relative(MULTI, file));
    const paths = [file, ...(rel.startsWith('shared/') ? ['admin', 'web'].map((app) => path.join(MULTI, app, 'imports', rel)) : [])];
    idx.setFileApps(file, layout.appsOf(paths));
  }
  return idx;
}

const multi = buildMulti();
const mAt = (rel: string, needle: string, delta = 1) => {
  const text = fs.readFileSync(M(rel), 'utf8');
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `"${needle}" not in ${rel}`);
  const t = targetAt(multi, M(rel), new LineMap(text).pos(i + delta));
  assert.ok(t, `no target at "${needle}" in ${rel}`);
  return t!;
};
const mWhere = (locs: { file: string }[]) => locs.map((l) => slash(path.relative(MULTI, l.file))).sort();
const appNames = (rel: string) => multi.appsOf(M(rel)).map((id) => multi.appName(id));
const mProblems = (rel: string) => problems(multi, M(rel), { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] }).map((p) => p.message);

test('apps: membership through folders, symlinked shared code and local packages', () => {
  assert.ok(multi.isMultiApp);
  assert.deepEqual(appNames('admin/client/main.js'), ['admin']);
  assert.deepEqual(appNames('web/server/methods.js'), ['web']);
  assert.deepEqual(appNames('shared/api.js'), ['admin', 'web']);
  assert.deepEqual(appNames('packages/audit/audit.js'), ['admin']);
  // used by acme:audit, which admin uses
  assert.deepEqual(appNames('packages/logger/logger.js'), ['admin']);
  // used by nobody and outside every app: visible from everywhere
  assert.deepEqual(appNames('packages/unused/unused.js'), []);
});

test('apps: definitions, helpers and templates resolve inside the app of the file', () => {
  assert.deepEqual(mWhere(definitions(multi, mAt('admin/client/main.js', "'common.ping'", 2)).map((d) => d.loc)), ['admin/server/methods.js']);
  // shared code runs in both apps
  assert.deepEqual(mWhere(definitions(multi, mAt('shared/api.js', "'common.ping'", 2)).map((d) => d.loc)), ['admin/server/methods.js', 'web/server/methods.js']);
  assert.deepEqual(mWhere(definitions(multi, mAt('web/client/main.html', '{{title}}', 3)).map((d) => d.loc)), ['web/client/main.js']);
  assert.deepEqual(mWhere(definitions(multi, mAt('admin/client/main.html', '{{> header', 4)).map((d) => d.loc)), ['shared/header.html']);
  // the same constant has a different value in each app
  assert.deepEqual([...multi.a.methods.keys()].filter((n) => n.endsWith('.home')).sort(), ['admin.home', 'web.home']);
  const home = mAt('web/client/main.js', 'PAGE.HOME', 1);
  assert.equal(home.name, 'web.home');
  assert.deepEqual(mWhere(definitions(multi, home).map((d) => d.loc)), ['web/server/methods.js']);
  // references of an app's method: its own calls and the shared ones
  assert.deepEqual(mWhere(references(multi, mAt('admin/server/methods.js', "'common.ping'", 2), true)), ['admin/client/main.js', 'admin/server/methods.js', 'shared/api.js']);
  // the same method in two apps is not a duplicate
  assert.equal(hasConflict(multi, multi.a.methods.get('common.ping')!.map((d) => d.loc)), false);
});

test('apps: diagnostics report names missing in the app (or in one of the apps of shared code)', () => {
  assert.deepEqual(mProblems('admin/client/main.js'), ["Meteor method 'web.signup' is not defined in app 'admin'."]);
  assert.deepEqual(mProblems('web/client/main.js'), ["Meteor method 'audit.log' is not defined in app 'web'."]);
  assert.deepEqual(mProblems('shared/api.js'), ["Meteor method 'admin.purge' is not defined in app 'web'."]);
  assert.deepEqual(mProblems('admin/client/main.html'), []);
});

test('apps: rename stays inside the apps that share the name', () => {
  const edits = (rel: string, needle: string, delta: number, name: string) => {
    const r = renameEdits(multi, mAt(rel, needle, delta), name);
    assert.ok('edits' in r, 'error' in r ? r.error : '');
    return mWhere((r as { edits: TextEdit[] }).edits.map((e) => e.loc));
  };
  // only the admin helper and template
  assert.deepEqual(edits('admin/client/main.html', '{{title}}', 3, 'heading'), ['admin/client/main.html', 'admin/client/main.js']);
  // web.signup is called (wrongly) from admin too: that call is not web's
  assert.deepEqual(edits('web/server/methods.js', "'web.signup'", 2, 'web.register'), ['web/client/main.js', 'web/server/methods.js']);
  // common.ping is called from shared code: renaming it in one app must rename it in the other one too
  assert.deepEqual(edits('admin/server/methods.js', "'common.ping'", 2, 'common.pong'), [
    'admin/client/main.js',
    'admin/server/methods.js',
    'shared/api.js',
    'web/client/main.js',
    'web/server/methods.js',
  ]);
  // a name existing only in another app is free…
  assert.ok('edits' in renameEdits(multi, mAt('packages/audit/audit.js', "'audit.log'", 2), 'web.signup'));
  // …unless shared code ties the two apps: admin.purge is called from shared/api.js, which runs in web too
  const tied = renameEdits(multi, mAt('admin/server/methods.js', "'admin.purge'", 2), 'web.signup');
  assert.match('error' in tied ? tied.error : '', /already exists/);
});

// ------------------------------------------------------------------------------ ValidatedMethod objects

test('ValidatedMethod objects: insertTask.call(), namespace and aliased imports, .name', () => {
  const calls = index.a.calls.get('tasks.insert')!.filter((c) => c.loc.file === F('client/tasksUsage.js'));
  assert.deepEqual(calls.map((c) => textAt(c.loc)), ['insertTask', 'Tasks.insertTask', 'addTask', 'insertTask.name']);
  for (const needle of ['insertTask.call', 'Tasks.insertTask', 'addTask.call', 'insertTask.name']) {
    const t = at('client/tasksUsage.js', needle, 1);
    assert.equal(t.type === 'method' && t.name, 'tasks.insert', needle);
    assert.deepEqual(where(definitions(index, t).map((d) => d.loc)), ['imports/api/tasks/tasks.js']);
  }
  // debounce.call() is not a method call and is not reported
  assert.deepEqual(noProblems(index, 'client/tasksUsage.js'), []);
  // references from the definition include the calls through the object
  const refs = references(index, at('imports/api/tasks/tasks.js', "'tasks.insert'", 2), false);
  assert.equal(where(refs).filter((f) => f === 'client/tasksUsage.js').length, 4);
});

test('Object.prototype names are neither method objects nor constants: hasOwnProperty.call() is not a method call', () => {
  const source = [
    `import { Meteor } from 'meteor/meteor';`,
    `const { hasOwnProperty } = Object.prototype;`,
    `export function f(o) {`,
    `  hasOwnProperty.call(o, 'a');`,
    `  toString.call(o);`,
    `  constructor.call(o);`,
    `  Meteor.call(valueOf);`,
    `}`,
    `export default toString;`,
  ].join('\n');
  const facts = parseJs('proto.js', source)!;
  assert.deepEqual(facts.calls.map((c) => [c.name, c.nameExpr]), [[undefined, 'valueOf']]);
  assert.deepEqual(facts.defaultExport, {});
  const idx = new MeteorIndex();
  idx.update(facts);
  assert.deepEqual([...idx.a.calls.keys()], []);
  assert.deepEqual(problems(idx, 'proto.js', { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] }), []);
});

test('rename a ValidatedMethod: the name string changes, the calls through the object are untouched', () => {
  const { edits, after } = doRename('client/tasksUsage.js', 'addTask.call', 1, 'tasks.add');
  assert.deepEqual(where(edits.map((e) => e.loc)), ['imports/api/tasks/tasks.js']);
  assert.equal(after.a.calls.get('tasks.add')!.filter((c) => c.loc.file === F('client/tasksUsage.js')).length, 4);
});

test('indexing skips minified bundles and library files that only use fn.call()', () => {
  const minified = `!function(){${'var a=Meteor.call("x");'.repeat(2000)}}();`;
  assert.equal(isMinified(minified), true);
  assert.equal(parseFile('vendor.js', minified, {}).skipped, 'minified');
  const source = Array.from({ length: 2000 }, (_, i) => `Meteor.call('m${i}');`).join('\n');
  assert.equal(isMinified(source), false);
  assert.equal(parseFile('app.js', source, {}).facts!.calls.length, 2000);
  // `.call(` on a name that is not imported: nothing to look at
  const lib = `function f() { return g.call(this, 1); }`;
  assert.equal(parseJs('lib.js', lib)!.calls.length, 0);
  const viaImport = `import { insertTask } from './tasks';\ninsertTask.call({});`;
  assert.equal(parseJs('a.js', viaImport)!.calls.length, 1);
});

// ------------------------------------------------------------------------------- false positives (synthetic apps)

/** An index of in-memory files (paths under /w/app) and the names reported missing in each file. */
function synthetic(files: Record<string, string>) {
  const idx = new MeteorIndex();
  for (const [rel, text] of Object.entries(files)) {
    const file = `/w/app/${rel}`;
    const facts = rel.endsWith('.html') ? parseHtml(file, text) : parseJs(file, text);
    if (facts) idx.update(facts);
  }
  const missing = (rel: string) =>
    problems(idx, `/w/app/${rel}`, { ignoreMethods: [], ignorePublications: [], ignoreTemplates: [] }).map((p) => /'([^']+)'/.exec(p.message)![1]);
  return { idx, missing, facts: (rel: string) => idx.facts(`/w/app/${rel}`)! };
}

test('subscribe: only Meteor, template instances, subscription managers and Meteor.connection are DDP subscriptions', () => {
  const { idx, missing } = synthetic({
    'server/pubs.js': `Meteor.publish('sample.feed', function () {});`,
    'client/feed.js': [
      `import { Meteor } from 'meteor/meteor';`,
      `import { Template } from 'meteor/templating';`,
      `const subs = new SubsManager();`,
      `Template.feed.onCreated(function () {`,
      `  const instance = this;`,
      `  this.subscribe('sample.missing1');`,
      `  this.autorun(() => instance.subscribe('sample.missing2'));`,
      `});`,
      `function onRenderedFeed() { this.subscribe('sample.missing3'); }`,
      `Template.feed.onRendered(onRenderedFeed);`,
      `Template.feed.onDestroyed(() => this.subscribe('sample.arrow'));`,
      `Template.feed.events({ 'click .x'(event, tpl) { tpl.subscribe('sample.missing4'); } });`,
      `Template.feed.helpers({ items() { return Template.instance().subscribe('sample.missing5'); } });`,
      `subs.subscribe('sample.missing6');`,
      `Meteor.connection.subscribe('sample.missing7');`,
      `Meteor.subscribe('sample.feed');`,
      `function setup() { this.subscribe('sample.event'); }`,
      `eventBus.subscribe('sample.event', () => {});`,
      `cacheClient.subscribe('sample.channel', () => {});`,
      `const remote = DDP.connect('https://example.test');`,
      `remote.subscribe('sample.remote');`,
    ].join('\n'),
  });
  assert.deepEqual(missing('client/feed.js'), ['sample.missing1', 'sample.missing2', 'sample.missing3', 'sample.missing4', 'sample.missing5', 'sample.missing6', 'sample.missing7']);
  // the others are kept for navigation, without diagnostics
  for (const name of ['sample.arrow', 'sample.event', 'sample.channel', 'sample.remote']) assert.ok(idx.a.subscriptions.get(name)!.every((c) => c.uncertain), name);
});

test('the Meteor object: import aliases count, a local or imported Meteor of another module does not', () => {
  const { facts } = synthetic({
    'client/aliased.js': `import { Meteor as M } from 'meteor/meteor';\nM.call('sample.aliased');\nif (M.isServer) { M.methods({ 'sample.server'() {} }); }`,
    'client/fake.js': `import Meteor from './fakeMeteor';\nMeteor.call('sample.fake');\nMeteor.subscribe('sample.fakeFeed');`,
    'client/local.js': `const Meteor = createBus();\nMeteor.call('sample.local');`,
  });
  assert.deepEqual(facts('client/aliased.js').calls.map((c) => c.name), ['sample.aliased']);
  assert.deepEqual(facts('client/aliased.js').methods.map((m) => [m.name, m.env]), [['sample.server', 'server']]);
  assert.deepEqual(facts('client/fake.js').calls, []);
  // `.subscribe` on something else: navigation only
  assert.deepEqual(facts('client/fake.js').subscriptions.map((s) => [s.name, s.uncertain]), [['sample.fakeFeed', true]]);
  assert.deepEqual(facts('client/local.js').calls, []);
});

test('indirect registrations: spreads, local variables, Object.assign, named and default imports', () => {
  const { idx, missing, facts } = synthetic({
    'imports/api/sample/methods.js': [
      `export const sampleMethods = {`,
      `  async 'sample.execute'(input) { return input; },`,
      `};`,
      `export const notRegistered = { 'sample.unregistered'() {} };`,
    ].join('\n'),
    'imports/api/sample/extra.js': `const base = { 'sample.base'() {} };\nexport default { ...base, 'sample.default': function () {} };`,
    'imports/api/sample/publications.js': `export const publications = { 'sample.items'() { return []; } };`,
    'server/register.js': [
      `import { Meteor } from 'meteor/meteor';`,
      `import { sampleMethods } from '/imports/api/sample/methods';`,
      `import extra from '../imports/api/sample/extra';`,
      `import { publications as pubs } from '/imports/api/sample/publications';`,
      `export function registerAll() {`,
      `  const registrations = { ...sampleMethods, 'sample.inline'() {} };`,
      `  Meteor.methods(registrations);`,
      `  Meteor.methods(Object.assign({}, extra));`,
      `  Meteor.methods(buildMethods());`,
      `  Meteor.publish(pubs);`,
      `}`,
    ].join('\n'),
    'client/calls.js': [
      `Meteor.call('sample.execute');`,
      `Meteor.call('sample.inline');`,
      `Meteor.call('sample.base');`,
      `Meteor.call('sample.default');`,
      `Meteor.call('sample.typo');`,
      `Meteor.call('sample.unregistered');`,
      `Meteor.subscribe('sample.items');`,
    ].join('\n'),
  });
  // a definition that is never registered is still missing
  assert.deepEqual(missing('client/calls.js'), ['sample.typo', 'sample.unregistered']);
  const def = idx.a.methods.get('sample.execute')!;
  assert.deepEqual(def.map((d) => [d.loc.file, d.kind, d.env, d.isAsync]), [['/w/app/imports/api/sample/methods.js', 'method', 'server', true]]);
  assert.deepEqual(idx.a.publications.get('sample.items')!.map((d) => d.loc.file), ['/w/app/imports/api/sample/publications.js']);
  // Ctrl+click on the key in the module that only declares the object
  const t = targetAt(idx, '/w/app/imports/api/sample/methods.js', { line: 1, character: 12 });
  assert.deepEqual(t && [t.type, t.name, t.type === 'method' && t.isDef], ['method', 'sample.execute', true]);
  // what cannot be followed statically is recorded (and logged), not guessed
  assert.equal(facts('server/register.js').dynamicRegistrations.length, 1);
});

test('library APIs: publishComposite, FindFromPublication, useSubscribe from react-meteor-data', () => {
  const { missing } = synthetic({
    'server/pubs.js': `Meteor.publishComposite('sample.composite', function () { return {}; });\nFindFromPublication.publish('sample.ffp', function () {});`,
    'client/react.js': `import { useSubscribe } from 'meteor/react-meteor-data';\nuseSubscribe('sample.composite');\nuseSubscribe('sample.ffp');\nuseSubscribe('sample.nopub');`,
    // a function of the app with the same name is not the library's
    'client/own.js': `import { useSubscribe } from './hooks';\nuseSubscribe('sample.nothing');`,
  });
  assert.deepEqual(missing('client/react.js'), ['sample.nopub']);
  assert.deepEqual(missing('client/own.js'), []);
});

test('templates: exact names only, dynamic inclusions are not reported', () => {
  const { missing } = synthetic({
    'client/items.html': `<template name="sampleItems">x</template>\n<template name="list">{{> sampleItem}}{{> sampleItems}}{{> Template.dynamic template=name}}</template>`,
  });
  assert.deepEqual(missing('client/items.html'), ['sampleItem']);
});

test('public/ and private/ of each Meteor app are excluded by convention, other folders with those names are not', () => {
  const f = new PathFilter([], ['/w/app', '/w/apps/admin']);
  assert.deepEqual(f.status('/w/app/private/ace/worker.js', 'private/ace/worker.js'), { excluded: true, by: 'private/ of a Meteor app' });
  assert.equal(f.excluded('/w/apps/admin/public/landing.html', 'apps/admin/public/landing.html'), true);
  assert.equal(f.excluded('/w/app/imports/private/code.js', 'imports/private/code.js'), false);
  assert.equal(f.excluded('/w/privateTools/x.js', 'privateTools/x.js'), false);
  // included again with `!`, from the Explorer too
  assert.equal(f.with(['!private/ace/**']).excluded('/w/app/private/ace/worker.js', 'private/ace/worker.js'), false);
  assert.deepEqual(togglePath([], '/w/app/private', 'private', true, false, f), ['!private/**']);
  assert.equal(togglePath([], '/w/app/private', 'private', true, true, f), undefined);
  assert.deepEqual(togglePath(['!private/**'], '/w/app/private', 'private', true, true, f), []);
});
