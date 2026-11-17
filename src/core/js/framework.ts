// What identifiers and expressions stand for in Meteor and Blaze: the framework globals, the DDP server,
// template instances, and how compiled Meteor code binds them.
import type * as t from '@babel/types';
import { Env } from '../model';
import { fnOf, isMember, MaybeNode, propName, unwrap } from './ast';
import { FileState, NameResult } from './state';

/**
 * Framework globals: the modules exporting them (`import`, `module.link`) and the packages defining them
 * as package globals in compiled code (`Package.blaze.Blaze`). Anything else with the same name is not the framework.
 */
export const FRAMEWORK: Record<string, { modules: string[]; pkgs: string[] }> = {
  Meteor: { modules: ['meteor/meteor'], pkgs: ['meteor'] },
  Template: { modules: ['meteor/templating', 'meteor/blaze', 'meteor/templating-runtime'], pkgs: ['templating', 'blaze', 'templating-runtime'] },
  Blaze: { modules: ['meteor/blaze'], pkgs: ['blaze'] },
  UI: { modules: ['meteor/blaze', 'meteor/ui'], pkgs: ['blaze', 'ui'] },
};
/** Subscription caches whose `.subscribe(name)` subscribes like Meteor.subscribe (meteorhacks:subs-manager, ccorcos:subs-cache). */
export const SUBSCRIPTION_MANAGERS = new Set(['SubsManager', 'SubsCache']);
/** Packages exporting a subscribe function: `useSubscribe('name')`. */
export const SUBSCRIBE_EXPORTS: Record<string, string> = { 'meteor/react-meteor-data': 'useSubscribe' };
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

export function isMeteor(st: FileState, n: MaybeNode): boolean {
  return n?.type === 'Identifier' && st.meteorNames.has(n.name);
}

export function isBlaze(st: FileState, n: MaybeNode): boolean {
  return n?.type === 'Identifier' && st.blazeIds.has(n.name);
}

export function isTemplateId(st: FileState, n: MaybeNode): boolean {
  return n?.type === 'Identifier' && st.templateIds.has(n.name);
}

/** `new Template(...)` */
export function isNewTemplate(st: FileState, n: MaybeNode): boolean {
  const u = n && unwrap(n);
  return u?.type === 'NewExpression' && (isTemplateId(st, u.callee) || (isMember(u.callee) && isBlaze(st, u.callee.object) && propName(u.callee) === 'Template'));
}

/** `Template.instance()` */
export function isTemplateInstanceCall(st: FileState, n: MaybeNode): boolean {
  return n?.type === 'CallExpression' && isMember(n.callee) && isTemplateId(st, n.callee.object) && propName(n.callee) === 'instance';
}

/** `Template.foo` / `Template['foo-bar']` → the template name and the range of `foo`. */
export function templateNameOf(st: FileState, node: MaybeNode): NameResult | undefined {
  if (!isMember(node) || !isTemplateId(st, node.object)) return undefined;
  const p = node.property;
  if (!node.computed && p.type === 'Identifier') {
    if (TEMPLATE_STATICS.has(p.name) || p.name.startsWith('_')) return undefined;
    return { name: p.name, kind: 'ident', start: p.start!, end: p.end! };
  }
  if (node.computed && p.type === 'StringLiteral') return { name: p.value, kind: 'string', start: p.start! + 1, end: p.end! - 1 };
  return undefined;
}

/** `Meteor.server`, a variable holding it, or an expression that may give it (`server || Meteor.server`). */
export function isServerValue(st: FileState, n: MaybeNode): boolean {
  const u = n && unwrap(n);
  if (!u) return false;
  if (u.type === 'Identifier') return st.serverIds.has(u.name);
  if (u.type === 'LogicalExpression') return isServerValue(st, u.left) || isServerValue(st, u.right);
  if (u.type === 'ConditionalExpression') return isServerValue(st, u.consequent) || isServerValue(st, u.alternate);
  return isMember(u) && isMeteor(st, u.object) && propName(u) === 'server';
}

/** The receiver of `.methods()` / `.publish()` is the DDP server. */
export function isDdpServer(st: FileState, n: t.Node): boolean {
  if (isServerValue(st, n)) return true;
  const p = isMember(n) ? propName(n) : undefined;
  return p !== undefined && st.serverProps.has(p);
}

/**
 * `x.subscribe(...)` is a DDP subscription when `x` is a template instance (`this` in a lifecycle callback,
 * `Template.instance()`, the instance argument of an event handler), a subscription manager or `Meteor.connection`.
 * Anything else (`eventBus.subscribe`, `redis.subscribe`, a DDP connection to another server) may not be.
 */
export function isSubscriber(st: FileState, obj: t.Node): boolean {
  if (obj.type === 'ThisExpression') return st.thisStack[st.thisStack.length - 1] === true;
  if (obj.type === 'Identifier') return st.subscribers.has(obj.name);
  if (isTemplateInstanceCall(st, obj)) return true;
  return isMember(obj) && isMeteor(st, obj.object) && propName(obj) === 'connection';
}

/** The environment where the branch of `if (Meteor.isServer)`, `if (!Meteor.isClient)` runs. */
export function envOfTest(st: FileState, test: MaybeNode): Env | undefined {
  if (test?.type === 'UnaryExpression' && test.operator === '!') {
    const e = envOfTest(st, test.argument);
    return e === 'server' ? 'client' : e === 'client' ? 'server' : undefined;
  }
  if (isMember(test) && isMeteor(st, test.object)) {
    const p = propName(test);
    if (p === 'isServer') return 'server';
    if (p === 'isClient') return 'client';
  }
  return undefined;
}

/**
 * `module.link('meteor/meteor', { Meteor(v) { Meteor = v } }, 0)`, what Meteor compiles an import into:
 * the module and, for every export, the local variable it is assigned to.
 */
export function moduleLink(n: t.Node): { spec: string; bindings: [string, string][] } | undefined {
  if (n.type !== 'CallExpression' || !isMember(n.callee) || propName(n.callee) !== 'link') return undefined;
  if (n.callee.object?.type !== 'Identifier' || n.callee.object.name !== 'module') return undefined;
  const [spec, setters] = n.arguments ?? [];
  if (spec?.type !== 'StringLiteral' || setters?.type !== 'ObjectExpression') return undefined;
  const bindings: [string, string][] = [];
  for (const p of setters.properties) {
    if (p.type === 'SpreadElement') continue;
    const name = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'StringLiteral' ? p.key.value : undefined;
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    const first = fn?.params?.[0];
    const param = first?.type === 'Identifier' ? first.name : undefined;
    // the statements of the setter, or the expression of an arrow `(v) => Meteor = v`
    const body = fn?.body;
    const exprs = body?.type === 'BlockStatement' ? body.body.map((s) => (s.type === 'ExpressionStatement' ? s.expression : undefined)) : body ? [body] : [];
    for (const e of exprs) {
      if (name && param && e?.type === 'AssignmentExpression' && e.left.type === 'Identifier' && e.right?.type === 'Identifier' && e.right.name === param) {
        bindings.push([name, e.left.name]);
      }
    }
  }
  return { spec: spec.value, bindings };
}

/**
 * `Package.meteor.Meteor`, `Package['templating-runtime'].Template`, `Package.blaze.Blaze.Template`:
 * a global of a package in compiled code (`pkg`: the package, `name`: the last property).
 */
export function packageGlobal(n: t.Node): { pkg: string; name: string } | undefined {
  if (!isMember(n) || !isMember(n.object)) return undefined;
  const name = propName(n);
  let pkgNode = n.object;
  while (isMember(pkgNode.object)) pkgNode = pkgNode.object;
  const root = pkgNode.object;
  const pkg = propName(pkgNode);
  return root?.type === 'Identifier' && root.name === 'Package' && pkg && name ? { pkg, name } : undefined;
}
