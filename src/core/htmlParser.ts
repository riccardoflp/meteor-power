import { emptyFacts, FileFacts, HtmlUsage, HtmlUsageKind, Loc } from './model';
import { LineMap, stripBom } from './text';

const BLOCK_BUILTINS = new Set(['if', 'unless', 'each', 'with', 'let']);
const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'this', 'in', 'else']);
const TOKEN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[()=]|[^\s()="']+/g;

interface Token {
  text: string;
  start: number;
  type: 'string' | 'punct' | 'word';
}

/** Extracts Blaze templates and Spacebars usages from an HTML file. */
export function parseHtml(file: string, source: string): FileFacts {
  const facts = emptyFacts(file);
  const text = stripBom(source);
  if (!/<template\b|<body\b/i.test(text)) return facts;

  const lm = new LineMap(text);
  const loc = (start: number, end: number): Loc => ({ file, range: lm.range(start, end) });
  const blocks: { start: number; end: number }[] = [];

  const openRe = /<template\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(text))) {
    const openEnd = openRe.lastIndex;
    const closeRe = /<\/template\s*>/gi;
    closeRe.lastIndex = openEnd;
    const c = closeRe.exec(text);
    const bodyEnd = c ? c.index : text.length;
    const end = c ? c.index + c[0].length : text.length;
    blocks.push({ start: m.index, end });

    const nm = /\bname\s*=\s*(["'])([^"']*)\1/i.exec(m[1]);
    if (nm) {
      const attrsStart = m.index + '<template'.length;
      const nameStart = attrsStart + nm.index + nm[0].length - 1 - nm[2].length;
      const name = nm[2];
      facts.templates.push({ name, loc: loc(nameStart, nameStart + name.length), fullLoc: loc(m.index, end) });
      scanBody(name, openEnd, bodyEnd);
    }
    openRe.lastIndex = end;
  }

  // <body> content behaves like a template called "body" (Template.body.helpers / events)
  const bodyRe = /<body\b[^>]*>/gi;
  while ((m = bodyRe.exec(text))) {
    const at = m.index;
    if (blocks.some((b) => at >= b.start && at < b.end)) continue;
    const close = text.toLowerCase().indexOf('</body>', bodyRe.lastIndex);
    const bodyEnd = close < 0 ? text.length : close;
    facts.templates.push({ name: 'body', loc: loc(at + 1, at + 5), fullLoc: loc(at, close < 0 ? text.length : close + 7) });
    scanBody('body', bodyRe.lastIndex, bodyEnd);
    break;
  }

  return facts;

  // ---------------------------------------------------------------------------------------------

  function scanBody(template: string, from: number, to: number) {
    const usages: HtmlUsage[] = [];
    const locals = new Set<string>();
    let i = from;
    for (;;) {
      const open = text.indexOf('{{', i);
      if (open < 0 || open >= to) break;
      if (text.startsWith('{{!--', open)) {
        const e = text.indexOf('--}}', open + 5);
        i = e < 0 ? to : e + 4;
        continue;
      }
      if (text.startsWith('{{!', open)) {
        const e = text.indexOf('}}', open + 3);
        i = e < 0 ? to : e + 2;
        continue;
      }
      const triple = text[open + 2] === '{';
      const contentStart = open + (triple ? 3 : 2);
      const closeTok = triple ? '}}}' : '}}';
      const close = text.indexOf(closeTok, contentStart);
      if (close < 0 || close > to) break;
      handleTag(template, contentStart, close, usages, locals);
      i = close + closeTok.length;
    }
    for (const u of usages) if (u.kind === 'helper' && locals.has(u.name)) u.local = true;
    facts.htmlUsages.push(...usages);
    scanMarks(template, from, to);
  }

  function handleTag(template: string, start: number, end: number, usages: HtmlUsage[], locals: Set<string>) {
    let s = start;
    while (s < end && /\s/.test(text[s])) s++;
    const lead = text[s];
    if (lead === '/') {
      const close = /^\/\s*([\w$.\-]+)/.exec(text.slice(s, end));
      if (close && !BLOCK_BUILTINS.has(close[1]) && !/^(Template|UI)\./.test(close[1])) {
        const at = s + close[0].length - close[1].length;
        facts.htmlCloses.push({ template, name: close[1], loc: loc(at, at + close[1].length) });
      }
      return;
    }
    const mode = lead === '>' ? 'inclusion' : lead === '#' ? 'block' : 'plain';
    if (mode !== 'plain') s++;
    const toks = tokenize(s, end);
    if (!toks.length) return;
    const first = toks[0];

    const add = (kind: HtmlUsageKind, name: string, at: number, path = name) => {
      usages.push({ template, name, path, kind, loc: loc(at, at + name.length), lineText: lm.lineText(lm.pos(at).line), local: false });
    };

    const exprs = (list: Token[]) => {
      for (let k = 0; k < list.length; k++) {
        const t = list[k];
        if (t.type !== 'word') continue;
        if (list[k + 1]?.text === '=') continue; // keyword argument name
        const w = t.text;
        if (KEYWORDS.has(w) || /^-?\d/.test(w) || w.startsWith('.') || w.startsWith('@') || w.startsWith('[') || /^this[./]/.test(w)) continue;
        const seg = w.split(/[./]/)[0];
        if (seg) add('helper', seg, t.start, w);
      }
    };

    if (mode === 'inclusion') {
      if (first.type !== 'word') return;
      if (first.text === 'Template.dynamic' || first.text === 'UI.dynamic') {
        for (let k = 1; k + 2 < toks.length; k++) {
          if (toks[k].text === 'template' && toks[k + 1].text === '=' && toks[k + 2].type === 'string') {
            const v = toks[k + 2];
            add('inclusion', v.text.slice(1, -1), v.start + 1);
          }
        }
      } else if (!/^(Template|UI)\./.test(first.text)) {
        add('inclusion', first.text, first.start);
      }
      exprs(toks.slice(1));
      return;
    }

    if (mode === 'block') {
      if (first.type !== 'word') return;
      const n = first.text;
      if (n === 'each' && toks[2]?.text === 'in' && toks[1]?.type === 'word') {
        locals.add(toks[1].text);
        exprs(toks.slice(3));
      } else if (n === 'let') {
        for (let k = 1; k + 1 < toks.length; k++) if (toks[k].type === 'word' && toks[k + 1].text === '=') locals.add(toks[k].text);
        exprs(toks.slice(1));
      } else if (BLOCK_BUILTINS.has(n)) {
        exprs(toks.slice(1));
      } else {
        if (!/^(Template|UI)\./.test(n)) add('block', n, first.start);
        exprs(toks.slice(1));
      }
      return;
    }

    if (first.type === 'word' && first.text === 'else') {
      const rest = toks.slice(1);
      exprs(rest[0] && BLOCK_BUILTINS.has(rest[0].text) ? rest.slice(1) : rest);
      return;
    }
    exprs(toks);
  }

  function tokenize(start: number, end: number): Token[] {
    const out: Token[] = [];
    const chunk = text.slice(start, end);
    TOKEN_RE.lastIndex = 0;
    let t: RegExpExecArray | null;
    while ((t = TOKEN_RE.exec(chunk))) {
      const s = t[0];
      const type = s[0] === '"' || s[0] === "'" ? 'string' : s === '(' || s === ')' || s === '=' ? 'punct' : 'word';
      out.push({ text: s, start: start + t.index, type });
    }
    return out;
  }

  function scanMarks(template: string, from: number, to: number) {
    const chunk = text.slice(from, to);
    const re = /\s(class|id)\s*=\s*(["'])([^"']*)\2/gi;
    let a: RegExpExecArray | null;
    while ((a = re.exec(chunk))) {
      const kind = a[1].toLowerCase() as 'class' | 'id';
      const valueStart = from + a.index + a[0].length - 1 - a[3].length;
      const wordRe = /[^\s]+/g;
      let w: RegExpExecArray | null;
      while ((w = wordRe.exec(a[3]))) {
        if (/[{}]/.test(w[0])) continue;
        const s = valueStart + w.index;
        facts.htmlMarks.push({ template, kind, name: w[0], loc: loc(s, s + w[0].length) });
      }
    }
  }
}
