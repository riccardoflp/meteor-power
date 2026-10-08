import * as path from 'path';
import * as vscode from 'vscode';
import { Scope } from '../core/index';
import { Loc } from '../core/model';
import { enclosingTemplate, templateHtmlDefs, templateJsDefs, templatesInFile } from '../core/queries';
import { appsLabel, openLoc, relPath, toPos } from './convert';
import { WorkspaceIndexer } from './indexer';
import { AppFilter, TemplatesMode, TemplatesTree } from './trees';

interface LocPick extends vscode.QuickPickItem {
  loc: Loc;
}

export function registerCommands(ctx: vscode.ExtensionContext, indexer: WorkspaceIndexer, templatesTree: TemplatesTree, filter: AppFilter) {
  const index = indexer.index;
  /** `path · app` */
  const where = (file: string) => {
    const apps = appsLabel(index, file);
    return apps ? `${relPath(file)} · ${apps}` : relPath(file);
  };

  const pickAndOpen = async (items: LocPick[], placeHolder: string) => {
    if (!items.length) {
      vscode.window.showInformationMessage('Meteor Power: nothing to show.');
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

  const openTemplateHtml = (name: string, scope: Scope) =>
    pickAndOpen(
      templateHtmlDefs(index, name, scope).map((d) => ({ label: name, description: where(d.loc.file), loc: d.loc })),
      `HTML of ${name}`,
    );

  const openTemplateJs = (name: string, scope: Scope) => {
    const parts = (index.a.parts.get(name) ?? []).filter((p) => index.inScope(scope, p.nameLoc.file));
    // one entry per file, pointing at the first part (helpers first if any)
    const byFile = new Map<string, Loc>();
    for (const p of [...parts].sort((x, y) => (x.kind === 'helpers' ? -1 : y.kind === 'helpers' ? 1 : 0))) {
      if (!byFile.has(p.nameLoc.file)) byFile.set(p.nameLoc.file, p.nameLoc);
    }
    // `Template.x.copyAs('name')`
    for (const d of templateJsDefs(index, name, scope)) if (!byFile.has(d.loc.file)) byFile.set(d.loc.file, d.loc);
    return pickAndOpen(
      [...byFile.values()].map((loc) => ({ label: path.basename(loc.file), description: where(loc.file), loc })),
      `JS of ${name}`,
    );
  };

  const setTemplatesMode = (mode: TemplatesMode) => {
    templatesTree.setMode(mode);
    void ctx.workspaceState.update('meteorPower.templatesMode', mode);
    void vscode.commands.executeCommand('setContext', 'meteorPower.templatesMode', mode);
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('meteorPower.refresh', () => indexer.rescan()),

    vscode.commands.registerCommand('meteorPower.openLocation', (loc: Loc) => openLoc(loc)),

    vscode.commands.registerCommand('meteorPower.openHtml', (arg: unknown) => {
      const name = nameOfArg(arg);
      if (name) return openTemplateHtml(name, filter.scope);
    }),

    vscode.commands.registerCommand('meteorPower.openJs', (arg: unknown) => {
      const name = nameOfArg(arg);
      if (name) return openTemplateJs(name, filter.scope);
    }),

    vscode.commands.registerCommand('meteorPower.selectApp', async () => {
      await indexer.ready;
      type AppPick = vscode.QuickPickItem & { app: string | null };
      const items: AppPick[] = [
        { label: '$(globe) All apps', description: filter.app === null ? 'current' : '', app: null },
        ...[...index.apps].map(([id, name]) => ({ label: `$(package) ${name}`, description: filter.app === id ? 'current' : '', detail: id, app: id })),
      ];
      if (items.length <= 2) {
        vscode.window.showInformationMessage('Meteor Power: this workspace contains a single Meteor app.');
        return;
      }
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Show the methods, publications and templates of…' });
      if (!picked) return;
      filter.app = picked.app;
      void ctx.workspaceState.update('meteorPower.app', picked.app);
    }),

    vscode.commands.registerCommand('meteorPower.templates.showHierarchy', () => setTemplatesMode('hierarchy')),
    vscode.commands.registerCommand('meteorPower.templates.showFlat', () => setTemplatesMode('flat')),

    vscode.commands.registerCommand('meteorPower.goToMethod', async () => {
      await indexer.ready;
      const items: LocPick[] = [];
      for (const [name, defs] of index.a.methods) {
        for (const d of defs) {
          const uses = index.a.calls.get(name)?.length ?? 0;
          items.push({
            label: `$(symbol-method) ${name}`,
            description: `(${d.params.join(', ')}) · ${d.env} · ${uses} ${uses === 1 ? 'call' : 'calls'}`,
            detail: where(d.loc.file),
            loc: d.loc,
          });
        }
      }
      items.sort((x, y) => x.label.localeCompare(y.label));
      return pickAndOpen(items, 'Search a Meteor method');
    }),

    vscode.commands.registerCommand('meteorPower.goToPublication', async () => {
      await indexer.ready;
      const items: LocPick[] = [];
      for (const [name, defs] of index.a.publications) {
        for (const d of defs) {
          const uses = index.a.subscriptions.get(name)?.length ?? 0;
          items.push({ label: `$(radio-tower) ${name}`, description: `(${d.params.join(', ')}) · ${uses} ${uses === 1 ? 'subscription' : 'subscriptions'}`, detail: where(d.loc.file), loc: d.loc });
        }
      }
      items.sort((x, y) => x.label.localeCompare(y.label));
      return pickAndOpen(items, 'Search a publication');
    }),

    vscode.commands.registerCommand('meteorPower.goToTemplate', async () => {
      await indexer.ready;
      const a = index.a;
      const items: LocPick[] = [];
      for (const name of [...a.templateNames].sort((x, y) => x.localeCompare(y))) {
        const helpers = a.helpers.get(name)?.size ?? 0;
        const events = a.events.get(name)?.length ?? 0;
        const description = `${helpers} ${helpers === 1 ? 'helper' : 'helpers'} · ${events} ${events === 1 ? 'event' : 'events'}`;
        const html = a.templates.get(name) ?? [];
        // one entry per HTML definition (the same name may exist in several apps), or the JS if there is no HTML
        for (const h of html) items.push({ label: `$(symbol-class) ${name}`, description, detail: where(h.loc.file), loc: h.loc });
        const js = html.length ? undefined : templateJsDefs(index, name)[0];
        if (js) items.push({ label: `$(symbol-class) ${name}`, description, detail: `JS only: ${where(js.loc.file)}`, loc: js.loc });
      }
      return pickAndOpen(items, 'Search a Blaze template');
    }),

    vscode.commands.registerCommand('meteorPower.switchTemplateFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      indexer.syncDocument(doc);
      const file = indexer.keyOf(doc.uri.fsPath);
      let name = enclosingTemplate(index, file, toPos(editor.selection.active));
      if (!name) {
        const names = templatesInFile(index, file);
        if (names.length === 1) name = names[0];
        else if (names.length > 1) name = await vscode.window.showQuickPick(names, { placeHolder: 'Which template?' });
      }
      if (!name) {
        vscode.window.showInformationMessage('Meteor Power: no Blaze template in this file.');
        return;
      }
      const isHtml = file.toLowerCase().endsWith('.html');
      const scope = index.scopeOf(file);
      const targets = isHtml ? templateJsDefs(index, name, scope) : templateHtmlDefs(index, name, scope);
      if (!targets.length) {
        vscode.window.showInformationMessage(`Meteor Power: no ${isHtml ? 'JS' : 'HTML'} file found for template '${name}'.`);
        return;
      }
      return isHtml ? openTemplateJs(name, scope) : openTemplateHtml(name, scope);
    }),
  );
}
