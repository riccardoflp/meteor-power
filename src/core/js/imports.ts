// Imports and aliases: what the local names of a file refer to, and the identity of modules.
import * as path from 'path';
import type * as t from '@babel/types';
import { exprPath, forEachNode, literalKey, unwrap } from './ast';
import { FileState } from './state';

const JS_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;

/**
 * Normalized identity of an imported module, used to find its `export default`:
 * relative imports become absolute paths, Meteor absolute imports (`/imports/x`) are kept as a path suffix.
 * Packages (`meteor/...`, npm) are ignored.
 */
export function moduleHint(file: string, spec: string): string | undefined {
  let hint: string;
  if (spec.startsWith('.')) hint = path.posix.join(path.posix.dirname(file.replace(/\\/g, '/')), spec);
  else if (spec.startsWith('/')) hint = spec;
  else return undefined;
  return hint.replace(JS_EXT, '').replace(/\/$/, '').toLowerCase();
}

/** Same normalization for the exporting file. */
export function moduleId(file: string): string {
  return file.replace(/\\/g, '/').replace(JS_EXT, '').toLowerCase();
}

/** Fills `imported` and `aliases`: import specifiers, destructuring and plain re-assignments. */
export function collectAliases(st: FileState, program: t.Program) {
  for (const stmt of program.body) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
    const spec = stmt.source.value;
    for (const sp of stmt.specifiers ?? []) {
      const local = sp.local?.name;
      if (!local) continue;
      st.imported.add(local);
      if (sp.type === 'ImportNamespaceSpecifier') st.aliases.set(local, '');
      else if (sp.type === 'ImportDefaultSpecifier') {
        const hint = moduleHint(st.file, spec);
        if (hint) st.aliases.set(local, `@default(${hint})`);
      } else if (sp.type === 'ImportSpecifier') {
        const importedName = sp.imported?.type === 'Identifier' ? sp.imported.name : sp.imported?.value;
        if (importedName === 'default') {
          const hint = moduleHint(st.file, spec);
          if (hint) st.aliases.set(local, `@default(${hint})`);
        } else if (importedName && importedName !== local) st.aliases.set(local, importedName);
      }
    }
  }
  // destructuring and plain re-assignments, anywhere in the file
  forEachNode(program, (n) => {
    if (n.type !== 'VariableDeclarator' || !n.init) return;
    const from = exprPath(unwrap(n.init));
    if (!from) return;
    if (n.id.type === 'Identifier') {
      if (n.id.name !== from) st.aliases.set(n.id.name, from);
    } else if (n.id.type === 'ObjectPattern') {
      for (const p of n.id.properties) {
        if (p.type !== 'ObjectProperty' || p.computed) continue;
        const key = literalKey(p.key);
        const value = p.value?.type === 'AssignmentPattern' ? p.value.left : p.value;
        if (key !== undefined && value?.type === 'Identifier') st.aliases.set(value.name, `${from}.${key}`);
      }
    }
  });
}
