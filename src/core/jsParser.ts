import * as path from 'path';
import { parse, ParserPlugin } from '@babel/parser';
import { CallSite, emptyFacts, Env, FileFacts, Loc, Member, MethodDef, NameKind, TemplateLinkKind, TemplatePartKind } from './model';
import { envFromPath, LineMap, makeSnippet, stripBom } from './text';

// Babel AST nodes; typed loosely on purpose, we only read a handful of fields.
type Node = any;

const QUICK_CHECK = /Meteor|Template|subscribe|ValidatedMethod|BlazeLayout/;
/** `x.call(`, `Tasks.x.callAsync(`: the root (`x`, `Tasks`) is in group 1. */
const OBJECT_CALL_CHECK = /([\w$]+)[\w$.]*\.(?:call(?:Async|Promise)?|_execute)\s*\(/g;
const IMPORT_CLAUSE = /\bimport\s+([\w$\s{},*]+?)\s+from\s*['"]/g;
/** Files that may only export name constants (e.g. `export const METHODS = { UPDATE: 'users.update' }`). */
const CONSTANTS_CHECK = /\bexport\s+(?:const|let|var|enum|default)\b/;
const CALL_FNS = new Set(['call', 'callAsync', 'apply', 'applyAsync']);
/** Methods of a ValidatedMethod object that call it: `insertTask.call(...)`, `insertTask.callAsync(...)`. */
const OBJECT_CALL_FNS = new Set(['call', 'callAsync', 'callPromise', '_execute']);
const TEMPLATE_PART_KINDS = new Set<string>(['helpers', 'events', 'onCreated', 'onRendered', 'onDestroyed']);
/** aldeed:template-extension */
const TEMPLATE_LINK_KINDS = new Set<string>(['inheritsHelpersFrom', 'inheritsEventsFrom', 'inheritsHooksFrom', 'replaces', 'copyAs']);
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

/** Project-specific helper functions (configured in the settings) that wrap the Meteor APIs. */
export interface JsParseOptions {
  /** e.g. `createMethod('name', fn)`, `createMethod({ name, run })`, `defineMethods({ 'a.b'() {} })` */
  methodDefiners?: string[];
  /** e.g. `callMethod('name', ...args)` */
  methodCallers?: string[];
  publicationDefiners?: string[];
  subscribeCallers?: string[];
}

/** Property names holding the function in `definer({ name, run })` forms. */
const FN_PROPS = ['run', 'handler', 'method', 'fn', 'publish', 'handle'];
const JS_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;

interface NameResult {
  name?: string;
  nameExpr?: string;
  kind: NameKind;
  start: number;
  end: number;
}

/**
 * Extracts Meteor/Blaze facts from a JS/TS file.
 * Returns `null` when the file cannot be parsed at all (so callers can keep the previous facts while typing).
 */
export function parseJs(file: string, source: string, options: JsParseOptions = {}): FileFacts | null {
  const facts = emptyFacts(file);
  const text = stripBom(source);
  const custom = {
    methodDefiners: options.methodDefiners ?? [],
    methodCallers: options.methodCallers ?? [],
    publicationDefiners: options.publicationDefiners ?? [],
    subscribeCallers: options.subscribeCallers ?? [],
  };
  const customNames = [...custom.methodDefiners, ...custom.methodCallers, ...custom.publicationDefiners, ...custom.subscribeCallers];
  const mentionsCustom = customNames.some((n) => text.includes(n.split('.').pop()!));
  if (!QUICK_CHECK.test(text) && !CONSTANTS_CHECK.test(text) && !mentionsCustom && !callsImportedObject(text)) return facts;

  const ast = tryParse(file, text);
  if (!ast) return null;

  const lm = new LineMap(text);
  const loc = (start: number, end: number): Loc => ({ file, range: lm.range(start, end) });
  const fileEnv = envFromPath(file);
  const objects = new Map<string, Node>();
  /**
   * Local name → what it stands for, used to rewrite constant references before resolving them:
   * `import { A as B }` (B → A), `import * as C` (C → ''), `import D from './x'` (D → @default(path)),
   * `const { X, Y: Z } = A` (X → A.X, Z → A.Y), `const M = A.B` (M → A.B).
   */
  const aliases = new Map<string, string>();
  /** Every local name bound by an import. */
  const imported = new Set<string>();

  collectTopLevel(ast.program);
  collectAliases(ast.program);
  collectMethodObjects(ast.program);
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
          if (s !== undefined) {
            facts.constants[d.id.name] = s;
            facts.constantLocs[d.id.name] = loc(init.start + 1, init.end - 1);
          }
          else if (init.type === 'ObjectExpression') {
            objects.set(d.id.name, init);
            flattenObject(d.id.name, init, 0);
          }
        }
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        collectDefaultExport(unwrap(stmt.declaration));
      } else if (decl.type === 'TSEnumDeclaration') {
        for (const m of decl.members ?? decl.body?.members ?? []) {
          const key = m.id?.type === 'Identifier' ? m.id.name : m.id?.value;
          const s = m.initializer && staticString(m.initializer);
          if (key && s !== undefined) {
            facts.constants[`${decl.id.name}.${key}`] = s;
            facts.constantLocs[`${decl.id.name}.${key}`] = loc(m.initializer.start + 1, m.initializer.end - 1);
          }
        }
      }
    }
  }

  function collectDefaultExport(node: Node) {
    if (!node) return;
    const s = staticString(node);
    if (s !== undefined) {
      facts.defaultExport[''] = s;
      facts.defaultExportLocs[''] = loc(node.start + 1, node.end - 1);
      return;
    }
    if (node.type === 'ObjectExpression') {
      const tmp: Record<string, string> = {};
      const tmpLocs: Record<string, Loc> = {};
      flattenObject('', node, 0, tmp, tmpLocs);
      for (const [k, v] of Object.entries(tmp)) {
        facts.defaultExport[k.slice(1)] = v;
        facts.defaultExportLocs[k.slice(1)] = tmpLocs[k];
      }
      return;
    }
    // `const X = {...}; export default X;`
    if (node.type === 'Identifier') {
      const prefix = node.name;
      if (facts.constants[prefix] !== undefined) {
        facts.defaultExport[''] = facts.constants[prefix];
        facts.defaultExportLocs[''] = facts.constantLocs[prefix];
      }
      for (const [k, v] of Object.entries(facts.constants)) {
        if (!k.startsWith(prefix + '.')) continue;
        facts.defaultExport[k.slice(prefix.length + 1)] = v;
        facts.defaultExportLocs[k.slice(prefix.length + 1)] = facts.constantLocs[k];
      }
    }
  }

  function collectAliases(program: Node) {
    for (const stmt of program.body) {
      if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
      const spec: string = stmt.source.value;
      for (const sp of stmt.specifiers ?? []) {
        const local = sp.local?.name;
        if (!local) continue;
        imported.add(local);
        if (sp.type === 'ImportNamespaceSpecifier') aliases.set(local, '');
        else if (sp.type === 'ImportDefaultSpecifier') {
          const hint = moduleHint(file, spec);
          if (hint) aliases.set(local, `@default(${hint})`);
        } else if (sp.type === 'ImportSpecifier') {
          const imported = sp.imported?.type === 'Identifier' ? sp.imported.name : sp.imported?.value;
          if (imported === 'default') {
            const hint = moduleHint(file, spec);
            if (hint) aliases.set(local, `@default(${hint})`);
          } else if (imported && imported !== local) aliases.set(local, imported);
        }
      }
    }
    // destructuring and plain re-assignments, anywhere in the file
    forEachNode(program, (n) => {
      if (n.type !== 'VariableDeclarator' || !n.init) return;
      const from = exprPath(unwrap(n.init));
      if (!from) return;
      if (n.id.type === 'Identifier') {
        if (n.id.name !== from) aliases.set(n.id.name, from);
      } else if (n.id.type === 'ObjectPattern') {
        for (const p of n.id.properties) {
          if (p.type !== 'ObjectProperty' || p.computed) continue;
          const key = literalKey(p.key);
          const value = p.value?.type === 'AssignmentPattern' ? p.value.left : p.value;
          if (key !== undefined && value?.type === 'Identifier') aliases.set(value.name, `${from}.${key}`);
        }
      }
    });
  }

  /** `const X = new ValidatedMethod({ name })`, also through the project's method definers (`new Method({ name })`). */
  function collectMethodObjects(program: Node) {
    forEachNode(program, (n) => {
      if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier' || !n.init) return;
      const init = unwrap(n.init);
      if (init.type !== 'NewExpression' && init.type !== 'CallExpression') return;
      const c = init.callee;
      const isValidated = init.type === 'NewExpression' && (isIdent(c, 'ValidatedMethod') || (isMember(c) && propName(c) === 'ValidatedMethod'));
      const fnPath = exprPath(c);
      if (!isValidated && !(fnPath && matchesFn(custom.methodDefiners, fnPath))) return;
      const obj = init.arguments?.[0] && unwrap(init.arguments[0]);
      if (obj?.type !== 'ObjectExpression') return;
      const nameProp = findProp(obj, 'name');
      const name = nameProp && nameOf(nameProp.value);
      if (name) facts.methodObjects[n.id.name] = { name: name.name, nameExpr: name.nameExpr, nameKind: name.kind };
    });
  }

  /**
   * A method object referenced by `path` (`insertTask`, `Tasks.insertTask`, an imported alias):
   * the name when it is declared in this file, otherwise `@obj:<variable>` resolved against the workspace.
   */
  function methodObjectRef(path: string): { name?: string; nameExpr?: string } | undefined {
    const local = facts.methodObjects[path];
    if (local) return local.name !== undefined ? { name: local.name } : { nameExpr: local.nameExpr };
    if (!imported.has(path.split('.')[0])) return undefined;
    const expanded = expandAliases(path);
    if (!expanded || expanded.startsWith('@default(')) return undefined;
    return { nameExpr: `@obj:${expanded}` };
  }

  /** Rewrites the leading alias of a path: `UM.RESET` → `USERS_METHODS.RESET`. */
  function expandAliases(p: string): string | undefined {
    for (let i = 0; i < 5; i++) {
      const dot = p.indexOf('.');
      const head = dot < 0 ? p : p.slice(0, dot);
      const rest = dot < 0 ? '' : p.slice(dot + 1);
      const target = aliases.get(head);
      if (target === undefined) break;
      p = target && rest ? `${target}.${rest}` : target || rest;
      if (!p) return undefined;
    }
    return p;
  }

  function flattenObject(
    prefix: string,
    obj: Node,
    depth: number,
    out: Record<string, string> = facts.constants,
    outLocs: Record<string, Loc> = facts.constantLocs,
  ) {
    if (depth > 4) return;
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' || p.computed) continue;
      const key = literalKey(p.key);
      if (key === undefined) continue;
      const v = unwrap(p.value);
      const s = staticString(v);
      if (s !== undefined) {
        out[`${prefix}.${key}`] = s;
        outLocs[`${prefix}.${key}`] = loc(v.start + 1, v.end - 1);
      } else if (v.type === 'ObjectExpression') flattenObject(`${prefix}.${key}`, v, depth + 1, out, outLocs);
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
        if (t) facts.templateRefs.push({ template: t.name!, nameKind: t.kind, loc: loc(t.start, t.end), lineText: lm.lineText(lm.pos(t.start).line) });
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
    if (visitCustom(node, env)) return;
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

    // insertTask.call({...}), Tasks.insertTask.callAsync({...}): calls through a ValidatedMethod object
    if (OBJECT_CALL_FNS.has(prop)) {
      const p = exprPath(obj);
      const ref = p && methodObjectRef(p);
      if (ref) {
        facts.calls.push({ ...ref, nameKind: 'ref', fn: prop, loc: loc(obj.start, obj.end), env, lineText: lm.lineText(lm.pos(obj.start).line) });
        return;
      }
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

    // Template.foo.inheritsHelpersFrom('bar' | ['bar', 'baz']), replaces('bar'), copyAs('bar')
    if (tpl && TEMPLATE_LINK_KINDS.has(prop)) {
      const arg = args[0] && unwrap(args[0]);
      const list: Node[] = arg?.type === 'ArrayExpression' ? arg.elements : [arg];
      for (const el of list) {
        const s = el && staticString(el);
        if (!s) continue;
        facts.templateLinks.push({
          template: tpl.name!,
          kind: prop as TemplateLinkKind,
          other: s,
          nameLoc: loc(tpl.start, tpl.end),
          otherLoc: loc(el.start + 1, el.end - 1),
          fullLoc: loc(node.start, node.end),
        });
        addTemplateRef(s, 'string', el.start + 1, el.end - 1);
      }
      return;
    }

    if (isIdent(obj, 'Template') && prop === 'registerHelper') {
      const n = nameOf(args[0]);
      if (n?.name) facts.globalHelpers.push(makeMember(n, fnOf(args[1]), node, undefined));
      return;
    }

    // BlazeLayout.render('layout', { main: 'page' })
    if (isIdent(obj, 'BlazeLayout') && prop === 'render') {
      const n = nameOf(args[0]);
      if (n?.name) addTemplateRef(n.name, n.kind, n.start, n.end);
      const o = args[1] && unwrap(args[1]);
      if (o?.type === 'ObjectExpression') {
        for (const p of o.properties) {
          if (p.type !== 'ObjectProperty') continue;
          const s = staticString(p.value);
          if (s) addTemplateRef(s, 'string', p.value.start + 1, p.value.end - 1);
        }
      }
    }
  }

  /** Calls to the project's own wrappers configured in the settings. */
  function visitCustom(node: Node, env: Env): boolean {
    if (!customNames.length) return false;
    const fnPath = exprPath(node.callee);
    if (!fnPath) return false;
    const args = node.arguments ?? [];
    if (matchesFn(custom.methodDefiners, fnPath)) addCustomDef(args, node, 'method', env);
    else if (matchesFn(custom.publicationDefiners, fnPath)) addCustomDef(args, node, 'publication', env);
    else if (matchesFn(custom.methodCallers, fnPath)) addCall(facts.calls, nameArg(args), fnPath, env);
    else if (matchesFn(custom.subscribeCallers, fnPath)) addCall(facts.subscriptions, nameArg(args), fnPath, env);
    else return false;
    return true;
  }

  /**
   * Supported shapes: `f('name', fn)`, `f('name', { run })`, `f({ name: 'x', run() {} })`,
   * `f({ 'a.b'() {}, 'a.c'() {} })` (like Meteor.methods), and the same with a const object.
   */
  function addCustomDef(args: Node[], node: Node, kind: 'method' | 'publication', env: Env) {
    const target = kind === 'method' ? facts.methods : facts.publications;
    const first = args[0] && unwrap(args[0]);
    if (!first) return;
    const obj = resolveObject(first);
    if (obj) {
      const nameProp = findProp(obj, 'name');
      if (nameProp) {
        const n = nameOf(nameProp.value);
        if (n) target.push(makeDef(n, kind, fnInObject(obj), node, env, undefined));
      } else {
        for (const p of obj.properties) addDefFromProperty(p, kind, env);
      }
      return;
    }
    const n = nameOf(first);
    if (!n) return;
    let fn: Node;
    for (const a of args.slice(1)) {
      const u = unwrap(a);
      fn = fnOf(u) ?? (u?.type === 'ObjectExpression' ? fnInObject(u) : undefined);
      if (fn) break;
    }
    target.push(makeDef(n, kind, fn, node, env, undefined));
  }

  /** `call('name', ...)` or `call({ name: 'x', ... })` */
  function nameArg(args: Node[]): Node {
    const first = args[0] && unwrap(args[0]);
    if (first?.type === 'ObjectExpression') return findProp(first, 'name')?.value;
    return first;
  }

  function visitNew(node: Node, env: Env) {
    if (visitCustom(node, env)) return;
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
      nameKind: n.kind,
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
      out.push(makeMember(n, fn, p, docOf(p)));
    }
    return out;
  }

  function makeMember(n: NameResult, fn: Node, full: Node, doc: string | undefined): Member {
    return {
      name: n.name!,
      nameKind: n.kind,
      loc: loc(n.start, n.end),
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
    target.push({ name: n.name, nameExpr: n.nameExpr, nameKind: n.kind, fn, loc: loc(n.start, n.end), env, lineText: lm.lineText(lm.pos(n.start).line) });
  }

  function addTemplateRef(name: string, nameKind: NameKind, start: number, end: number) {
    facts.templateRefs.push({ template: name, nameKind, loc: loc(start, end), lineText: lm.lineText(lm.pos(start).line) });
  }

  /** `Template.foo` / `Template['foo-bar']` → the template name and the range of `foo`. */
  function templateNameOf(node: Node): NameResult | undefined {
    if (!isMember(node) || !isIdent(node.object, 'Template')) return undefined;
    const p = node.property;
    if (!node.computed && p.type === 'Identifier') {
      if (TEMPLATE_STATICS.has(p.name) || p.name.startsWith('_')) return undefined;
      return { name: p.name, kind: 'ident', start: p.start, end: p.end };
    }
    if (node.computed && p.type === 'StringLiteral') return { name: p.value, kind: 'string', start: p.start + 1, end: p.end - 1 };
    return undefined;
  }

  /** Resolves a name argument: string literal, static template literal, or constant reference. */
  function nameOf(arg: Node): NameResult | undefined {
    if (!arg) return undefined;
    const node = unwrap(arg);
    const s = staticString(node);
    if (s !== undefined) return { name: s, kind: 'string', start: node.start + 1, end: node.end - 1 };
    const raw = exprPath(node);
    const p = raw && expandAliases(raw);
    if (p) {
      const c = facts.constants[p];
      // `insertTask.name`
      if (c === undefined && raw.endsWith('.name')) {
        const ref = methodObjectRef(raw.slice(0, -'.name'.length));
        if (ref) return { ...ref, kind: 'ref', start: node.start, end: node.end };
      }
      return { name: c, nameExpr: p, kind: 'expr', start: node.start, end: node.end };
    }
    return undefined;
  }

  function keyName(p: Node): NameResult | undefined {
    const k = p.key;
    if (!k) return undefined;
    if (!p.computed) {
      if (k.type === 'Identifier') return { name: k.name, kind: 'ident', start: k.start, end: k.end };
      if (k.type === 'StringLiteral') return { name: k.value, kind: 'string', start: k.start + 1, end: k.end - 1 };
      if (k.type === 'NumericLiteral') return { name: String(k.value), kind: 'ident', start: k.start, end: k.end };
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

function matchesFn(list: string[], fnPath: string): boolean {
  if (!list.length) return false;
  const last = fnPath.slice(fnPath.lastIndexOf('.') + 1);
  return list.some((n) => n === fnPath || (!n.includes('.') && n === last));
}

function findProp(obj: Node, key: string): Node | undefined {
  return obj.properties.find((p: Node) => (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && !p.computed && literalKey(p.key) === key);
}

function fnInObject(obj: Node): Node | undefined {
  for (const k of FN_PROPS) {
    const p = findProp(obj, k);
    if (!p) continue;
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    if (fn) return fn;
  }
  return undefined;
}

function forEachNode(node: Node, cb: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) forEachNode(n, cb);
    return;
  }
  if (typeof node.type !== 'string') return;
  cb(node);
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (v && typeof v === 'object') forEachNode(v, cb);
  }
}

/**
 * Normalized identity of an imported module, used to find its `export default`:
 * relative imports become absolute paths, Meteor absolute imports (`/imports/x`) are kept as a path suffix.
 * Packages (`meteor/...`, npm) are ignored.
 */
function moduleHint(file: string, spec: string): string | undefined {
  let hint: string;
  if (spec.startsWith('.')) hint = path.posix.join(path.posix.dirname(file.replace(/\\/g, '/')), spec);
  else if (spec.startsWith('/')) hint = spec;
  else return undefined;
  return hint.replace(JS_EXT, '').replace(/\/$/, '').toLowerCase();
}

/** Same normalization for the exporting file. */
export function moduleId(file: string): string {
  return file.replace(/\\/g, '/').replace(JS_EXT, '').toLowerCase();
}

/**
 * Whether a file may call a ValidatedMethod object imported from elsewhere (`insertTask.call(...)`):
 * a `.call(` on an imported name. Plain `fn.call(this)` is everywhere in libraries, those files are skipped.
 */
function callsImportedObject(text: string): boolean {
  if (!text.includes('import')) return false;
  const imported = new Set<string>();
  for (const m of text.matchAll(IMPORT_CLAUSE)) for (const n of m[1].match(/[\w$]+/g) ?? []) imported.add(n);
  if (!imported.size) return false;
  for (const m of text.matchAll(OBJECT_CALL_CHECK)) if (imported.has(m[1])) return true;
  return false;
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
