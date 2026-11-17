// Methods and publications: their registrations (Meteor.methods, Meteor.publish, ValidatedMethod, the project's
// wrappers), the calls to methods and the subscriptions to publications.
import type * as t from '@babel/types';
import { Env } from '../model';
import {
  Arg,
  CallLike,
  exprPath,
  findProp,
  fnInObject,
  FnNode,
  fnOf,
  forEachNode,
  isIdent,
  isMember,
  literalKey,
  matchesFn,
  MaybeNode,
  propName,
  propValue,
  unwrap,
} from './ast';
import { addCall, docOf, makeDef } from './defs';
import { assignedDefs } from './flow';
import { isDdpServer, isMeteor, isSubscriber } from './framework';
import { keyName, methodObjectRef, nameOf, objectRef, resolveObject } from './names';
import { FileState, lineTextAt, NameResult, nodeLoc } from './state';

const CALL_FNS = new Set(['call', 'callAsync', 'apply', 'applyAsync']);
/** Methods of a ValidatedMethod object that call it: `insertTask.call(...)`, `insertTask.callAsync(...)`. */
const OBJECT_CALL_FNS = new Set(['call', 'callAsync', 'callPromise', '_execute']);

type DefKind = 'method' | 'publication';

/** `const X = new ValidatedMethod({ name })`, also through the project's method definers (`new Method({ name })`). */
export function collectMethodObjects(st: FileState, program: t.Program) {
  forEachNode(program, (n) => {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier' || !n.init) return;
    const init = unwrap(n.init);
    if (init.type !== 'NewExpression' && init.type !== 'CallExpression') return;
    const c = init.callee;
    const isValidated = init.type === 'NewExpression' && (isIdent(c, 'ValidatedMethod') || (isMember(c) && propName(c) === 'ValidatedMethod'));
    const fnPath = exprPath(c);
    if (!isValidated && !(fnPath && matchesFn(st.custom.methodDefiners, fnPath))) return;
    const obj = init.arguments?.[0] && unwrap(init.arguments[0]);
    if (obj?.type !== 'ObjectExpression') return;
    const nameProp = findProp(obj, 'name');
    const name = nameOf(st, propValue(nameProp));
    if (name) st.facts.methodObjects[n.id.name] = { name: name.name, nameExpr: name.nameExpr, nameKind: name.kind };
  });
}

/**
 * `obj.prop(...args)` for methods and publications: registrations on Meteor or the DDP server, method calls,
 * subscriptions. Returns whether the call was one of them (nothing else to look for).
 */
export function visitMeteorCall(st: FileState, node: t.CallExpression | t.OptionalCallExpression, obj: t.Node, prop: string, args: Arg[], env: Env): boolean {
  if (isMeteor(st, obj)) {
    if (prop === 'methods') {
      registerObject(st, args[0], 'method', env, 0, node);
    } else if (CALL_FNS.has(prop)) {
      addCall(st, st.facts.calls, args[0], prop, env);
    } else if (prop === 'publish' && args.length === 1) {
      // Meteor.publish({ 'a.b'() {} }), also through a variable or an import
      registerObject(st, args[0], 'publication', env, 0, node);
    } else if (prop === 'publish' || prop === 'publishComposite') {
      // publishComposite: reywood:publish-composite
      addPublication(st, node, args, env);
    } else if (prop === 'subscribe') {
      addCall(st, st.facts.subscriptions, args[0], prop, env);
    }
    return true;
  }

  // Meteor.server.methods({...}), accounts._server.methods(methods): what Meteor.methods does
  if ((prop === 'methods' || prop === 'publish') && isDdpServer(st, obj)) {
    if (prop === 'methods') registerObject(st, args[0], 'method', env, 0, node);
    else if (args.length === 1) registerObject(st, args[0], 'publication', env, 0, node);
    else addPublication(st, node, args, env);
    return true;
  }

  // percolate:find-from-publication
  if (isIdent(obj, 'FindFromPublication') && prop === 'publish') {
    addPublication(st, node, args, env);
    return true;
  }

  // insertTask.call({...}), Tasks.insertTask.callAsync({...}): calls through a ValidatedMethod object
  if (OBJECT_CALL_FNS.has(prop)) {
    const p = exprPath(obj);
    const ref = p && methodObjectRef(st, p);
    if (ref) {
      st.facts.calls.push({ ...ref, nameKind: 'ref', fn: prop, loc: nodeLoc(st, obj), env, lineText: lineTextAt(st, obj.start!) });
      return true;
    }
  }

  // this.subscribe('x') in onCreated, instance.subscribe('x'), Template.instance().subscribe('x'), subsManager.subscribe('x');
  // other receivers are kept for navigation but never reported: `eventBus.subscribe('x', handler)`
  if (prop === 'subscribe') {
    addCall(st, st.facts.subscriptions, args[0], prop, env, !isSubscriber(st, obj));
    return true;
  }
  return false;
}

/** `new ValidatedMethod({ name, run })` */
export function visitValidatedMethod(st: FileState, node: t.NewExpression, env: Env) {
  const c = node.callee;
  const isValidated = isIdent(c, 'ValidatedMethod') || (isMember(c) && propName(c) === 'ValidatedMethod');
  if (!isValidated) return;
  const o = node.arguments?.[0] && unwrap(node.arguments[0]);
  if (o?.type !== 'ObjectExpression') return;
  let name: NameResult | undefined;
  let run: FnNode | undefined;
  for (const p of o.properties) {
    if (p.type === 'SpreadElement' || p.computed) continue;
    const key = literalKey(p.key);
    if (key === 'name' && p.type === 'ObjectProperty') name = nameOf(st, p.value);
    if (key === 'run') run = p.type === 'ObjectMethod' ? p : fnOf(p.value);
  }
  if (name) st.facts.methods.push(makeDef(st, name, 'validated', run, node, env, docOf(node)));
}

/** Calls to the project's own wrappers configured in the settings. */
export function visitCustom(st: FileState, node: CallLike, env: Env): boolean {
  if (!st.customNames.length) return false;
  const fnPath = exprPath(node.callee);
  if (!fnPath) return false;
  const args = node.arguments ?? [];
  const { custom } = st;
  if (matchesFn(custom.methodDefiners, fnPath)) addCustomDef(st, args, node, 'method', env);
  else if (matchesFn(custom.publicationDefiners, fnPath)) addCustomDef(st, args, node, 'publication', env);
  else if (matchesFn(custom.methodCallers, fnPath)) addCall(st, st.facts.calls, nameArg(args), fnPath, env);
  else if (matchesFn(custom.subscribeCallers, fnPath)) addCall(st, st.facts.subscriptions, nameArg(args), fnPath, env);
  else return false;
  return true;
}

/**
 * Supported shapes: `f('name', fn)`, `f('name', { run })`, `f({ name: 'x', run() {} })`,
 * `f({ 'a.b'() {}, 'a.c'() {} })` (like Meteor.methods), and the same with a const object.
 */
function addCustomDef(st: FileState, args: Arg[], node: CallLike, kind: DefKind, env: Env) {
  const target = kind === 'method' ? st.facts.methods : st.facts.publications;
  const first = args[0] && unwrap(args[0]);
  if (!first) return;
  const obj = resolveObject(st, first);
  if (obj) {
    const nameProp = findProp(obj, 'name');
    if (nameProp) {
      const n = nameOf(st, propValue(nameProp));
      if (n) target.push(makeDef(st, n, kind, fnInObject(obj), node, env, undefined));
    } else {
      registerObject(st, obj, kind, env, 0, node);
    }
    return;
  }
  const n = nameOf(st, first);
  if (!n) return;
  let fn: FnNode | undefined;
  for (const a of args.slice(1)) {
    const u = unwrap(a);
    fn = fnOf(u) ?? (u?.type === 'ObjectExpression' ? fnInObject(u) : undefined);
    if (fn) break;
  }
  target.push(makeDef(st, n, kind, fn, node, env, undefined));
}

/** `call('name', ...)` or `call({ name: 'x', ... })` */
function nameArg(args: Arg[]): MaybeNode {
  const first = args[0] && unwrap(args[0]);
  if (first?.type === 'ObjectExpression') return propValue(findProp(first, 'name'));
  return first;
}

/**
 * `Meteor.methods(x)`, `Meteor.publish(x)`: the definitions of an object literal, following spreads,
 * `Object.assign`, local variables and imports (resolved later against the workspace).
 */
function registerObject(st: FileState, arg: MaybeNode, kind: DefKind, env: Env, depth = 0, at?: t.Node): void {
  const n = arg && unwrap(arg);
  if (!n || depth > 8) return;
  if (n.type === 'ObjectExpression') {
    for (const p of n.properties) {
      if (p.type === 'SpreadElement') registerObject(st, p.argument, kind, env, depth + 1, at);
      else addDefFromProperty(st, p, kind, env);
    }
    return;
  }
  // Object.assign({}, a, b)
  if (n.type === 'CallExpression' && isMember(n.callee) && isIdent(n.callee.object, 'Object') && propName(n.callee) === 'assign') {
    for (const a of n.arguments) if (a.type !== 'SpreadElement') registerObject(st, a, kind, env, depth + 1, at);
    return;
  }
  if (n.type === 'Identifier') {
    const local = st.objects.get(n.name) ?? st.localObjects.get(n.name);
    if (local) {
      registerObject(st, local, kind, env, depth + 1, at);
      // registrations[name] = fn
      for (const def of assignedDefs(st, n.name, local, kind, env, at)) (kind === 'method' ? st.facts.methods : st.facts.publications).push(def);
      // `let registrations = {}; registrations = other;`: the content is not only what is written here
      if (st.reassigned.has(n.name)) st.facts.dynamicRegistrations.push(nodeLoc(st, n));
      return;
    }
  }
  const ref = objectRef(st, n);
  if (ref) st.facts.registrations.push({ kind, ref, env, loc: nodeLoc(st, n) });
  else st.facts.dynamicRegistrations.push(nodeLoc(st, n));
}

function addDefFromProperty(st: FileState, p: t.ObjectExpression['properties'][number], kind: DefKind, env: Env) {
  if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') return;
  const n = keyName(st, p);
  if (!n) return;
  const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
  const def = makeDef(st, n, kind, fn, p, env, docOf(p));
  (kind === 'method' ? st.facts.methods : st.facts.publications).push(def);
}

/** `Meteor.publish('name', fn)` and the libraries with the same shape. */
function addPublication(st: FileState, node: t.Node, args: Arg[], env: Env) {
  const n = nameOf(st, args[0]);
  if (n) st.facts.publications.push(makeDef(st, n, 'publication', fnOf(args[1]), node, env, undefined));
}
