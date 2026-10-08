import { moduleId } from './jsParser';
import { CallSite, FileFacts, HtmlClose, HtmlMark, HtmlUsage, Loc, Member, MethodDef, NameSource, TemplateHtml, TemplatePart, TemplateRef } from './model';

export type Named<T> = T & { name: string };
export type TemplateMember = Member & { template: string };

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
  resolve(ns: NameSource): string | undefined;
  /**
   * Where the string of the constant behind a name reference is written (e.g. `RESET: 'users.reset'`
   * for `USERS_METHODS.RESET`). `file` is the file containing the reference. Empty if not a constant reference.
   */
  constantLocs(ns: NameSource, file: string): Loc[];
}

export class MeteorIndex {
  private readonly files = new Map<string, FileFacts>();
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
    this.invalidate();
  }

  facts(file: string): FileFacts | undefined {
    return this.files.get(file);
  }

  allFacts(): IterableIterator<FileFacts> {
    return this.files.values();
  }

  get a(): Aggregate {
    return (this.agg ??= buildAggregate([...this.files.values()]));
  }

  private invalidate() {
    this.agg = undefined;
    this._version++;
  }
}

function buildAggregate(all: FileFacts[]): Aggregate {
  const constants = new Map<string, Set<string>>();
  for (const f of all) {
    for (const [k, v] of Object.entries(f.constants)) {
      let set = constants.get(k);
      if (!set) constants.set(k, (set = new Set()));
      set.add(v);
    }
  }

  // `export default` constants by module id (path without extension, lower case, `/` separators)
  const defaults: { id: string; values: Record<string, string>; locs: Record<string, Loc> }[] = [];
  for (const f of all) {
    if (Object.keys(f.defaultExport).length) defaults.push({ id: moduleId(f.file), values: f.defaultExport, locs: f.defaultExportLocs });
  }
  const byFile = new Map(all.map((f) => [f.file, f]));
  const constantEntries = new Map<string, { value: string; loc: Loc }[]>();
  for (const f of all) {
    for (const [k, v] of Object.entries(f.constants)) {
      const l = f.constantLocs[k];
      if (l) push(constantEntries, k, { value: v, loc: l });
    }
  }

  /** `@default(<module hint>).A.B` → the default exports of that module having `A.B`. */
  const defaultsFor = (expr: string) => {
    const close = expr.indexOf(')');
    const hint = expr.slice('@default('.length, close);
    const key = expr.slice(close + 2); // after ")."
    const absolute = hint.startsWith('/') && !/^\/[a-z]:\//.test(hint) && !hint.startsWith('//');
    const found: { value: string; loc: Loc | undefined }[] = [];
    for (const d of defaults) {
      const matches = absolute
        ? d.id.endsWith(hint) || d.id.endsWith(hint + '/index')
        : d.id === hint || d.id === hint + '/index';
      if (matches && d.values[key] !== undefined) found.push({ value: d.values[key], loc: d.locs[key] });
    }
    return found;
  };
  const resolveDefault = (expr: string): string | undefined => {
    const values = new Set(defaultsFor(expr).map((d) => d.value));
    return values.size === 1 ? [...values][0] : undefined;
  };

  const resolveCache = new Map<string, string | undefined>();
  const resolve = (ns: NameSource): string | undefined => {
    if (ns.name !== undefined) return ns.name;
    const expr = ns.nameExpr;
    if (!expr) return undefined;
    if (resolveCache.has(expr)) return resolveCache.get(expr);
    if (expr.startsWith('@default(')) {
      const v = resolveDefault(expr);
      resolveCache.set(expr, v);
      return v;
    }
    // Try the full path, then drop leading segments: `C.USERS.RESET` (namespace import) → `USERS.RESET` → `RESET`.
    let result: string | undefined;
    const segs = expr.split('.');
    for (let i = 0; i < segs.length && result === undefined; i++) {
      const set = constants.get(segs.slice(i).join('.'));
      if (set?.size === 1) result = [...set][0];
      else if (set && set.size > 1) break;
    }
    resolveCache.set(expr, result);
    return result;
  };

  const constantLocs = (ns: NameSource, file: string): Loc[] => {
    if (ns.nameKind !== 'expr' || !ns.nameExpr) return [];
    const value = resolve(ns);
    if (value === undefined) return [];
    const expr = ns.nameExpr;
    const own = byFile.get(file)?.constantLocs[expr];
    if (own) return [own];
    if (expr.startsWith('@default(')) {
      return defaultsFor(expr).flatMap((d) => (d.value === value && d.loc ? [d.loc] : []));
    }
    // same lookup order as `resolve`
    const segs = expr.split('.');
    for (let i = 0; i < segs.length; i++) {
      const entries = constantEntries.get(segs.slice(i).join('.'))?.filter((e) => e.value === value);
      if (entries?.length) return entries.map((e) => e.loc);
    }
    return [];
  };

  const a: Aggregate = {
    methods: new Map(),
    calls: new Map(),
    publications: new Map(),
    subscriptions: new Map(),
    templates: new Map(),
    parts: new Map(),
    templateRefs: new Map(),
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

  const addNamed = <T extends NameSource>(map: MultiMap<Named<T>>, items: T[]) => {
    for (const it of items) {
      const name = resolve(it);
      if (name !== undefined) push(map, name, { ...it, name });
    }
  };

  for (const f of all) {
    addNamed(a.methods, f.methods);
    addNamed(a.calls, f.calls);
    addNamed(a.publications, f.publications);
    addNamed(a.subscriptions, f.subscriptions);
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
