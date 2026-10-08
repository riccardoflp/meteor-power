import * as path from 'path';
import * as vscode from 'vscode';
import { Aggregate, Named, TemplateMember } from '../core/index';
import { CallSite, Env, Loc, Member, MethodDef, TemplatePart } from '../core/model';
import { templateUsages } from '../core/queries';
import { relPath } from './convert';
import { WorkspaceIndexer } from './indexer';

const ENV_ICON: Record<Env, vscode.ThemeIcon> = {
  server: new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.blue')),
  client: new vscode.ThemeIcon('browser', new vscode.ThemeColor('charts.green')),
  both: new vscode.ThemeIcon('symbol-method', new vscode.ThemeColor('charts.purple')),
};
const ENV_TEXT: Record<Env, string> = { server: 'server', client: 'client', both: 'client+server' };

function openCommand(loc: Loc, title = 'Open'): vscode.Command {
  return { command: 'meteorPower.openLocation', title, arguments: [loc] };
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
  ) {
    indexer.onDidChange(() => this.refresh());
  }

  refresh() {
    this.roots = undefined;
    this.emitter.fire(undefined);
  }

  private build(): NameNode[] {
    const a = this.indexer.index.a;
    const defs = this.mode === 'methods' ? a.methods : a.publications;
    const uses = this.mode === 'methods' ? a.calls : a.subscriptions;
    const root = new Map<string, NameNode>();

    for (const [name, list] of defs) {
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
      level.set('name:' + name, { kind: 'name', label: segs[segs.length - 1], name, defs: list, uses: uses.get(name) ?? [] });
    }

    const out = sortNodes([...root.values()]);
    const unknown: NameNode[] = [];
    for (const [name, list] of uses) {
      if (!defs.has(name)) unknown.push({ kind: 'name', label: name, name, defs: [], uses: list });
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
        if (!d) {
          item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
          item.description = usesText;
          item.tooltip = `'${node.name}' is used but not defined in the workspace`;
          return item;
        }
        item.iconPath = node.defs.length > 1 ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')) : ENV_ICON[d.env];
        item.description = `${ENV_TEXT[d.env]} · ${usesText}`;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendCodeblock(`${d.isAsync ? 'async ' : ''}'${node.name}'(${d.params.join(', ')})`, 'javascript');
        md.appendMarkdown(node.defs.map((x) => `${relPath(x.loc.file)}:${x.loc.range.start.line + 1}`).join('  \n'));
        if (node.defs.length > 1) md.appendMarkdown(`\n\n$(warning) Defined ${node.defs.length} times`);
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
  | { kind: 'group'; template: string; group: 'helpers' | 'events'; members: TemplateMember[] }
  | { kind: 'member'; member: Member; group: 'helpers' | 'events' }
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
  ) {
    indexer.onDidChange(() => this.refresh());
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

  /** parent template → templates it includes with `{{> x}}` / `{{#x}}`. */
  private graph(): Map<string, Set<string>> {
    if (this.children) return this.children;
    const a = this.a;
    const children = new Map<string, Set<string>>();
    for (const [child, usages] of a.inclusions) {
      if (!a.templateNames.has(child)) continue;
      for (const u of usages) {
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
    const a = this.a;
    const all = [...a.templateNames].sort((x, y) => x.localeCompare(y));
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
    if (!node) {
      const out: TplNode[] = [];
      if (a.globalHelpers.size) out.push({ kind: 'globals' });
      for (const name of this.rootNames()) out.push({ kind: 'template', name, ancestors: [] });
      return out;
    }
    switch (node.kind) {
      case 'globals':
        return [...a.globalHelpers.values()].map((l) => ({ kind: 'global' as const, member: l[0] })).sort((x, y) => x.member.name.localeCompare(y.member.name));
      case 'template': {
        const out: TplNode[] = [];
        const helpers = [...(a.helpers.get(node.name)?.values() ?? [])].map((l) => l[0]);
        const events = a.events.get(node.name) ?? [];
        if (helpers.length) out.push({ kind: 'group', template: node.name, group: 'helpers', members: helpers });
        if (events.length) out.push({ kind: 'group', template: node.name, group: 'events', members: events });
        for (const p of a.parts.get(node.name) ?? []) if (p.kind !== 'helpers' && p.kind !== 'events') out.push({ kind: 'lifecycle', part: p });
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

  getTreeItem(node: TplNode): vscode.TreeItem {
    const a = this.a;
    switch (node.kind) {
      case 'globals': {
        const item = new vscode.TreeItem('Global helpers', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('globe');
        item.description = String(a.globalHelpers.size);
        return item;
      }
      case 'global':
      case 'member': {
        const m = node.member;
        const isEvent = node.kind === 'member' && node.group === 'events';
        const item = new vscode.TreeItem(m.name);
        item.iconPath = new vscode.ThemeIcon(isEvent ? 'zap' : 'symbol-function');
        item.description = isEvent ? '' : m.params.join(', ');
        item.tooltip = new vscode.MarkdownString().appendCodeblock(m.snippet, 'javascript');
        item.command = openCommand(m.loc);
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(node.group === 'helpers' ? 'Helpers' : 'Events', vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.group === 'helpers' ? 'symbol-function' : 'zap');
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
        const html = a.templates.get(node.name) ?? [];
        const parts = a.parts.get(node.name) ?? [];
        const recursive = node.ancestors.includes(node.name);
        const hasDetails = !!a.helpers.get(node.name)?.size || !!a.events.get(node.name)?.length || parts.some((p) => p.kind !== 'helpers' && p.kind !== 'events');
        const hasKids = this.mode === 'hierarchy' && !!this.graph().get(node.name)?.size;
        const collapsible = recursive || !(hasDetails || hasKids) ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(node.name, collapsible);
        item.id = [...node.ancestors, node.name].join('>');
        item.iconPath = html.length ? new vscode.ThemeIcon('symbol-class') : new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        const where = html.length ? path.basename(html[0].loc.file) : parts.length ? 'JS only' : '';
        item.description = recursive ? `${where} (recursive)` : where;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${node.name}**\n\n`);
        if (html.length) md.appendMarkdown(`$(code) ${html.map((h) => relPath(h.loc.file)).join(', ')}\n\n`);
        const jsFiles = [...new Set(parts.map((p) => relPath(p.nameLoc.file)))];
        if (jsFiles.length) md.appendMarkdown(`$(symbol-method) ${jsFiles.join(', ')}\n\n`);
        md.appendMarkdown(`Used in ${templateUsages(a, node.name).length} places`);
        item.tooltip = md;
        item.contextValue = `template${html.length ? '.html' : ''}${parts.length ? '.js' : ''}`;
        const target = html[0]?.loc ?? parts[0]?.nameLoc;
        if (target) item.command = openCommand(target);
        return item;
      }
    }
  }

  getParent(): undefined {
    return undefined;
  }
}
