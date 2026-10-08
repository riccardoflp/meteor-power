import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const OUT = process.env.SCREENSHOTS_OUT!;
const SET = process.env.SCREENSHOTS_SET!;
/** Logical size of the window; the image is in physical pixels (DPI scaling). */
const WIDTH = 1280;
const HEIGHT = 760;
/** Height of the title bar, cropped away. */
const TITLE_BAR = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const uri = (rel: string) => vscode.Uri.file(path.join(root(), rel));

// ------------------------------------------------------------------------------------- capture

const PS = `
param([string]$Mode, [string]$Out, [int]$W, [int]$H, [int]$TitleBar)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Win]::SetProcessDPIAware() | Out-Null
$p = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*meteor-power-screenshots*' } | Select-Object -First 1
if (-not $p) { throw 'window not found' }
$hwnd = $p.MainWindowHandle
$scale = [Win]::GetDpiForWindow($hwnd) / 96.0
if ($Mode -eq 'size') {
  [Win]::ShowWindow($hwnd, 9) | Out-Null
  [Win]::MoveWindow($hwnd, 40, 40, [int]($W * $scale), [int]($H * $scale), $true) | Out-Null
  exit
}
# window rect (with the invisible resize borders) and visible frame
$r = New-Object Win+RECT
$f = New-Object Win+RECT
[Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
[Win]::DwmGetWindowAttribute($hwnd, 9, [ref]$f, 16) | Out-Null
if ($Mode -eq 'cursor') {
  # keep the mouse out of the window (no stray tooltips)
  [Win]::SetCursorPos($f.Right + 20, $f.Bottom + 20) | Out-Null
  exit
}
$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Win]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
# crop the borders and the title bar
$top = [int]($TitleBar * $scale)
$rect = New-Object System.Drawing.Rectangle ($f.Left - $r.Left), ($f.Top - $r.Top + $top), ($f.Right - $f.Left), ($f.Bottom - $f.Top - $top)
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
`;
const psFile = path.join(os.tmpdir(), 'meteor-power-capture.ps1');

function ps(mode: 'size' | 'cursor' | 'shot', out = '') {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Mode', mode, '-Out', out || 'none', '-W', String(WIDTH), '-H', String(HEIGHT), '-TitleBar', String(TITLE_BAR)];
  try {
    // PowerShell 5.1 fails on the extension host environment: give it only the basic system variables
    const KEEP = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'Path', 'PATHEXT', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles'];
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      const name = KEEP.find((n) => n.toLowerCase() === k.toLowerCase());
      if (name && v !== undefined && !(name in env)) env[name] = v;
    }
    execFileSync('powershell.exe', args, { encoding: 'utf8', env });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    throw new Error(`capture failed: ${err.stderr || err.stdout}`);
  }
}

async function shot(name: string) {
  ps('cursor');
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(900);
  ps('shot', path.join(OUT, `${name}.png`));
  console.log(`  📸 ${name}.png`);
}

// --------------------------------------------------------------------------------------- helpers

async function open(rel: string, needle?: string, delta = 1): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri(rel));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (needle) {
    const at = doc.getText().indexOf(needle);
    if (at < 0) throw new Error(`"${needle}" not in ${rel}`);
    const pos = doc.positionAt(at + delta);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return editor;
}

/** Inserts a line after the one containing `needle` and puts the cursor at its end. */
async function typeLine(editor: vscode.TextEditor, needle: string, text: string) {
  const doc = editor.document;
  const line = doc.positionAt(doc.getText().indexOf(needle)).line;
  await editor.edit((e) => e.insert(doc.lineAt(line).range.end, '\n' + text));
  const end = doc.lineAt(line + 1).range.end;
  editor.selection = new vscode.Selection(end, end);
}

async function reset() {
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor').then(undefined, () => undefined);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.view.extension.meteorPower');
}

/** Expands the root nodes of a side panel view whose label is in `labels`. */
async function expand(api: any, view: 'methods' | 'publications' | 'templates', labels: string[], levels = 1) {
  const tree = api.trees[view];
  for (const node of await tree.getChildren(undefined)) {
    const item = await tree.getTreeItem(node);
    const label = typeof item.label === 'string' ? item.label : item.label?.label;
    if (labels.includes(label)) await api.views[view].reveal(node, { expand: levels, select: false, focus: false });
  }
}

// ----------------------------------------------------------------------------------------- shots

async function demo(api: any) {
  // 1. overview: side panel + hover of a helper used in the HTML
  await reset();
  await expand(api, 'methods', ['tasks', 'lists']);
  await expand(api, 'templates', ['appLayout', 'listPage'], 1);
  await open('imports/ui/pages/listPage.html', '{{remainingCount}}', 3);
  await vscode.commands.executeCommand('editor.action.showHover');
  await shot('overview');

  // 2. hover on a method name written as a constant
  await reset();
  await open('imports/ui/components/taskItem.js', 'TASKS.REMOVE', 8);
  await vscode.commands.executeCommand('editor.action.showHover');
  await shot('hover-method');

  // 3. completion of method names
  await reset();
  let editor = await open('imports/ui/pages/listPage.js');
  await typeLine(editor, "input.value = '';", "    await Meteor.callAsync('");
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
  await sleep(600);
  await vscode.commands.executeCommand('toggleSuggestionDetails');
  await shot('completion-methods');
  await vscode.commands.executeCommand('hideSuggestWidget');
  await vscode.commands.executeCommand('workbench.action.files.revert');

  // 4. completion of helpers in the HTML (own, inherited, global)
  await reset();
  editor = await open('imports/ui/components/card.html');
  await typeLine(editor, '<small>{{taskCount}}', '    {{');
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
  await shot('completion-helpers');
  await vscode.commands.executeCommand('hideSuggestWidget');
  await vscode.commands.executeCommand('workbench.action.files.revert');

  // 5. rename (F2)
  await reset();
  await open('imports/ui/components/taskItem.js', "'tasks.setChecked'", 3);
  const original = vscode.window.showInputBox;
  let close: (() => void) | undefined;
  (vscode.window as any).showInputBox = (opts: vscode.InputBoxOptions) => {
    // a real input box, kept open for the screenshot
    const box = vscode.window.createInputBox();
    box.title = opts.title;
    box.value = 'tasks.toggle';
    box.prompt = opts.prompt;
    box.show();
    return new Promise<undefined>((resolve) => (close = () => (box.hide(), resolve(undefined))));
  };
  const renaming = vscode.commands.executeCommand('meteorPower.rename');
  await shot('rename');
  close?.();
  await renaming;
  (vscode.window as any).showInputBox = original;
}

async function multi(api: any) {
  // shared code opened through the symlink of one app: missing in the other app
  await reset();
  await vscode.commands.executeCommand('meteorPower.publications.removeView').then(undefined, () => undefined);
  await expand(api, 'methods', ['Calls to undefined methods'], 2);
  await expand(api, 'methods', ['common'], 1);
  await expand(api, 'methods', ['admin'], 0);
  await open('admin/imports/shared/api.js', "'admin.purge'", 3);
  await vscode.commands.executeCommand('editor.action.showHover');
  await shot('multi-app');
}

export async function run(): Promise<void> {
  fs.writeFileSync(psFile, PS);
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'meteor-power')!;
  const api = await ext.activate();
  await api.ready();
  ps('size');
  await sleep(2500);
  if (SET === 'demo') await demo(api);
  else await multi(api);
}
