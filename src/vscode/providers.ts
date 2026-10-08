import * as vscode from 'vscode';
import { MeteorIndex, Named, Scope } from '../core/index';
import { Loc, Member, MethodDef } from '../core/model';
import {
  appList,
  definitions,
  enclosingTemplate,
  eventTargets,
  findHelper,
  hasConflict,
  helperUsages,
  parentChain,
  problems,
  references,
  Target,
  targetAt,
  templateFiles,
  templateHtmlDefs,
  templateJsDefs,
  templateLinks,
  templateUsages,
  visible,
} from '../core/queries';
import { appsLabel, fileLink, relPath, toLocation, toPos, toRange } from './convert';
import { WorkspaceIndexer } from './indexer';

export const SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', pattern: '**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}' },
  { scheme: 'file', pattern: '**/*.html' },
];

const ENV_LABEL = { server: '$(server) server', client: '$(browser) client', both: '$(arrow-swap) client + server' };
const ENV_TEXT = { server: 'server', client: 'client', both: 'client + server' };
const BLOCK_BUILTINS = ['if', 'unless', 'each', 'with', 'let'];

export function registerProviders(ctx: vscode.ExtensionContext, indexer: WorkspaceIndexer) {
  const index = indexer.index;

  const target = (doc: vscode.TextDocument, pos: vscode.Position): Target | undefined => {
    indexer.syncDocument(doc);
    return targetAt(index, indexer.keyOf(doc.uri.fsPath), toPos(pos));
  };

  /** Index locations use real paths: map those in the current document back to its URI (it may be opened via a symlink). */
  const uriIn = (doc: vscode.TextDocument, l: Loc): vscode.Uri =>
    l.file === indexer.keyOf(doc.uri.fsPath) ? doc.uri : vscode.Uri.file(l.file);

  ctx.subscriptions.push(
    vscode.languages.registerDefinitionProvider(SELECTOR, {
      provideDefinition(doc, pos) {
        const t = target(doc, pos);
        if (!t) return undefined;
        return definitions(index, t).map(
          (d): vscode.LocationLink => ({
            originSelectionRange: toRange(t.loc),
            targetUri: uriIn(doc, d.loc),
            targetRange: toRange(d.full ?? d.loc),
            targetSelectionRange: toRange(d.loc),
          }),
        );
      },
    }),

    vscode.languages.registerReferenceProvider(SELECTOR, {
      provideReferences(doc, pos, context) {
        const t = target(doc, pos);
        if (!t) return undefined;
        return references(index, t, context.includeDeclaration).map((l) => new vscode.Location(uriIn(doc, l), toRange(l)));
      },
    }),

    vscode.languages.registerHoverProvider(SELECTOR, {
      provideHover(doc, pos) {
        const t = target(doc, pos);
        if (!t) return undefined;
        const md = hoverFor(t);
        return md ? new vscode.Hover(md, toRange(t.loc)) : undefined;
      },
    }),

    vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: (doc, pos) => complete(doc, pos) }, "'", '"', '`', '.', '/', '{', '>', '#', ' '),

    vscode.languages.registerWorkspaceSymbolProvider({ provideWorkspaceSymbols: (q) => workspaceSymbols(q) }),

    vscode.languages.registerDocumentSymbolProvider({ scheme: 'file', pattern: '**/*.html' }, {
      provideDocumentSymbols(doc) {
        indexer.syncDocument(doc);
        const f = index.facts(indexer.keyOf(doc.uri.fsPath));
        return (f?.templates ?? []).map(
          (t) => new vscode.DocumentSymbol(t.name, 'Blaze template', vscode.SymbolKind.Class, toRange(t.fullLoc), toRange(t.loc)),
        );
      },
    }),
  );

  // ----------------------------------------------------------------------------------------- hover

  function hoverFor(t: Target): vscode.MarkdownString | undefined {
    const a = index.a;
    const scope = index.scopeOf(t.loc.file);
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    const notIn = (missing: string[]) => `\n\n$(warning) Not defined in ${missing.length === 1 ? 'app' : 'apps'} ${appList(index, missing)}.`;
    switch (t.type) {
      case 'method':
      case 'publication': {
        const isMethod = t.type === 'method';
        const all = (isMethod ? a.methods : a.publications).get(t.name) ?? [];
        const defs = visible(index, scope, all);
        const uses = visible(index, scope, (isMethod ? a.calls : a.subscriptions).get(t.name)).length;
        if (!defs.length) {
          md.appendMarkdown(`**${isMethod ? 'Method' : 'Publication'}** \`${t.name}\`\n\n$(warning) No definition found in the workspace.`);
          if (all.length) md.appendMarkdown(` Defined only in other apps: ${all.map((d) => fileLink(d.loc)).join(', ')}`);
          return md;
        }
        for (const d of defs) appendDef(md, d);
        md.appendMarkdown(`\n\n${uses} ${isMethod ? (uses === 1 ? 'call' : 'calls') : uses === 1 ? 'subscription' : 'subscriptions'} in the workspace`);
        if (hasConflict(index, defs.map((d) => d.loc))) md.appendMarkdown(`\n\n$(warning) Defined ${defs.length} times.`);
        const missing = index.missingApps(scope, all.map((d) => d.loc.file));
        if (missing.length) md.appendMarkdown(notIn(missing));
        return md;
      }
      case 'template': {
        const html = templateHtmlDefs(index, t.name, scope);
        const js = templateJsDefs(index, t.name, scope);
        md.appendMarkdown(`**Template** \`${t.name}\`\n\n`);
        if (html.length) md.appendMarkdown(`$(code) HTML: ${html.map((h) => fileLink(h.loc)).join(', ')}\n\n`);
        else md.appendMarkdown(`$(warning) No \`<template name="${t.name}">\` found\n\n`);
        const jsFiles = [...new Map(js.map((p) => [p.loc.file, p.loc])).values()];
        if (jsFiles.length) md.appendMarkdown(`$(symbol-method) JS: ${jsFiles.map(fileLink).join(', ')}\n\n`);
        for (const l of templateLinks(index, t.name, scope)) md.appendMarkdown(`$(type-hierarchy-sub) \`${l.kind}('${l.other}')\`\n\n`);
        const helpers = helperNames(index, t.name, scope);
        if (helpers.length) md.appendMarkdown(`**Helpers:** ${helpers.map((h) => `\`${h}\``).join(' ')}\n\n`);
        const events = visible(index, scope, a.events.get(t.name));
        if (events.length) md.appendMarkdown(`**Events:** ${events.map((e) => `\`${e.name}\``).join(' ')}\n\n`);
        const usedIn = templateUsages(index, t.name, scope).length;
        md.appendMarkdown(`Used in ${usedIn} ${usedIn === 1 ? 'place' : 'places'}`);
        const files = templateFiles(index, t.name);
        const missing = index.missingApps(scope, files);
        if (files.length && missing.length) md.appendMarkdown(notIn(missing));
        return md;
      }
      case 'helper': {
        const defs = findHelper(index, t.template, t.name, scope);
        if (!defs.length) {
          if (t.isDef) return undefined;
          md.appendMarkdown(
            `\`${t.name}\`: no helper with this name in \`${t.template}\` or among the global helpers.\n\nProbably a data context field.`,
          );
          return md;
        }
        const owner = defs[0].template ?? null;
        const inherited = owner !== null && t.template !== null && owner !== t.template ? ` (inherited by \`${t.template}\`)` : '';
        md.appendMarkdown(`**${owner === null ? 'Global helper' : `Helper of \`${owner}\``}${inherited}** \`${t.name}\`\n\n`);
        for (const d of defs) appendMember(md, d);
        if (t.isDef) {
          const n = helperUsages(index, owner, t.name, scope).length;
          md.appendMarkdown(`\n\nUsed ${n} ${n === 1 ? 'time' : 'times'} in HTML`);
        }
        return md;
      }
      case 'event': {
        const n = eventTargets(index, t.template, t.name, scope).length;
        md.appendMarkdown(`**Event** \`${t.name}\` of \`${t.template}\`\n\n`);
        md.appendMarkdown(n ? `${n} matching ${n === 1 ? 'element' : 'elements'} in the HTML (Ctrl+Click to go there)` : `No element with this class/id found in the template HTML.`);
        return md;
      }
    }
  }

  function appendDef(md: vscode.MarkdownString, d: Named<MethodDef>) {
    const sig = `${d.isAsync ? 'async ' : ''}'${d.name}'(${d.params.join(', ')})`;
    md.appendCodeblock(sig, 'javascript');
    const kind = d.kind === 'validated' ? ' · ValidatedMethod' : '';
    const apps = appsLabel(index, d.loc.file);
    md.appendMarkdown(`${ENV_LABEL[d.env]}${kind}${apps ? ` · $(package) ${apps}` : ''} · ${fileLink(d.loc)}\n\n`);
    if (d.doc) md.appendMarkdown(d.doc + '\n\n');
  }

  function appendMember(md: vscode.MarkdownString, m: Member) {
    md.appendMarkdown(fileLink(m.loc) + '\n');
    md.appendCodeblock(m.snippet, 'javascript');
  }

  // ------------------------------------------------------------------------------------ completion

  function complete(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    indexer.syncDocument(doc);
    return doc.fileName.toLowerCase().endsWith('.html') ? completeHtml(doc, pos) : completeJs(doc, pos);
  }

  function completeJs(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const line = doc.lineAt(pos.line).text;
    const prefix = line.slice(0, pos.character);
    const a = index.a;
    const scope = index.scopeOf(indexer.keyOf(doc.uri.fsPath));

    const call = /(?:\bMeteor\s*\.\s*(call|callAsync|apply|applyAsync|subscribe)|\.\s*(subscribe))\s*\(\s*(['"`])([^'"`]*)$/.exec(prefix);
    if (call) {
      const isMethod = !!call[1] && call[1] !== 'subscribe';
      const typed = call[4];
      const quote = call[3];
      let endChar = pos.character;
      while (endChar < line.length && /[\w.\-/:]/.test(line[endChar])) endChar++;
      const range = new vscode.Range(pos.line, pos.character - typed.length, pos.line, endChar);
      const map = isMethod ? a.methods : a.publications;
      const items: vscode.CompletionItem[] = [];
      for (const [name, all] of map) {
        const d = visible(index, scope, all)[0];
        if (!d) continue;
        const item = new vscode.CompletionItem({ label: name, detail: `(${d.params.join(', ')})`, description: ENV_TEXT[d.env] }, isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Event);
        item.range = range;
        item.filterText = name;
        item.sortText = name;
        const md = new vscode.MarkdownString(undefined, true);
        appendDef(md, d);
        item.documentation = md;
        // close the string if the user has not typed the closing quote yet
        if (line[endChar] !== quote) item.insertText = name + quote;
        items.push(item);
      }
      return items;
    }

    const tpl = /\bTemplate\s*\.\s*([\w$]*)$/.exec(prefix);
    if (tpl) {
      const range = new vscode.Range(pos.line, pos.character - tpl[1].length, pos.line, pos.character);
      return templatesIn(index, scope).map((name) => {
        const item = new vscode.CompletionItem({ label: name, description: 'Blaze template' }, vscode.CompletionItemKind.Class);
        item.range = range;
        const html = templateHtmlDefs(index, name, scope)[0];
        if (html) item.detail = relPath(html.loc.file);
        return item;
      });
    }
    return undefined;
  }

  function completeHtml(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const offset = doc.offsetAt(pos);
    const text = doc.getText();
    const from = Math.max(0, offset - 3000);
    const before = text.slice(from, offset);
    const open = before.lastIndexOf('{{');
    if (open < 0 || before.indexOf('}}', open) >= 0) return undefined;
    const inner = before.slice(open + 2).replace(/^\{/, '');
    if (inner.startsWith('!')) return undefined;
    const a = index.a;
    const file = indexer.keyOf(doc.uri.fsPath);
    const scope = index.scopeOf(file);
    const word = /[\w$.\-]*$/.exec(inner)![0];
    const range = new vscode.Range(pos.translate(0, -word.length), pos);
    const items: vscode.CompletionItem[] = [];

    const templateItems = () => {
      for (const name of templatesIn(index, scope)) {
        const item = new vscode.CompletionItem({ label: name, description: 'template' }, vscode.CompletionItemKind.Class);
        item.range = range;
        const html = templateHtmlDefs(index, name, scope)[0];
        if (html) item.detail = relPath(html.loc.file);
        items.push(item);
      }
    };

    const helperItems = () => {
      const tpl = enclosingTemplate(index, file, toPos(pos));
      const seen = new Set<string>();
      // own helpers, then inherited ones (inheritsHelpersFrom…), then global ones
      for (const [i, t] of (tpl ? parentChain(index, tpl, 'helpers', scope) : []).entries()) {
        for (const [name, defs] of a.helpers.get(t) ?? []) {
          const d = visible(index, scope, defs)[0];
          if (!d || seen.has(name)) continue;
          seen.add(name);
          items.push(helperItem(name, d, i === 0 ? `helper of ${t}` : `inherited from ${t}`, i === 0 ? '0' : '1'));
        }
      }
      for (const [name, defs] of a.globalHelpers) {
        const d = visible(index, scope, defs)[0];
        if (d && !seen.has(name)) items.push(helperItem(name, d, 'global helper', '2'));
      }
    };

    const helperItem = (name: string, m: Member, description: string, sortPrefix: string) => {
      const item = new vscode.CompletionItem({ label: name, detail: m.params.length ? ` ${m.params.join(' ')}` : '', description }, vscode.CompletionItemKind.Function);
      item.range = range;
      item.sortText = sortPrefix + name;
      const md = new vscode.MarkdownString();
      appendMember(md, m);
      item.documentation = md;
      return item;
    };

    if (/^\s*>\s*[\w$.\-]*$/.test(inner)) {
      templateItems();
    } else if (/^\s*#\s*[\w$.\-]*$/.test(inner)) {
      for (const b of BLOCK_BUILTINS) {
        const item = new vscode.CompletionItem(b, vscode.CompletionItemKind.Keyword);
        item.range = range;
        items.push(item);
      }
      templateItems();
      helperItems();
    } else if (/^\s*\//.test(inner)) {
      return undefined;
    } else {
      helperItems();
    }
    return items;
  }

  // -------------------------------------------------------------------------------- workspace symbols

  function workspaceSymbols(query: string): vscode.SymbolInformation[] {
    const a = index.a;
    const q = query.toLowerCase();
    const matches = (name: string) => {
      if (!q) return true;
      const n = name.toLowerCase();
      let i = 0;
      for (const c of n) if (c === q[i]) i++;
      return i === q.length;
    };
    const out: vscode.SymbolInformation[] = [];
    const add = (name: string, kind: vscode.SymbolKind, container: string, l: Loc) => {
      if (matches(name)) out.push(new vscode.SymbolInformation(name, kind, container, toLocation(l)));
    };
    const inApp = (label: string, l: Loc) => {
      const apps = appsLabel(index, l.file);
      return apps ? `${label} · ${apps}` : label;
    };
    for (const [name, defs] of a.methods) for (const d of defs) add(name, vscode.SymbolKind.Method, inApp('Meteor method', d.loc), d.loc);
    for (const [name, defs] of a.publications) for (const d of defs) add(name, vscode.SymbolKind.Event, inApp('Meteor publication', d.loc), d.loc);
    for (const [name, defs] of a.templates) for (const d of defs) add(name, vscode.SymbolKind.Class, inApp('Blaze template', d.loc), d.loc);
    for (const [name, defs] of a.globalHelpers) for (const d of defs) add(name, vscode.SymbolKind.Function, inApp('Blaze global helper', d.loc), d.loc);
    return out.slice(0, 500);
  }
}

/** Helpers available in a template (own and inherited) in the scope. */
export function helperNames(index: MeteorIndex, template: string, scope: Scope): string[] {
  const out = new Set<string>();
  for (const t of parentChain(index, template, 'helpers', scope)) {
    for (const [name, defs] of index.a.helpers.get(t) ?? []) if (visible(index, scope, defs).length) out.add(name);
  }
  return [...out];
}

/** Template names existing in the apps of the scope. */
export function templatesIn(index: MeteorIndex, scope: Scope): string[] {
  const names = [...index.a.templateNames];
  return scope ? names.filter((n) => templateFiles(index, n).some((f) => index.inScope(scope, f))) : names;
}

// ------------------------------------------------------------------------------------------- CodeLens

export class MeteorCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly indexer: WorkspaceIndexer) {
    indexer.onDidChange(() => this.emitter.fire());
  }

  refresh() {
    this.emitter.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('meteorPower').get<boolean>('codeLens.enabled', true)) return [];
    this.indexer.syncDocument(doc);
    const index = this.indexer.index;
    const f = index.facts(this.indexer.keyOf(doc.uri.fsPath));
    if (!f) return [];
    const a = index.a;
    const scope = index.scopeOf(f.file);
    const lenses: vscode.CodeLens[] = [];

    const refsLens = (at: Loc, locs: Loc[], singular: string, plural: string) => {
      const range = toRange(at);
      const title = `${locs.length} ${locs.length === 1 ? singular : plural}`;
      lenses.push(
        new vscode.CodeLens(range, {
          title,
          command: locs.length ? 'editor.action.showReferences' : '',
          arguments: locs.length ? [doc.uri, range.start, locs.map(toLocation)] : undefined,
        }),
      );
    };

    for (const d of f.methods) {
      const name = a.resolve(d);
      if (name !== undefined) refsLens(d.loc, visible(index, scope, a.calls.get(name)).map((c) => c.loc), 'call', 'calls');
    }
    for (const d of f.publications) {
      const name = a.resolve(d);
      if (name !== undefined) refsLens(d.loc, visible(index, scope, a.subscriptions.get(name)).map((c) => c.loc), 'subscription', 'subscriptions');
    }

    // JS: one "→ HTML" lens per template per file
    const seen = new Set<string>();
    for (const p of f.templateParts) {
      if (seen.has(p.template)) continue;
      seen.add(p.template);
      const html = templateHtmlDefs(index, p.template, scope)[0];
      const range = toRange(p.nameLoc);
      if (html) lenses.push(new vscode.CodeLens(range, { title: '$(code) HTML', command: 'meteorPower.openLocation', arguments: [html.loc] }));
      refsLens(p.nameLoc, templateUsages(index, p.template, scope), 'use', 'uses');
    }

    // HTML: on each <template name="x">
    for (const t of f.templates) {
      const parts = templateJsDefs(index, t.name, scope);
      const helpers = helperNames(index, t.name, scope).length;
      const events = visible(index, scope, a.events.get(t.name)).length;
      const range = toRange(t.loc);
      if (parts.length) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(symbol-method) JS · ${helpers} ${helpers === 1 ? 'helper' : 'helpers'} · ${events} ${events === 1 ? 'event' : 'events'}`,
            command: 'meteorPower.openJs',
            arguments: [t.name],
          }),
        );
      } else {
        lenses.push(new vscode.CodeLens(range, { title: 'no JS', command: '' }));
      }
      refsLens(t.loc, templateUsages(index, t.name, scope), 'use', 'uses');
    }
    return lenses;
  }
}

// ---------------------------------------------------------------------------------------- Diagnostics

export class MeteorDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('meteorPower');

  constructor(private readonly indexer: WorkspaceIndexer) {}

  refresh() {
    this.collection.clear();
    const cfg = vscode.workspace.getConfiguration('meteorPower');
    if (!cfg.get<boolean>('diagnostics.enabled', true)) return;
    const severity = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      information: vscode.DiagnosticSeverity.Information,
      hint: vscode.DiagnosticSeverity.Hint,
    }[cfg.get<string>('diagnostics.severity', 'warning')] ?? vscode.DiagnosticSeverity.Warning;
    const opts = {
      ignoreMethods: cfg.get<string[]>('diagnostics.ignoreMethods', []),
      ignorePublications: cfg.get<string[]>('diagnostics.ignorePublications', []),
      ignoreTemplates: cfg.get<string[]>('diagnostics.ignoreTemplates', []),
    };
    const index = this.indexer.index;
    for (const f of index.allFacts()) {
      if (!f.calls.length && !f.subscriptions.length && !f.htmlUsages.length) continue;
      const list = problems(index, f.file, opts).map((p) => {
        const d = new vscode.Diagnostic(toRange(p.loc), p.message, severity);
        d.source = 'Meteor Power';
        d.code = p.code;
        return d;
      });
      if (list.length) this.collection.set(vscode.Uri.file(f.file), list);
    }
  }

  dispose() {
    this.collection.dispose();
  }
}
