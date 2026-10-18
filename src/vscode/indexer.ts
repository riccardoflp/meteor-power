import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AppLayout, AppRoot, isBuildManifest, normPath, PackageRoot, parseMeteorPackages, parsePackageJs, usesBlaze } from '../core/apps';
import { MeteorIndex, PackageGap } from '../core/index';
import { JsParseOptions } from '../core/jsParser';
import { locateAppPackages, PackageArch, parseMeteorVersions, restrictToArch, warehouseDir } from '../core/meteorPackages';
import { MAX_SIZE, ParsedFile, parseFile } from '../core/parseFile';
import { PathFilter, PathStatus } from '../core/pathFilter';
import { globToRegExp } from '../core/text';
import { ParsePool } from './parsePool';

const SUPPORTED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|html)$/i;
/** Build output and dependencies: never app or package definitions. */
const LAYOUT_SKIP = /[\\/](node_modules|\.meteor[\\/]local|\.npm)[\\/]/;
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
  /** `.meteor/versions` changed: the packages to read change, a full scan is needed. */
  private packagesChanged = false;
  private filter = new PathFilter([]);
  /** `meteorPower.packageDirs`: the only folders outside the workspace whose files are indexed. */
  private outsideDirs: string[] = [];
  private includeRe: RegExp | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];
  private scanId = 0;
  private options: JsParseOptions = {};
  /** path as seen by VS Code → real path on disk (symlinks resolved) */
  private readonly realPaths = new Map<string, string>();
  /** real path → every path it was seen by (the same file reached through several symlinked folders) */
  private readonly aliases = new Map<string, Set<string>>();
  private layout = new AppLayout([], []);
  /** During the initial scan, changes are announced once at the end. */
  private scanning = false;
  private readonly pool: ParsePool;

  /** Fired (debounced) whenever the index content changes. */
  readonly onDidChange = this.changeEmitter.event;
  ready: Promise<void> = Promise.resolve();

  constructor(
    readonly index: MeteorIndex,
    private readonly log: vscode.LogOutputChannel,
    workerScript: string,
  ) {
    this.pool = new ParsePool(workerScript);
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
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Meteor Power: indexing' }, (p) =>
        this.fullScan(p).catch((e) => {
          this.scanning = false;
          this.log.error('Indexing failed', e);
        }),
      ),
    );
    return this.ready;
  }

  private async fullScan(progress: vscode.Progress<{ message?: string }>) {
    const id = ++this.scanId;
    const t0 = Date.now();
    const cfg = vscode.workspace.getConfiguration('meteorPower');
    const include = cfg.get<string>('include') || '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,html}';
    const exclude = cfg.get<string[]>('exclude') ?? [];
    this.filter = new PathFilter(exclude);
    this.includeRe = globToRegExp(include);
    this.options = {
      methodDefiners: cfg.get<string[]>('methods.defineFunctions', []),
      methodCallers: cfg.get<string[]>('methods.callFunctions', []),
      publicationDefiners: cfg.get<string[]>('publications.defineFunctions', []),
      subscribeCallers: cfg.get<string[]>('publications.subscribeFunctions', []),
    };
    const packageDirs = this.packageDirs(cfg.get<string[]>('packageDirs', []));
    this.outsideDirs = packageDirs.map((d) => normPath(d));

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
    const layoutWatcher = vscode.workspace.createFileSystemWatcher('**/{.meteor/release,.meteor/packages,.meteor/versions,package.js,star.json}');
    for (const ev of [layoutWatcher.onDidCreate, layoutWatcher.onDidChange, layoutWatcher.onDidDelete]) {
      // npm packages also have package.js files, and a running Meteor rewrites .meteor/local all the time
      ev((u) => {
        if (LAYOUT_SKIP.test(u.fsPath)) return;
        if (path.basename(u.fsPath) === 'versions') this.packagesChanged = true;
        this.scheduleLayout();
      });
    }
    this.watchers.push(layoutWatcher);

    const [found, outside, layout] = await Promise.all([
      this.findWorkspaceFiles(include),
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
    // public/ and private/ of the apps are only known now
    for (const u of [...found, ...outside].filter((x) => this.accepts(x))) {
      const key = this.track(u.fsPath);
      if (!unique.has(key)) unique.set(key, u);
    }
    const files = [...unique].map(([key, u]) => ({ key, path: u.fsPath }));
    const t1 = Date.now();
    this.log.info(
      `Found ${files.length} files in ${t1 - t0} ms` +
        (outside.length ? ` (${outside.length} in package folders outside the workspace)` : '') +
        `; ${layout.apps.length} Meteor app(s), ${layout.packages.length} local package(s)`,
    );

    this.scanning = true;
    const parsed: ParsedFile[] = [];
    let lastReport = 0;
    const { workers } = await this.pool.parseAll(
      files,
      this.options,
      (results) => {
        if (id !== this.scanId) return;
        for (const r of results) {
          parsed.push(r);
          if (r.facts) this.index.update(r.facts);
        }
        if (Date.now() - lastReport > 300) {
          lastReport = Date.now();
          progress.report({ message: `${Math.round((100 * parsed.length) / files.length)}% (${parsed.length}/${files.length})` });
        }
      },
      () => id !== this.scanId,
    );
    if (id !== this.scanId) return;
    await this.indexPackages(layout, id);
    if (id !== this.scanId) return;
    const t2 = Date.now();
    // open editors may contain unsaved changes
    // (only those: the others are as on disk, or already closed or deleted, and must not come back)
    for (const d of vscode.workspace.textDocuments) if (d.isDirty) this.syncDocument(d);
    void this.index.a;
    const t3 = Date.now();
    this.scanning = false;
    this.changeEmitter.fire();
    const t4 = Date.now();
    this.logScan(parsed, workers, { parse: t2 - t1, aggregate: t3 - t2, views: t4 - t3, total: t4 - t0 });
  }

  /** What the scan did and where the time went, to spot folders worth excluding. */
  private logScan(parsed: ParsedFile[], workers: number, ms: { parse: number; aggregate: number; views: number; total: number }) {
    const rel = (f: string) => vscode.workspace.asRelativePath(f, false);
    const bytes = parsed.reduce((s, r) => s + r.size, 0);
    const sum = (k: 'readMs' | 'parseMs') => (parsed.reduce((s, r) => s + r[k], 0) / 1000).toFixed(1);
    const skipped = parsed.filter((r) => r.skipped);
    this.log.info(
      `Parsed ${parsed.length} files (${(bytes / 1e6).toFixed(1)} MB) in ${ms.parse} ms on ${workers ? `${workers} worker threads` : 'the extension host'}; ` +
        `aggregation ${ms.aggregate} ms, diagnostics and views ${ms.views} ms; total ${ms.total} ms ` +
        `(summed over the threads: reading ${sum('readMs')} s, parsing ${sum('parseMs')} s)`,
    );
    if (skipped.length) {
      this.log.info(`Skipped ${skipped.length} minified or too large files, e.g.:`);
      for (const r of skipped.slice(0, 10)) this.log.info(`  ${rel(r.key)} (${r.skipped}, ${(r.size / 1000).toFixed(0)} KB)`);
    }
    const failed = parsed.filter((r) => !r.facts && !r.skipped && !r.missing);
    if (failed.length) {
      this.log.warn(`${failed.length} files could not be parsed: what they define is unknown, e.g.:`);
      for (const r of failed.slice(0, 10)) this.log.warn(`  ${rel(r.key)}`);
    }
    // Meteor.methods(buildMethods()): the names they register are unknown, calls to them may be reported
    const dynamic = [...this.index.allFacts()].flatMap((f) => f.dynamicRegistrations);
    if (dynamic.length) {
      this.log.info(`${dynamic.length} Meteor.methods / Meteor.publish registrations cannot be followed statically, e.g.:`);
      for (const l of dynamic.slice(0, 10)) this.log.info(`  ${rel(l.file)}:${l.range.start.line + 1}`);
    }
    const slowest = [...parsed].sort((x, y) => y.parseMs - x.parseMs).slice(0, 10).filter((r) => r.parseMs >= 50);
    if (slowest.length) {
      this.log.info('Slowest files:');
      for (const r of slowest) this.log.info(`  ${r.parseMs.toFixed(0)} ms  ${rel(r.key)} (${(r.size / 1000).toFixed(0)} KB)`);
    }
    // folders two levels deep, by parsing time
    const folders = new Map<string, { files: number; bytes: number; ms: number }>();
    for (const r of parsed) {
      const parts = rel(r.key).split(/[\\/]/);
      const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '.';
      const f = folders.get(dir) ?? { files: 0, bytes: 0, ms: 0 };
      f.files++;
      f.bytes += r.size;
      f.ms += r.parseMs;
      folders.set(dir, f);
    }
    const top = [...folders].sort((x, y) => y[1].ms - x[1].ms).slice(0, 10);
    this.log.info('Heaviest folders (add them to meteorPower.exclude if they are not Meteor code):');
    for (const [dir, f] of top) this.log.info(`  ${dir}: ${f.files} files, ${(f.bytes / 1e6).toFixed(1)} MB, ${f.ms.toFixed(0)} ms`);
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
    const [releases, packageFiles, manifests] = await Promise.all([
      vscode.workspace.findFiles('**/.meteor/release', '{**/node_modules/**,**/.meteor/local/**}'),
      vscode.workspace.findFiles('**/package.js', '{**/node_modules/**,**/.meteor/**,**/.npm/**}'),
      // `meteor build --directory <dir>` writes <dir>/bundle/star.json, wherever <dir> is
      vscode.workspace.findFiles('**/star.json', '{**/node_modules/**,**/.meteor/local/**}'),
    ]);
    const generated: string[] = [];
    for (const m of manifests) {
      const text = await readText(m.fsPath);
      if (text && isBuildManifest(text)) generated.push(normPath(path.dirname(m.fsPath)));
    }
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
      dirs.map(async (dir) => {
        const packages = parseMeteorPackages((await readText(path.join(dir, '.meteor', 'packages'))) ?? '');
        const versions = [...parseMeteorVersions((await readText(path.join(dir, '.meteor', 'versions'))) ?? '').keys()];
        return { id: normPath(dir), name: unique ? base(dir) : vscode.workspace.asRelativePath(dir, false), packages, blaze: usesBlaze(packages, versions) };
      }),
    );

    const packages: PackageRoot[] = [];
    for (const u of packageFiles) {
      const text = await readText(u.fsPath);
      const dir = path.dirname(u.fsPath);
      const info = text && parsePackageJs(text, path.basename(dir));
      // a build copies the packages of the app: those copies are not local packages
      if (info && !generated.some((g) => normPath(dir).startsWith(g + '/'))) packages.push({ dir: normPath(dir), ...info });
    }
    return new AppLayout(apps, packages, generated);
  }

  private setLayout(layout: AppLayout) {
    this.layout = layout;
    this.filter = new PathFilter(this.filter.patterns, layout.apps.map((a) => a.id), layout.generated);
    this.index.setApps(new Map(layout.apps.map((a) => [a.id, a.name])), new Map(layout.apps.map((a) => [a.id, a.blaze])));
    for (const key of this.aliases.keys()) this.updateApps(key);
  }

  /** `.meteor/packages` or a `package.js` changed: recompute which app each file belongs to. */
  private scheduleLayout() {
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(async () => {
      const t0 = Date.now();
      const cfg = vscode.workspace.getConfiguration('meteorPower');
      const layout = await this.detectLayout(this.packageDirs(cfg.get<string[]>('packageDirs', [])));
      const dirs = (l: AppLayout) => [...l.apps.map((a) => a.id).sort(), '#', ...[...l.generated].sort()].join('|');
      if (dirs(layout) !== dirs(this.layout) || this.packagesChanged) {
        // an app or a build output appeared or disappeared: what is indexed changes
        void this.rescan();
        return;
      }
      this.setLayout(layout);
      this.log.info(`Apps and packages changed: ${layout.apps.length} app(s), ${layout.packages.length} local package(s) (${Date.now() - t0} ms)`);
      this.fireChange();
    }, 500);
  }

  /**
   * Definitions of the Meteor packages of each app, from its last build or the Meteor package cache.
   * Their files are never diagnosed; packages whose code is unknown make the app's diagnostics uncertain.
   */
  private async indexPackages(layout: AppLayout, id: number) {
    this.packagesChanged = false;
    if (!layout.apps.length) return;
    const t0 = Date.now();
    const warehouse = warehouseDir(process.env, process.platform, os.homedir());
    const local = new Set(layout.packages.map((p) => p.name));
    const files = new Map<string, { path: string; pkg: string; arch?: PackageArch; testOnly: boolean; apps: Set<string> }>();
    /** `app|package` → keys of its files */
    const pkgFiles = new Map<string, Set<string>>();
    const gaps = new Map<string, PackageGap[]>();
    for (const app of layout.apps) {
      const found = await locateAppPackages(app.id, local, warehouse);
      if (id !== this.scanId) return;
      gaps.set(app.id, found.missing.map((name) => ({ name, reason: 'missing' as const })));
      const from = { build: 0, cache: 0 };
      for (const src of found.sources) {
        from[src.from]++;
        for (const f of src.files) {
          const key = this.keyOf(f.path);
          const entry = files.get(key) ?? { path: f.path, pkg: src.name, arch: f.arch, testOnly: !!src.testOnly, apps: new Set<string>() };
          entry.apps.add(app.id);
          files.set(key, entry);
          pkgFiles.set(`${app.id}|${src.name}`, (pkgFiles.get(`${app.id}|${src.name}`) ?? new Set()).add(key));
        }
      }
      const where = warehouse ? path.join(warehouse, 'packages') : 'no Meteor package cache found';
      const missing = found.missing.length ? `; not found (${where}): ${found.missing.join(', ')}` : '';
      this.log.info(
        `Meteor packages of ${app.name}: ${from.build} from the last build, ${from.cache} from the package cache${missing}${found.buildNote ? ` (${found.buildNote})` : ''}`,
      );
    }
    const unreadable = new Map<string, string>();
    await this.pool.parseAll(
      [...files].map(([key, f]) => ({ key, path: f.path })),
      // the project's wrappers are not the packages': only Meteor's own APIs
      { library: true },
      (results) => {
        if (id !== this.scanId) return;
        for (const r of results) {
          const f = files.get(r.key)!;
          if (!r.facts) {
            // a file of the package that cannot be read: what it defines is unknown
            unreadable.set(r.key, r.skipped ?? (r.missing ? 'not readable' : 'syntax error'));
            continue;
          }
          this.index.updateLibrary(restrictToArch(r.facts, f.arch), f.pkg, f.testOnly);
          this.index.setFileApps(r.key, layout.isMulti ? [...f.apps].sort() : []);
        }
      },
      () => id !== this.scanId,
    );
    if (id !== this.scanId) return;
    for (const [k, keys] of pkgFiles) {
      const [app, pkg] = k.split('|');
      if ([...keys].some((x) => unreadable.has(x))) gaps.get(app)?.push({ name: pkg, reason: 'unreadable' });
    }
    for (const [app, list] of gaps) this.index.setPackageGaps(app, list);
    for (const [key, why] of unreadable) this.log.warn(`Meteor package ${files.get(key)!.pkg}: ${key} could not be parsed (${why}); the package counts as not analyzed`);
    this.log.info(`Meteor packages: ${files.size} file(s) indexed for definitions in ${Date.now() - t0} ms`);
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
    const key = this.track(file);
    const { facts, skipped } = parseFile(key, doc.getText(), this.options);
    this.versions.set(file, doc.version);
    if (facts) this.index.update(facts);
    else if (skipped) this.index.remove(key);
    // a syntax error while typing: keep the previous facts
    else return;
    this.fireChange();
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
    // e.g. a running Meteor rewriting .meteor/local: nothing to remember
    if (!this.accepts(uri)) return;
    const key = this.track(uri.fsPath);
    const open = vscode.workspace.textDocuments.find((d) => this.keyOf(d.uri.fsPath) === key);
    if (open) {
      if (!open.isDirty) this.syncDocument(open);
      return;
    }
    void this.indexFile(uri);
  }

  private onDiskDelete(uri: vscode.Uri) {
    if (!this.accepts(uri)) return;
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

  private async indexFile(uri: vscode.Uri) {
    if (!this.accepts(uri)) return;
    const key = this.track(uri.fsPath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SIZE) {
        this.index.remove(key);
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      const { facts, skipped } = parseFile(key, Buffer.from(bytes).toString('utf8'), this.options);
      if (facts) this.index.update(facts);
      else if (skipped) this.index.remove(key);
      this.fireChange();
    } catch {
      this.index.remove(key);
    }
  }

  /**
   * The files to index in the workspace folders. `findFiles` takes the excluded globs, then the folders
   * included again with `!` are searched on their own (an excluded glob would hide them).
   */
  private async findWorkspaceFiles(include: string): Promise<vscode.Uri[]> {
    const globs = (list: string[]) => (list.length ? `{${list.join(',')}}` : undefined);
    const reincluded = this.filter.reincluded;
    const [main, ...extra] = await Promise.all([
      vscode.workspace.findFiles(include, globs(this.filter.excludes)),
      ...reincluded.map((g) => vscode.workspace.findFiles(g, '{**/node_modules/**,**/.git/**,**/.meteor/local/**}')),
    ]);
    if (!reincluded.length) return main;
    const seen = new Set(main.map((u) => u.fsPath));
    const more = extra.flat().filter((u) => !seen.has(u.fsPath) && this.includeRe?.test(slash(u.fsPath)) && this.accepts(u));
    return [...main, ...more];
  }

  /** `meteorPower.exclude` with the conventional exclusions of the apps. */
  get pathFilter(): PathFilter {
    return this.filter;
  }

  /** Whether a file or folder is excluded by `meteorPower.exclude`, and by which pattern. */
  pathStatus(uri: vscode.Uri, isDir = false): PathStatus {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = folder ? slash(path.relative(folder.uri.fsPath, uri.fsPath)) : undefined;
    const inside = (p: string) => (isDir ? `${p}/x.js` : p);
    return this.filter.status(inside(slash(uri.fsPath)), rel === undefined ? undefined : inside(rel));
  }

  private accepts(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !SUPPORTED.test(uri.fsPath)) return false;
    // a file opened from elsewhere (a Meteor package, any other folder) is not workspace code
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      const n = normPath(uri.fsPath);
      if (!this.outsideDirs.some((d) => n.startsWith(d + '/'))) return false;
    }
    // the code of a Meteor package, opened in an editor: already read for its definitions
    if (this.index.libraryOf(this.keyOf(uri.fsPath))) return false;
    return !this.pathStatus(uri).excluded;
  }

  private fireChange() {
    if (this.scanning) return;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.changeEmitter.fire(), 250);
  }

  dispose() {
    for (const w of this.watchers) w.dispose();
    for (const t of this.pending.values()) clearTimeout(t);
    clearTimeout(this.changeTimer);
    clearTimeout(this.layoutTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

const slash = (p: string) => p.replace(/\\/g, '/');

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
