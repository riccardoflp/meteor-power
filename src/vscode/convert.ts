import * as vscode from 'vscode';
import { Loc, Pos } from '../core/model';
import { MeteorIndex } from '../core/index';

export function toRange(l: Loc): vscode.Range {
  const { start, end } = l.range;
  return new vscode.Range(start.line, start.character, end.line, end.character);
}

export function toLocation(l: Loc): vscode.Location {
  return new vscode.Location(vscode.Uri.file(l.file), toRange(l));
}

export function toPos(p: vscode.Position): Pos {
  return { line: p.line, character: p.character };
}

export function relPath(file: string): string {
  return vscode.workspace.asRelativePath(file, vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 1);
}

export function fileLink(l: Loc): string {
  const line = l.range.start.line + 1;
  const uri = vscode.Uri.file(l.file).with({ fragment: `L${line},${l.range.start.character + 1}` });
  return `[${relPath(l.file)}:${line}](${uri.toString()})`;
}

export async function openLoc(l: Loc, preview = false): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(l.file));
  const range = toRange(l);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(range.start, range.start), preview });
  const editor = vscode.window.activeTextEditor;
  editor?.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

/** `admin` or `admin, web` for a file in several apps; empty with a single app or outside every app. */
export function appsLabel(index: MeteorIndex, file: string): string {
  if (!index.isMultiApp) return '';
  return index.appsOf(file).map((id) => index.appName(id)).join(', ');
}
