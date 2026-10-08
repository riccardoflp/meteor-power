import { Aggregate, MeteorIndex } from './index';
import { Loc, Member, Pos } from './model';
import { containsPos, wildcardMatch } from './text';

/** What is under the cursor. */
export type Target =
  | { type: 'method'; name: string; loc: Loc; isDef: boolean }
  | { type: 'publication'; name: string; loc: Loc; isDef: boolean }
  | { type: 'template'; name: string; loc: Loc; origin: 'html' | 'js' | 'inclusion' }
  | { type: 'helper'; name: string; template: string | null; loc: Loc; isDef: boolean }
  | { type: 'event'; name: string; template: string; loc: Loc };

/** A definition: `loc` is the name, `full` the whole body (used for peek). */
export interface Def {
  loc: Loc;
  full?: Loc;
}

export function targetAt(index: MeteorIndex, file: string, pos: Pos): Target | undefined {
  const f = index.facts(file);
  if (!f) return undefined;
  const a = index.a;
  const hit = (l: Loc) => containsPos(l.range, pos);

  for (const c of f.calls) {
    if (!hit(c.loc)) continue;
    const name = a.resolve(c);
    return name !== undefined ? { type: 'method', name, loc: c.loc, isDef: false } : undefined;
  }
  for (const c of f.subscriptions) {
    if (!hit(c.loc)) continue;
    const name = a.resolve(c);
    return name !== undefined ? { type: 'publication', name, loc: c.loc, isDef: false } : undefined;
  }
  for (const d of f.methods) {
    if (!hit(d.loc)) continue;
    const name = a.resolve(d);
    return name !== undefined ? { type: 'method', name, loc: d.loc, isDef: true } : undefined;
  }
  for (const d of f.publications) {
    if (!hit(d.loc)) continue;
    const name = a.resolve(d);
    return name !== undefined ? { type: 'publication', name, loc: d.loc, isDef: true } : undefined;
  }
  for (const p of f.templateParts) {
    if (!hit(p.fullLoc)) continue;
    for (const m of p.members) {
      if (!hit(m.loc)) continue;
      if (p.kind === 'helpers') return { type: 'helper', name: m.name, template: p.template, loc: m.loc, isDef: true };
      if (p.kind === 'events') return { type: 'event', name: m.name, template: p.template, loc: m.loc };
    }
  }
  for (const h of f.globalHelpers) {
    if (hit(h.loc)) return { type: 'helper', name: h.name, template: null, loc: h.loc, isDef: true };
  }
  for (const r of f.templateRefs) {
    if (hit(r.loc)) return { type: 'template', name: r.template, loc: r.loc, origin: 'js' };
  }
  for (const t of f.templates) {
    if (hit(t.loc)) return { type: 'template', name: t.name, loc: t.loc, origin: 'html' };
  }
  for (const u of f.htmlUsages) {
    if (!hit(u.loc)) continue;
    if (u.kind === 'inclusion') return { type: 'template', name: u.name, loc: u.loc, origin: 'inclusion' };
    if (u.kind === 'block') {
      // {{#foo}} is a template if one exists with that name, otherwise a block helper
      if (a.templateNames.has(u.name) || !findHelper(a, u.template, u.name).length) {
        return { type: 'template', name: u.name, loc: u.loc, origin: 'inclusion' };
      }
      return { type: 'helper', name: u.name, template: u.template, loc: u.loc, isDef: false };
    }
    if (u.local) return undefined;
    return { type: 'helper', name: u.name, template: u.template, loc: u.loc, isDef: false };
  }
  return undefined;
}

/** Helper definitions visible from a template: its own helpers first, then global ones. */
export function findHelper(a: Aggregate, template: string | null, name: string): Member[] {
  if (template !== null) {
    const own = a.helpers.get(template)?.get(name);
    if (own?.length) return own;
  }
  return a.globalHelpers.get(name) ?? [];
}

export function definitions(index: MeteorIndex, t: Target): Def[] {
  const a = index.a;
  switch (t.type) {
    case 'method':
      return t.isDef ? [{ loc: t.loc }] : (a.methods.get(t.name) ?? []).map((d) => ({ loc: d.loc, full: d.fullLoc }));
    case 'publication':
      return t.isDef ? [{ loc: t.loc }] : (a.publications.get(t.name) ?? []).map((d) => ({ loc: d.loc, full: d.fullLoc }));
    case 'template': {
      const html = templateHtmlDefs(a, t.name);
      const js = templateJsDefs(a, t.name);
      // From the HTML name jump to the JS; from everywhere else jump to the HTML (or JS if there is no HTML).
      if (t.origin === 'html') return js.length ? js : [{ loc: t.loc }];
      return html.length ? html : js;
    }
    case 'helper':
      if (t.isDef) return [{ loc: t.loc }];
      return findHelper(a, t.template, t.name).map((m) => ({ loc: m.loc, full: m.fullLoc }));
    case 'event': {
      const found = eventTargets(a, t.template, t.name);
      return found.length ? found.map((loc) => ({ loc })) : [{ loc: t.loc }];
    }
  }
}

export function references(index: MeteorIndex, t: Target, includeDeclaration: boolean): Loc[] {
  const a = index.a;
  const out: Loc[] = [];
  switch (t.type) {
    case 'method':
      if (includeDeclaration) out.push(...(a.methods.get(t.name) ?? []).map((d) => d.loc));
      out.push(...(a.calls.get(t.name) ?? []).map((c) => c.loc));
      break;
    case 'publication':
      if (includeDeclaration) out.push(...(a.publications.get(t.name) ?? []).map((d) => d.loc));
      out.push(...(a.subscriptions.get(t.name) ?? []).map((c) => c.loc));
      break;
    case 'template':
      out.push(...templateUsages(a, t.name));
      if (includeDeclaration) out.push(...(a.templates.get(t.name) ?? []).map((d) => d.loc));
      break;
    case 'helper': {
      const defs = findHelper(a, t.template, t.name);
      const isGlobal = t.template === null || !a.helpers.get(t.template!)?.get(t.name)?.length;
      if (includeDeclaration) out.push(...defs.map((d) => d.loc));
      out.push(...helperUsages(a, isGlobal ? null : t.template, t.name));
      break;
    }
    case 'event':
      out.push(...eventTargets(a, t.template, t.name));
      break;
  }
  return dedupe(out);
}

export function templateHtmlDefs(a: Aggregate, name: string): Def[] {
  return (a.templates.get(name) ?? []).map((d) => ({ loc: d.loc, full: d.fullLoc }));
}

export function templateJsDefs(a: Aggregate, name: string): Def[] {
  return (a.parts.get(name) ?? []).map((p) => ({ loc: p.nameLoc, full: p.fullLoc }));
}

/** `{{> name}}`, `{{#name}}`, `Template.name`, `BlazeLayout.render('name')`. */
export function templateUsages(a: Aggregate, name: string): Loc[] {
  const inclusions = (a.inclusions.get(name) ?? []).map((u) => u.loc);
  // `Template.foo.helpers(...)` also produces a ref; those are definitions, not usages
  const partLocs = new Set((a.parts.get(name) ?? []).map((p) => key(p.nameLoc)));
  const refs = (a.templateRefs.get(name) ?? []).filter((r) => !partLocs.has(key(r.loc))).map((r) => r.loc);
  return [...inclusions, ...refs];
}

/**
 * Usages of a helper in the HTML. For a template helper, only inside that template;
 * for a global helper, in every template that does not define its own helper with the same name.
 */
export function helperUsages(a: Aggregate, template: string | null, name: string): Loc[] {
  const out: Loc[] = [];
  const scan = (tpl: string) => {
    for (const u of a.usagesByTemplate.get(tpl) ?? []) {
      if (u.name === name && !u.local && (u.kind === 'helper' || (u.kind === 'block' && !a.templateNames.has(name)))) out.push(u.loc);
    }
  };
  if (template !== null) scan(template);
  else for (const tpl of a.usagesByTemplate.keys()) if (!a.helpers.get(tpl)?.get(name)?.length) scan(tpl);
  return out;
}

/** Elements in the template HTML matching the `.class` / `#id` selectors of an event map key. */
export function eventTargets(a: Aggregate, template: string, eventKey: string): Loc[] {
  const marks = a.marks.get(template) ?? [];
  const out: Loc[] = [];
  const re = /([.#])([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(eventKey))) {
    const kind = m[1] === '.' ? 'class' : 'id';
    for (const mark of marks) if (mark.kind === kind && mark.name === m[2]) out.push(mark.loc);
  }
  return dedupe(out);
}

/** The template enclosing a position: the `<template>` block in HTML or the `Template.x.*(...)` call in JS. */
export function enclosingTemplate(index: MeteorIndex, file: string, pos: Pos): string | undefined {
  const f = index.facts(file);
  if (!f) return undefined;
  for (const t of f.templates) if (containsPos(t.fullLoc.range, pos)) return t.name;
  for (const p of f.templateParts) if (containsPos(p.fullLoc.range, pos)) return p.template;
  return undefined;
}

/** Templates defined or referenced in a file (for the HTML⇄JS switch when the cursor is outside any template). */
export function templatesInFile(index: MeteorIndex, file: string): string[] {
  const f = index.facts(file);
  if (!f) return [];
  return [...new Set([...f.templates.map((t) => t.name), ...f.templateParts.map((p) => p.template)])];
}

export interface Problem {
  loc: Loc;
  message: string;
  code: 'unknown-method' | 'unknown-publication' | 'unknown-template';
}

export interface DiagnosticOptions {
  ignoreMethods: string[];
  ignorePublications: string[];
  ignoreTemplates: string[];
}

export function problems(index: MeteorIndex, file: string, opts: DiagnosticOptions): Problem[] {
  const f = index.facts(file);
  if (!f) return [];
  const a = index.a;
  const ignored = (list: string[], name: string) => list.some((p) => wildcardMatch(p, name));
  const out: Problem[] = [];
  for (const c of f.calls) {
    const name = a.resolve(c);
    if (name === undefined || a.methods.has(name) || ignored(opts.ignoreMethods, name)) continue;
    out.push({ loc: c.loc, message: `Meteor method '${name}' is not defined in the workspace.`, code: 'unknown-method' });
  }
  for (const c of f.subscriptions) {
    const name = a.resolve(c);
    if (name === undefined || a.publications.has(name) || ignored(opts.ignorePublications, name)) continue;
    out.push({ loc: c.loc, message: `Publication '${name}' is not defined in the workspace.`, code: 'unknown-publication' });
  }
  for (const u of f.htmlUsages) {
    if (u.kind !== 'inclusion' || a.templateNames.has(u.name) || ignored(opts.ignoreTemplates, u.name)) continue;
    out.push({ loc: u.loc, message: `Template '${u.name}' is not defined in the workspace.`, code: 'unknown-template' });
  }
  return out;
}

function key(l: Loc) {
  return `${l.file}:${l.range.start.line}:${l.range.start.character}`;
}

function dedupe(locs: Loc[]): Loc[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = key(l);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
