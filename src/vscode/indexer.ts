import * as vscode from 'vscode';
import { MeteorIndex } from '../core/index';
import { parseHtml } from '../core/htmlParser';
import { parseJs } from '../core/jsParser';
import { FileFacts } from '../core/model';
import { globToRegExp } from '../core/text';

const SUPPORTED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|html)$/i;
const MAX_SIZE = 1_500_000;

/** Keeps the MeteorIndex in sync with the workspace: initial scan, file watcher, unsaved editor changes. */
export class WorkspaceIndexer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly versions = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private changeTimer: NodeJS.Timeout | undefined;
  private excludes: RegExp[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private scanId = 0;

  /** Fired (debounced) whenever the index content changes. */
  readonly onDidChange = this.changeEmitter.event;
  ready: Promise<void> = Promise.resolve();

  constructor(readonly index: MeteorIndex) {
    this.disposables.push(
      this.changeEmitter,
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleDocument(e.document)),
      vscode.workspace.onDidOpenTextDocument((d) => this.syncDocument(d)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        // the editor may have been closed without saving: go back to the content on disk
        if (d.isDirty) void this.indexFile(d.uri);
        this.versions.delete(d.uri.fsPath);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('meteorpower.include') || e.affectsConfiguration('meteorpower.exclude')) void this.rescan();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
    );
  }

  rescan(): Promise<void> {
    this.ready = Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'MeteorPower: indexing…' }, () => this.fullScan()),
    );
    return this.ready;
  }

  private async fullScan() {
    const id = ++this.scanId;
    const cfg = vscode.workspace.getConfiguration('meteorpower');
    const include = cfg.get<string>('include') || '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,html}';
    const exclude = cfg.get<string[]>('exclude') ?? [];
    this.excludes = exclude.map(globToRegExp);

    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(include);
    this.watcher.onDidCreate((u) => this.onDiskChange(u));
    this.watcher.onDidChange((u) => this.onDiskChange(u));
    this.watcher.onDidDelete((u) => {
      this.index.remove(u.fsPath);
      this.fireChange();
    });

    const excludeGlob = exclude.length ? `{${exclude.join(',')}}` : undefined;
    const uris = await vscode.workspace.findFiles(include, excludeGlob);
    if (id !== this.scanId) return;

    this.index.clear();
    this.versions.clear();
    const BATCH = 64;
    for (let i = 0; i < uris.length; i += BATCH) {
      await Promise.all(uris.slice(i, i + BATCH).map((u) => this.indexFile(u, false)));
      if (id !== this.scanId) return;
    }
    // open editors may contain unsaved changes
    for (const d of vscode.workspace.textDocuments) this.syncDocument(d);
    this.fireChange(true);
  }

  /** Makes sure the index reflects the current text of a document (call before answering a query on it). */
  syncDocument(doc: vscode.TextDocument): void {
    if (!this.accepts(doc.uri)) return;
    const file = doc.uri.fsPath;
    if (this.versions.get(file) === doc.version) return;
    const t = this.pending.get(file);
    if (t) {
      clearTimeout(t);
      this.pending.delete(file);
    }
    const facts = parse(file, doc.getText());
    this.versions.set(file, doc.version);
    if (facts) {
      this.index.update(facts);
      this.fireChange();
    }
  }

  private scheduleDocument(doc: vscode.TextDocument) {
    if (!this.accepts(doc.uri)) return;
    const file = doc.uri.fsPath;
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        this.syncDocument(doc);
      }, 300),
    );
  }

  private onDiskChange(uri: vscode.Uri) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) {
      if (!open.isDirty) this.syncDocument(open);
      return;
    }
    void this.indexFile(uri);
  }

  private async indexFile(uri: vscode.Uri, notify = true) {
    if (!this.accepts(uri)) return;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SIZE) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const facts = parse(uri.fsPath, Buffer.from(bytes).toString('utf8'));
      if (facts) this.index.update(facts);
      if (notify) this.fireChange();
    } catch {
      this.index.remove(uri.fsPath);
    }
  }

  private accepts(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !SUPPORTED.test(uri.fsPath)) return false;
    const p = uri.fsPath.replace(/\\/g, '/');
    return !this.excludes.some((re) => re.test(p));
  }

  private fireChange(immediate = false) {
    clearTimeout(this.changeTimer);
    if (immediate) this.changeEmitter.fire();
    else this.changeTimer = setTimeout(() => this.changeEmitter.fire(), 250);
  }

  dispose() {
    this.watcher?.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
    clearTimeout(this.changeTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

function parse(file: string, text: string): FileFacts | null {
  return file.toLowerCase().endsWith('.html') ? parseHtml(file, text) : parseJs(file, text);
}
