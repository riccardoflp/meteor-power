// What identifiers stand for: the Meteor object and the Blaze globals, the DDP server, template instances,
// subscription managers, template lifecycle callbacks, local objects.
import type * as t from '@babel/types';
import { own } from '../model';
import { exprPath, fnOf, forEachNode, isMember, propName, unwrap } from './ast';
import { collectFlow } from './flow';
import { FRAMEWORK, isServerValue, isTemplateInstanceCall, moduleLink, packageGlobal, SUBSCRIBE_EXPORTS, SUBSCRIPTION_MANAGERS, templateNameOf } from './framework';
import { resolveObject } from './names';
import { FileState } from './state';
import { LIFECYCLE_KINDS } from './templates';

type Declaration = t.FunctionDeclaration | t.ClassDeclaration | t.VariableDeclarator;

/** Fills the framework names, the DDP server, the subscribers, the lifecycle callbacks and (see {@link collectFlow}) the flow. */
export function collectBindings(st: FileState, program: t.Program) {
  const { frameworkIds } = st;
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
    const spec = stmt.source.value;
    for (const sp of stmt.specifiers ?? []) {
      const local = sp.local?.name;
      const name = sp.type === 'ImportSpecifier' ? (sp.imported?.type === 'Identifier' ? sp.imported.name : sp.imported?.value) : undefined;
      for (const g of Object.keys(FRAMEWORK)) {
        if (name === g && FRAMEWORK[g].modules.includes(spec)) frameworkIds[g].add(local);
        else if (local === g) frameworkIds[g].delete(g);
      }
      if (SUBSCRIBE_EXPORTS[spec] !== undefined && name === SUBSCRIBE_EXPORTS[spec]) st.subscribeFns.add(local);
    }
  }
  // compiled Meteor code (package sources, build output): imports become `let Meteor; module.link('meteor/meteor',
  // { Meteor(v) { Meteor = v } })`, and package globals `var Meteor = Package.meteor.Meteor`
  const linked = new Set<string>();
  forEachNode(program, (n) => {
    const link = moduleLink(n);
    if (!link) return;
    for (const [name, local] of link.bindings) {
      if (!own(FRAMEWORK, name)?.modules.includes(link.spec)) continue;
      frameworkIds[name].add(local);
      linked.add(local);
    }
  });
  const declares = (n: Declaration, name: string) => {
    const id = n.id;
    if ((id?.type === 'Identifier' ? id.name : undefined) !== name || linked.has(name)) return false;
    if (n.type !== 'VariableDeclarator') return n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration';
    const from = n.init && packageGlobal(unwrap(n.init));
    return !(from && from.name === name && FRAMEWORK[name].pkgs.includes(from.pkg));
  };
  const serverCandidates: [string, t.Node, boolean][] = [];
  const fnDecls = new Map<string, t.FunctionDeclaration | t.FunctionExpression>();
  const lifecycleRefs: string[] = [];
  forEachNode(program, (n) => {
    collectFlow(st, n);
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' || (n.type === 'VariableDeclarator' && n.init)) && declares(n, 'Meteor')) st.meteorNames.delete('Meteor');
    for (const g of ['Template', 'Blaze', 'UI']) {
      if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration' || n.type === 'VariableDeclarator') && declares(n, g)) frameworkIds[g].delete(g);
    }
    // candidates for the DDP server, checked once the Meteor names are known
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) serverCandidates.push([n.id.name, n.init, false]);
    if (n.type === 'AssignmentExpression' && n.operator === '=') {
      if (n.left.type === 'Identifier') serverCandidates.push([n.left.name, n.right, false]);
      else if (isMember(n.left) && propName(n.left)) serverCandidates.push([propName(n.left)!, n.right, true]);
    }
    if (n.type === 'FunctionDeclaration' && n.id) fnDecls.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) {
      const name = n.id.name;
      const init = unwrap(n.init);
      if (init.type === 'FunctionExpression') fnDecls.set(name, init);
      if (init.type === 'ObjectExpression' && !st.localObjects.has(name)) st.localObjects.set(name, init);
      // new SubsManager(), Template.instance()
      const ctor = init.type === 'NewExpression' && exprPath(init.callee);
      if (ctor && SUBSCRIPTION_MANAGERS.has(ctor.slice(ctor.lastIndexOf('.') + 1))) st.subscribers.add(name);
      if (isTemplateInstanceCall(st, init)) st.subscribers.add(name);
    }
    if (n.type !== 'CallExpression' || !isMember(n.callee)) return;
    const tpl = templateNameOf(st, n.callee.object);
    const prop = propName(n.callee);
    if (!tpl || !prop) return;
    const arg = n.arguments?.[0] && unwrap(n.arguments[0]);
    if (LIFECYCLE_KINDS.has(prop)) {
      if (arg?.type === 'FunctionExpression') st.lifecycleFns.add(arg);
      else if (arg?.type === 'Identifier') lifecycleRefs.push(arg.name);
    } else if (prop === 'events') {
      // 'click .x'(event, instance) {}
      for (const p of resolveObject(st, arg)?.properties ?? []) {
        const fn = p.type === 'ObjectMethod' ? p : p.type === 'ObjectProperty' ? fnOf(p.value) : undefined;
        const param = fn?.params?.[1];
        if (param?.type === 'Identifier') st.subscribers.add(param.name);
      }
    }
  });
  for (const name of lifecycleRefs) {
    const fn = fnDecls.get(name);
    if (fn) st.lifecycleFns.add(fn);
  }
  // twice, for `const s = Meteor.server; this._server = s`
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, value, isProp] of serverCandidates) if (isServerValue(st, value)) (isProp ? st.serverProps : st.serverIds).add(name);
  }
}
