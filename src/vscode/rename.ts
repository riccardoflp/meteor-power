import * as path from 'path';
import * as vscode from 'vscode';
import { renameEdits, renameInfo, TextEdit, validateNewName } from '../core/rename';
import { Target, targetAt } from '../core/queries';
import { toPos, toRange } from './convert';
import { SELECTOR } from './providers';
import { WorkspaceIndexer } from './indexer';

const LABEL: Record<Target['type'], string> = {
  method: 'method',
  publication: 'publication',
  template: 'template',
  helper: 'helper',
  event: 'event',
};

/**
 * Rename (F2) of methods, publications, templates and helpers across JS and HTML.
 * F2 is bound to `meteorPower.rename` only when the cursor is on one of them (context key `meteorPower.canRename`),
 * because in JS/TS files the built-in TypeScript rename would otherwise win and rename just the object key.
 */
export function registerRename(ctx: vscode.ExtensionContext, indexer: WorkspaceIndexer) {
  const index = indexer.index;

  const targetIn = (doc: vscode.TextDocument, pos: vscode.Position): Target | undefined => {
    indexer.syncDocument(doc);
    return targetAt(index, indexer.keyOf(doc.uri.fsPath), toPos(pos));
  };

  /** Edits are computed on the latest text of every open editor. */
  const syncOpenDocuments = () => {
    for (const d of vscode.workspace.textDocuments) indexer.syncDocument(d);
  };

  const toWorkspaceEdit = (doc: vscode.TextDocument, edits: TextEdit[]) => {
    const we = new vscode.WorkspaceEdit();
    const docKey = indexer.keyOf(doc.uri.fsPath);
    for (const e of edits) {
      // the document may be open through a symlink: keep its URI
      const uri = e.loc.file === docKey ? doc.uri : vscode.Uri.file(e.loc.file);
      we.replace(uri, toRange(e.loc), e.newText);
    }
    return we;
  };

  // --------------------------------------------------------------------- standard rename provider

  ctx.subscriptions.push(
    vscode.languages.registerRenameProvider(SELECTOR, {
      prepareRename(doc, pos) {
        const t = targetIn(doc, pos);
        if (!t) return undefined;
        const info = renameInfo(t);
        if ('error' in info) throw new Error(info.error);
        return { range: toRange(t.loc), placeholder: info.name };
      },
      provideRenameEdits(doc, pos, newName) {
        syncOpenDocuments();
        const t = targetIn(doc, pos);
        if (!t) return undefined;
        const r = renameEdits(index, t, newName);
        if ('error' in r) throw new Error(r.error);
        return toWorkspaceEdit(doc, r.edits);
      },
    }),
  );

  // ---------------------------------------------------------------- F2 command with its own input box

  ctx.subscriptions.push(
    vscode.commands.registerCommand('meteorPower.rename', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const t = targetIn(doc, editor.selection.active);
      if (!t) return vscode.commands.executeCommand('editor.action.rename');
      const info = renameInfo(t);
      if ('error' in info) {
        vscode.window.showInformationMessage(`Meteor Power: ${info.error}`);
        return;
      }
      const what = t.type === 'helper' ? (t.template ? `helper of '${t.template}'` : 'global helper') : LABEL[t.type];
      const newName = await vscode.window.showInputBox({
        title: `Rename ${what} '${info.name}'`,
        value: info.name,
        prompt: 'Updates the definition and every usage in JS and HTML',
        validateInput: (v) => validateNewName(index, t, v),
      });
      if (newName === undefined || newName.trim() === info.name) return;

      syncOpenDocuments();
      const fresh = targetIn(doc, editor.selection.active) ?? t;
      const r = renameEdits(index, fresh, newName);
      if ('error' in r) {
        vscode.window.showErrorMessage(`Meteor Power: ${r.error}`);
        return;
      }
      const ok = await vscode.workspace.applyEdit(toWorkspaceEdit(doc, r.edits));
      if (!ok) {
        vscode.window.showErrorMessage('Meteor Power: the rename could not be applied.');
        return;
      }
      const files = new Set(r.edits.map((e) => e.loc.file));
      const names = [...files].map((f) => path.basename(f)).slice(0, 4).join(', ');
      vscode.window.setStatusBarMessage(
        `$(check) Renamed '${info.name}' → '${newName.trim()}': ${r.edits.length} ${r.edits.length === 1 ? 'change' : 'changes'} in ${files.size} ${files.size === 1 ? 'file' : 'files'} (${names}${files.size > 4 ? ', …' : ''})`,
        8000,
      );
    }),
  );

  // ------------------------------------------------------------------ context key for the F2 binding

  let canRename = false;
  let timer: NodeJS.Timeout | undefined;
  const update = () => {
    const editor = vscode.window.activeTextEditor;
    let value = false;
    if (editor && vscode.languages.match(SELECTOR, editor.document)) {
      const t = targetIn(editor.document, editor.selection.active);
      value = !!t && t.type !== 'event';
    }
    if (value !== canRename) {
      canRename = value;
      void vscode.commands.executeCommand('setContext', 'meteorPower.canRename', value);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 50);
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    indexer.onDidChange(schedule),
    { dispose: () => clearTimeout(timer) },
  );
  schedule();
}
