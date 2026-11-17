// Blaze templates in JS: helpers, events and callbacks, template links, global helpers, templates created
// in code and references to templates.
import type * as t from '@babel/types';
import { Member, NameKind, TemplateLinkKind, TemplatePartKind } from '../model';
import { makeSnippet } from '../text';
import { Arg, FnNode, fnOf, isIdent, isMember, MaybeNode, MemberLike, propName, SKIP_KEYS, staticString, unwrap } from './ast';
import { docOf, paramsOf } from './defs';
import { isBlaze, isNewTemplate, isTemplateId, templateNameOf } from './framework';
import { keyName, nameOf, resolveObject } from './names';
import { FileState, innerLoc, lineTextAt, loc, NameResult, nodeLoc } from './state';

const TEMPLATE_PART_KINDS = new Set<string>(['helpers', 'events', 'onCreated', 'onRendered', 'onDestroyed']);
/** Template callbacks called with the template instance as `this`. */
export const LIFECYCLE_KINDS = new Set<string>(['onCreated', 'onRendered', 'onDestroyed']);
/** aldeed:template-extension */
const TEMPLATE_LINK_KINDS = new Set<string>(['inheritsHelpersFrom', 'inheritsEventsFrom', 'inheritsHooksFrom', 'replaces', 'copyAs']);

/** `obj.prop(...args)` on a template, `Template`, `Blaze` or `BlazeLayout`. */
export function visitTemplateCall(st: FileState, node: t.CallExpression | t.OptionalCallExpression, obj: t.Node, prop: string, args: Arg[]) {
  const tpl = templateNameOf(st, obj);
  if (tpl && TEMPLATE_PART_KINDS.has(prop)) {
    const members = prop === 'helpers' || prop === 'events' ? membersOf(st, resolveObject(st, args[0])) : [];
    st.facts.templateParts.push({
      template: tpl.name!,
      kind: prop as TemplatePartKind,
      nameLoc: loc(st, tpl.start, tpl.end),
      fullLoc: nodeLoc(st, node),
      members,
    });
    return;
  }

  // Template.foo.inheritsHelpersFrom('bar' | ['bar', 'baz']), replaces('bar'), copyAs('bar')
  if (tpl && TEMPLATE_LINK_KINDS.has(prop)) {
    const arg = args[0] && unwrap(args[0]);
    const list: MaybeNode[] = arg?.type === 'ArrayExpression' ? arg.elements : [arg];
    for (const el of list) {
      if (!el) continue;
      const s = staticString(el);
      if (!s) continue;
      st.facts.templateLinks.push({
        template: tpl.name!,
        kind: prop as TemplateLinkKind,
        other: s,
        nameLoc: loc(st, tpl.start, tpl.end),
        otherLoc: innerLoc(st, el),
        fullLoc: nodeLoc(st, node),
      });
      addTemplateRef(st, s, 'string', el.start! + 1, el.end! - 1);
    }
    return;
  }

  // Template.registerHelper, Blaze.registerHelper, UI.registerHelper
  if ((isTemplateId(st, obj) || isBlaze(st, obj)) && prop === 'registerHelper') {
    const n = nameOf(st, args[0]);
    if (!n?.name) return;
    st.facts.globalHelpers.push(makeMember(st, n, fnOf(args[1]), node, undefined, args[1]));
    // a helper whose value is a Template: `{{> name}}` renders it
    if (isNewTemplate(st, args[1])) st.facts.jsTemplates.push({ name: n.name, via: 'helper', loc: loc(st, n.start, n.end), fullLoc: nodeLoc(st, node) });
    return;
  }

  // BlazeLayout.render('layout', { main: 'page' })
  if (isIdent(obj, 'BlazeLayout') && prop === 'render') {
    const n = nameOf(st, args[0]);
    if (n?.name) addTemplateRef(st, n.name, n.kind, n.start, n.end);
    const o = args[1] && unwrap(args[1]);
    if (o?.type === 'ObjectExpression') {
      for (const p of o.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const s = staticString(p.value);
        if (s) addTemplateRef(st, s, 'string', p.value.start! + 1, p.value.end! - 1);
      }
    }
  }
}

/**
 * Template.samplePanel = new Template('Template.samplePanel', renderFn): the name callers use is the property
 * (whatever it is, `Template.__region__` too: the value is a Template)
 */
export function visitTemplateAssignment(st: FileState, node: t.AssignmentExpression) {
  const left = node.left;
  if (node.operator !== '=' || !isMember(left) || !isTemplateId(st, left.object) || !isNewTemplate(st, node.right)) return;
  const name = propName(left);
  if (!name) return;
  const p = left.property;
  const at = p.type === 'StringLiteral' ? innerLoc(st, p) : nodeLoc(st, p);
  st.facts.jsTemplates.push({ name, via: 'assignment', loc: at, fullLoc: nodeLoc(st, node) });
}

/** `Template.foo` anywhere: a reference to the template. */
export function visitTemplateMember(st: FileState, node: MemberLike) {
  const tpl = templateNameOf(st, node);
  if (tpl) addTemplateRef(st, tpl.name!, tpl.kind, tpl.start, tpl.end);
}

function addTemplateRef(st: FileState, name: string, nameKind: NameKind, start: number, end: number) {
  st.facts.templateRefs.push({ template: name, nameKind, loc: loc(st, start, end), lineText: lineTextAt(st, start) });
}

/** The helpers or event handlers of an object literal. */
function membersOf(st: FileState, obj: t.ObjectExpression | undefined): Member[] {
  if (!obj) return [];
  const out: Member[] = [];
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue;
    const n = keyName(st, p);
    if (!n?.name) continue;
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    out.push(makeMember(st, n, fn, p, docOf(p), p.type === 'ObjectMethod' ? p : p.value));
  }
  return out;
}

/** `value`: the helper's value, to know whether `{{> name}}` can render it. */
function makeMember(st: FileState, n: NameResult, fn: FnNode | undefined, full: t.Node, doc: string | undefined, value?: MaybeNode): Member {
  const m: Member = {
    name: n.name!,
    nameKind: n.kind,
    loc: loc(st, n.start, n.end),
    fullLoc: nodeLoc(st, full),
    params: paramsOf(st, fn),
    isAsync: !!fn?.async,
    snippet: makeSnippet(st.text.slice(full.start!, full.end!)),
    doc,
  };
  const returns = value && helperReturns(st, value);
  if (returns) m.returns = returns;
  return m;
}

/**
 * What a helper gives to `{{> name}}`: `template` for a Template (`new Template(...)`, `Template.x`, a function
 * returning one), `unknown` when it cannot be told statically, `undefined` for plain values (strings, numbers…).
 */
function helperReturns(st: FileState, value: t.Node): Member['returns'] {
  const v = value && unwrap(value);
  if (!v) return undefined;
  const kindOf = (e: MaybeNode): Member['returns'] | 'value' => {
    const x = e && unwrap(e);
    if (!x) return 'value';
    if (isNewTemplate(st, x) || templateNameOf(st, x)) return 'template';
    if (staticString(x) !== undefined || /Literal$/.test(x.type) || x.type === 'ObjectExpression' || x.type === 'ArrayExpression') return 'value';
    if (x.type === 'TemplateLiteral' || x.type === 'BinaryExpression') return 'value';
    return 'unknown';
  };
  const fn = v.type === 'ObjectMethod' || v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression' ? v : undefined;
  if (!fn) {
    const k = kindOf(v);
    return k === 'value' ? undefined : k;
  }
  const results: MaybeNode[] = [];
  if (fn.body.type !== 'BlockStatement') results.push(fn.body);
  else {
    // return statements of this function, not of the functions inside it
    const visit = (x: unknown): void => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(visit);
      const n = x as t.Node;
      if (typeof n.type !== 'string' || (n !== fn.body && /Function|ObjectMethod|ClassMethod/.test(n.type))) return;
      if (n.type === 'ReturnStatement') results.push(n.argument);
      for (const key in n) {
        const c = (n as unknown as Record<string, unknown>)[key];
        if (!SKIP_KEYS.has(key) && c && typeof c === 'object') visit(c);
      }
    };
    visit(fn.body);
  }
  const kinds = results.map(kindOf);
  return kinds.includes('template') ? 'template' : kinds.includes('unknown') ? 'unknown' : undefined;
}
