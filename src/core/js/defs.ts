// Builders of the definitions and call sites added to the facts.
import type * as t from '@babel/types';
import { CallSite, Env, MethodDef } from '../model';
import { makeSnippet } from '../text';
import { FnNode, MaybeNode } from './ast';
import { nameOf } from './names';
import { FileState, lineTextAt, loc, NameResult, nodeLoc } from './state';

/** `full`: the whole definition (for its range and snippet); `fn`: its function, for the parameters. */
export function makeDef(st: FileState, n: NameResult, kind: MethodDef['kind'], fn: FnNode | undefined, full: t.Node, env: Env, doc: string | undefined): MethodDef {
  return {
    name: n.name,
    nameExpr: n.nameExpr,
    nameKind: n.kind,
    kind,
    loc: loc(st, n.start, n.end),
    fullLoc: nodeLoc(st, full),
    params: paramsOf(st, fn),
    isAsync: !!fn?.async,
    env,
    doc,
    snippet: makeSnippet(st.text.slice(full.start!, full.end!)),
  };
}

/** A call whose first argument (`arg`) is the name of a method or publication. */
export function addCall(st: FileState, target: CallSite[], arg: MaybeNode, fn: string, env: Env, uncertain = false) {
  const n = nameOf(st, arg);
  if (!n) return;
  const call: CallSite = { name: n.name, nameExpr: n.nameExpr, nameKind: n.kind, fn, loc: loc(st, n.start, n.end), env, lineText: lineTextAt(st, n.start) };
  if (uncertain) call.uncertain = true;
  target.push(call);
}

/** The parameters of a function, as written. */
export function paramsOf(st: FileState, fn: FnNode | undefined): string[] {
  if (!fn?.params) return [];
  return fn.params.map((p) => st.text.slice(p.start!, p.end!).replace(/\s+/g, ' '));
}

/** The JSDoc comment, or the line comments, right above a node. */
export function docOf(node: t.Node): string | undefined {
  const comments = node.leadingComments;
  if (!comments?.length) return undefined;
  const last = comments[comments.length - 1];
  if (last.type === 'CommentBlock') {
    if (!last.value.startsWith('*')) return undefined;
    return last.value
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*+ ?/, ''))
      .join('\n')
      .trim() || undefined;
  }
  // consecutive line comments right above the node
  const lines: string[] = [];
  for (let i = comments.length - 1; i >= 0 && comments[i].type === 'CommentLine'; i--) lines.unshift(comments[i].value.trim());
  return lines.join('\n') || undefined;
}
