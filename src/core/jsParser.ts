import { parse, ParserPlugin } from '@babel/parser';
import { CallSite, emptyFacts, Env, FileFacts, Loc, Member, MethodDef, TemplatePartKind } from './model';
import { envFromPath, LineMap, makeSnippet, stripBom } from './text';

// Babel AST nodes; typed loosely on purpose, we only read a handful of fields.
type Node = any;

const QUICK_CHECK = /Meteor|Template|subscribe|ValidatedMethod|BlazeLayout/;
/** Files that may only export name constants (e.g. `export const METHODS = { UPDATE: 'users.update' }`). */
const CONSTANTS_CHECK = /\bexport\s+(?:const|let|var|enum)\b/;
const CALL_FNS = new Set(['call', 'callAsync', 'apply', 'applyAsync']);
const TEMPLATE_PART_KINDS = new Set<string>(['helpers', 'events', 'onCreated', 'onRendered', 'onDestroyed']);
/** Properties of the global `Template` that are not template names. */
const TEMPLATE_STATICS = new Set([
  'instance',
  'currentData',
  'parentData',
  'registerHelper',
  'deregisterHelper',
  'dynamic',
  'contentBlock',
  'elseBlock',
  'prototype',
  'constructor',
  'bind',
  'call',
  'apply',
  'toString',
  'hasOwnProperty',
]);
const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range']);

interface NameResult {
  name?: string;
  nameExpr?: string;
  start: number;
  end: number;
}

/**
 * Extracts Meteor/Blaze facts from a JS/TS file.
 * Returns `null` when the file cannot be parsed at all (so callers can keep the previous facts while typing).
 */
export function parseJs(file: string, source: string): FileFacts | null {
  const facts = emptyFacts(file);
  const text = stripBom(source);
  if (!QUICK_CHECK.test(text) && !CONSTANTS_CHECK.test(text)) return facts;

  const ast = tryParse(file, text);
  if (!ast) return null;

  const lm = new LineMap(text);
  const loc = (start: number, end: number): Loc => ({ file, range: lm.range(start, end) });
  const fileEnv = envFromPath(file);
  const objects = new Map<string, Node>();

  collectTopLevel(ast.program);
  walk(ast.program, undefined);
  return facts;

  // ---------------------------------------------------------------------------------------------

  function collectTopLevel(program: Node) {
    for (const stmt of program.body) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (!decl) continue;
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id?.type !== 'Identifier' || !d.init) continue;
          const init = unwrap(d.init);
          const s = staticString(init);
          if (s !== undefined) facts.constants[d.id.name] = s;
          else if (init.type === 'ObjectExpression') {
            objects.set(d.id.name, init);
            flattenObject(d.id.name, init, 0);
          }
        }
      } else if (decl.type === 'TSEnumDeclaration') {
        for (const m of decl.members ?? decl.body?.members ?? []) {
          const key = m.id?.type === 'Identifier' ? m.id.name : m.id?.value;
          const s = m.initializer && staticString(m.initializer);
          if (key && s !== undefined) facts.constants[`${decl.id.name}.${key}`] = s;
        }
      }
    }
  }

  function flattenObject(prefix: string, obj: Node, depth: number) {
    if (depth > 4) return;
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' || p.computed) continue;
      const key = literalKey(p.key);
      if (key === undefined) continue;
      const v = unwrap(p.value);
      const s = staticString(v);
      if (s !== undefined) facts.constants[`${prefix}.${key}`] = s;
      else if (v.type === 'ObjectExpression') flattenObject(`${prefix}.${key}`, v, depth + 1);
    }
  }

  function walk(node: Node, env: Env | undefined): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, env);
      return;
    }
    if (typeof node.type !== 'string') return;

    switch (node.type) {
      case 'IfStatement': {
        const e = envOfTest(node.test);
        if (e) {
          walk(node.test, env);
          walk(node.consequent, e);
          walk(node.alternate, e === 'server' ? 'client' : 'server');
          return;
        }
        break;
      }
      case 'CallExpression':
      case 'OptionalCallExpression':
        visitCall(node, env ?? fileEnv ?? 'both');
        break;
      case 'NewExpression':
        visitNew(node, env ?? fileEnv ?? 'both');
        break;
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const t = templateNameOf(node);
        if (t) facts.templateRefs.push({ template: t.name!, loc: loc(t.start, t.end), lineText: lm.lineText(lm.pos(t.start).line) });
        break;
      }
    }

    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (v && typeof v === 'object') walk(v, env);
    }
  }

  function visitCall(node: Node, env: Env) {
    const callee = node.callee;
    if (!isMember(callee)) return;
    const prop = propName(callee);
    if (!prop) return;
    const obj = callee.object;
    const args = node.arguments ?? [];

    if (isIdent(obj, 'Meteor')) {
      if (prop === 'methods') {
        const o = resolveObject(args[0]);
        if (o) for (const p of o.properties) addDefFromProperty(p, 'method', env);
      } else if (CALL_FNS.has(prop)) {
        addCall(facts.calls, args[0], prop, env);
      } else if (prop === 'publish') {
        const o = args[0] && unwrap(args[0]);
        if (o?.type === 'ObjectExpression') {
          for (const p of o.properties) addDefFromProperty(p, 'publication', env);
        } else {
          const n = nameOf(args[0]);
          if (n) facts.publications.push(makeDef(n, 'publication', fnOf(args[1]), node, env, undefined));
        }
      } else if (prop === 'subscribe') {
        addCall(facts.subscriptions, args[0], prop, env);
      }
      return;
    }

    // this.subscribe('x'), instance.subscribe('x'), Template.instance().subscribe('x')
    if (prop === 'subscribe') {
      addCall(facts.subscriptions, args[0], prop, env);
      return;
    }

    const tpl = templateNameOf(obj);
    if (tpl && TEMPLATE_PART_KINDS.has(prop)) {
      const members = prop === 'helpers' || prop === 'events' ? membersOf(resolveObject(args[0])) : [];
      facts.templateParts.push({
        template: tpl.name!,
        kind: prop as TemplatePartKind,
        nameLoc: loc(tpl.start, tpl.end),
        fullLoc: loc(node.start, node.end),
        members,
      });
      return;
    }

    if (isIdent(obj, 'Template') && prop === 'registerHelper') {
      const n = nameOf(args[0]);
      if (n?.name) facts.globalHelpers.push(makeMember(n.name, n.start, n.end, fnOf(args[1]), node, undefined));
      return;
    }

    // BlazeLayout.render('layout', { main: 'page' })
    if (isIdent(obj, 'BlazeLayout') && prop === 'render') {
      const n = nameOf(args[0]);
      if (n?.name) addTemplateRef(n.name, n.start, n.end);
      const o = args[1] && unwrap(args[1]);
      if (o?.type === 'ObjectExpression') {
        for (const p of o.properties) {
          if (p.type !== 'ObjectProperty') continue;
          const s = staticString(p.value);
          if (s) addTemplateRef(s, p.value.start + 1, p.value.end - 1);
        }
      }
    }
  }

  function visitNew(node: Node, env: Env) {
    const c = node.callee;
    const isValidated = isIdent(c, 'ValidatedMethod') || (isMember(c) && propName(c) === 'ValidatedMethod');
    if (!isValidated) return;
    const o = node.arguments?.[0] && unwrap(node.arguments[0]);
    if (o?.type !== 'ObjectExpression') return;
    let name: NameResult | undefined;
    let run: Node;
    for (const p of o.properties) {
      const key = p.key && !p.computed ? literalKey(p.key) : undefined;
      if (key === 'name' && p.type === 'ObjectProperty') name = nameOf(p.value);
      if (key === 'run') run = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    }
    if (name) facts.methods.push(makeDef(name, 'validated', run, node, env, docOf(node)));
  }

  function addDefFromProperty(p: Node, kind: 'method' | 'publication', env: Env) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') return;
    const n = keyName(p);
    if (!n) return;
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    const def = makeDef(n, kind, fn, p, env, docOf(p));
    (kind === 'method' ? facts.methods : facts.publications).push(def);
  }

  function makeDef(n: NameResult, kind: MethodDef['kind'], fn: Node, full: Node, env: Env, doc: string | undefined): MethodDef {
    return {
      name: n.name,
      nameExpr: n.nameExpr,
      kind,
      loc: loc(n.start, n.end),
      fullLoc: loc(full.start, full.end),
      params: paramsOf(fn),
      isAsync: !!fn?.async,
      env,
      doc,
      snippet: makeSnippet(text.slice(full.start, full.end)),
    };
  }

  function membersOf(obj: Node | undefined): Member[] {
    if (!obj) return [];
    const out: Member[] = [];
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
      const n = keyName(p);
      if (!n?.name) continue;
      const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
      out.push(makeMember(n.name, n.start, n.end, fn, p, docOf(p)));
    }
    return out;
  }

  function makeMember(name: string, start: number, end: number, fn: Node, full: Node, doc: string | undefined): Member {
    return {
      name,
      loc: loc(start, end),
      fullLoc: loc(full.start, full.end),
      params: paramsOf(fn),
      isAsync: !!fn?.async,
      snippet: makeSnippet(text.slice(full.start, full.end)),
      doc,
    };
  }

  function addCall(target: CallSite[], arg: Node, fn: string, env: Env) {
    const n = nameOf(arg);
    if (!n) return;
    target.push({ name: n.name, nameExpr: n.nameExpr, fn, loc: loc(n.start, n.end), env, lineText: lm.lineText(lm.pos(n.start).line) });
  }

  function addTemplateRef(name: string, start: number, end: number) {
    facts.templateRefs.push({ template: name, loc: loc(start, end), lineText: lm.lineText(lm.pos(start).line) });
  }

  /** `Template.foo` / `Template['foo-bar']` → the template name and the range of `foo`. */
  function templateNameOf(node: Node): NameResult | undefined {
    if (!isMember(node) || !isIdent(node.object, 'Template')) return undefined;
    const p = node.property;
    if (!node.computed && p.type === 'Identifier') {
      if (TEMPLATE_STATICS.has(p.name) || p.name.startsWith('_')) return undefined;
      return { name: p.name, start: p.start, end: p.end };
    }
    if (node.computed && p.type === 'StringLiteral') return { name: p.value, start: p.start + 1, end: p.end - 1 };
    return undefined;
  }

  /** Resolves a name argument: string literal, static template literal, or constant reference. */
  function nameOf(arg: Node): NameResult | undefined {
    if (!arg) return undefined;
    const node = unwrap(arg);
    const s = staticString(node);
    if (s !== undefined) return { name: s, start: node.start + 1, end: node.end - 1 };
    const path = exprPath(node);
    if (path) {
      const c = facts.constants[path];
      return c !== undefined ? { name: c, start: node.start, end: node.end } : { nameExpr: path, start: node.start, end: node.end };
    }
    return undefined;
  }

  function keyName(p: Node): NameResult | undefined {
    const k = p.key;
    if (!k) return undefined;
    if (!p.computed) {
      if (k.type === 'Identifier') return { name: k.name, start: k.start, end: k.end };
      if (k.type === 'StringLiteral') return { name: k.value, start: k.start + 1, end: k.end - 1 };
      if (k.type === 'NumericLiteral') return { name: String(k.value), start: k.start, end: k.end };
      return undefined;
    }
    return nameOf(k);
  }

  function resolveObject(arg: Node): Node | undefined {
    if (!arg) return undefined;
    const n = unwrap(arg);
    if (n.type === 'ObjectExpression') return n;
    if (n.type === 'Identifier') return objects.get(n.name);
    return undefined;
  }

  function paramsOf(fn: Node): string[] {
    if (!fn?.params) return [];
    return fn.params.map((p: Node) => text.slice(p.start, p.end).replace(/\s+/g, ' '));
  }

  function docOf(node: Node): string | undefined {
    const comments: Node[] | undefined = node.leadingComments;
    if (!comments?.length) return undefined;
    const last = comments[comments.length - 1];
    if (last.type === 'CommentBlock') {
      if (!last.value.startsWith('*')) return undefined;
      return last.value
        .split(/\r?\n/)
        .map((l: string) => l.replace(/^\s*\*+ ?/, ''))
        .join('\n')
        .trim() || undefined;
    }
    // consecutive line comments right above the node
    const lines: string[] = [];
    for (let i = comments.length - 1; i >= 0 && comments[i].type === 'CommentLine'; i--) lines.unshift(comments[i].value.trim());
    return lines.join('\n') || undefined;
  }
}

function tryParse(file: string, text: string): Node | undefined {
  const lower = file.toLowerCase();
  const isTs = /\.(ts|tsx|mts|cts)$/.test(lower);
  const plugins: ParserPlugin[] = isTs ? ['typescript', 'decorators-legacy'] : ['jsx', 'decorators-legacy'];
  if (lower.endsWith('.tsx')) plugins.push('jsx');
  const options = {
    sourceType: 'unambiguous' as const,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
    plugins,
  };
  try {
    return parse(text, options);
  } catch {
    // e.g. a `.js` file using TypeScript/Flow syntax: retry with the other dialect
    try {
      return parse(text, { ...options, plugins: isTs ? ['typescript', 'jsx'] : ['flow', 'jsx'] });
    } catch {
      return undefined;
    }
  }
}

function unwrap(node: Node): Node {
  let n = node;
  for (;;) {
    if (!n) return n;
    if (
      n.type === 'TSAsExpression' ||
      n.type === 'TSSatisfiesExpression' ||
      n.type === 'TSNonNullExpression' ||
      n.type === 'TypeCastExpression' ||
      n.type === 'ParenthesizedExpression'
    ) {
      n = n.expression;
    } else if (n.type === 'CallExpression' && isMember(n.callee) && isIdent(n.callee.object, 'Object') && propName(n.callee) === 'freeze') {
      n = n.arguments[0];
    } else return n;
  }
}

function staticString(node: Node): string | undefined {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

function literalKey(k: Node): string | undefined {
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  return undefined;
}

/** `A`, `A.B.C`, `A['B']` → "A.B.C" */
function exprPath(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (isMember(node)) {
    const obj = exprPath(node.object);
    if (!obj) return undefined;
    const p = node.property;
    if (!node.computed && p.type === 'Identifier') return `${obj}.${p.name}`;
    if (node.computed && p.type === 'StringLiteral') return `${obj}.${p.value}`;
  }
  return undefined;
}

function fnOf(node: Node): Node | undefined {
  const n = node && unwrap(node);
  if (!n) return undefined;
  if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return n;
  return undefined;
}

function isMember(n: Node): boolean {
  return n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';
}

function isIdent(n: Node, name: string): boolean {
  return n?.type === 'Identifier' && n.name === name;
}

function propName(member: Node): string | undefined {
  const p = member.property;
  if (!member.computed && p.type === 'Identifier') return p.name;
  if (member.computed && p.type === 'StringLiteral') return p.value;
  return undefined;
}

function envOfTest(test: Node): Env | undefined {
  if (test?.type === 'UnaryExpression' && test.operator === '!') {
    const e = envOfTest(test.argument);
    return e === 'server' ? 'client' : e === 'client' ? 'server' : undefined;
  }
  if (isMember(test) && isIdent(test.object, 'Meteor')) {
    const p = propName(test);
    if (p === 'isServer') return 'server';
    if (p === 'isClient') return 'client';
  }
  return undefined;
}
