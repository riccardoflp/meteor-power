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
