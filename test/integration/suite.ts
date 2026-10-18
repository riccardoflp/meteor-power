import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const uri = (rel: string) => vscode.Uri.file(path.join(root(), rel));

async function posOf(rel: string, needle: string, delta = 1): Promise<[vscode.TextDocument, vscode.Position]> {
  const doc = await vscode.workspace.openTextDocument(uri(rel));
  const at = doc.getText().indexOf(needle);
  assert.ok(at >= 0, `"${needle}" not in ${rel}`);
  return [doc, doc.positionAt(at + delta)];
}

function rel(u: vscode.Uri) {
  return path.relative(root(), u.fsPath).replace(/\\/g, '/');
}

function targetUri(d: vscode.Location | vscode.LocationLink) {
  return 'targetUri' in d ? d.targetUri : d.uri;
}

const checks: [string, () => Promise<void>][] = [
  [
    'definition: Meteor.callAsync string → method',
    async () => {
      const [doc, pos] = await posOf('client/legacy/logic/userCard.js', "'users.update'", 3);
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
      assert.deepEqual(defs.map((d) => rel(targetUri(d))), ['imports/api/users/methods.js']);
    },
  ],
  [
    'definition: {{helper}} in HTML → JS helper elsewhere',
    async () => {
      const [doc, pos] = await posOf('imports/ui/components/userCard.html', '{{fullName}}', 4);
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
      assert.ok(defs.some((d) => rel(targetUri(d)) === 'client/legacy/logic/userCard.js'), JSON.stringify(defs.map((d) => rel(targetUri(d)))));
    },
  ],
  [
    'definition: {{> avatar}} → template',
    async () => {
      const [doc, pos] = await posOf('imports/ui/components/userCard.html', '{{> avatar', 6);
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
      assert.ok(defs.some((d) => rel(targetUri(d)) === 'imports/ui/components/userCard.html'));
    },
  ],
  [
    'references: method definition → calls',
    async () => {
      const [doc, pos] = await posOf('imports/api/users/methods.js', "'users.update'", 3);
      const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', doc.uri, pos);
      assert.ok(refs.some((r) => rel(r.uri) === 'client/legacy/logic/userCard.js'));
    },
  ],
  [
    'hover: method call shows signature',
    async () => {
      const [doc, pos] = await posOf('client/legacy/logic/userCard.js', "'users.update'", 3);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /async 'users\.update'\(userId, data\)/);
    },
  ],
  [
    'completion: method names inside Meteor.callAsync(\'',
    async () => {
      const doc = await vscode.workspace.openTextDocument(uri('client/legacy/logic/userCard.js'));
      await vscode.window.showTextDocument(doc);
      const edit = new vscode.WorkspaceEdit();
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      edit.insert(doc.uri, end, "\nMeteor.callAsync('users.");
      await vscode.workspace.applyEdit(edit);
      const pos = doc.lineAt(doc.lineCount - 1).range.end;
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, pos, "'");
      const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
      await vscode.commands.executeCommand('workbench.action.files.revert');
      assert.ok(labels.includes('users.update') && labels.includes('users.profile.save'), labels.slice(0, 20).join(','));
    },
  ],
  [
    'completion: helpers inside {{ }} of the enclosing template',
    async () => {
      const doc = await vscode.workspace.openTextDocument(uri('imports/ui/components/userCard.html'));
      await vscode.window.showTextDocument(doc);
      const [, at] = await posOf('imports/ui/components/userCard.html', '<h2>', 4);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, at, '{{fu');
      await vscode.workspace.applyEdit(edit);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', doc.uri, at.translate(0, 4));
      const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
      await vscode.commands.executeCommand('workbench.action.files.revert');
      assert.ok(labels.includes('fullName') && labels.includes('formatDate'), labels.slice(0, 20).join(','));
    },
  ],
  [
    'codelens: call counts on method definitions',
    async () => {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri('imports/api/users/methods.js'), 10);
      const titles = lenses.map((l) => l.command?.title ?? '');
      assert.ok(titles.includes('1 call'), titles.join(' | '));
    },
  ],
  [
    'diagnostics: unknown method / publication / template',
    async () => {
      const js = vscode.languages.getDiagnostics(uri('client/legacy/logic/userCard.js')).map((d) => d.message);
      const html = vscode.languages.getDiagnostics(uri('imports/ui/components/userCard.html')).map((d) => d.message);
      assert.ok(js.some((m) => m.includes('users.typo')), js.join(' | '));
      assert.ok(js.some((m) => m.includes('users.unknownPub')), js.join(' | '));
      assert.ok(html.some((m) => m.includes('missingTemplate')), html.join(' | '));
    },
  ],
  [
    'workspace symbols: methods and templates',
    async () => {
      const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', 'userCard');
      assert.ok(syms.some((s) => s.name === 'userCard' && s.kind === vscode.SymbolKind.Class));
    },
  ],
  [
    'switch HTML ⇄ JS command',
    async () => {
      const [doc, pos] = await posOf('imports/ui/components/userCard.html', 'Save<');
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(pos, pos);
      await vscode.commands.executeCommand('meteorPower.switchTemplateFile');
      assert.equal(rel(vscode.window.activeTextEditor!.document.uri), 'client/legacy/logic/userCard.js');
    },
  ],
];

/** Renders a tree provider as indented text (labels + descriptions), expanding everything up to `depth`. */
async function renderTree(provider: vscode.TreeDataProvider<unknown>, depth = 6): Promise<string> {
  const lines: string[] = [];
  const visit = async (el: unknown, level: number) => {
    const kids = (await provider.getChildren(el as never)) ?? [];
    for (const k of kids) {
      const item = await provider.getTreeItem(k as never);
      const label = typeof item.label === 'string' ? item.label : item.label?.label;
      lines.push(`${'  '.repeat(level)}${label}${item.description ? `  — ${item.description}` : ''}`);
      if (level < depth && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) await visit(k, level + 1);
    }
  };
  await visit(undefined, 0);
  return lines.join('\n');
}

let api: any;

checks.push([
  'sidebar trees: namespaces, unknown calls, template hierarchy',
  async () => {
    const methods = await renderTree(api.trees.methods);
    const templates = await renderTree(api.trees.templates);
    console.log('\n--- Methods ---\n' + methods + '\n--- Templates ---\n' + templates + '\n');
    assert.match(methods, /^users\s+—/m);
    assert.match(methods, /^ {2}profile/m);
    assert.match(methods, /Calls to undefined methods/);
    assert.match(templates, /^mainLayout/m);
    assert.match(templates, /^ {2}userCard/m);
    assert.match(templates, /^ {4}avatar/m);
  },
]);

checks.push([
  'symlinked folders: a file reachable from 4 paths is indexed once',
  async () => {
    const found = await vscode.workspace.findFiles('**/shared.js');
    assert.equal(found.length, 4, `findFiles should see the file through the 3 links too: ${found.map(rel).join(', ')}`);
    assert.equal(api.index.a.publications.get('shared.items')?.length, 1);
    const defs = api.index.a.methods.get('shared.ping');
    assert.equal(defs?.length, 1);
    assert.equal(rel(vscode.Uri.file(defs[0].loc.file)), 'common/shared.js');

    // from a call site: go to the real file
    const [doc, pos] = await posOf('client/sharedUsage.js', "'shared.ping'", 2);
    const d = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    assert.deepEqual(d.map((x) => rel(targetUri(x))), ['common/shared.js']);

    // the file opened through a link still works and does not create duplicates
    const [linked, lpos] = await posOf('apps/b/imports/common/shared.js', "'shared.ping'", 2);
    await vscode.window.showTextDocument(linked);
    const self = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', linked.uri, lpos);
    assert.equal(rel(targetUri(self[0])), 'apps/b/imports/common/shared.js');
    const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', linked.uri, lpos);
    assert.ok(refs.some((r) => rel(r.uri) === 'client/sharedUsage.js'));
    assert.equal(api.index.a.methods.get('shared.ping')?.length, 1);
  },
]);

checks.push([
  'settings: custom wrappers, import aliases, public/ excluded',
  async () => {
    // .vscode/settings.json of the fixture declares callMethod / createMethod / useSubscribe / ...
    const [doc, pos] = await posOf('client/orders.js', "callMethod('orders.create'", 13);
    const d = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    assert.deepEqual(d.map((x) => rel(targetUri(x))), ['imports/api/orders/methods.js']);
    const [, apos] = await posOf('client/orders.js', 'OrderNames.CANCEL', 12);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, apos);
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.match(text, /async 'orders\.cancel'\(\{ orderId \}\)/);
    assert.equal(vscode.languages.getDiagnostics(doc.uri).length, 0);
    assert.ok(!api.index.a.templateNames.has('notBlaze'), 'public/ must not be indexed');
    // not even when opened in an editor
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri('public/landing.html')));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!api.index.a.templateNames.has('notBlaze'), 'an open public/ file must not be indexed');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  },
]);

checks.push([
  'Explorer: Exclude from / Include in Meteor Power edit meteorPower.exclude and reindex',
  async () => {
    const settingsFile = uri('.vscode/settings.json');
    const original = await vscode.workspace.fs.readFile(settingsFile);
    const until = async (what: string, ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) {
        await new Promise((r) => setTimeout(r, 100));
        await api.ready();
      }
      assert.ok(ok(), what);
    };
    const exclude = () => vscode.workspace.getConfiguration('meteorPower').get<string[]>('exclude', []);
    try {
      // public/ is hidden by the default `**/public/**`: included again with `!public/**`
      await vscode.commands.executeCommand('meteorPower.includePath', uri('public'));
      assert.equal(exclude().at(-1), '!public/**');
      await until('public/ indexed', () => api.index.a.templateNames.has('notBlaze'));
      // a folder and a file selected together
      await vscode.commands.executeCommand('meteorPower.excludePath', uri('imports/api/orders'), [uri('imports/api/orders'), uri('client/orders.js')]);
      assert.deepEqual(exclude().slice(-2), ['imports/api/orders/**', 'client/orders.js']);
      await until('orders excluded', () => !api.index.a.methods.has('orders.cancel') && !api.index.facts(uri('client/orders.js').fsPath));
      // and back
      await vscode.commands.executeCommand('meteorPower.includePath', uri('imports/api/orders'), [uri('imports/api/orders'), uri('client/orders.js'), uri('public')]);
      await vscode.commands.executeCommand('meteorPower.excludePath', uri('public'));
      await until('back to the defaults', () => api.index.a.methods.has('orders.cancel') && !api.index.a.templateNames.has('notBlaze'));
      assert.ok(!exclude().some((p) => p.includes('orders') || p.startsWith('!')), exclude().join(', '));
    } finally {
      await vscode.workspace.getConfiguration('meteorPower').update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.writeFile(settingsFile, original);
      await until('settings restored', () => !api.index.a.templateNames.has('notBlaze') && api.index.a.methods.has('orders.cancel'));
    }
  },
]);

const until = async (what: string | (() => string), ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 100));
    await api.ready();
  }
  assert.ok(ok(), typeof what === 'string' ? what : what());
};
const ours = (u: vscode.Uri) => vscode.languages.getDiagnostics(u).filter((d) => d.source === 'Meteor Power');
const write = (rel: string, text: string) => vscode.workspace.fs.writeFile(uri(rel), Buffer.from(text));

checks.push([
  'stale diagnostics: removed after exclusion and deletion; diagnostics of other tools untouched',
  async () => {
    const file = uri('scratch/stale.js');
    const other = vscode.languages.createDiagnosticCollection('otherTool');
    const settingsFile = uri('.vscode/settings.json');
    const original = await vscode.workspace.fs.readFile(settingsFile);
    try {
      await write('scratch/stale.js', "import { Meteor } from 'meteor/meteor';\nMeteor.call('stale.unknown');\n");
      await until('call reported', () => ours(file).some((d) => d.message.includes('stale.unknown')));
      other.set(file, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), 'from another tool')]);
      other.set(uri('client/orders.js'), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), 'from another tool')]);

      await vscode.workspace.getConfiguration('meteorPower').update('exclude', ['scratch/**'], vscode.ConfigurationTarget.Workspace);
      await until('excluded: our diagnostic gone', () => !ours(file).length && !api.index.facts(file.fsPath));
      await vscode.workspace.getConfiguration('meteorPower').update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      await until('included again: reported again', () => ours(file).length === 1);

      await vscode.workspace.fs.delete(file);
      await until('deleted: our diagnostic gone', () => !ours(file).length && !api.index.facts(file.fsPath));
      for (const u of [file, uri('client/orders.js')]) {
        assert.deepEqual(vscode.languages.getDiagnostics(u).filter((d) => d.message === 'from another tool').length, 1, rel(u));
      }
    } finally {
      other.dispose();
      await vscode.workspace.getConfiguration('meteorPower').update('exclude', undefined, vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.fs.delete(uri('scratch'), { recursive: true, useTrash: false }).then(undefined, () => undefined);
      await vscode.workspace.fs.writeFile(settingsFile, original);
    }
  },
]);

checks.push([
  'meteor build output: excluded as soon as star.json appears, even when opened; its diagnostics disappear',
  async () => {
    // a folder with any name: a renamed bundle (the default `**/bundle/**` does not match): only star.json says it is a build
    const appFile = uri('release-out/site-2026/programs/server/app/app.js');
    await write('release-out/site-2026/programs/server/app/app.js', "Meteor.methods({ 'bundle.only'() {} });\nMeteor.call('bundle.missing');\n");
    try {
      // before the manifest it is ordinary code
      await until('indexed before the manifest', () => api.index.a.methods.has('bundle.only') && ours(appFile).length === 1);
      await write('release-out/site-2026/star.json', JSON.stringify({ format: 'site-archive-pre1', programs: [{ name: 'server', path: 'programs/server/program.json' }] }));
      await until('build output dropped', () => !api.index.a.methods.has('bundle.only') && !ours(appFile).length);
      // a new file in it, and an open one, are not indexed
      await write('release-out/site-2026/programs/web.browser/app/app.js', "Meteor.call('bundle.client');\n");
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(appFile));
      await new Promise((r) => setTimeout(r, 800));
      await api.ready();
      assert.ok(!api.index.a.methods.has('bundle.only'), 'an open build file must not be indexed');
      assert.ok(!api.index.allFacts().some((f: { file: string }) => f.file.toLowerCase().includes('release-out')), 'no build file indexed');
      assert.equal(ours(appFile).length, 0);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      await vscode.workspace.fs.delete(uri('release-out'), { recursive: true, useTrash: false }).then(undefined, () => undefined);
    }
  },
]);

checks.push([
  'Meteor packages: definitions read from the last build; a package read nowhere makes diagnostics Information',
  async () => {
    const check = uri('client/pkgcheck.js');
    const built = uri('.meteor/local/build/programs/server/packages/acme_tools.js');
    try {
      // synthetic build of the app (written first: older than .meteor/versions, so it is not trusted to be complete)
      await write('.meteor/local/build/star.json', JSON.stringify({ format: 'site-archive-pre1' }));
      await write('.meteor/local/build/programs/server/packages/acme_tools.js', "var Meteor = Package.meteor.Meteor;\nMeteor.methods({ 'acme.ping'() {} });\nMeteor.call('acme.internal');\n");
      await write('client/pkgcheck.js', "import { Meteor } from 'meteor/meteor';\nMeteor.call('acme.ping');\nMeteor.call('pkg.nowhere');\n");
      // before .meteor/versions the app has no packages: both calls are unknown
      await until('calls reported', () => ours(check).length === 2);
      await new Promise((r) => setTimeout(r, 200));
      await write('.meteor/versions', 'acme:tools@1.0.0\nmissing:pkg@1.0.0\n');
      await until('package read', () => api.index.a.methods.has('acme.ping'));
      await until('uncertain diagnostic', () => ours(check).length === 1 && ours(check)[0].severity === vscode.DiagnosticSeverity.Information);
      const [d] = ours(check);
      assert.match(d.message, /'pkg\.nowhere'.*Not certain: package missing:pkg not found in the app's last build or in the Meteor package cache\./);
      // the package file is never diagnosed, not even when opened
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(built));
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(ours(built).length, 0);
      assert.ok(api.index.a.methods.has('acme.ping'));
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
      for (const rel of ['.meteor/versions', '.meteor/local', 'client/pkgcheck.js']) {
        await vscode.workspace.fs.delete(uri(rel), { recursive: true, useTrash: false }).then(undefined, () => undefined);
      }
      await until('back to no packages', () => !api.index.a.methods.has('acme.ping') && !ours(check).length);
    }
  },
]);

checks.push([
  'Meteor packages from the package cache: selected version, version change, unreachable version, local package edits',
  async () => {
    // METEOR_WAREHOUSE_DIR points to test/fixtures/warehouse (see run.ts): synthetic packages only
    const js = uri('client/pkgcache.js');
    const html = uri('client/pkgcache.html');
    const pkgFile = vscode.Uri.file(path.resolve(root(), '..', 'warehouse', 'packages', 'example_auth', '2.0.0', 'os', 'server.js'));
    const names = (u: vscode.Uri) => ours(u).map((d) => /'([^']+)'/.exec(d.message)![1]).sort();
    const severityOf = (u: vscode.Uri, name: string) => ours(u).find((d) => d.message.includes(`'${name}'`))?.severity;
    try {
      await write(
        'client/pkgcache.js',
        "import { Meteor } from 'meteor/meteor';\nMeteor.callAsync('example.performTask', {});\nMeteor.callAsync('example.v1only');\nMeteor.callAsync('example.v2only');\nMeteor.call('example.clientStub');\nMeteor.call('example.nowhere');\nMeteor.call('example.local.v2');\n",
      );
      await write('client/pkgcache.html', '<template name="pkgCache">{{> exampleRegion}}{{> exampleMissing}}</template>\n');
      await until('everything unknown before .meteor/versions', () => names(js).length === 6 && names(html).length === 2);

      // 1, 2, 3, 9: the selected packages resolve their names, the old diagnostics go away, the missing ones stay
      // (templating: a synthetic package without code, it makes the app a Blaze app)
      await write('.meteor/versions', 'example:auth@1.0.0\nexample:router@1.4.0\ntemplating@1.0.0\n');
      await until(() => `version 1.0.0 resolved: ${names(js).join()} | ${names(html).join()}`, () => names(js).join() === 'example.clientStub,example.local.v2,example.nowhere,example.v2only' && names(html).join() === 'exampleMissing');
      assert.equal(severityOf(js, 'example.nowhere'), vscode.DiagnosticSeverity.Warning);
      // go to definition lands in the package
      const [doc, pos] = await posOf('client/pkgcache.js', "'example.performTask'", 3);
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
      assert.ok(defs.some((d) => targetUri(d).fsPath.toLowerCase().endsWith(path.join('example_auth', '1.0.0', 'os', 'server.js'))), JSON.stringify(defs.map((d) => targetUri(d).fsPath)));

      // 8: another version selected: the index follows it
      await write('.meteor/versions', 'example:auth@2.0.0\nexample:router@1.4.0\ntemplating@1.0.0\n');
      await until(() => `version 2.0.0 resolved: ${names(js).join()}`, () => names(js).join() === 'example.clientStub,example.local.v2,example.nowhere,example.v1only');

      // 10: a package file opened in an editor is never diagnosed (it calls an unknown method)
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pkgFile));
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(ours(pkgFile).length, 0);
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      // 8: a local package: its source is indexed as workspace code and follows the edits
      await write('packages/example-local/package.js', "Package.describe({ name: 'example:local' });\nPackage.onUse((api) => { api.mainModule('methods.js', 'server'); });\n");
      await write('packages/example-local/methods.js', "Meteor.methods({ 'example.local.v1'() {} });\n");
      await until('local package indexed', () => api.index.a.methods.has('example.local.v1'));
      await write('packages/example-local/methods.js', "Meteor.methods({ 'example.local.v2'() {} });\n");
      await until('local package edit followed', () => !names(js).includes('example.local.v2') && !api.index.a.methods.has('example.local.v1'));

      // 7: a selected version that cannot be found: incomplete analysis, not a certain absence
      await write('.meteor/versions', 'example:auth@9.9.9\nexample:router@1.4.0\ntemplating@1.0.0\n');
      await until(() => `unreachable version: ${ours(js).map((d) => `${d.severity} ${d.message}`).join(' / ')}`, () => names(js).includes('example.performTask') && severityOf(js, 'example.nowhere') === vscode.DiagnosticSeverity.Information);
      assert.match(ours(js).find((d) => d.message.includes('example.nowhere'))!.message, /Not certain: package example:auth not found in the app's last build or in the Meteor package cache\.$/);
      assert.equal(names(html).join(), 'exampleMissing');
    } finally {
      for (const rel of ['.meteor/versions', 'client/pkgcache.js', 'client/pkgcache.html', 'packages']) {
        await vscode.workspace.fs.delete(uri(rel), { recursive: true, useTrash: false }).then(undefined, () => undefined);
      }
      await until(() => `back to no packages: ${api.index.a.methods.has('example.performTask')} ${ours(js).map((d) => d.message).join(' / ')}`, () => !api.index.a.methods.has('example.performTask') && !ours(js).length);
    }
  },
]);

checks.push([
  'ValidatedMethod objects: Ctrl+Click and references',
  async () => {
    const [doc, pos] = await posOf('client/tasksUsage.js', 'Tasks.insertTask', 8);
    const d = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    // (the built-in TypeScript provider may add the variable declaration)
    const nameLine = d.find((x) => rel(targetUri(x)) === 'imports/api/tasks/tasks.js' && ('targetUri' in x ? x.targetSelectionRange ?? x.targetRange : x.range).start.line === 4);
    assert.ok(nameLine, JSON.stringify(d.map((x) => rel(targetUri(x)))));
    const [def, dpos] = await posOf('imports/api/tasks/tasks.js', "'tasks.insert'", 2);
    const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', def.uri, dpos);
    assert.equal(refs.filter((r) => rel(r.uri) === 'client/tasksUsage.js').length, 4);
  },
]);

checks.push([
  'rename provider: helper in HTML → JS key + HTML usage',
  async () => {
    const [doc, pos] = await posOf('imports/ui/components/userCard.html', '{{fullName}}', 4);
    const we = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, pos, 'displayName');
    const files = we.entries().map(([u, edits]) => `${rel(u)}:${edits.length}`).sort();
    assert.deepEqual(files, ['client/legacy/logic/userCard.js:1', 'imports/ui/components/userCard.html:1']);
  },
]);

checks.push([
  'rename command (F2): renames a method in every file, then the changes are reverted',
  async () => {
    const [doc, pos] = await posOf('client/legacy/logic/userCard.js', "'users.update'", 3);
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(pos, pos);
    const original = vscode.window.showInputBox;
    (vscode.window as any).showInputBox = async () => 'users.edit';
    try {
      await vscode.commands.executeCommand('meteorPower.rename');
    } finally {
      (vscode.window as any).showInputBox = original;
    }
    const defDoc = await vscode.workspace.openTextDocument(uri('imports/api/users/methods.js'));
    const callText = doc.getText();
    const defText = defDoc.getText();
    // undo: revert both documents (nothing was saved to disk)
    for (const d of [doc, defDoc]) {
      await vscode.window.showTextDocument(d);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    assert.ok(callText.includes("Meteor.callAsync('users.edit'"), 'call not renamed');
    assert.ok(defText.includes("'users.edit': async function"), 'definition not renamed');
    assert.ok(doc.getText().includes("'users.update'"), 'revert failed');
  },
]);

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'meteor-power')!;
  api = await ext.activate();
  await api.ready();
  // diagnostics are refreshed with a debounce
  await new Promise((r) => setTimeout(r, 600));

  const failures: string[] = [];
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (e) {
      console.log(`  ✖ ${name}\n      ${(e as Error).message}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} integration check(s) failed`);
}
