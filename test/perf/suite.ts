import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const t0 = Date.now();
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'meteor-power')!;
  const api = await ext.activate();
  await api.ready();
  const a = api.index.a;
  console.log(`ready after ${Date.now() - t0} ms: ${a.methods.size} methods, ${a.templateNames.size} templates, ${api.index.apps.size} apps`);
  for (const name of ['methods', 'publications', 'templates'] as const) {
    const t = Date.now();
    const tree = api.trees[name];
    tree.refresh();
    const roots = await tree.getChildren(undefined);
    for (const r of roots) await tree.getTreeItem(r);
    console.log(`${name} tree: ${roots.length} roots in ${Date.now() - t} ms`);
  }
  await vscode.commands.executeCommand('workbench.view.extension.meteorPower');
  // give the log a moment to be flushed
  await new Promise((r) => setTimeout(r, 1500));
}
