import { globToRegExp } from './text';

/** Never Meteor source, whatever the settings say. */
const ALWAYS_EXCLUDED = /(?:^|\/)(?:node_modules|\.git|\.meteor\/local)(?:\/|$)/i;

interface Rule {
  pattern: string;
  negated: boolean;
  /** Relative to the workspace folder (VS Code glob semantics): only matches paths inside the workspace. */
  anchored: boolean;
  re: RegExp;
}

/** Why a path is excluded, or not. */
export interface PathStatus {
  excluded: boolean;
  /** The pattern deciding it (last match wins), `undefined` when no pattern matches. */
  by?: string;
  /** node_modules, .git, .meteor/local, `meteor build` output: cannot be included. */
  always?: boolean;
}

/**
 * `meteorPower.exclude`: globs of the paths not to index, in order. `!glob` includes again what
 * an earlier pattern excludes (like `.gitignore`). Globs starting with `**` match anywhere, the others
 * are relative to the workspace folder (like `files.exclude`).
 */
export class PathFilter {
  private readonly rules: Rule[];
  private readonly conventions: string[];
  private readonly generated: string[];

  /**
   * `appDirs`: the folders of the Meteor apps (`/` separators). Their `public/` (static files) and `private/`
   * (server assets) are not app code: excluded unless a pattern includes them again.
   */
  constructor(
    readonly patterns: readonly string[],
    private readonly appDirs: readonly string[] = [],
    /** Folders written by `meteor build`: generated copies of the app, never indexed. */
    private readonly generatedDirs: readonly string[] = [],
  ) {
    this.generated = generatedDirs.map((d) => `${d.replace(/\/+$/, '')}/`.toLowerCase());
    this.conventions = appDirs.flatMap((d) => ['public', 'private'].map((x) => `${d.replace(/\/+$/, '')}/${x}/`.toLowerCase()));
    this.rules = patterns.flatMap((raw) => {
      const negated = raw.startsWith('!');
      const pattern = normPattern(negated ? raw.slice(1) : raw);
      if (!pattern) return [];
      const anchored = !pattern.startsWith('**');
      // a glob naming a folder (`scripts`, `scripts/`) also matches what it contains
      const re = globToRegExp(pattern.endsWith('/**') ? pattern : `${pattern}{,/**}`, anchored);
      return [{ pattern: raw, negated, anchored, re }];
    });
  }

  /** Patterns without `!`, to pass to `findFiles` when there is nothing to include again. */
  get excludes(): string[] {
    return this.rules.filter((r) => !r.negated).map((r) => r.pattern);
  }

  /** The `!` patterns (without the `!`): folders to search again because an earlier pattern hides them. */
  get reincluded(): string[] {
    return this.rules.filter((r) => r.negated).map((r) => r.pattern.slice(1));
  }

  /**
   * `abs`: the full path; `rel`: the path relative to its workspace folder (`undefined` outside the workspace).
   * Both with `/` separators. A folder is tested with a trailing `/`.
   */
  status(abs: string, rel?: string): PathStatus {
    if (ALWAYS_EXCLUDED.test(rel ?? abs)) return { excluded: true, always: true };
    const lower = abs.toLowerCase();
    if (this.generated.some((d) => lower.startsWith(d))) return { excluded: true, always: true, by: 'output of meteor build' };
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const r = this.rules[i];
      const hit = r.anchored ? rel !== undefined && r.re.test(rel) : r.re.test(abs);
      if (hit) return { excluded: !r.negated, by: r.pattern };
    }
    const dir = this.conventions.find((d) => lower.startsWith(d));
    if (dir) return { excluded: true, by: `${dir.split('/').slice(-2, -1)[0]}/ of a Meteor app` };
    return { excluded: false };
  }

  /** A filter with other patterns and the same apps. */
  with(patterns: readonly string[]): PathFilter {
    return new PathFilter(patterns, this.appDirs, this.generatedDirs);
  }

  excluded(abs: string, rel?: string): boolean {
    return this.status(abs, rel).excluded;
  }
}

/** `./a/b/`, `a\b` → `a/b` */
function normPattern(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** The pattern written for a path chosen in the Explorer: `a/b/**` for a folder, `a/b.js` for a file. */
function patternFor(rel: string, isDir: boolean): string {
  return isDir ? `${rel}/**` : rel;
}

/** Path a folder or file is tested with: for a folder, any file inside it. */
function probe(rel: string, isDir: boolean): string {
  return isDir ? `${rel}/x.js` : rel;
}

/**
 * Patterns that name `rel` itself or something inside it, written without wildcards before it
 * (`a/b`, `a/b/**`, `!a/b/c.js`): they are replaced when the user excludes or includes `rel`.
 */
function isAbout(raw: string, rel: string): boolean {
  const p = normPattern(raw.startsWith('!') ? raw.slice(1) : raw).toLowerCase();
  const r = rel.toLowerCase();
  return p === r || p.startsWith(r + '/');
}

/**
 * The new `meteorPower.exclude` after excluding (`exclude = true`) or including a workspace path.
 * `abs` and `rel` as in {@link PathFilter.status}; `base` gives the Meteor apps (conventional exclusions).
 * Returns `undefined` when nothing has to change.
 */
export function togglePath(
  patterns: readonly string[],
  abs: string,
  rel: string,
  isDir: boolean,
  exclude: boolean,
  base: PathFilter = new PathFilter([]),
): string[] | undefined {
  rel = normPattern(rel);
  const absProbe = isDir ? `${abs.replace(/\/+$/, '')}/x.js` : abs;
  const isNow = (list: readonly string[]) => base.with(list).excluded(absProbe, probe(rel, isDir));
  if (isNow(patterns) === exclude) return undefined;
  // rules about this path or its content are replaced by one rule for the whole path
  const kept = patterns.filter((p) => !isAbout(p, rel));
  if (isNow(kept) === exclude) return kept;
  return [...kept, (exclude ? '' : '!') + patternFor(rel, isDir)];
}
