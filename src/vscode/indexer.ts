import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AppLayout, AppRoot, normPath, PackageRoot, parseMeteorPackages, parsePackageJs } from '../core/apps';
import { MeteorIndex } from '../core/index';
import { parseHtml } from '../core/htmlParser';
import { JsParseOptions, parseJs } from '../core/jsParser';
import { FileFacts } from '../core/model';
import { globToRegExp } from '../core/text';

const SUPPORTED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|html)$/i;
const MAX_SIZE = 1_500_000;
/** Never walked in package folders outside the workspace. */
const WALK_SKIP = new Set(['node_modules', '.git', '.npm', '.meteor']);

/** Keeps the MeteorIndex in sync with the workspace: initial scan, file watcher, unsaved editor changes. */
export class WorkspaceIndexer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly versions = new Map<string, number>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private changeTimer: NodeJS.Timeout | undefined;
  private layoutTimer: NodeJS.Timeout | undefined;
  private excludes: RegExp[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  private scanId = 0;
  private options: JsParseOptions = {};
  /** path as seen by VS Code → real path on disk (symlinks resolved) */
  private readonly realPaths = new Map<string, string>();
  /** real path → every path it was seen by (the same file reached through several symlinked folders) */
  private readonly aliases = new Map<string, Set<string>>();
  private layout = new AppLayout([], []);

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
        const keys = ['meteorPower.include', 'meteorPower.exclude', 'meteorPower.methods', 'meteorPower.publications', 'meteorPower.packageDirs'];
        if (keys.some((k) => e.affectsConfiguration(k))) void this.rescan();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rescan()),
    );
  }

  rescan(): Promise<void> {
    this.ready = Promise.resolve(
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Meteor Power: indexing…' }, () => this.fullScan()),
    );
    return this.ready;
  }

  private async fullScan() {
    const id = ++this.scanId;
    const cfg = vscode.workspace.getConfiguration('meteorPower');
    const include = cfg.get<string>('include') || '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,html}';
    const exclude = cfg.get<string[]>('exclude') ?? [];
    this.excludes = exclude.map(globToRegExp);
    this.options = {
      methodDefiners: cfg.get<string[]>('methods.defineFunctions', []),
      methodCallers: cfg.get<string[]>('methods.callFunctions', []),
      publicationDefiners: cfg.get<string[]>('publications.defineFunctions', []),
      subscribeCallers: cfg.get<string[]>('publications.subscribeFunctions', []),
    };
    const packageDirs = this.packageDirs(cfg.get<string[]>('packageDirs', []));

    for (const w of this.watchers) w.dispose();
    this.watchers = [vscode.workspace.createFileSystemWatcher(include)];
    // package folders outside the workspace
    for (const dir of packageDirs) this.watchers.push(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), include)));
    for (const w of this.watchers) {
      w.onDidCreate((u) => this.onDiskChange(u));
      w.onDidChange((u) => this.onDiskChange(u));
      w.onDidDelete((u) => this.onDiskDelete(u));
    }
    // app and package definitions: only the app of each file changes, nothing to parse again
    const layoutWatcher = vscode.workspace.createFileSystemWatcher('**/{.meteor/release,.meteor/packages,package.js}');
    for (const ev of [layoutWatcher.onDidCreate, layoutWatcher.onDidChange, layoutWatcher.onDidDelete]) ev(() => this.scheduleLayout());
    this.watchers.push(layoutWatcher);

    const excludeGlob = exclude.length ? `{${exclude.join(',')}}` : undefined;
    const [found, outside, layout] = await Promise.all([
      vscode.workspace.findFiles(include, excludeGlob),
      Promise.all(packageDirs.map((d) => this.walk(d))).then((l) => l.flat()),
      this.detectLayout(packageDirs),
    ]);
    if (id !== this.scanId) return;

    this.index.clear();
    this.versions.clear();
    this.realPaths.clear();
    this.aliases.clear();
    this.setLayout(layout);
    // the same file reached through several symlinked folders is indexed once, under its real path,
    // but every path is remembered: it tells which apps the file belongs to
    const unique = new Map<string, vscode.Uri>();
    for (const u of [...found, ...outside]) {
      const key = this.track(u.fsPath);
      if (!unique.has(key)) unique.set(key, u);
    }
    const uris = [...unique.values()];
    const BATCH = 64;
    for (let i = 0; i < uris.length; i += BATCH) {
      await Promise.all(uris.slice(i, i + BATCH).map((u) => this.indexFile(u, false)));
      if (id !== this.scanId) return;
    }
    // open editors may contain unsaved changes
    for (const d of vscode.workspace.textDocuments) this.syncDocument(d);
    this.fireChange(true);
  }

  // ------------------------------------------------------------------------------------- apps

  /** `meteorPower.packageDirs` and `METEOR_PACKAGE_DIRS`, as absolute paths of existing folders. */
  private packageDirs(fromSettings: string[]): string[] {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const fromEnv = (process.env.METEOR_PACKAGE_DIRS ?? '').split(path.delimiter);
    const out = new Map<string, string>();
    for (const raw of [...fromSettings, ...fromEnv]) {
      const p = raw.trim();
      if (!p) continue;
      const abs = path.isAbsolute(p) ? p : base ? path.join(base, p) : undefined;
      if (!abs || !fs.existsSync(abs)) continue;
      const dir = vscode.Uri.file(abs).fsPath;
      // inside the workspace it is indexed anyway
      if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir))) continue;
      out.set(normPath(dir), dir);
    }
    return [...out.values()];
  }

  /** Meteor apps (folders with `.meteor/release`) and local packages (folders with `package.js`). */
  private async detectLayout(packageDirs: string[]): Promise<AppLayout> {
    const [releases, packageFiles] = await Promise.all([
      vscode.workspace.findFiles('**/.meteor/release', '**/node_modules/**'),
      vscode.workspace.findFiles('**/package.js', '{**/node_modules/**,**/.meteor/**,**/.npm/**}'),
    ]);
    for (const dir of packageDirs) {
      for (const p of await this.walk(dir, /^package\.js$/)) packageFiles.push(p);
    }

    const appDirs = new Map<string, string>();
    for (const r of releases) {
      const dir = path.dirname(path.dirname(r.fsPath));
      appDirs.set(normPath(this.keyOf(dir)), dir);
    }
    const dirs = [...appDirs.values()];
    const base = (d: string) => path.basename(d);
    const unique = new Set(dirs.map(base)).size === dirs.length;
    const apps: AppRoot[] = await Promise.all(
      dirs.map(async (dir) => ({
        id: normPath(dir),
        name: unique ? base(dir) : vscode.workspace.asRelativePath(dir, false),
        packages: parseMeteorPackages((await readText(path.join(dir, '.meteor', 'packages'))) ?? ''),
      })),
    );

    const packages: PackageRoot[] = [];
    for (const u of packageFiles) {
      const text = await readText(u.fsPath);
      const dir = path.dirname(u.fsPath);
      const info = text && parsePackageJs(text, path.basename(dir));
      if (info) packages.push({ dir: normPath(dir), ...info });
    }
    return new AppLayout(apps, packages);
  }

  private setLayout(layout: AppLayout) {
    this.layout = layout;
    this.index.setApps(new Map(layout.apps.map((a) => [a.id, a.name])));
    for (const key of this.aliases.keys()) this.updateApps(key);
  }

  /** `.meteor/packages` or a `package.js` changed: recompute which app each file belongs to. */
  private scheduleLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(async () => {
      const cfg = vscode.workspace.getConfiguration('meteorPower');
      const layout = await this.detectLayout(this.packageDirs(cfg.get<string[]>('packageDirs', [])));
      this.setLayout(layout);
      this.fireChange();
    }, 500);
  }

  private updateApps(key: string) {
    if (!this.layout.isMulti) {
      this.index.setFileApps(key, []);
      return;
    }
    this.index.setFileApps(key, this.layout.appsOf([key, ...(this.aliases.get(key) ?? [])]));
  }

  /** Remembers a path of a file and returns the key it is indexed under. */
  private track(fsPath: string): string {
    const key = this.keyOf(fsPath);
    let set = this.aliases.get(key);
    if (!set) this.aliases.set(key, (set = new Set()));
    if (!set.has(fsPath)) {
      set.add(fsPath);
      this.updateApps(key);
    }
    return key;
  }

  /** Files of a folder outside the workspace (`findFiles` only searches the workspace). */
  private async walk(dir: string, match: RegExp = SUPPORTED): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    const visit = async (d: string, depth: number) => {
      if (depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) {
          if (!WALK_SKIP.has(e.name)) await visit(p, depth + 1);
        } else if (match.test(e.name) && this.accepts(vscode.Uri.file(p))) {
          out.push(vscode.Uri.file(p));
        }
      }
    };
    await visit(dir, 0);
    return out;
  }

  // ------------------------------------------------------------------------------------ files

  /**
   * The key under which a file is indexed: its real path, so that a file reachable through
   * symlinked folders is indexed (and shown) once. Locations in the index always use this path.
   */
  keyOf(fsPath: string): string {
    let key = this.realPaths.get(fsPath);
    if (key === undefined) {
      key = fsPath;
      try {
        const real = fs.realpathSync.native(fsPath);
        const same = process.platform === 'linux' ? real === fsPath : real.toLowerCase() === fsPath.toLowerCase();
        // normalize like VS Code does (lower-case drive letter on Windows)
        if (!same) key = vscode.Uri.file(real).fsPath;
      } catch {
        // missing file: keep the path as is
      }
      this.realPaths.set(fsPath, key);
    }
    return key;
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
    const facts = parse(this.track(file), doc.getText(), this.options);
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
    const key = this.track(uri.fsPath);
    const open = vscode.workspace.textDocuments.find((d) => this.keyOf(d.uri.fsPath) === key);
    if (open) {
      if (!open.isDirty) this.syncDocument(open);
      return;
    }
    void this.indexFile(uri);
  }

  private onDiskDelete(uri: vscode.Uri) {
    const key = this.keyOf(uri.fsPath);
    this.realPaths.delete(uri.fsPath);
    const set = this.aliases.get(key);
    set?.delete(uri.fsPath);
    if (fs.existsSync(key) && set?.size) {
      // only one of the symlinked paths is gone
      this.updateApps(key);
    } else {
      this.aliases.delete(key);
      this.index.remove(key);
    }
    this.fireChange();
  }

  private async indexFile(uri: vscode.Uri, notify = true) {
    if (!this.accepts(uri)) return;
    const key = this.track(uri.fsPath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SIZE) return;
      const bytes = await vscode.workspace.fs.readFile(uri);
      const facts = parse(key, Buffer.from(bytes).toString('utf8'), this.options);
      if (facts) this.index.update(facts);
      if (notify) this.fireChange();
    } catch {
      this.index.remove(key);
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
    for (const w of this.watchers) w.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
    clearTimeout(this.changeTimer);
    clearTimeout(this.layoutTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

function parse(file: string, text: string, options: JsParseOptions): FileFacts | null {
  return file.toLowerCase().endsWith('.html') ? parseHtml(file, text) : parseJs(file, text, options);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
