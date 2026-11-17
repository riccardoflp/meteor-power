// Resolution of names written in the code: literals, constants, aliases, imported objects.
import type * as t from '@babel/types';
import { own } from '../model';
import { exprPath, KeyedProp, MaybeNode, staticString, unwrap } from './ast';
import { FileState, NameResult } from './state';

/** Rewrites the leading alias of a path: `UM.RESET` → `USERS_METHODS.RESET`. */
export function expandAliases(st: FileState, p: string): string | undefined {
  for (let i = 0; i < 5; i++) {
    const dot = p.indexOf('.');
    const head = dot < 0 ? p : p.slice(0, dot);
    const rest = dot < 0 ? '' : p.slice(dot + 1);
    const target = st.aliases.get(head);
    if (target === undefined) break;
    p = target && rest ? `${target}.${rest}` : target || rest;
    if (!p) return undefined;
  }
  return p;
}

/** Resolves a name argument: string literal, static template literal, or constant reference. */
export function nameOf(st: FileState, arg: MaybeNode): NameResult | undefined {
  if (!arg) return undefined;
  const node = unwrap(arg);
  const s = staticString(node);
  if (s !== undefined) return { name: s, kind: 'string', start: node.start! + 1, end: node.end! - 1 };
  const raw = exprPath(node);
  const p = raw && expandAliases(st, raw);
  if (raw && p) {
    const c = own(st.facts.constants, p);
    // `insertTask.name`
    if (c === undefined && raw.endsWith('.name')) {
      const ref = methodObjectRef(st, raw.slice(0, -'.name'.length));
      if (ref) return { ...ref, kind: 'ref', start: node.start!, end: node.end! };
    }
    return { name: c, nameExpr: p, kind: 'expr', start: node.start!, end: node.end! };
  }
  return undefined;
}

/** The key of an object member: `a`, `'a.b'`, `1`, `[NAME]`. */
export function keyName(st: FileState, p: KeyedProp): NameResult | undefined {
  const k = p.key;
  if (!k) return undefined;
  if (!p.computed) {
    if (k.type === 'Identifier') return { name: k.name, kind: 'ident', start: k.start!, end: k.end! };
    if (k.type === 'StringLiteral') return { name: k.value, kind: 'string', start: k.start! + 1, end: k.end! - 1 };
    if (k.type === 'NumericLiteral') return { name: String(k.value), kind: 'ident', start: k.start!, end: k.end! };
    return undefined;
  }
  return nameOf(st, k);
}

/**
 * A method object referenced by `path` (`insertTask`, `Tasks.insertTask`, an imported alias):
 * the name when it is declared in this file, otherwise `@obj:<variable>` resolved against the workspace.
 */
export function methodObjectRef(st: FileState, path: string): { name?: string; nameExpr?: string } | undefined {
  const local = own(st.facts.methodObjects, path);
  if (local) return local.name !== undefined ? { name: local.name } : { nameExpr: local.nameExpr };
  if (!st.imported.has(path.split('.')[0])) return undefined;
  const expanded = expandAliases(st, path);
  if (!expanded || expanded.startsWith('@default(')) return undefined;
  return { nameExpr: `@obj:${expanded}` };
}

/** An imported object: `sampleMethods`, `Api.methods` → `@obj:...`; a default import → `@default(...)`. */
export function objectRef(st: FileState, n: t.Node): string | undefined {
  const p = exprPath(n);
  if (!p || !st.imported.has(p.split('.')[0])) return undefined;
  const expanded = expandAliases(st, p);
  if (!expanded) return undefined;
  return expanded.startsWith('@default(') ? expanded : `@obj:${expanded}`;
}

/** An object literal, written in place or held by a top-level variable. */
export function resolveObject(st: FileState, arg: MaybeNode): t.ObjectExpression | undefined {
  if (!arg) return undefined;
  const n = unwrap(arg);
  if (n.type === 'ObjectExpression') return n;
  if (n.type === 'Identifier') return st.objects.get(n.name);
  return undefined;
}
