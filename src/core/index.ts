import { moduleId } from './jsParser';
import { CallSite, FileFacts, HtmlMark, HtmlUsage, Member, MethodDef, NameSource, TemplateHtml, TemplatePart, TemplateRef } from './model';

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
  /** All known template names (HTML or JS). */
  templateNames: Set<string>;
  resolve(ns: NameSource): string | undefined;
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
  const defaults: { id: string; values: Record<string, string> }[] = [];
  for (const f of all) if (Object.keys(f.defaultExport).length) defaults.push({ id: moduleId(f.file), values: f.defaultExport });

  /** `@default(<module hint>).A.B` → the `A.B` value of the default export of that module. */
  const resolveDefault = (expr: string): string | undefined => {
    const close = expr.indexOf(')');
    const hint = expr.slice('@default('.length, close);
    const key = expr.slice(close + 2); // after ")."
    const absolute = hint.startsWith('/') && !/^\/[a-z]:\//.test(hint) && !hint.startsWith('//');
    const values = new Set<string>();
    for (const d of defaults) {
      const matches = absolute
        ? d.id.endsWith(hint) || d.id.endsWith(hint + '/index')
        : d.id === hint || d.id === hint + '/index';
      const v = matches ? d.values[key] : undefined;
      if (v !== undefined) values.add(v);
    }
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
    templateNames: new Set(),
    resolve,
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
  }
  return a;
}
