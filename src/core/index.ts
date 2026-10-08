import { moduleId } from './jsParser';
import { CallSite, FileFacts, HtmlClose, HtmlMark, HtmlUsage, Loc, Member, MethodDef, NameSource, TemplateHtml, TemplateLink, TemplatePart, TemplateRef } from './model';

export type Named<T> = T & { name: string };
export type TemplateMember = Member & { template: string };

/**
 * The Meteor apps a query is about: those of the file it starts from. `null` means every app
 * (single-app workspace, or a file outside every app).
 */
export type Scope = ReadonlySet<string> | null;

/** A template receiving helpers or events from another one (`inheritsHelpersFrom`, `replaces`, `copyAs`). */
export interface Inherit {
  from: string;
  link: TemplateLink;
}

type MultiMap<T> = Map<string, T[]>;

function push<T>(map: MultiMap<T>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Cross-file view of the workspace, rebuilt lazily after any file change. */
export interface Aggregate {
  methods: MultiMap<Named<MethodDef>>;
  calls: MultiMap<Named<CallSite>>;
  publications: MultiMap<Named<MethodDef>>;
  subscriptions: MultiMap<Named<CallSite>>;
  /** HTML definitions by template name. */
  templates: MultiMap<TemplateHtml>;
  /** JS parts (helpers/events/lifecycle) by template name. */
  parts: MultiMap<TemplatePart>;
  templateRefs: MultiMap<TemplateRef>;
  /** template-extension calls by the `Template.x` they are called on. */
  links: MultiMap<TemplateLink>;
  /** template → templates it takes helpers from (inheritsHelpersFrom, replaces, copyAs). */
  helperParents: MultiMap<Inherit>;
  /** template → templates it takes events from (inheritsEventsFrom, replaces, copyAs). */
  eventParents: MultiMap<Inherit>;
  /** `Template.foo.copyAs('bar')` by the new name (`bar`). */
  copies: MultiMap<TemplateLink>;
  /** template → helper name → definitions */
  helpers: Map<string, MultiMap<TemplateMember>>;
  events: MultiMap<TemplateMember>;
  globalHelpers: MultiMap<Member>;
  usagesByTemplate: MultiMap<HtmlUsage>;
  /** `{{> x}}` and `{{#x}}` usages, keyed by the included name. */
  inclusions: MultiMap<HtmlUsage>;
  marks: MultiMap<HtmlMark>;
  /** `{{/x}}` by template */
  closes: MultiMap<HtmlClose>;
  /** All known template names (HTML or JS). */
  templateNames: Set<string>;
  /**
   * The name a definition or call refers to. Constants are looked up in the apps of `file`
   * (by default the file of `ns.loc`), so two apps may give the same constant different values.
   */
  resolve(ns: NameSource & { loc?: Loc }, file?: string): string | undefined;
  /**
   * Where the string of the constant behind a name reference is written (e.g. `RESET: 'users.reset'`
   * for `USERS_METHODS.RESET`). `file` is the file containing the reference. Empty if not a constant reference.
   */
  constantLocs(ns: NameSource, file: string): Loc[];
}

export class MeteorIndex {
  private readonly files = new Map<string, FileFacts>();
  /** file → ids of the Meteor apps it belongs to (absent or empty: none, visible from everywhere) */
  private readonly fileApps = new Map<string, string[]>();
  /** app id → display name */
  private appNames = new Map<string, string>();
  private agg: Aggregate | undefined;
  private _version = 0;

  get version() {
    return this._version;
  }

  update(facts: FileFacts) {
    this.files.set(facts.file, facts);
    this.invalidate();
  }

  remove(file: string) {
    if (this.files.delete(file)) this.invalidate();
  }

  clear() {
    this.files.clear();
    this.fileApps.clear();
    this.invalidate();
  }

  // ------------------------------------------------------------------------------------ apps

  /** The Meteor apps of the workspace (id → display name). */
  setApps(names: Map<string, string>) {
    this.appNames = new Map(names);
    this.invalidate();
  }

  /** The apps a file belongs to. */
  setFileApps(file: string, apps: string[]) {
    const old = this.fileApps.get(file);
    if (old && old.length === apps.length && old.every((x, i) => x === apps[i])) return;
    if (!old && !apps.length) return;
    if (apps.length) this.fileApps.set(file, apps);
    else this.fileApps.delete(file);
    this.invalidate();
  }

  get apps(): ReadonlyMap<string, string> {
    return this.appNames;
  }

  /** True when there is more than one app, i.e. when scoping makes a difference. */
  get isMultiApp(): boolean {
    return this.appNames.size > 1;
  }

  appsOf(file: string): readonly string[] {
    return this.fileApps.get(file) ?? [];
  }

  appName(id: string): string {
    return this.appNames.get(id) ?? id;
  }

  /** The apps seen from a file. */
  scopeOf(file: string): Scope {
    if (!this.isMultiApp) return null;
    const apps = this.fileApps.get(file);
    return apps?.length ? new Set(apps) : null;
  }

  /** Whether something written in `file` exists in (one of) the apps of the scope. */
  inScope(scope: Scope, file: string): boolean {
    if (!scope) return true;
    const apps = this.fileApps.get(file);
    return !apps?.length || apps.some((x) => scope.has(x));
  }

  /**
   * Apps of the scope in which nothing in `files` exists, e.g. the apps where a method called from
   * shared code is not defined. Always empty when the scope is every app: check first that `files` is not empty.
   */
  missingApps(scope: Scope, files: Iterable<string>): string[] {
    if (!scope) return [];
    const missing = new Set(scope);
    for (const f of files) {
      const apps = this.fileApps.get(f);
      if (!apps?.length) return [];
      for (const x of apps) missing.delete(x);
    }
    return [...missing];
  }

  /**
   * Starting from the apps of `seed`, adds the apps of every file in scope until nothing changes:
   * the set of apps that must be edited together (shared code calling a method ties the apps together).
   */
  closure(seed: string, files: string[]): Scope {
    let scope = this.scopeOf(seed);
    if (!scope) return null;
    const set = new Set(scope);
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of files) {
        if (!this.inScope(set, f)) continue;
        for (const x of this.appsOf(f)) if (!set.has(x)) {
          set.add(x);
          changed = true;
        }
      }
    }
    scope = set;
    return set.size === this.appNames.size ? null : scope;
  }

  facts(file: string): FileFacts | undefined {
    return this.files.get(file);
  }

  allFacts(): IterableIterator<FileFacts> {
    return this.files.values();
  }

  get a(): Aggregate {
    return (this.agg ??= buildAggregate([...this.files.values()], this));
  }

  private invalidate() {
    this.agg = undefined;
    this._version++;
  }
}

function buildAggregate(all: FileFacts[], index: MeteorIndex): Aggregate {
  // constant name → every value it has, with the file declaring it (two apps may declare it differently)
  const constants = new Map<string, { value: string; file: string; loc: Loc | undefined }[]>();
  for (const f of all) {
    for (const [k, v] of Object.entries(f.constants)) push(constants, k, { value: v, file: f.file, loc: f.constantLocs[k] });
  }

  // `export default` constants by module id (path without extension, lower case, `/` separators)
  const defaults: { id: string; file: string; values: Record<string, string>; locs: Record<string, Loc> }[] = [];
  for (const f of all) {
    if (Object.keys(f.defaultExport).length) defaults.push({ id: moduleId(f.file), file: f.file, values: f.defaultExport, locs: f.defaultExportLocs });
  }
  const byFile = new Map(all.map((f) => [f.file, f]));
  // method objects (`const insertTask = new ValidatedMethod(...)`) by variable name
  const methodObjects = new Map<string, { ns: NameSource; file: string }[]>();
  for (const f of all) for (const [k, ns] of Object.entries(f.methodObjects)) push(methodObjects, k, { ns, file: f.file });

  /** `@default(<module hint>).A.B` → the default exports of that module having `A.B`. */
  const defaultsFor = (expr: string, scope: Scope) => {
    const close = expr.indexOf(')');
    const hint = expr.slice('@default('.length, close);
    const key = expr.slice(close + 2); // after ")."
    const absolute = hint.startsWith('/') && !/^\/[a-z]:\//.test(hint) && !hint.startsWith('//');
    const found: { value: string; loc: Loc | undefined }[] = [];
    for (const d of defaults) {
      if (!index.inScope(scope, d.file)) continue;
      const matches = absolute
        ? d.id.endsWith(hint) || d.id.endsWith(hint + '/index')
        : d.id === hint || d.id === hint + '/index';
      if (matches && d.values[key] !== undefined) found.push({ value: d.values[key], loc: d.locs[key] });
    }
    return found;
  };

  /** Constants named like `expr` visible from the scope: the full path, then without leading segments. */
  const constantsFor = (expr: string, scope: Scope) => {
    // `C.USERS.RESET` (namespace import) → `USERS.RESET` → `RESET`
    const segs = expr.split('.');
    for (let i = 0; i < segs.length; i++) {
      const found = constants.get(segs.slice(i).join('.'))?.filter((c) => index.inScope(scope, c.file));
      if (found?.length) return found;
    }
    return [];
  };

  const resolveCache = new Map<string, string | undefined>();
  const resolve = (ns: NameSource & { loc?: Loc }, file = ns.loc?.file): string | undefined => {
    if (ns.name !== undefined) return ns.name;
    const expr = ns.nameExpr;
    if (!expr) return undefined;
    const scope = file === undefined ? null : index.scopeOf(file);
    const cacheKey = `${scope ? [...scope].join('|') : '*'}#${expr}`;
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey);
    let values: Set<string | undefined>;
    if (expr.startsWith('@obj:')) {
      // the method object with that variable name (`Tasks.insertTask` → `insertTask`)
      resolveCache.set(cacheKey, undefined); // no cycles through constants pointing back here
      const segs = expr.slice('@obj:'.length).split('.');
      let objs: { ns: NameSource; file: string }[] = [];
      for (let i = 0; i < segs.length && !objs.length; i++) objs = (methodObjects.get(segs.slice(i).join('.')) ?? []).filter((o) => index.inScope(scope, o.file));
      values = new Set(objs.map((o) => resolve(o.ns, o.file)));
    } else {
      const found = expr.startsWith('@default(') ? defaultsFor(expr, scope) : constantsFor(expr, scope);
      values = new Set(found.map((c) => c.value));
    }
    const result = values.size === 1 ? [...values][0] : undefined;
    resolveCache.set(cacheKey, result);
    return result;
  };

  const constantLocs = (ns: NameSource, file: string): Loc[] => {
    if (ns.nameKind !== 'expr' || !ns.nameExpr) return [];
    const value = resolve(ns, file);
    if (value === undefined) return [];
    const expr = ns.nameExpr;
    const own = byFile.get(file)?.constantLocs[expr];
    if (own) return [own];
    const scope = index.scopeOf(file);
    const found = expr.startsWith('@default(') ? defaultsFor(expr, scope) : constantsFor(expr, scope);
    return found.flatMap((c) => (c.value === value && c.loc ? [c.loc] : []));
  };

  const a: Aggregate = {
    methods: new Map(),
    calls: new Map(),
    publications: new Map(),
    subscriptions: new Map(),
    templates: new Map(),
    parts: new Map(),
    templateRefs: new Map(),
    links: new Map(),
    helperParents: new Map(),
    eventParents: new Map(),
    copies: new Map(),
    helpers: new Map(),
    events: new Map(),
    globalHelpers: new Map(),
    usagesByTemplate: new Map(),
    inclusions: new Map(),
    marks: new Map(),
    closes: new Map(),
    templateNames: new Set(),
    resolve,
    constantLocs,
  };

  const addNamed = <T extends NameSource>(map: MultiMap<Named<T>>, items: T[], file: string) => {
    for (const it of items) {
      const name = resolve(it, file);
      if (name !== undefined) push(map, name, { ...it, name });
    }
  };

  for (const f of all) {
    addNamed(a.methods, f.methods, f.file);
    addNamed(a.calls, f.calls, f.file);
    addNamed(a.publications, f.publications, f.file);
    addNamed(a.subscriptions, f.subscriptions, f.file);
    for (const t of f.templates) {
      push(a.templates, t.name, t);
      a.templateNames.add(t.name);
    }
    for (const p of f.templateParts) {
      push(a.parts, p.template, p);
      a.templateNames.add(p.template);
      for (const m of p.members) {
        const tm = { ...m, template: p.template };
        if (p.kind === 'helpers') {
          let byName = a.helpers.get(p.template);
          if (!byName) a.helpers.set(p.template, (byName = new Map()));
          push(byName, m.name, tm);
        } else if (p.kind === 'events') push(a.events, p.template, tm);
      }
    }
    for (const r of f.templateRefs) push(a.templateRefs, r.template, r);
    for (const l of f.templateLinks) {
      push(a.links, l.template, l);
      switch (l.kind) {
        case 'inheritsHelpersFrom':
          push(a.helperParents, l.template, { from: l.other, link: l });
          break;
        case 'inheritsEventsFrom':
          push(a.eventParents, l.template, { from: l.other, link: l });
          break;
        case 'replaces':
          // foo's HTML is rendered in place of bar's, with bar's helpers and events
          push(a.helperParents, l.template, { from: l.other, link: l });
          push(a.eventParents, l.template, { from: l.other, link: l });
          break;
        case 'copyAs':
          // bar is a new template with foo's HTML, helpers and events
          push(a.copies, l.other, l);
          push(a.helperParents, l.other, { from: l.template, link: l });
          push(a.eventParents, l.other, { from: l.template, link: l });
          a.templateNames.add(l.other);
          break;
      }
    }
    for (const h of f.globalHelpers) push(a.globalHelpers, h.name, h);
    for (const u of f.htmlUsages) {
      push(a.usagesByTemplate, u.template, u);
      if (u.kind !== 'helper') push(a.inclusions, u.name, u);
    }
    for (const m of f.htmlMarks) push(a.marks, m.template, m);
    for (const c of f.htmlCloses) push(a.closes, c.template, c);
  }
  return a;
}
