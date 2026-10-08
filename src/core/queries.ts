import { MeteorIndex, Scope } from './index';
import { Loc, Member, Pos, TemplateLink } from './model';
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

/** A helper definition; `template` is the template defining it, absent for global helpers. */
export type HelperDef = Member & { template?: string };

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
      if (a.templateNames.has(u.name) || !findHelper(index, u.template, u.name, index.scopeOf(file)).length) {
        return { type: 'template', name: u.name, loc: u.loc, origin: 'inclusion' };
      }
      return { type: 'helper', name: u.name, template: u.template, loc: u.loc, isDef: false };
    }
    if (u.local) return undefined;
    return { type: 'helper', name: u.name, template: u.template, loc: u.loc, isDef: false };
  }
  return undefined;
}

/** Keeps the items written in a file of the scope. */
export function visible<T extends { loc: Loc }>(index: MeteorIndex, scope: Scope, list: readonly T[] | undefined): T[] {
  if (!list) return [];
  return scope ? list.filter((x) => index.inScope(scope, x.loc.file)) : [...list];
}

/**
 * A template followed by the templates it takes helpers (or events) from, nearest first:
 * `inheritsHelpersFrom`, `replaces`, `copyAs`, transitively.
 */
export function parentChain(index: MeteorIndex, template: string, kind: 'helpers' | 'events', scope: Scope): string[] {
  const parents = kind === 'helpers' ? index.a.helperParents : index.a.eventParents;
  const out = [template];
  for (let i = 0; i < out.length; i++) {
    for (const p of parents.get(out[i]) ?? []) {
      if (!out.includes(p.from) && index.inScope(scope, p.link.fullLoc.file)) out.push(p.from);
    }
  }
  return out;
}

/** Helper definitions visible from a template: its own, then inherited ones, then global ones. */
export function findHelper(index: MeteorIndex, template: string | null, name: string, scope: Scope): HelperDef[] {
  const a = index.a;
  if (template !== null) {
    for (const t of parentChain(index, template, 'helpers', scope)) {
      const own = visible(index, scope, a.helpers.get(t)?.get(name));
      if (own.length) return own;
    }
  }
  return visible(index, scope, a.globalHelpers.get(name));
}

/** The template defining the helper `name` seen from `template`: `null` for a global helper, `undefined` if none. */
export function helperOwner(index: MeteorIndex, template: string | null, name: string, scope: Scope): string | null | undefined {
  const defs = findHelper(index, template, name, scope);
  return defs.length ? defs[0].template ?? null : undefined;
}

export function definitions(index: MeteorIndex, t: Target): Def[] {
  const a = index.a;
  const scope = index.scopeOf(t.loc.file);
  switch (t.type) {
    case 'method':
      return t.isDef ? [{ loc: t.loc }] : visible(index, scope, a.methods.get(t.name)).map((d) => ({ loc: d.loc, full: d.fullLoc }));
    case 'publication':
      return t.isDef ? [{ loc: t.loc }] : visible(index, scope, a.publications.get(t.name)).map((d) => ({ loc: d.loc, full: d.fullLoc }));
    case 'template': {
      const html = templateHtmlDefs(index, t.name, scope);
      const js = templateJsDefs(index, t.name, scope);
      // From the HTML name jump to the JS; from everywhere else jump to the HTML (or JS if there is no HTML).
      if (t.origin === 'html') return js.length ? js : [{ loc: t.loc }];
      return html.length ? html : js;
    }
    case 'helper':
      if (t.isDef) return [{ loc: t.loc }];
      return findHelper(index, t.template, t.name, scope).map((m) => ({ loc: m.loc, full: m.fullLoc }));
    case 'event': {
      const found = eventTargets(index, t.template, t.name, scope);
      return found.length ? found.map((loc) => ({ loc })) : [{ loc: t.loc }];
    }
  }
}

export function references(index: MeteorIndex, t: Target, includeDeclaration: boolean): Loc[] {
  const a = index.a;
  const scope = index.scopeOf(t.loc.file);
  const out: Loc[] = [];
  switch (t.type) {
    case 'method':
      if (includeDeclaration) out.push(...visible(index, scope, a.methods.get(t.name)).map((d) => d.loc));
      out.push(...visible(index, scope, a.calls.get(t.name)).map((c) => c.loc));
      break;
    case 'publication':
      if (includeDeclaration) out.push(...visible(index, scope, a.publications.get(t.name)).map((d) => d.loc));
      out.push(...visible(index, scope, a.subscriptions.get(t.name)).map((c) => c.loc));
      break;
    case 'template':
      out.push(...templateUsages(index, t.name, scope));
      if (includeDeclaration) out.push(...visible(index, scope, a.templates.get(t.name)).map((d) => d.loc));
      break;
    case 'helper': {
      const defs = findHelper(index, t.template, t.name, scope);
      if (includeDeclaration) out.push(...defs.map((d) => d.loc));
      if (defs.length) out.push(...helperUsages(index, defs[0].template ?? null, t.name, scope));
      break;
    }
    case 'event':
      out.push(...eventTargets(index, t.template, t.name, scope));
      break;
  }
  return dedupe(out);
}

export function templateHtmlDefs(index: MeteorIndex, name: string, scope: Scope = null): Def[] {
  return visible(index, scope, index.a.templates.get(name)).map((d) => ({ loc: d.loc, full: d.fullLoc }));
}

/** `Template.x.helpers/events/onCreated…(...)`, and `Template.y.copyAs('x')` for templates created by a copy. */
export function templateJsDefs(index: MeteorIndex, name: string, scope: Scope = null): Def[] {
  const a = index.a;
  const parts = (a.parts.get(name) ?? []).filter((p) => index.inScope(scope, p.nameLoc.file)).map((p) => ({ loc: p.nameLoc, full: p.fullLoc }));
  const copies = (a.copies.get(name) ?? []).filter((l) => index.inScope(scope, l.otherLoc.file)).map((l) => ({ loc: l.otherLoc, full: l.fullLoc }));
  return [...parts, ...copies];
}

/** Files where a template exists: its HTML, its JS, a `copyAs` creating it. */
export function templateFiles(index: MeteorIndex, name: string): string[] {
  const a = index.a;
  return [
    ...(a.templates.get(name) ?? []).map((d) => d.loc.file),
    ...(a.parts.get(name) ?? []).map((p) => p.nameLoc.file),
    ...(a.copies.get(name) ?? []).map((l) => l.otherLoc.file),
  ];
}

/** `{{> name}}`, `{{#name}}`, `Template.name`, `BlazeLayout.render('name')`, `inheritsHelpersFrom('name')`. */
export function templateUsages(index: MeteorIndex, name: string, scope: Scope = null): Loc[] {
  const a = index.a;
  const inclusions = visible(index, scope, a.inclusions.get(name)).map((u) => u.loc);
  // `Template.foo.helpers(...)` and `Template.foo.inheritsHelpersFrom(...)` also produce a ref: those are not usages
  const own = new Set([...(a.parts.get(name) ?? []).map((p) => key(p.nameLoc)), ...(a.links.get(name) ?? []).map((l) => key(l.nameLoc))]);
  const refs = visible(index, scope, a.templateRefs.get(name)).filter((r) => !own.has(key(r.loc))).map((r) => r.loc);
  return [...inclusions, ...refs];
}

/** template-extension links of a template, in the scope (for hovers and the side panel). */
export function templateLinks(index: MeteorIndex, name: string, scope: Scope = null): TemplateLink[] {
  return (index.a.links.get(name) ?? []).filter((l) => index.inScope(scope, l.fullLoc.file));
}

/**
 * Usages in the HTML of the helper `name` defined by `owner` (`null`: the global helper):
 * in every template where that name resolves to that definition, i.e. the owner itself, the templates
 * inheriting from it without overriding the helper, and (for a global helper) all those not defining their own.
 */
export function helperUsages(index: MeteorIndex, owner: string | null, name: string, scope: Scope): Loc[] {
  const a = index.a;
  const out: Loc[] = [];
  const ownerOf = new Map<string, string | null | undefined>();
  for (const [tpl, usages] of a.usagesByTemplate) {
    for (const u of usages) {
      if (u.name !== name || u.local || !(u.kind === 'helper' || (u.kind === 'block' && !a.templateNames.has(name)))) continue;
      if (!index.inScope(scope, u.loc.file)) continue;
      // which definition this usage sees, from the apps of its own file
      const k = `${tpl}\n${u.loc.file}`;
      if (!ownerOf.has(k)) ownerOf.set(k, helperOwner(index, tpl, name, index.scopeOf(u.loc.file)));
      if (ownerOf.get(k) === owner) out.push(u.loc);
    }
  }
  return out;
}

/**
 * Elements matching the `.class` / `#id` selectors of an event map key, in the HTML of the template
 * and of the templates taking its events (`inheritsEventsFrom`, `replaces`, `copyAs`).
 */
export function eventTargets(index: MeteorIndex, template: string, eventKey: string, scope: Scope = null): Loc[] {
  const a = index.a;
  const templates = [template];
  for (let i = 0; i < templates.length; i++) {
    for (const [child, parents] of a.eventParents) {
      if (templates.includes(child)) continue;
      if (parents.some((p) => p.from === templates[i] && index.inScope(scope, p.link.fullLoc.file))) templates.push(child);
    }
  }
  const marks = templates.flatMap((t) => visible(index, scope, a.marks.get(t)));
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

/** True when two of the definitions exist in the same app (or are both outside every app): a real duplicate. */
export function hasConflict(index: MeteorIndex, locs: Loc[]): boolean {
  if (locs.length < 2) return false;
  if (!index.isMultiApp) return true;
  for (let i = 0; i < locs.length; i++) {
    const scope = index.scopeOf(locs[i].file);
    for (let j = i + 1; j < locs.length; j++) if (index.inScope(scope, locs[j].file)) return true;
  }
  return false;
}

/** `'admin'`, `'admin', 'web'` */
export function appList(index: MeteorIndex, ids: Iterable<string>): string {
  return [...ids].map((id) => `'${index.appName(id)}'`).join(', ');
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
  const scope = index.scopeOf(file);
  const ignored = (list: string[], name: string) => list.some((p) => wildcardMatch(p, name));
  const out: Problem[] = [];
  /** Not defined anywhere, or not in some of the apps this file belongs to (e.g. shared code). */
  const check = (what: string, name: string, files: string[], loc: Loc, code: Problem['code']) => {
    if (!files.length) {
      out.push({ loc, message: `${what} '${name}' is not defined in the workspace.`, code });
      return;
    }
    const missing = index.missingApps(scope, files);
    if (missing.length) out.push({ loc, message: `${what} '${name}' is not defined in ${missing.length === 1 ? 'app' : 'apps'} ${appList(index, missing)}.`, code });
  };
  for (const c of f.calls) {
    const name = a.resolve(c);
    if (name === undefined || ignored(opts.ignoreMethods, name)) continue;
    check('Meteor method', name, (a.methods.get(name) ?? []).map((d) => d.loc.file), c.loc, 'unknown-method');
  }
  for (const c of f.subscriptions) {
    const name = a.resolve(c);
    if (name === undefined || ignored(opts.ignorePublications, name)) continue;
    check('Publication', name, (a.publications.get(name) ?? []).map((d) => d.loc.file), c.loc, 'unknown-publication');
  }
  for (const u of f.htmlUsages) {
    if (u.kind !== 'inclusion' || ignored(opts.ignoreTemplates, u.name)) continue;
    check('Template', u.name, templateFiles(index, u.name), u.loc, 'unknown-template');
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
