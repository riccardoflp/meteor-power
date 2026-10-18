/**
 * Meteor packages used by an app (Atmosphere and core packages), read only for their definitions:
 * methods, publications, templates and global helpers they register. Their files are never diagnosed.
 *
 * Where the code of a package is found, in order:
 * 1. the last build of the app, `.meteor/local/build/programs/<arch>/packages/<name>.js`, written by `meteor run`;
 * 2. the Meteor package cache, `<warehouse>/packages/<name>/<version>/`, for the version selected in
 *    `.meteor/versions`, through the isopack metadata (`isopack.json` and one JSON file per architecture).
 * Packages found in neither place are reported as not analyzed: what they define is unknown.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseMeteorPackages } from './apps';
import { FileFacts } from './model';

/** `.meteor/versions`: `name@version` per line. */
export function parseMeteorVersions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const at = line.lastIndexOf('@');
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}

/** Folder and file name of a package: `ostrio:files` → `ostrio_files`. */
export function packageFileName(name: string): string {
  return name.replace(/:/g, '_');
}

/**
 * The Meteor folder holding the package cache: `METEOR_WAREHOUSE_DIR` when set, otherwise where the
 * installer puts it (`%LOCALAPPDATA%\.meteor` on Windows, `~/.meteor` elsewhere).
 */
export function warehouseDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | undefined {
  if (env.METEOR_WAREHOUSE_DIR) return env.METEOR_WAREHOUSE_DIR;
  if (platform === 'win32') return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, '.meteor') : undefined;
  return home ? path.join(home, '.meteor') : undefined;
}

/** Where a file of a package runs: `server` (Meteor arch `os`), `client` (`web.*`), unknown otherwise. */
export type PackageArch = 'server' | 'client';

export interface PackageFile {
  path: string;
  arch?: PackageArch;
}

export interface PackageSource {
  name: string;
  files: PackageFile[];
  from: 'build' | 'cache';
  /** `testOnly` package (`Package.describe({ testOnly: true })`): loaded only by `meteor test`. */
  testOnly?: boolean;
}

export interface AppPackages {
  sources: PackageSource[];
  /** Packages whose code was found nowhere. */
  missing: string[];
  /** Why the build was not used, for the log. */
  buildNote?: string;
}

const MAX_CACHE_FILES = 400;
const SKIP_DIRS = new Set(['node_modules', '.npm', '.git']);

/** The arch of a Meteor build or unibuild name: `os`, `os.windows.x86_64` → server, `web.browser` → client. */
export function archOf(name: string): PackageArch | undefined {
  if (name === 'os' || name === 'server' || name.startsWith('os.')) return 'server';
  if (name.startsWith('web.')) return 'client';
  return undefined;
}

/**
 * One server arch and one client arch among those available: the other web archs (`web.browser.legacy`,
 * `web.cordova`) are the same package compiled again, read twice they would only duplicate definitions.
 */
function chooseArchs(names: string[]): Set<string> {
  const sorted = [...names].sort();
  const server = sorted.find((n) => n === 'os' || n === 'server') ?? sorted.find((n) => archOf(n) === 'server');
  const client = sorted.find((n) => n === 'web.browser') ?? sorted.find((n) => archOf(n) === 'client');
  return new Set([server, client].filter((x): x is string => !!x));
}

/**
 * What a package file may define where it runs: methods and publications exist on the server only
 * (on the client they are stubs), templates and helpers on the client only.
 */
export function restrictToArch(facts: FileFacts, arch: PackageArch | undefined): FileFacts {
  if (arch === 'server') return { ...facts, jsTemplates: [], templateParts: [], globalHelpers: [], templates: [], htmlUsages: [] };
  if (arch === 'client') return { ...facts, methods: [], publications: [], registrations: [], dynamicRegistrations: [] };
  return facts;
}

/**
 * Where the code of each package of the app is. `local`: names of the packages whose source is in the
 * workspace (indexed as source, not here).
 */
export async function locateAppPackages(appDir: string, local: ReadonlySet<string>, warehouse: string | undefined): Promise<AppPackages> {
  const meteorDir = path.join(appDir, '.meteor');
  let versions: Map<string, string | undefined> = parseMeteorVersions((await read(path.join(meteorDir, 'versions'))) ?? '');
  // never resolved (no .meteor/versions): the listed packages, without versions; the packages they use are unknown
  if (!versions.size) versions = new Map(parseMeteorPackages((await read(path.join(meteorDir, 'packages'))) ?? '').map((n) => [n, undefined]));
  const out: AppPackages = { sources: [], missing: [] };
  if (!versions.size) return out;

  const build = await readBuild(path.join(meteorDir, 'local', 'build'), path.join(meteorDir, 'versions'));
  if (build.note) out.buildNote = build.note;
  for (const [name, version] of versions) {
    if (local.has(name)) continue;
    const cacheDir = warehouse && version ? path.join(warehouse, 'packages', packageFileName(name), version) : undefined;
    const fromBuild = build.files?.get(packageFileName(name));
    if (fromBuild) {
      // the build has no metadata: testOnly comes from the cached isopack, when there is one
      const meta = cacheDir ? isopackOf(await readJson(path.join(cacheDir, 'isopack.json'))) : undefined;
      out.sources.push({ name, files: fromBuild, from: 'build', ...(meta?.testOnly === true ? { testOnly: true } : {}) });
      continue;
    }
    // an up-to-date build loads every package with runtime code: one missing from it has none (build plugins)
    if (build.complete) continue;
    const cached = cacheDir ? await cachedPackage(cacheDir) : undefined;
    if (cached) out.sources.push({ name, files: cached.files, from: 'cache', ...(cached.testOnly ? { testOnly: true } : {}) });
    else out.missing.push(name);
  }
  return out;
}

/**
 * `programs/<arch>/packages/*.js` of a build, by file name, for one server and one client arch.
 * `complete` when the build is newer than `.meteor/versions`.
 */
async function readBuild(buildDir: string, versionsFile: string): Promise<{ files?: Map<string, PackageFile[]>; complete: boolean; note?: string }> {
  const programs = path.join(buildDir, 'programs');
  const archs = await list(programs);
  if (!archs) return { complete: false };
  const files = new Map<string, PackageFile[]>();
  for (const arch of chooseArchs(archs)) {
    for (const n of (await list(path.join(programs, arch, 'packages'))) ?? []) {
      if (!n.endsWith('.js')) continue;
      const key = n.slice(0, -3);
      files.set(key, [...(files.get(key) ?? []), { path: path.join(programs, arch, 'packages', n), arch: archOf(arch) }]);
    }
  }
  if (!files.size) return { complete: false };
  const [built, changed] = await Promise.all([mtime(path.join(buildDir, 'star.json')), mtime(versionsFile)]);
  const complete = built !== undefined && changed !== undefined && built >= changed;
  return { files, complete, note: complete ? undefined : 'the last build is older than .meteor/versions' };
}

/** The isopack description in `isopack.json` (`{ "isopack-2": { name, builds, testOnly, … } }`). */
function isopackOf(json: unknown): { builds?: unknown; testOnly?: unknown } | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const values = Object.entries(json as Record<string, unknown>)
    .filter(([k, v]) => k.startsWith('isopack') && v && typeof v === 'object')
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
  return values[0]?.[1] as { builds?: unknown; testOnly?: unknown } | undefined;
}

/** The JavaScript files of a cached package version, `undefined` when it is not in the cache. */
async function cachedPackage(dir: string): Promise<{ files: PackageFile[]; testOnly: boolean } | undefined> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return undefined;
  const iso = isopackOf(await readJson(path.join(dir, 'isopack.json')));
  const testOnly = iso?.testOnly === true;
  const files: PackageFile[] = [];
  const seen = new Set<string>();
  const add = (p: string, arch: PackageArch | undefined) => {
    if (seen.has(p) || files.length >= MAX_CACHE_FILES) return;
    seen.add(p);
    files.push({ path: p, arch });
  };

  // the metadata: one unibuild per arch, listing its JavaScript resources
  const builds = (Array.isArray(iso?.builds) ? iso.builds : []).filter(
    (b): b is { arch: string; path: string } => typeof b?.arch === 'string' && typeof b?.path === 'string',
  );
  const chosen = chooseArchs(builds.map((b) => b.arch));
  for (const b of builds) {
    if (!chosen.has(b.arch)) continue;
    const unibuild = (await readJson(path.join(dir, b.path))) as { resources?: unknown } | undefined;
    const resources = Array.isArray(unibuild?.resources) ? unibuild.resources : [];
    for (const r of resources) {
      if (typeof r?.file === 'string' && r.type !== 'asset' && /\.(js|mjs|cjs)$/i.test(r.file)) add(path.join(dir, r.file), archOf(b.arch));
    }
  }
  if (files.length) return { files, testOnly };

  // no usable metadata: the arch folders (`os`, `web.browser`), or everything when there are none
  const archDirs = chooseArchs(entries.filter((e) => e.isDirectory() && archOf(e.name)).map((e) => e.name));
  const visit = async (d: string, depth: number, arch: PackageArch | undefined) => {
    if (depth > 8 || files.length >= MAX_CACHE_FILES) return;
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(p, depth + 1, arch);
      } else if (/\.(js|mjs|cjs)$/i.test(e.name)) add(p, arch);
    }
  };
  if (archDirs.size) for (const a of archDirs) await visit(path.join(dir, a), 1, archOf(a));
  else await visit(dir, 0, undefined);
  return { files, testOnly };
}

async function read(file: string): Promise<string | undefined> {
  return fs.promises.readFile(file, 'utf8').catch(() => undefined);
}

async function readJson(file: string): Promise<unknown> {
  const text = await read(file);
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function list(dir: string): Promise<string[] | undefined> {
  return fs.promises.readdir(dir).catch(() => undefined);
}

async function mtime(file: string): Promise<number | undefined> {
  return fs.promises.stat(file).then((s) => s.mtimeMs, () => undefined);
}
