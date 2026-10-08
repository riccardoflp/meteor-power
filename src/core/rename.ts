import { MeteorIndex, Scope } from './index';
import { Loc, NameSource } from './model';
import { findHelper, helperOwner, helperUsages, Target, visible } from './queries';

export interface TextEdit {
  loc: Loc;
  newText: string;
}

export type RenameResult = { edits: TextEdit[] } | { error: string };

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The current name of a renameable target, or why it cannot be renamed. */
export function renameInfo(t: Target): { name: string } | { error: string } {
  if (t.type === 'event') return { error: 'Event selectors cannot be renamed.' };
  return { name: t.name };
}

/**
 * The apps a rename applies to. With several Meteor apps, a name used in app A only is renamed in A
 * (and in the shared code A uses); shared code using the name ties together every app it belongs to.
 */
function renameScope(index: MeteorIndex, t: Target): Scope {
  if (!index.isMultiApp) return null;
  const a = index.a;
  let files: string[] = [];
  switch (t.type) {
    case 'method':
      files = [...(a.methods.get(t.name) ?? []), ...(a.calls.get(t.name) ?? [])].map((x) => x.loc.file);
      break;
    case 'publication':
      files = [...(a.publications.get(t.name) ?? []), ...(a.subscriptions.get(t.name) ?? [])].map((x) => x.loc.file);
      break;
    case 'template':
      files = [...(a.templates.get(t.name) ?? []), ...(a.inclusions.get(t.name) ?? []), ...(a.templateRefs.get(t.name) ?? [])].map((x) => x.loc.file);
      break;
    case 'helper':
      // shared HTML using the helper ties together the apps defining it
      files = findHelper(index, t.template, t.name, index.scopeOf(t.loc.file)).map((d) => d.loc.file);
      for (const list of a.usagesByTemplate.values()) for (const u of list) if (u.name === t.name) files.push(u.loc.file);
      break;
  }
  return index.closure(t.loc.file, files);
}

/** An error message for an invalid new name, `undefined` when it is fine. */
export function validateNewName(index: MeteorIndex, t: Target, newName: string, scope = renameScope(index, t)): string | undefined {
  const a = index.a;
  const name = newName.trim();
  if (t.type === 'event') return 'Event selectors cannot be renamed.';
  if (!name) return 'The name cannot be empty.';
  if (name === t.name) return undefined;
  switch (t.type) {
    case 'method':
    case 'publication':
      if (/['"`\\\r\n]/.test(name)) return 'The name cannot contain quotes, backslashes or line breaks.';
      if (visible(index, scope, (t.type === 'method' ? a.methods : a.publications).get(name)).length) return `A ${t.type} named '${name}' already exists.`;
      return undefined;
    case 'template': {
      if (!IDENT.test(name)) return 'Template names must be valid identifiers (letters, digits, _ and $).';
      const exists = [...(a.templates.get(name) ?? []).map((d) => d.loc), ...(a.parts.get(name) ?? []).map((p) => p.nameLoc), ...(a.copies.get(name) ?? []).map((l) => l.otherLoc)];
      if (exists.some((l) => index.inScope(scope, l.file))) return `A template named '${name}' already exists.`;
      return undefined;
    }
    case 'helper': {
      if (!IDENT.test(name)) return 'Helper names must be valid identifiers (letters, digits, _ and $).';
      const owner = helperOwner(index, t.template, t.name, index.scopeOf(t.loc.file));
      if (owner === undefined) return undefined;
      const taken = owner === null ? visible(index, scope, a.globalHelpers.get(name)) : visible(index, scope, a.helpers.get(owner)?.get(name));
      if (taken.length) return `A ${owner === null ? 'global helper' : `helper of '${owner}'`} named '${name}' already exists.`;
      return undefined;
    }
  }
}

/** All the text edits needed to rename a method, publication, template or helper everywhere. */
export function renameEdits(index: MeteorIndex, t: Target, newName: string): RenameResult {
  const scope = renameScope(index, t);
  const invalid = validateNewName(index, t, newName, scope);
  if (invalid) return { error: invalid };
  const name = newName.trim();
  const a = index.a;
  const edits: TextEdit[] = [];
  let error: string | undefined;
  const inScope = (l: Loc) => index.inScope(scope, l.file);

  /** One occurrence of the old name, written as a string, an identifier or a constant reference. */
  const rename = (o: NameSource & { loc: Loc }) => {
    if (o.nameKind === 'expr') {
      const locs = a.constantLocs(o, o.loc.file);
      if (!locs.length) error ??= `Cannot find the constant '${o.nameExpr}' that defines this name.`;
      for (const loc of locs) edits.push({ loc, newText: name });
    } else if (o.nameKind === 'ident') {
      edits.push({ loc: o.loc, newText: IDENT.test(name) ? name : `'${name}'` });
    } else {
      edits.push({ loc: o.loc, newText: name });
    }
  };
  const raw = (loc: Loc) => edits.push({ loc, newText: name });

  switch (t.type) {
    case 'method':
    case 'publication': {
      const defs = visible(index, scope, (t.type === 'method' ? a.methods : a.publications).get(t.name));
      const uses = visible(index, scope, (t.type === 'method' ? a.calls : a.subscriptions).get(t.name));
      for (const o of [...defs, ...uses]) rename(o);
      break;
    }
    case 'template': {
      for (const d of visible(index, scope, a.templates.get(t.name))) raw(d.loc);
      for (const u of visible(index, scope, a.inclusions.get(t.name))) raw(u.loc);
      for (const list of a.closes.values()) for (const c of list) if (c.name === t.name && inScope(c.loc)) raw(c.loc);
      // `Template.x` (identifier) and `Template['x']` / `BlazeLayout.render('x')` / `inheritsHelpersFrom('x')` (strings)
      for (const r of visible(index, scope, a.templateRefs.get(t.name))) rename({ ...r, name: r.template });
      break;
    }
    case 'helper': {
      const defs = findHelper(index, t.template, t.name, scope ?? index.scopeOf(t.loc.file));
      if (!defs.length) return { error: `No helper '${t.name}' is defined: it is probably a data context field.` };
      const owner = defs[0].template ?? null;
      for (const d of defs) {
        if (d.nameKind === 'expr') return { error: `The helper '${t.name}' is registered through a constant: rename the constant instead.` };
        rename(d);
      }
      for (const loc of helperUsages(index, owner, t.name, scope)) raw(loc);
      // `{{/blockHelper}}`, where `{{#blockHelper}}` resolves to the same definition
      if (!a.templateNames.has(t.name)) {
        for (const [tpl, list] of a.closes) {
          for (const c of list) {
            if (c.name === t.name && inScope(c.loc) && helperOwner(index, tpl, t.name, index.scopeOf(c.loc.file)) === owner) raw(c.loc);
          }
        }
      }
      break;
    }
  }
  if (error) return { error };
  return { edits: dedupe(edits) };
}

function dedupe(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const { start, end } = e.loc.range;
    const k = `${e.loc.file}:${start.line}:${start.character}:${end.line}:${end.character}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
