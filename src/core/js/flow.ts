// Registrations built step by step: `const methods = {}; methods[NAME] = fn; Meteor.methods(methods)`.
// Which code may not run, which function contains what, and the member assignments of object variables.
import type * as t from '@babel/types';
import { Env, MethodDef, own } from '../model';
import { exprPath, fnOf, isMember, staticString, unwrap } from './ast';
import { makeDef } from './defs';
import { nameOf } from './names';
import { FileState, MemberAssignment, NameResult, nodeLoc } from './state';

/** Assignments, local string constants, functions and conditional code, for registrations built step by step. */
export function collectFlow(st: FileState, n: t.Node) {
  switch (n.type) {
    case 'AssignmentExpression':
      if (n.operator !== '=') break;
      if (isMember(n.left) && n.left.object?.type === 'Identifier') {
        const list = st.memberAssignments.get(n.left.object.name);
        if (list) list.push(n as MemberAssignment);
        else st.memberAssignments.set(n.left.object.name, [n as MemberAssignment]);
      } else if (n.left.type === 'Identifier') st.reassigned.add(n.left.name);
      break;
    case 'VariableDeclaration':
      if (n.kind !== 'const') break;
      for (const d of n.declarations) {
        if (d.id?.type !== 'Identifier' || !d.init) continue;
        const s = staticString(unwrap(d.init));
        if (s !== undefined && !st.localStrings.has(d.id.name)) st.localStrings.set(d.id.name, s);
      }
      break;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
      st.functions.push(n);
      break;
    case 'IfStatement':
      for (const b of [n.consequent, n.alternate]) if (b) st.conditionalRanges.push([b.start!, b.end!]);
      break;
    case 'ConditionalExpression':
      st.conditionalRanges.push([n.consequent.start!, n.consequent.end!], [n.alternate.start!, n.alternate.end!]);
      break;
    case 'LogicalExpression':
      st.conditionalRanges.push([n.right.start!, n.right.end!]);
      break;
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'SwitchCase':
    case 'CatchClause':
      st.conditionalRanges.push([n.start!, n.end!]);
      break;
  }
}

/** The innermost function containing a position (`undefined`: top level). */
function functionAt(st: FileState, pos: number): t.Node | undefined {
  let best: t.Node | undefined;
  for (const f of st.functions) if (f.start! <= pos && pos < f.end! && (!best || f.start! >= best.start!)) best = f;
  return best;
}

/**
 * `obj[key] = fn` / `obj.key = fn` for the object variable `name` declared by `decl`, as definitions.
 * `at`: the registration call; assignments after it in the same function are not registered
 * (`Meteor.methods` copies the object), those in other functions or under a condition are conditional.
 */
export function assignedDefs(
  st: FileState,
  name: string,
  decl: t.Node,
  kind: 'method' | 'publication',
  env: Env,
  at?: t.Node,
  registered = true,
): MethodDef[] {
  const out: MethodDef[] = [];
  const declFn = functionAt(st, decl.start!);
  const atFn = at && functionAt(st, at.start!);
  for (const a of st.memberAssignments.get(name) ?? []) {
    const fn = functionAt(st, a.start!);
    if (at && fn === atFn && a.start! > at.start!) continue;
    const key = memberKey(st, a.left);
    if (!key) {
      // only worth logging when the object is certainly registered
      if (registered) st.facts.dynamicRegistrations.push(nodeLoc(st, a.left));
      continue;
    }
    const def = makeDef(st, key, kind, fnOf(a.right), a, env, undefined);
    const insideCondition = st.conditionalRanges.some(([s, e]) => s <= a.start! && a.end! <= e && !(s <= decl.start! && decl.end! <= e));
    if (fn !== declFn || insideCondition) def.conditional = true;
    out.push(def);
  }
  return out;
}

/** The key of `obj.key` / `obj['a.b']` / `obj[NAME]` when it is known statically. */
function memberKey(st: FileState, m: MemberAssignment['left']): NameResult | undefined {
  const p = m.property;
  if (!m.computed) return p.type === 'Identifier' ? { name: p.name, kind: 'ident', start: p.start!, end: p.end! } : undefined;
  const raw = exprPath(unwrap(p));
  if (raw && !raw.includes('.') && st.localStrings.has(raw) && !st.reassigned.has(raw) && own(st.facts.constants, raw) === undefined) {
    return { name: st.localStrings.get(raw), kind: 'expr', nameExpr: raw, start: p.start!, end: p.end! };
  }
  const n = nameOf(st, p);
  if (!n || n.name !== undefined) return n;
  // a constant: declared at the top of this file or imported, not a local variable such as a loop index
  const head = raw?.split('.')[0];
  const expanded = n.nameExpr ?? '';
  return head && (st.imported.has(head) || own(st.facts.constants, expanded) !== undefined || expanded.startsWith('@')) ? n : undefined;
}
