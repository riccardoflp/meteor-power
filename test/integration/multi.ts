import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Workspace with two Meteor apps (admin, web), a shared folder symlinked into both as imports/shared,
 * and local packages in packages/ (acme:audit used by admin, acme:logger used by acme:audit, acme:unused).
 */
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const uri = (rel: string) => vscode.Uri.file(path.join(root(), rel));
const rel = (u: vscode.Uri) => path.relative(root(), u.fsPath).replace(/\\/g, '/');
const targetUri = (d: vscode.Location | vscode.LocationLink) => ('targetUri' in d ? d.targetUri : d.uri);

async function definitionsAt(file: string, needle: string, delta: number): Promise<string[]> {
  const doc = await vscode.workspace.openTextDocument(uri(file));
  const at = doc.getText().indexOf(needle);
  assert.ok(at >= 0, `"${needle}" not in ${file}`);
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, doc.positionAt(at + delta));
  return defs.map((d) => rel(targetUri(d))).sort();
}

const messages = (file: string) => vscode.languages.getDiagnostics(uri(file)).map((d) => d.message);

async function renderRoots(provider: vscode.TreeDataProvider<unknown>): Promise<string[]> {
  const kids = (await provider.getChildren(undefined)) ?? [];
  const out: string[] = [];
  for (const k of kids) {
    const item = await provider.getTreeItem(k as never);
    out.push(`${typeof item.label === 'string' ? item.label : item.label?.label}${item.description ? ` — ${item.description}` : ''}`);
  }
  return out;
}

let api: any;

const checks: [string, () => Promise<void>][] = [
  [
    'apps detected, shared symlinked code belongs to both, packages to the apps using them',
    async () => {
      assert.deepEqual([...api.index.apps.values()].sort(), ['admin', 'web']);
      const names = (file: string) => api.index.appsOf(uri(file).fsPath).map((id: string) => api.index.appName(id));
      assert.deepEqual(names('shared/api.js'), ['admin', 'web']);
      assert.deepEqual(names('admin/client/main.js'), ['admin']);
      assert.deepEqual(names('packages/audit/audit.js'), ['admin']);
      assert.deepEqual(names('packages/logger/logger.js'), ['admin']);
      assert.deepEqual(names('packages/unused/unused.js'), []);
    },
  ],
  [
    'definitions are resolved inside the app of the file',
    async () => {
      assert.deepEqual(await definitionsAt('admin/client/main.js', "'common.ping'", 2), ['admin/server/methods.js']);
      assert.deepEqual(await definitionsAt('web/client/main.js', "'common.ping'", 2), ['web/server/methods.js']);
      // the shared file opened through the symlink of an app: it runs in both apps
      assert.deepEqual(await definitionsAt('web/imports/shared/api.js', "'common.ping'", 2), ['admin/server/methods.js', 'web/server/methods.js']);
      assert.deepEqual(await definitionsAt('web/client/main.html', '{{title}}', 3), ['web/client/main.js']);
      // (the built-in TypeScript provider adds the `PAGE` import)
      const home = await definitionsAt('admin/client/main.js', 'PAGE.HOME', 6);
      assert.ok(home.includes('admin/server/methods.js') && !home.includes('web/server/methods.js'), home.join(', '));
      assert.deepEqual(await definitionsAt('admin/client/main.js', "'logger.write'", 2), ['packages/logger/logger.js']);
    },
  ],
  [
    'diagnostics: missing in the app, or in one of the apps of shared code',
    async () => {
      assert.deepEqual(messages('admin/client/main.js'), ["Meteor method 'web.signup' is not defined in app 'admin'."]);
      assert.deepEqual(messages('web/client/main.js'), ["Meteor method 'audit.log' is not defined in app 'web'."]);
      assert.deepEqual(messages('shared/api.js'), ["Meteor method 'admin.purge' is not defined in app 'web'."]);
    },
  ],
  [
    'hover shows the app of the definition',
    async () => {
      const doc = await vscode.workspace.openTextDocument(uri('admin/client/main.js'));
      const pos = doc.positionAt(doc.getText().indexOf("'common.ping'") + 2);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos);
      const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
      assert.match(text, /\$\(package\) admin/);
      assert.doesNotMatch(text, /Defined 2 times/);
    },
  ],
  [
    'side panel: all apps, then filtered on one app',
    async () => {
      const all = await renderRoots(api.trees.methods);
      console.log('\n--- Methods (all apps) ---\n' + all.join('\n'));
      assert.ok(all.some((l) => l.startsWith('web')), all.join(' | '));
      assert.ok(all.some((l) => l.startsWith('admin')), all.join(' | '));
      const adminId = [...api.index.apps.entries()].find(([, name]: [string, string]) => name === 'admin')![0];
      api.filter.app = adminId;
      try {
        const admin = await renderRoots(api.trees.methods);
        console.log('--- Methods (admin) ---\n' + admin.join('\n') + '\n');
        assert.ok(!admin.some((l) => l.startsWith('web ')), admin.join(' | '));
        assert.ok(admin.some((l) => l.startsWith('audit')), admin.join(' | '));
        assert.ok(admin.some((l) => l.startsWith('Calls to undefined methods — 1')), admin.join(' | '));
      } finally {
        api.filter.app = null;
      }
    },
  ],
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'meteor-power')!;
  api = await ext.activate();
  await api.ready();
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
