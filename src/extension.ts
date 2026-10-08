import * as vscode from 'vscode';
import { MeteorIndex } from './core/index';
import { registerCommands } from './vscode/commands';
import { registerRename } from './vscode/rename';
import { WorkspaceIndexer } from './vscode/indexer';
import { MeteorCodeLensProvider, MeteorDiagnostics, registerProviders, SELECTOR } from './vscode/providers';
import { NamesTree, TemplatesMode, TemplatesTree } from './vscode/trees';

export interface MeteorPowerApi {
  index: MeteorIndex;
  ready: () => Promise<void>;
  trees: { methods: NamesTree; publications: NamesTree; templates: TemplatesTree };
}

export function activate(ctx: vscode.ExtensionContext): MeteorPowerApi {
  const index = new MeteorIndex();
  const indexer = new WorkspaceIndexer(index);
  ctx.subscriptions.push(indexer);

  registerProviders(ctx, indexer);

  const codeLens = new MeteorCodeLensProvider(indexer);
  ctx.subscriptions.push(vscode.languages.registerCodeLensProvider(SELECTOR, codeLens));

  const diagnostics = new MeteorDiagnostics(indexer);
  ctx.subscriptions.push(diagnostics, indexer.onDidChange(() => diagnostics.refresh()));

  const mode = ctx.workspaceState.get<TemplatesMode>('meteorPower.templatesMode', 'hierarchy');
  void vscode.commands.executeCommand('setContext', 'meteorPower.templatesMode', mode);
  const templatesTree = new TemplatesTree(indexer, mode);
  const methodsTree = new NamesTree(indexer, 'methods');
  const publicationsTree = new NamesTree(indexer, 'publications');
  ctx.subscriptions.push(
    vscode.window.createTreeView('meteorPower.methods', { treeDataProvider: methodsTree, showCollapseAll: true }),
    vscode.window.createTreeView('meteorPower.publications', { treeDataProvider: publicationsTree, showCollapseAll: true }),
    vscode.window.createTreeView('meteorPower.templates', { treeDataProvider: templatesTree, showCollapseAll: true }),
  );

  registerCommands(ctx, indexer, templatesTree);
  registerRename(ctx, indexer);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'workbench.view.extension.meteorPower';
  const updateStatus = () => {
    const a = index.a;
    status.text = `$(zap) ${a.methods.size} methods · ${a.templateNames.size} templates`;
    status.tooltip = `Meteor Power: ${a.methods.size} methods, ${a.publications.size} publications, ${a.templateNames.size} templates`;
    status.show();
  };
  ctx.subscriptions.push(status, indexer.onDidChange(updateStatus));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('meteorPower.diagnostics')) diagnostics.refresh();
      if (e.affectsConfiguration('meteorPower.codeLens')) codeLens.refresh();
    }),
  );

  void indexer.rescan();
  return { index, ready: () => indexer.ready, trees: { methods: methodsTree, publications: publicationsTree, templates: templatesTree } };
}

export function deactivate() {}
