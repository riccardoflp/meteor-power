import { Env, Pos, Range } from './model';

/** Converts string offsets to line/character positions (UTF-16 code units, like VS Code). */
export class LineMap {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10) this.starts.push(i + 1);
      else if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++;
        this.starts.push(i + 1);
      }
    }
  }

  pos(offset: number): Pos {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo] };
  }

  range(start: number, end: number): Range {
    return { start: this.pos(start), end: this.pos(end) };
  }

  lineText(line: number): string {
    const start = this.starts[line] ?? 0;
    const end = line + 1 < this.starts.length ? this.starts[line + 1] : this.text.length;
    const t = this.text.slice(start, end).trim();
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function envFromPath(file: string): Env | undefined {
  const segments = file.replace(/\\/g, '/').toLowerCase().split('/');
  if (segments.includes('server')) return 'server';
  if (segments.includes('client')) return 'client';
  return undefined;
}

/** First lines of a code fragment, dedented, for hovers. */
export function makeSnippet(code: string, maxLines = 30): string {
  const lines = code.split(/\r?\n/);
  const cut = lines.length > maxLines;
  const shown = lines.slice(0, maxLines);
  const indents = shown
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  const out = [shown[0], ...shown.slice(1).map((l) => l.slice(Math.min(min, /^\s*/.exec(l)![0].length)))];
  if (cut) out.push('  // …');
  return out.join('\n');
}

export function containsPos(range: Range, pos: Pos): boolean {
  const { start, end } = range;
  if (pos.line < start.line || pos.line > end.line) return false;
  if (pos.line === start.line && pos.character < start.character) return false;
  if (pos.line === end.line && pos.character > end.character) return false;
  return true;
}

/**
 * Converts a glob like `**\/node_modules/**` or `*.{js,ts}` to a RegExp over `/`-separated paths.
 * `anchored`: the glob must match from the start of the path (a path relative to the workspace folder).
 */
export function globToRegExp(glob: string, anchored = false): RegExp {
  let re = '';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup = true;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : '(?:^|/)' + re.replace(/^\(\?:\.\*\/\)\?/, '') + '$', 'i');
}

/** Name matching with `*` wildcards, used by the ignore lists. */
export function wildcardMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

/** Edit distance with adjacent transpositions (optimal string alignment): `usres` → `users` is 1. */
export function editDistance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0].push(j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i].push(d);
    }
  }
  return rows[a.length][b.length];
}

/** The candidates closest to a misspelled name, nearest first (a third of its length apart at most, between 1 and 4 edits). */
export function closestNames(name: string, candidates: Iterable<string>, max = 3): string[] {
  const limit = Math.max(1, Math.min(4, Math.floor(name.length / 3)));
  const found: [string, number][] = [];
  for (const c of new Set(candidates)) {
    if (c === name || Math.abs(c.length - name.length) > limit) continue;
    const d = editDistance(name, c);
    if (d <= limit) found.push([c, d]);
  }
  return found.sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0])).slice(0, max).map(([c]) => c);
}

/**
 * How well a workspace symbol matches a query, lower is better, `undefined` when it does not:
 * the same name, then a prefix of the name or of a segment (`insert` in `tasks.insert`), then a substring,
 * then the query letters in order (`tskins`). Case is ignored.
 */
export function symbolMatchScore(query: string, name: string): number | undefined {
  const q = query.toLowerCase();
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.split(/[.\-_/:]/).some((seg) => seg.startsWith(q))) return 2;
  if (n.includes(q)) return 3;
  let i = 0;
  for (const c of n) if (c === q[i]) i++;
  return i === q.length ? 4 : undefined;
}
