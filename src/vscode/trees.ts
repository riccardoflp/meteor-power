import * as path from 'path';
import * as vscode from 'vscode';
import { Aggregate, MeteorIndex, Named, Scope, TemplateMember } from '../core/index';
import { CallSite, Env, Loc, Member, MethodDef, TemplatePart } from '../core/model';
import { hasConflict, parentChain, templateHtmlDefs, templateJsDefs, templateLinks, templateUsages, visible } from '../core/queries';
import { appsLabel, relPath } from './convert';
import { WorkspaceIndexer } from './indexer';
import { templatesIn } from './providers';

const ENV_ICON: Record<Env, vscode.ThemeIcon> = {
  server: new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue')),
  client: new vscode.ThemeIcon('browser', new vscode.ThemeColor('charts.green')),
  both: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.purple')),
};
const ENV_TEXT: Record<Env, string> = { server: 'server', client: 'client', both: 'client+server' };

function openCommand(loc: Loc, title = 'Open'): vscode.Command {
  return { command: 'meteorPower.openLocation', title, arguments: [loc] };
}

/** The app shown in the side panel when the workspace contains several Meteor apps (`null`: all of them). */
export class AppFilter implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private _app: string | null = null;

  constructor(private readonly index: MeteorIndex) {}

  get app(): string | null {
    return this._app && this.index.apps.has(this._app) ? this._app : null;
  }

  set app(value: string | null) {
    this._app = value;
    this.emitter.fire();
  }

  get scope(): Scope {
    const app = this.app;
    return app ? new Set([app]) : null;
  }

  /** Shown next to the view titles. */
  get label(): string {
    const app = this.app;
    return app ? this.index.appName(app) : this.index.isMultiApp ? 'all apps' : '';
  }

  dispose() {
    this.emitter.dispose();
  }
}

/** Apps of a list of definitions: `all apps`, or their names (empty with a single app). */
function appsOfDefs(index: MeteorIndex, files: string[]): string {
  if (!index.isMultiApp) return '';
  const ids = new Set(files.flatMap((f) => index.appsOf(f)));
  if (files.some((f) => !index.appsOf(f).length) || ids.size === index.apps.size) return 'all apps';
  return [...ids].map((id) => index.appName(id)).join(', ');
}

// ------------------------------------------------------------------------- Methods / Publications

type NameNode =
  | { kind: 'ns'; label: string; path: string; children: Map<string, NameNode>; count: number }
  | { kind: 'name'; label: string; name: string; defs: Named<MethodDef>[]; uses: Named<CallSite>[] }
  | { kind: 'use'; use: CallSite }
  | { kind: 'unknownGroup'; items: NameNode[] };

/** Tree of method (or publication) names grouped by namespace: `users.profile.save` → users › profile › save. */
export class NamesTree implements vscode.TreeDataProvider<NameNode> {
  private readonly emitter = new vscode.EventEmitter<NameNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: NameNode[] | undefined;

  constructor(
    private readonly indexer: WorkspaceIndexer,
    private readonly mode: 'methods' | 'publications',
    private readonly filter: AppFilter,
  ) {
    indexer.onDidChange(() => this.refresh());
    filter.onDidChange(() => this.refresh());
  }

  refresh() {
    this.roots = undefined;
    this.emitter.fire(undefined);
  }

  private build(): NameNode[] {
    const index = this.indexer.index;
    const a = index.a;
    const scope = this.filter.scope;
    const defs = this.mode === 'methods' ? a.methods : a.publications;
    const uses = this.mode === 'methods' ? a.calls : a.subscriptions;
    const root = new Map<string, NameNode>();

    for (const [name, all] of defs) {
      const list = visible(index, scope, all);
      if (!list.length) continue;
      const segs = name.split(/[./]/).filter(Boolean);
      if (!segs.length) segs.push(name);
      let level = root;
      let prefix = '';
      for (let i = 0; i < segs.length - 1; i++) {
        prefix = prefix ? `${prefix}.${segs[i]}` : segs[i];
        let ns = level.get('ns:' + segs[i]);
        if (!ns) level.set('ns:' + segs[i], (ns = { kind: 'ns', label: segs[i], path: prefix, children: new Map(), count: 0 }));
        if (ns.kind === 'ns') {
          ns.count++;
          level = ns.children;
        }
      }
      level.set('name:' + name, { kind: 'name', label: segs[segs.length - 1], name, defs: list, uses: visible(index, scope, uses.get(name)) });
    }

    const out = sortNodes([...root.values()]);
    const unknown: NameNode[] = [];
    for (const [name, list] of uses) {
      // not defined at all, or not in (one of) the apps of the call
      const defFiles = (defs.get(name) ?? []).map((d) => d.loc.file);
      const bad = visible(index, scope, list).filter((u) => !defFiles.length || index.missingApps(scope ?? index.scopeOf(u.loc.file), defFiles).length);
      if (bad.length) unknown.push({ kind: 'name', label: name, name, defs: [], uses: bad });
    }
    if (unknown.length) out.push({ kind: 'unknownGroup', items: unknown.sort((x, y) => labelOf(x).localeCompare(labelOf(y))) });
    return out;
  }

  getChildren(node?: NameNode): NameNode[] {
    if (!node) return (this.roots ??= this.build());
    switch (node.kind) {
      case 'ns':
        return sortNodes([...node.children.values()]);
      case 'name':
        return node.uses.map((use) => ({ kind: 'use', use }));
      case 'unknownGroup':
        return node.items;
      default:
        return [];
    }
  }

  getTreeItem(node: NameNode): vscode.TreeItem {
    const isMethod = this.mode === 'methods';
    switch (node.kind) {
      case 'ns': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.description = String(node.count);
        item.tooltip = node.path;
        return item;
      }
      case 'name': {
        const hasUses = node.uses.length > 0;
        const item = new vscode.TreeItem(node.label, hasUses ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        const usesText = `${node.uses.length} ${isMethod ? (node.uses.length === 1 ? 'call' : 'calls') : node.uses.length === 1 ? 'subscription' : 'subscriptions'}`;
        const d = node.defs[0];
        const index = this.indexer.index;
        if (!d) {
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          item.description = usesText;
          item.tooltip = index.isMultiApp ? `'${node.name}' is used where it is not defined` : `'${node.name}' is used but not defined in the workspace`;
          return item;
        }
        const conflict = hasConflict(index, node.defs.map((x) => x.loc));
        item.iconPath = conflict ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')) : ENV_ICON[d.env];
        const apps = this.filter.app ? '' : appsOfDefs(index, node.defs.map((x) => x.loc.file));
        item.description = `${ENV_TEXT[d.env]} · ${usesText}${apps ? ` · ${apps}` : ''}`;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendCodeblock(`${d.isAsync ? 'async ' : ''}'${node.name}'(${d.params.join(', ')})`, 'javascript');
        md.appendMarkdown(
          node.defs
            .map((x) => {
              const apps = appsLabel(index, x.loc.file);
              return `${relPath(x.loc.file)}:${x.loc.range.start.line + 1}${apps ? ` · $(package) ${apps}` : ''}`;
            })
            .join('  \n'),
        );
        if (conflict) md.appendMarkdown(`\n\n$(warning) Defined ${node.defs.length} times`);
        if (d.doc) md.appendMarkdown('\n\n' + d.doc);
        item.tooltip = md;
        item.command = openCommand(d.loc);
        item.contextValue = isMethod ? 'method' : 'publication';
        return item;
      }
      case 'use': {
        const u = node.use;
        const item = new vscode.TreeItem(`${path.basename(u.loc.file)}:${u.loc.range.start.line + 1}`);
        item.description = u.lineText;
        item.tooltip = `${relPath(u.loc.file)}:${u.loc.range.start.line + 1}\n${u.lineText}`;
        item.iconPath = new vscode.ThemeIcon('call-incoming');
        item.command = openCommand(u.loc);
        return item;
      }
      case 'unknownGroup': {
        const item = new vscode.TreeItem(isMethod ? 'Calls to undefined methods' : 'Subscriptions to undefined publications', vscode.TreeItemCollapsibleState.Collapsed);
        if (this.indexer.index.isMultiApp) item.tooltip = 'Not defined anywhere, or not in (one of) the apps of the calling file';
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.description = String(node.items.length);
        return item;
      }
    }
  }
}

function labelOf(n: NameNode): string {
  return n.kind === 'ns' || n.kind === 'name' ? n.label : '';
}

function sortNodes(nodes: NameNode[]): NameNode[] {
  // namespaces first, then names
  return nodes.sort((x, y) => (x.kind === y.kind ? labelOf(x).localeCompare(labelOf(y)) : x.kind === 'ns' ? -1 : 1));
}

// ------------------------------------------------------------------------------------- Templates

export type TemplatesMode = 'hierarchy' | 'flat';

type TplNode =
  | { kind: 'template'; name: string; ancestors: string[] }
  | { kind: 'group'; template: string; group: 'helpers' | 'inherited' | 'events'; members: TemplateMember[] }
  | { kind: 'member'; member: Member; group: 'helpers' | 'inherited' | 'events' }
  | { kind: 'lifecycle'; part: TemplatePart }
  | { kind: 'globals' }
  | { kind: 'global'; member: Member };

export class TemplatesTree implements vscode.TreeDataProvider<TplNode> {
  private readonly emitter = new vscode.EventEmitter<TplNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private children: Map<string, Set<string>> | undefined;
  private roots: string[] | undefined;

  constructor(
    private readonly indexer: WorkspaceIndexer,
    public mode: TemplatesMode,
    private readonly filter: AppFilter,
  ) {
    indexer.onDidChange(() => this.refresh());
    filter.onDidChange(() => this.refresh());
  }

  refresh() {
    this.children = undefined;
    this.roots = undefined;
    this.emitter.fire(undefined);
  }

  setMode(mode: TemplatesMode) {
    this.mode = mode;
    this.refresh();
  }

  private get a(): Aggregate {
    return this.indexer.index.a;
  }

  private get index(): MeteorIndex {
    return this.indexer.index;
  }

  /** First definition of each own helper, and inherited helpers not overridden. */
  private helpersOf(name: string): { own: TemplateMember[]; inherited: TemplateMember[] } {
    const scope = this.filter.scope;
    const own: TemplateMember[] = [];
    const inherited: TemplateMember[] = [];
    const seen = new Set<string>();
    for (const [i, t] of parentChain(this.index, name, 'helpers', scope).entries()) {
      for (const defs of this.a.helpers.get(t)?.values() ?? []) {
        const d = visible(this.index, scope, defs)[0];
        if (!d || seen.has(d.name)) continue;
        seen.add(d.name);
        (i === 0 ? own : inherited).push(d);
      }
    }
    return { own, inherited };
  }

  /** parent template → templates it includes with `{{> x}}` / `{{#x}}`. */
  private graph(): Map<string, Set<string>> {
    if (this.children) return this.children;
    const a = this.a;
    const children = new Map<string, Set<string>>();
    for (const [child, usages] of a.inclusions) {
      if (!a.templateNames.has(child)) continue;
      for (const u of visible(this.index, this.filter.scope, usages)) {
        if (u.template === child) continue;
        let set = children.get(u.template);
        if (!set) children.set(u.template, (set = new Set()));
        set.add(child);
      }
    }
    return (this.children = children);
  }

  private rootNames(): string[] {
    if (this.roots) return this.roots;
    const all = templatesIn(this.index, this.filter.scope).sort((x, y) => x.localeCompare(y));
    if (this.mode === 'flat') return (this.roots = all);
    const graph = this.graph();
    const included = new Set<string>();
    for (const set of graph.values()) for (const c of set) included.add(c);
    const roots = all.filter((n) => !included.has(n));
    // templates only reachable through a cycle would never appear: add them as roots
    const reached = new Set<string>();
    const visit = (n: string) => {
      if (reached.has(n)) return;
      reached.add(n);
      for (const c of graph.get(n) ?? []) visit(c);
    };
    roots.forEach(visit);
    for (const n of all) if (!reached.has(n)) {
      roots.push(n);
      visit(n);
    }
    return (this.roots = roots);
  }

  getChildren(node?: TplNode): TplNode[] {
    const a = this.a;
    const scope = this.filter.scope;
    if (!node) {
      const out: TplNode[] = [];
      if (this.globals().length) out.push({ kind: 'globals' });
      for (const name of this.rootNames()) out.push({ kind: 'template', name, ancestors: [] });
      return out;
    }
    switch (node.kind) {
      case 'globals':
        return this.globals().map((member) => ({ kind: 'global' as const, member })).sort((x, y) => x.member.name.localeCompare(y.member.name));
      case 'template': {
        const out: TplNode[] = [];
        const { own, inherited } = this.helpersOf(node.name);
        const events = visible(this.index, scope, a.events.get(node.name));
        if (own.length) out.push({ kind: 'group', template: node.name, group: 'helpers', members: own });
        if (inherited.length) out.push({ kind: 'group', template: node.name, group: 'inherited', members: inherited });
        if (events.length) out.push({ kind: 'group', template: node.name, group: 'events', members: events });
        for (const p of visible(this.index, scope, (a.parts.get(node.name) ?? []).map((p) => ({ ...p, loc: p.nameLoc })))) {
          if (p.kind !== 'helpers' && p.kind !== 'events') out.push({ kind: 'lifecycle', part: p });
        }
        if (this.mode === 'hierarchy') {
          const chain = [...node.ancestors, node.name];
          const kids = [...(this.graph().get(node.name) ?? [])].sort((x, y) => x.localeCompare(y));
          for (const k of kids) out.push({ kind: 'template', name: k, ancestors: chain });
        }
        return out;
      }
      case 'group':
        return node.members.map((member) => ({ kind: 'member' as const, member, group: node.group }));
      default:
        return [];
    }
  }

  private globals(): Member[] {
    const out: Member[] = [];
    for (const defs of this.a.globalHelpers.values()) {
      const d = visible(this.index, this.filter.scope, defs)[0];
      if (d) out.push(d);
    }
    return out;
  }

  getTreeItem(node: TplNode): vscode.TreeItem {
    const a = this.a;
    const index = this.index;
    const scope = this.filter.scope;
    switch (node.kind) {
      case 'globals': {
        const item = new vscode.TreeItem('Global helpers', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('globe');
        item.description = String(this.globals().length);
        return item;
      }
      case 'global':
      case 'member': {
        const m = node.member;
        const isEvent = node.kind === 'member' && node.group === 'events';
        const isInherited = node.kind === 'member' && node.group === 'inherited';
        const item = new vscode.TreeItem(m.name);
        item.iconPath = new vscode.ThemeIcon(isEvent ? 'zap' : 'symbol-function');
        item.description = isEvent ? '' : isInherited ? `from ${(m as TemplateMember).template}` : m.params.join(', ');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(m.snippet, 'javascript');
        item.command = openCommand(m.loc);
        return item;
      }
      case 'group': {
        const label = { helpers: 'Helpers', inherited: 'Inherited helpers', events: 'Events' }[node.group];
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon({ helpers: 'symbol-function', inherited: 'type-hierarchy-sub', events: 'zap' }[node.group]);
        item.description = String(node.members.length);
        return item;
      }
      case 'lifecycle': {
        const item = new vscode.TreeItem(node.part.kind);
        item.iconPath = new vscode.ThemeIcon('debug-start');
        item.description = path.basename(node.part.nameLoc.file);
        item.command = openCommand(node.part.fullLoc);
        return item;
      }
      case 'template': {
        const html = templateHtmlDefs(index, node.name, scope);
        const parts = templateJsDefs(index, node.name, scope);
        const recursive = node.ancestors.includes(node.name);
        const { own, inherited } = this.helpersOf(node.name);
        const lifecycle = (a.parts.get(node.name) ?? []).some((p) => p.kind !== 'helpers' && p.kind !== 'events' && index.inScope(scope, p.nameLoc.file));
        const hasDetails = !!own.length || !!inherited.length || !!visible(index, scope, a.events.get(node.name)).length || lifecycle;
        const hasKids = this.mode === 'hierarchy' && !!this.graph().get(node.name)?.size;
        const collapsible = recursive || !(hasDetails || hasKids) ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.name, collapsible);
        item.id = [...node.ancestors, node.name].join('>');
        item.iconPath = html.length ? new vscode.ThemeIcon('symbol-class') : new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        const where = html.length ? path.basename(html[0].loc.file) : parts.length ? 'JS only' : '';
        const apps = this.filter.app ? '' : appsOfDefs(index, [...html, ...parts].map((d) => d.loc.file));
        item.description = `${where}${recursive ? ' (recursive)' : ''}${apps ? ` · ${apps}` : ''}`;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${node.name}**\n\n`);
        if (html.length) md.appendMarkdown(`$(code) ${html.map((h) => relPath(h.loc.file)).join(', ')}\n\n`);
        const jsFiles = [...new Set(parts.map((p) => relPath(p.loc.file)))];
        if (jsFiles.length) md.appendMarkdown(`$(symbol-method) ${jsFiles.join(', ')}\n\n`);
        for (const l of templateLinks(index, node.name, scope)) md.appendMarkdown(`$(type-hierarchy-sub) \`${l.kind}('${l.other}')\`\n\n`);
        md.appendMarkdown(`Used in ${templateUsages(index, node.name, scope).length} places`);
        item.tooltip = md;
        item.contextValue = `template${html.length ? '.html' : ''}${parts.length ? '.js' : ''}`;
        const target = html[0]?.loc ?? parts[0]?.loc;
        if (target) item.command = openCommand(target);
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }
}
