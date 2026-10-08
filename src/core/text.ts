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

/** Converts a glob like `**\/node_modules/**` or `*.{js,ts}` to a RegExp over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
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
  return new RegExp('(?:^|/)' + re.replace(/^\(\?:\.\*\/\)\?/, '') + '$', 'i');
}

/** Name matching with `*` wildcards, used by the ignore lists. */
export function wildcardMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}
