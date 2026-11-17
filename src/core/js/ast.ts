// Helpers on Babel AST nodes that need nothing from the file being parsed.
import type * as t from '@babel/types';

/** Keys of a node that never lead to code: positions, comments, parser extras. */
export const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'range']);
/** Property names holding the function in `definer({ name, run })` forms. */
const FN_PROPS = ['run', 'handler', 'method', 'fn', 'publish', 'handle'];

/** A child that may be missing (`null` in the AST, `undefined` for an argument not passed). */
export type MaybeNode = t.Node | null | undefined;
/** `a.b`, `a?.b` */
export type MemberLike = t.MemberExpression | t.OptionalMemberExpression;
/** Functions: declarations, expressions, arrows, object and class methods. */
export type FnNode = t.Function;
/** A member of an object literal that has a key (not a spread). */
export type KeyedProp = t.ObjectProperty | t.ObjectMethod;
/** A call: `f()`, `f?.()`, `new F()`. */
export type CallLike = t.CallExpression | t.OptionalCallExpression | t.NewExpression;
/** An argument of a call. */
export type Arg = CallLike['arguments'][number];

/** Calls `cb` on every node under `node` (itself included), parents first. */
export function forEachNode(node: unknown, cb: (n: t.Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) forEachNode(n, cb);
    return;
  }
  if (typeof (node as t.Node).type !== 'string') return;
  cb(node as t.Node);
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (node as Record<string, unknown>)[key];
    if (v && typeof v === 'object') forEachNode(v, cb);
  }
}

/**
 * Strips what does not change a value: `x as T`, `x!`, `(x)`, `Object.freeze(x)`.
 * Never gives `undefined` for a node: `Object.freeze()` without argument is kept as it is.
 */
export function unwrap(node: t.Node): t.Node;
export function unwrap(node: MaybeNode): MaybeNode;
export function unwrap(node: MaybeNode): MaybeNode {
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
    } else if (n.type === 'CallExpression' && n.arguments.length > 0 && isMember(n.callee) && isIdent(n.callee.object, 'Object') && propName(n.callee) === 'freeze') {
      n = n.arguments[0];
    } else return n;
  }
}

/** `'x'` and `` `x` `` (without expressions). */
export function staticString(node: MaybeNode): string | undefined {
  if (!node) return undefined;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value?.cooked ?? undefined;
  return undefined;
}

/** The name of a non-computed key: `a`, `'a'`, `1`. */
export function literalKey(k: t.Node): string | undefined {
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  return undefined;
}

/** `A`, `A.B.C`, `A['B']` → "A.B.C" */
export function exprPath(node: t.Node): string | undefined {
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

/** A function expression or arrow function (after unwrapping). */
export function fnOf(node: MaybeNode): t.FunctionExpression | t.ArrowFunctionExpression | undefined {
  const n = node && unwrap(node);
  if (!n) return undefined;
  if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return n;
  return undefined;
}

export function isMember(n: MaybeNode): n is MemberLike {
  return n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';
}

export function isIdent(n: MaybeNode, name: string): boolean {
  return n?.type === 'Identifier' && n.name === name;
}

/** The property of `a.b` / `a['b']` when it is known statically. */
export function propName(member: MemberLike): string | undefined {
  const p = member.property;
  if (!member.computed && p.type === 'Identifier') return p.name;
  if (member.computed && p.type === 'StringLiteral') return p.value;
  return undefined;
}

/** The member of an object literal with a given (non-computed) key. */
export function findProp(obj: t.ObjectExpression, key: string): KeyedProp | undefined {
  return obj.properties.find((p): p is KeyedProp => (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && !p.computed && literalKey(p.key) === key);
}

/** The value of `key: value` (a method `key() {}` has none). */
export function propValue(p: KeyedProp | undefined): t.Node | undefined {
  return p?.type === 'ObjectProperty' ? p.value : undefined;
}

/** The function of `definer({ name, run() {} })`: under one of the usual property names. */
export function fnInObject(obj: t.ObjectExpression): FnNode | undefined {
  for (const k of FN_PROPS) {
    const p = findProp(obj, k);
    if (!p) continue;
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    if (fn) return fn;
  }
  return undefined;
}

/** Whether a called function (`a.b.c`) is in a list of names: full paths, or bare names matching the last part. */
export function matchesFn(list: string[], fnPath: string): boolean {
  if (!list.length) return false;
  const last = fnPath.slice(fnPath.lastIndexOf('.') + 1);
  return list.some((n) => n === fnPath || (!n.includes('.') && n === last));
}
