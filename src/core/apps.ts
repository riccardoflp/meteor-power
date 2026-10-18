/**
 * Several Meteor apps in one workspace: which app(s) each file belongs to.
 *
 * - An app is a folder containing `.meteor/release`; a file belongs to the apps whose folder contains it.
 * - A file reachable through symlinks has several paths: it belongs to every app reached by any of them
 *   (a shared folder linked into three apps belongs to all three).
 * - A file of a local package (a folder with `package.js`) belongs to the apps that use the package,
 *   directly in `.meteor/packages` or through other packages (`api.use` / `api.imply`).
 * - A file outside every app (and not in a used package) belongs to none: it is visible from everywhere.
 */

export interface AppRoot {
  /** Normalized folder path, used as id. */
  id: string;
  /** Display name. */
  name: string;
  /** Packages listed in `.meteor/packages`. */
  packages: string[];
  /** See {@link usesBlaze}. */
  blaze?: boolean;
}

export interface PackageRoot {
  /** Normalized folder path. */
  dir: string;
  name: string;
  /** Packages it uses or implies. */
  uses: string[];
}

/** Packages providing Blaze templates: an app without any of them has no `{{> template}}`. */
const BLAZE_PACKAGES = ['blaze', 'templating', 'templating-runtime', 'blaze-html-templates'];

/**
 * Whether an app uses Blaze. `versions` (`.meteor/versions`) lists every package, implied ones included:
 * the answer is certain. With `.meteor/packages` only, a package may bring Blaze in: `undefined` when none is listed.
 */
export function usesBlaze(packages: readonly string[], versions: readonly string[] | undefined): boolean | undefined {
  if (versions?.length) return versions.some((p) => BLAZE_PACKAGES.includes(p));
  return packages.some((p) => BLAZE_PACKAGES.includes(p)) ? true : undefined;
}

/**
 * Test files, loaded by Meteor only in test mode (`*.test.js`, `*.app-spec.js`, ...), and files in `tests/`
 * folders, never loaded by the app. `file`: the path inside the app (a folder above it named `tests` does not count).
 */
export function isTestFile(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  return /\.(?:app-)?(?:test|spec)s?\.[^/.]+$/i.test(p) || /(?:^|\/)tests\//i.test(p);
}

/** Lower case on case-insensitive file systems, `/` separators, no trailing slash. */
export function normPath(p: string, caseInsensitive = process.platform !== 'linux'): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? s.toLowerCase() : s;
}

/** Package names listed in `.meteor/packages` (comments and version constraints removed). */
export function parseMeteorPackages(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    out.push(line.split(/[@\s]/)[0]);
  }
  return out;
}

/** Name and dependencies of a package from its `package.js`; the folder name when it has no explicit name. */
export function parsePackageJs(text: string, dirName: string): { name: string; uses: string[] } | undefined {
  if (!/\bPackage\s*\.\s*describe\b/.test(text)) return undefined;
  const describe = /\bPackage\s*\.\s*describe\s*\(\s*\{([\s\S]*?)\}\s*\)/.exec(text);
  const name = describe && /\bname\s*:\s*['"`]([^'"`]+)['"`]/.exec(describe[1]);
  const uses = new Set<string>();
  const re = /\bapi\s*\.\s*(?:use|imply)\s*\(\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const s of m[1].match(/['"`][^'"`]+['"`]/g) ?? []) uses.add(s.slice(1, -1).split(/[@\s]/)[0]);
  }
  return { name: name ? name[1] : dirName, uses: [...uses] };
}

export class AppLayout {
  private readonly appsByPackage = new Map<string, string[]>();
  private readonly packageDirs: PackageRoot[];

  constructor(
    readonly apps: AppRoot[],
    readonly packages: PackageRoot[],
    /** Folders written by `meteor build` (with a `star.json`), normalized like app ids. */
    readonly generated: string[] = [],
  ) {
    // deepest folders first, so that a nested package wins over the one containing it
    this.packageDirs = [...packages].sort((x, y) => y.dir.length - x.dir.length);
    const byName = new Map(packages.map((p) => [p.name, p]));
    for (const app of apps) {
      // packages used by the app, directly or through other local packages
      const queue = [...app.packages];
      const seen = new Set<string>();
      while (queue.length) {
        const name = queue.pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        const pkg = byName.get(name);
        if (!pkg) continue;
        const list = this.appsByPackage.get(pkg.dir);
        if (list) list.push(app.id);
        else this.appsByPackage.set(pkg.dir, [app.id]);
        queue.push(...pkg.uses);
      }
    }
  }

  /** True when the workspace has more than one app, i.e. when scoping makes any difference. */
  get isMulti(): boolean {
    return this.apps.length > 1;
  }

  /** Apps a single path belongs to. */
  appsOfPath(p: string): string[] {
    const n = normPath(p);
    const pkg = this.packageDirs.find((d) => isUnder(n, d.dir));
    const used = pkg && this.appsByPackage.get(pkg.dir);
    if (used) return used;
    return this.apps.filter((a) => isUnder(n, a.id)).map((a) => a.id);
  }

  /** Apps a file belongs to, given every path it can be reached by. */
  appsOf(paths: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const p of paths) for (const id of this.appsOfPath(p)) out.add(id);
    return [...out].sort();
  }
}

/**
 * True when `star.json` describes the output of `meteor build` (`bundle/star.json`, next to `programs/`):
 * generated code, never indexed. The JSON is checked, not the folder name, which the user chooses.
 */
export function isBuildManifest(text: string): boolean {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  if (!json || typeof json !== 'object') return false;
  const { format, programs } = json as { format?: unknown; programs?: unknown };
  if (typeof format === 'string' && format.startsWith('site-archive')) return true;
  return Array.isArray(programs) && programs.some((x) => typeof x?.path === 'string' && x.path.startsWith('programs/'));
}

function isUnder(path: string, dir: string): boolean {
  return path.length > dir.length && path.startsWith(dir) && path[dir.length] === '/';
}
