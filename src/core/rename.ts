import { Aggregate, MeteorIndex } from './index';
import { Loc, NameSource } from './model';
import { findHelper, helperUsages, Target } from './queries';

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

/** An error message for an invalid new name, `undefined` when it is fine. */
export function validateNewName(index: MeteorIndex, t: Target, newName: string): string | undefined {
  const a = index.a;
  const name = newName.trim();
  if (t.type === 'event') return 'Event selectors cannot be renamed.';
  if (!name) return 'The name cannot be empty.';
  if (name === t.name) return undefined;
  switch (t.type) {
    case 'method':
    case 'publication':
      if (/['"`\\\r\n]/.test(name)) return 'The name cannot contain quotes, backslashes or line breaks.';
      if ((t.type === 'method' ? a.methods : a.publications).has(name)) return `A ${t.type} named '${name}' already exists.`;
      return undefined;
    case 'template':
      if (!IDENT.test(name)) return 'Template names must be valid identifiers (letters, digits, _ and $).';
      if (a.templateNames.has(name)) return `A template named '${name}' already exists.`;
      return undefined;
    case 'helper': {
      if (!IDENT.test(name)) return 'Helper names must be valid identifiers (letters, digits, _ and $).';
      const isGlobal = isGlobalHelper(a, t.template, t.name);
      const taken = isGlobal ? a.globalHelpers.has(name) : !!a.helpers.get(t.template!)?.has(name);
      if (taken) return `A ${isGlobal ? 'global helper' : `helper of '${t.template}'`} named '${name}' already exists.`;
      return undefined;
    }
  }
}

/** All the text edits needed to rename a method, publication, template or helper everywhere. */
export function renameEdits(index: MeteorIndex, t: Target, newName: string): RenameResult {
  const invalid = validateNewName(index, t, newName);
  if (invalid) return { error: invalid };
  const name = newName.trim();
  const a = index.a;
  const edits: TextEdit[] = [];
  let error: string | undefined;

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
      const defs = (t.type === 'method' ? a.methods : a.publications).get(t.name) ?? [];
      const uses = (t.type === 'method' ? a.calls : a.subscriptions).get(t.name) ?? [];
      for (const o of [...defs, ...uses]) rename(o);
      break;
    }
    case 'template': {
      for (const d of a.templates.get(t.name) ?? []) raw(d.loc);
      for (const u of a.inclusions.get(t.name) ?? []) raw(u.loc);
      for (const list of a.closes.values()) for (const c of list) if (c.name === t.name) raw(c.loc);
      // `Template.x` (identifier) and `Template['x']` / `BlazeLayout.render('x')` (strings)
      for (const r of a.templateRefs.get(t.name) ?? []) rename({ ...r, name: r.template });
      break;
    }
    case 'helper': {
      const defs = findHelper(a, t.template, t.name);
      if (!defs.length) return { error: `No helper '${t.name}' is defined: it is probably a data context field.` };
      const isGlobal = isGlobalHelper(a, t.template, t.name);
      for (const d of defs) {
        if (d.nameKind === 'expr') return { error: `The helper '${t.name}' is registered through a constant: rename the constant instead.` };
        rename(d);
      }
      for (const loc of helperUsages(a, isGlobal ? null : t.template, t.name)) raw(loc);
      // `{{/blockHelper}}`
      if (!a.templateNames.has(t.name)) {
        for (const [tpl, list] of a.closes) {
          if (isGlobal ? a.helpers.get(tpl)?.has(t.name) : tpl !== t.template) continue;
          for (const c of list) if (c.name === t.name) raw(c.loc);
        }
      }
      break;
    }
  }
  if (error) return { error };
  return { edits: dedupe(edits) };
}

function isGlobalHelper(a: Aggregate, template: string | null, name: string): boolean {
  return template === null || !a.helpers.get(template)?.get(name)?.length;
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

