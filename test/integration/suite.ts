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
      assert.ok(titles.includes('1 chiamata'), titles.join(' | '));
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
      const [doc, pos] = await posOf('imports/ui/components/userCard.html', 'Salva');
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(pos, pos);
      await vscode.commands.executeCommand('meteorpower.switchTemplateFile');
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
    console.log('\n--- Metodi ---\n' + methods + '\n--- Template ---\n' + templates + '\n');
    assert.match(methods, /^users\s+—/m);
    assert.match(methods, /^ {2}profile/m);
    assert.match(methods, /Chiamate a metodi non definiti/);
    assert.match(templates, /^mainLayout/m);
    assert.match(templates, /^ {2}userCard/m);
    assert.match(templates, /^ {4}avatar/m);
  },
]);

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'meteorpower')!;
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
