import * as vscode from 'vscode';
import { Named } from '../core/index';
import { Loc, Member, MethodDef } from '../core/model';
import {
  definitions,
  enclosingTemplate,
  eventTargets,
  findHelper,
  helperUsages,
  problems,
  references,
  Target,
  targetAt,
  templateUsages,
} from '../core/queries';
import { fileLink, relPath, toLocation, toPos, toRange } from './convert';
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
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    switch (t.type) {
      case 'method':
      case 'publication': {
        const isMethod = t.type === 'method';
        const defs = (isMethod ? a.methods : a.publications).get(t.name) ?? [];
        const uses = (isMethod ? a.calls : a.subscriptions).get(t.name)?.length ?? 0;
        if (!defs.length) {
          md.appendMarkdown(`**${isMethod ? 'Method' : 'Publication'}** \`${t.name}\`\n\n$(warning) No definition found in the workspace.`);
          return md;
        }
        for (const d of defs) appendDef(md, d);
        md.appendMarkdown(`\n\n${uses} ${isMethod ? (uses === 1 ? 'call' : 'calls') : uses === 1 ? 'subscription' : 'subscriptions'} in the workspace`);
        if (defs.length > 1) md.appendMarkdown(`\n\n$(warning) Defined ${defs.length} times.`);
        return md;
      }
      case 'template': {
        const html = a.templates.get(t.name) ?? [];
        const parts = a.parts.get(t.name) ?? [];
        md.appendMarkdown(`**Template** \`${t.name}\`\n\n`);
        if (html.length) md.appendMarkdown(`$(code) HTML: ${html.map((h) => fileLink(h.loc)).join(', ')}\n\n`);
        else md.appendMarkdown(`$(warning) No \`<template name="${t.name}">\` found\n\n`);
        const jsFiles = [...new Map(parts.map((p) => [p.nameLoc.file, p.nameLoc])).values()];
        if (jsFiles.length) md.appendMarkdown(`$(symbol-method) JS: ${jsFiles.map(fileLink).join(', ')}\n\n`);
        const helpers = [...(a.helpers.get(t.name)?.keys() ?? [])];
        if (helpers.length) md.appendMarkdown(`**Helpers:** ${helpers.map((h) => `\`${h}\``).join(' ')}\n\n`);
        const events = a.events.get(t.name) ?? [];
        if (events.length) md.appendMarkdown(`**Events:** ${events.map((e) => `\`${e.name}\``).join(' ')}\n\n`);
        const usedIn = templateUsages(a, t.name).length;
        md.appendMarkdown(`Used in ${usedIn} ${usedIn === 1 ? 'place' : 'places'}`);
        return md;
      }
      case 'helper': {
        const defs = findHelper(a, t.template, t.name);
        if (!defs.length) {
          if (t.isDef) return undefined;
          md.appendMarkdown(
            `\`${t.name}\`: no helper with this name in \`${t.template}\` or among the global helpers.\n\nProbably a data context field.`,
          );
          return md;
        }
        const isGlobal = t.template === null || !a.helpers.get(t.template)?.get(t.name)?.length;
        md.appendMarkdown(`**${isGlobal ? 'Global helper' : `Helper of \`${t.template}\``}** \`${t.name}\`\n\n`);
        for (const d of defs) appendMember(md, d);
        if (t.isDef) {
          const n = helperUsages(a, isGlobal ? null : t.template, t.name).length;
          md.appendMarkdown(`\n\nUsed ${n} ${n === 1 ? 'time' : 'times'} in HTML`);
        }
        return md;
      }
      case 'event': {
        const n = eventTargets(a, t.template, t.name).length;
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
    md.appendMarkdown(`${ENV_LABEL[d.env]}${kind} · ${fileLink(d.loc)}\n\n`);
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

    const call = /(?:\bMeteor\s*\.\s*(call|callAsync|apply|applyAsync|subscribe)|\.\s*(subscribe))\s*\(\s*(['"`])([^'"`]*)$/.exec(prefix);
    if (call) {
      const isMethod = !!call[1] && call[1] !== 'subscribe';
      const typed = call[4];
      const quote = call[3];
      let endChar = pos.character;
      while (endChar < line.length && /[\w.\-/:]/.test(line[endChar])) endChar++;
      const range = new vscode.Range(pos.line, pos.character - typed.length, pos.line, endChar);
      const map = isMethod ? a.methods : a.publications;
      return [...map.entries()].map(([name, defs]) => {
        const d = defs[0];
        const item = new vscode.CompletionItem({ label: name, detail: `(${d.params.join(', ')})`, description: ENV_TEXT[d.env] }, isMethod ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Event);
        item.range = range;
        item.filterText = name;
        item.sortText = name;
        const md = new vscode.MarkdownString(undefined, true);
        appendDef(md, d);
        item.documentation = md;
        // close the string if the user has not typed the closing quote yet
        if (line[endChar] !== quote) item.insertText = name + quote;
        return item;
      });
    }

    const tpl = /\bTemplate\s*\.\s*([\w$]*)$/.exec(prefix);
    if (tpl) {
      const range = new vscode.Range(pos.line, pos.character - tpl[1].length, pos.line, pos.character);
      return [...a.templateNames].map((name) => {
        const item = new vscode.CompletionItem({ label: name, description: 'Blaze template' }, vscode.CompletionItemKind.Class);
        item.range = range;
        const html = a.templates.get(name)?.[0];
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
    const word = /[\w$.\-]*$/.exec(inner)![0];
    const range = new vscode.Range(pos.translate(0, -word.length), pos);
    const items: vscode.CompletionItem[] = [];

    const templateItems = () => {
      for (const name of a.templateNames) {
        const item = new vscode.CompletionItem({ label: name, description: 'template' }, vscode.CompletionItemKind.Class);
        item.range = range;
        const html = a.templates.get(name)?.[0];
        if (html) item.detail = relPath(html.loc.file);
        items.push(item);
      }
    };

    const helperItems = () => {
      const tpl = enclosingTemplate(index, indexer.keyOf(doc.uri.fsPath), toPos(pos));
      const own = tpl ? a.helpers.get(tpl) : undefined;
      for (const [name, defs] of own ?? []) items.push(helperItem(name, defs[0], `helper of ${tpl}`, '0'));
      for (const [name, defs] of a.globalHelpers) if (!own?.has(name)) items.push(helperItem(name, defs[0], 'global helper', '1'));
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
    for (const [name, defs] of a.methods) for (const d of defs) add(name, vscode.SymbolKind.Method, 'Meteor method', d.loc);
    for (const [name, defs] of a.publications) for (const d of defs) add(name, vscode.SymbolKind.Event, 'Meteor publication', d.loc);
    for (const [name, defs] of a.templates) for (const d of defs) add(name, vscode.SymbolKind.Class, 'Blaze template', d.loc);
    for (const [name, defs] of a.globalHelpers) for (const d of defs) add(name, vscode.SymbolKind.Function, 'Blaze global helper', d.loc);
    return out.slice(0, 500);
  }
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
      if (name !== undefined) refsLens(d.loc, (a.calls.get(name) ?? []).map((c) => c.loc), 'call', 'calls');
    }
    for (const d of f.publications) {
      const name = a.resolve(d);
      if (name !== undefined) refsLens(d.loc, (a.subscriptions.get(name) ?? []).map((c) => c.loc), 'subscription', 'subscriptions');
    }

    // JS: one "→ HTML" lens per template per file
    const seen = new Set<string>();
    for (const p of f.templateParts) {
      if (seen.has(p.template)) continue;
      seen.add(p.template);
      const html = a.templates.get(p.template)?.[0];
      const range = toRange(p.nameLoc);
      if (html) lenses.push(new vscode.CodeLens(range, { title: '$(code) HTML', command: 'meteorPower.openLocation', arguments: [html.loc] }));
      refsLens(p.nameLoc, templateUsages(a, p.template), 'use', 'uses');
    }

    // HTML: on each <template name="x">
    for (const t of f.templates) {
      const parts = a.parts.get(t.name) ?? [];
      const helpers = a.helpers.get(t.name)?.size ?? 0;
      const events = a.events.get(t.name)?.length ?? 0;
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
      refsLens(t.loc, templateUsages(a, t.name), 'use', 'uses');
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
