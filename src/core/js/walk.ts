// The last pass: every node of the file, in order, with the environment of the code (`if (Meteor.isServer)`)
// and the meaning of `this`.
import type * as t from '@babel/types';
import { Env } from '../model';
import { isMember, propName, SKIP_KEYS } from './ast';
import { addCall } from './defs';
import { envOfTest } from './framework';
import { visitCustom, visitMeteorCall, visitValidatedMethod } from './methods';
import { FileState } from './state';
import { visitTemplateAssignment, visitTemplateCall, visitTemplateMember } from './templates';

export function walk(st: FileState, node: unknown, env: Env | undefined): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(st, n, env);
    return;
  }
  const n = node as t.Node;
  if (typeof n.type !== 'string') return;

  switch (n.type) {
    case 'IfStatement': {
      const e = envOfTest(st, n.test);
      if (e) {
        walk(st, n.test, env);
        walk(st, n.consequent, e);
        walk(st, n.alternate, e === 'server' ? 'client' : 'server');
        return;
      }
      break;
    }
    case 'CallExpression':
    case 'OptionalCallExpression':
      visitCall(st, n, env ?? st.fileEnv ?? 'both');
      break;
    case 'NewExpression':
      visitNew(st, n, env ?? st.fileEnv ?? 'both');
      break;
    case 'AssignmentExpression':
      visitTemplateAssignment(st, n);
      break;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      visitTemplateMember(st, n);
      break;
  }

  // `this` changes in every non-arrow function: a template instance in lifecycle callbacks only
  const ownThis = n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod';
  if (ownThis) st.thisStack.push(st.lifecycleFns.has(n));
  // const instance = this;
  if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init?.type === 'ThisExpression' && st.thisStack[st.thisStack.length - 1]) {
    st.subscribers.add(n.id.name);
  }
  for (const key in n) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (v && typeof v === 'object') walk(st, v, env);
  }
  if (ownThis) st.thisStack.pop();
}

function visitCall(st: FileState, node: t.CallExpression | t.OptionalCallExpression, env: Env) {
  if (visitCustom(st, node, env)) return;
  const callee = node.callee;
  const args = node.arguments ?? [];
  // useSubscribe('name') from meteor/react-meteor-data
  if (callee?.type === 'Identifier' && st.subscribeFns.has(callee.name)) {
    addCall(st, st.facts.subscriptions, args[0], callee.name, env);
    return;
  }
  if (!isMember(callee)) return;
  const prop = propName(callee);
  if (!prop) return;
  if (visitMeteorCall(st, node, callee.object, prop, args, env)) return;
  visitTemplateCall(st, node, callee.object, prop, args);
}

function visitNew(st: FileState, node: t.NewExpression, env: Env) {
  if (visitCustom(st, node, env)) return;
  visitValidatedMethod(st, node, env);
}
