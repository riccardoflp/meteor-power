import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseJs } from '../src/core/jsParser';
import { parseHtml } from '../src/core/htmlParser';
import { MeteorIndex } from '../src/core/index';
import { definitions, enclosingTemplate, problems, references, targetAt, Target } from '../src/core/queries';
import { Loc, Pos } from '../src/core/model';
import { globToRegExp, LineMap, wildcardMatch } from '../src/core/text';

const ROOT = path.resolve(__dirname, '../../test/fixtures/app');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const index = new MeteorIndex();
for (const file of walk(ROOT)) {
  const text = fs.readFileSync(file, 'utf8');
  const facts = file.endsWith('.html') ? parseHtml(file, text) : /\.(js|ts)$/.test(file) ? parseJs(file, text) : undefined;
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
  assert.deepEqual(names, ['tasks.insert', 'tasks.serverOnly', 'tasks.toggle', 'users.profile.save', 'users.remove', 'users.reset', 'users.update']);
  assert.equal(index.a.methods.get('tasks.serverOnly')![0].env, 'server');
  assert.equal(index.a.methods.get('tasks.insert')![0].kind, 'validated');
  const update = index.a.methods.get('users.update')![0];
  assert.deepEqual(update.params, ['userId', 'data']);
  assert.equal(update.isAsync, true);
  assert.match(update.doc!, /Updates the user profile/);
  assert.deepEqual(index.a.methods.get('users.reset')![0].params, ['id', '{ force = false } = {}']);
});

test('indexes publications (string, object form, constant key) and skips null publications', () => {
  assert.deepEqual([...index.a.publications.keys()].sort(), ['users.list', 'users.one']);
  assert.deepEqual([...index.a.subscriptions.keys()].sort(), ['users.list', 'users.unknownPub']);
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
  assert.deepEqual(where(references(index, t, false)), ['imports/api/users/methods.js', 'imports/ui/layouts/layout.ts']);
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

test('parser keeps going on broken files and returns null only when hopeless', () => {
  const partial = parseJs('x.js', "Meteor.methods({ 'a.b'() {} });\nMeteor.callAsync('a.b'");
  assert.ok(partial === null || partial.methods.length === 1);
  const html = parseHtml('x.html', '<template name="t">{{foo</template>');
  assert.equal(html.templates.length, 1);
});
