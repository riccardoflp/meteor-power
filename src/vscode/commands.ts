import * as path from 'path';
import * as vscode from 'vscode';
import { Loc } from '../core/model';
import { enclosingTemplate, templateHtmlDefs, templateJsDefs, templatesInFile } from '../core/queries';
import { openLoc, relPath, toPos } from './convert';
import { WorkspaceIndexer } from './indexer';
import { TemplatesMode, TemplatesTree } from './trees';

interface LocPick extends vscode.QuickPickItem {
  loc: Loc;
}

export function registerCommands(ctx: vscode.ExtensionContext, indexer: WorkspaceIndexer, templatesTree: TemplatesTree) {
  const index = indexer.index;

  const pickAndOpen = async (items: LocPick[], placeHolder: string) => {
    if (!items.length) {
      vscode.window.showInformationMessage('MeteorPower: nothing to show.');
      return;
    }
    if (items.length === 1) return openLoc(items[0].loc);
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    if (picked) await openLoc(picked.loc);
  };

  const nameOfArg = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') return arg;
    if (arg && typeof arg === 'object' && 'name' in arg && typeof (arg as { name: unknown }).name === 'string') return (arg as { name: string }).name;
    return undefined;
  };

  const openTemplateHtml = (name: string) =>
    pickAndOpen(
      templateHtmlDefs(index.a, name).map((d) => ({ label: name, description: relPath(d.loc.file), loc: d.loc })),
      `HTML of ${name}`,
    );

  const openTemplateJs = (name: string) => {
    const parts = index.a.parts.get(name) ?? [];
    // one entry per file, pointing at the first part (helpers first if any)
    const byFile = new Map<string, Loc>();
    for (const p of [...parts].sort((x, y) => (x.kind === 'helpers' ? -1 : y.kind === 'helpers' ? 1 : 0))) {
      if (!byFile.has(p.nameLoc.file)) byFile.set(p.nameLoc.file, p.nameLoc);
    }
    return pickAndOpen(
      [...byFile.values()].map((loc) => ({ label: path.basename(loc.file), description: relPath(loc.file), loc })),
      `JS of ${name}`,
    );
  };

  const setTemplatesMode = (mode: TemplatesMode) => {
    templatesTree.setMode(mode);
    void ctx.workspaceState.update('meteorpower.templatesMode', mode);
    void vscode.commands.executeCommand('setContext', 'meteorpower.templatesMode', mode);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('meteorpower.refresh', () => indexer.rescan()),

    vscode.commands.registerCommand('meteorpower.openLocation', (loc: Loc) => openLoc(loc)),

    vscode.commands.registerCommand('meteorpower.openHtml', (arg: unknown) => {
      const name = nameOfArg(arg);
      if (name) return openTemplateHtml(name);
    }),

    vscode.commands.registerCommand('meteorpower.openJs', (arg: unknown) => {
      const name = nameOfArg(arg);
      if (name) return openTemplateJs(name);
    }),

    vscode.commands.registerCommand('meteorpower.templates.showHierarchy', () => setTemplatesMode('hierarchy')),
    vscode.commands.registerCommand('meteorpower.templates.showFlat', () => setTemplatesMode('flat')),

    vscode.commands.registerCommand('meteorpower.goToMethod', async () => {
      await indexer.ready;
      const items: LocPick[] = [];
      for (const [name, defs] of index.a.methods) {
        for (const d of defs) {
          const uses = index.a.calls.get(name)?.length ?? 0;
          items.push({
            label: `$(symbol-method) ${name}`,
            description: `(${d.params.join(', ')}) · ${d.env} · ${uses} ${uses === 1 ? 'call' : 'calls'}`,
            detail: relPath(d.loc.file),
            loc: d.loc,
          });
        }
      }
      items.sort((x, y) => x.label.localeCompare(y.label));
      return pickAndOpen(items, 'Search a Meteor method');
    }),

    vscode.commands.registerCommand('meteorpower.goToPublication', async () => {
      await indexer.ready;
      const items: LocPick[] = [];
      for (const [name, defs] of index.a.publications) {
        for (const d of defs) {
          const uses = index.a.subscriptions.get(name)?.length ?? 0;
          items.push({ label: `$(radio-tower) ${name}`, description: `(${d.params.join(', ')}) · ${uses} ${uses === 1 ? 'subscription' : 'subscriptions'}`, detail: relPath(d.loc.file), loc: d.loc });
        }
      }
      items.sort((x, y) => x.label.localeCompare(y.label));
      return pickAndOpen(items, 'Search a publication');
    }),

    vscode.commands.registerCommand('meteorpower.goToTemplate', async () => {
      await indexer.ready;
      const a = index.a;
      const items: LocPick[] = [];
      for (const name of [...a.templateNames].sort((x, y) => x.localeCompare(y))) {
        const html = a.templates.get(name)?.[0];
        const part = a.parts.get(name)?.[0];
        const loc = html?.loc ?? part?.nameLoc;
        if (!loc) continue;
        const helpers = a.helpers.get(name)?.size ?? 0;
        const events = a.events.get(name)?.length ?? 0;
        items.push({
          label: `$(symbol-class) ${name}`,
          description: `${helpers} ${helpers === 1 ? 'helper' : 'helpers'} · ${events} ${events === 1 ? 'event' : 'events'}`,
          detail: html ? relPath(html.loc.file) : `JS only: ${relPath(part!.nameLoc.file)}`,
          loc,
        });
      }
      return pickAndOpen(items, 'Search a Blaze template');
    }),

    vscode.commands.registerCommand('meteorpower.switchTemplateFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      indexer.syncDocument(doc);
      const file = doc.uri.fsPath;
      let name = enclosingTemplate(index, file, toPos(editor.selection.active));
      if (!name) {
        const names = templatesInFile(index, file);
        if (names.length === 1) name = names[0];
        else if (names.length > 1) name = await vscode.window.showQuickPick(names, { placeHolder: 'Which template?' });
      }
      if (!name) {
        vscode.window.showInformationMessage('MeteorPower: no Blaze template in this file.');
        return;
      }
      const isHtml = file.toLowerCase().endsWith('.html');
      const targets = isHtml ? templateJsDefs(index.a, name) : templateHtmlDefs(index.a, name);
      if (!targets.length) {
        vscode.window.showInformationMessage(`MeteorPower: no ${isHtml ? 'JS' : 'HTML'} file found for template '${name}'.`);
        return;
      }
      return isHtml ? openTemplateJs(name) : openTemplateHtml(name);
    }),
  );
}
