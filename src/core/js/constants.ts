// Name constants (`export const METHODS = { UPDATE: 'users.update' }`, enums, `export default`) and the object
// maps of methods that another file may register (`export const methods = { 'a.b'() {} }`).
import type * as t from '@babel/types';
import { Loc, MethodDef, own } from '../model';
import { fnOf, literalKey, MaybeNode, staticString, unwrap } from './ast';
import { docOf, makeDef } from './defs';
import { assignedDefs } from './flow';
import { keyName, objectRef } from './names';
import { FileState, innerLoc } from './state';

/** Top-level string constants, object literals and enums, and the default export. */
export function collectTopLevel(st: FileState, program: t.Program) {
  const { facts } = st;
  for (const stmt of program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (!decl) continue;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id?.type !== 'Identifier' || !d.init) continue;
        const init = unwrap(d.init);
        const s = staticString(init);
        if (s !== undefined) {
          facts.constants[d.id.name] = s;
          facts.constantLocs[d.id.name] = innerLoc(st, init);
        }
        else if (init.type === 'ObjectExpression') {
          st.objects.set(d.id.name, init);
          flattenObject(st, d.id.name, init, 0);
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      collectDefaultExport(st, unwrap(stmt.declaration));
    } else if (decl.type === 'TSEnumDeclaration') {
      for (const m of decl.members ?? decl.body?.members ?? []) {
        const key = m.id?.type === 'Identifier' ? m.id.name : m.id?.value;
        const init = m.initializer;
        const s = init ? staticString(init) : undefined;
        if (key && init && s !== undefined) {
          facts.constants[`${decl.id.name}.${key}`] = s;
          facts.constantLocs[`${decl.id.name}.${key}`] = innerLoc(st, init);
        }
      }
    }
  }
}

function collectDefaultExport(st: FileState, node: MaybeNode) {
  if (!node) return;
  const { facts } = st;
  const s = staticString(node);
  if (s !== undefined) {
    facts.defaultExport[''] = s;
    facts.defaultExportLocs[''] = innerLoc(st, node);
    return;
  }
  if (node.type === 'ObjectExpression') {
    const tmp: Record<string, string> = {};
    const tmpLocs: Record<string, Loc> = {};
    flattenObject(st, '', node, 0, tmp, tmpLocs);
    for (const [k, v] of Object.entries(tmp)) {
      facts.defaultExport[k.slice(1)] = v;
      facts.defaultExportLocs[k.slice(1)] = tmpLocs[k];
    }
    return;
  }
  // `const X = {...}; export default X;`
  if (node.type === 'Identifier') {
    const prefix = node.name;
    if (own(facts.constants, prefix) !== undefined) {
      facts.defaultExport[''] = facts.constants[prefix];
      facts.defaultExportLocs[''] = facts.constantLocs[prefix];
    }
    for (const [k, v] of Object.entries(facts.constants)) {
      if (!k.startsWith(prefix + '.')) continue;
      facts.defaultExport[k.slice(prefix.length + 1)] = v;
      facts.defaultExportLocs[k.slice(prefix.length + 1)] = facts.constantLocs[k];
    }
  }
}

/** The string values of a (nested) object literal, as `prefix.key.subkey` constants. */
function flattenObject(
  st: FileState,
  prefix: string,
  obj: t.ObjectExpression,
  depth: number,
  out: Record<string, string> = st.facts.constants,
  outLocs: Record<string, Loc> = st.facts.constantLocs,
) {
  if (depth > 4) return;
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty' || p.computed) continue;
    const key = literalKey(p.key);
    if (key === undefined) continue;
    const v = unwrap(p.value);
    const s = staticString(v);
    if (s !== undefined) {
      out[`${prefix}.${key}`] = s;
      outLocs[`${prefix}.${key}`] = innerLoc(st, v);
    } else if (v.type === 'ObjectExpression') flattenObject(st, `${prefix}.${key}`, v, depth + 1, out, outLocs);
  }
}

/** Top-level object literals with functions or spreads, which another file may register with `Meteor.methods`. */
export function collectObjectMaps(st: FileState, program: t.Program) {
  for (const stmt of program.body) {
    if (stmt.type === 'ExportDefaultDeclaration') {
      const d = unwrap(stmt.declaration);
      const obj = d?.type === 'ObjectExpression' ? d : d?.type === 'Identifier' ? st.objects.get(d.name) : undefined;
      if (obj) addObjectMap(st, '@default', obj, d.type === 'Identifier' ? d.name : undefined);
      continue;
    }
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) if (d.id?.type === 'Identifier' && st.objects.has(d.id.name)) addObjectMap(st, d.id.name, st.objects.get(d.id.name)!);
    }
    // export { a as b }
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.source) {
      for (const sp of stmt.specifiers ?? []) {
        const local = sp.type === 'ExportSpecifier' ? sp.local?.name : undefined;
        const exported = sp.exported?.type === 'Identifier' ? sp.exported.name : sp.exported?.value;
        if (!local || !exported || local === exported || !st.objects.has(local)) continue;
        if (exported === 'default') addObjectMap(st, '@default', st.objects.get(local)!, local);
        else addObjectMap(st, exported, st.objects.get(local)!, local);
      }
    }
  }
}

/** `localName`: the variable holding the object, whose later `obj[key] = fn` are members too. */
function addObjectMap(st: FileState, name: string, obj: t.ObjectExpression, localName: string | undefined = name === '@default' ? undefined : name) {
  const env = st.fileEnv ?? 'both';
  const members: MethodDef[] = localName ? assignedDefs(st, localName, obj, 'method', env, undefined, false) : [];
  const spreads: string[] = [];
  for (const p of obj.properties) {
    if (p.type === 'SpreadElement') {
      const arg = unwrap(p.argument);
      const ref = arg?.type === 'Identifier' && st.objects.has(arg.name) ? arg.name : arg && objectRef(st, arg);
      if (ref) spreads.push(ref);
      continue;
    }
    const fn = p.type === 'ObjectMethod' ? p : fnOf(p.value);
    const n = fn && keyName(st, p);
    if (n) members.push(makeDef(st, n, 'method', fn, p, env, docOf(p)));
  }
  if (members.length || spreads.length) st.facts.objectMaps[name] = { members, spreads };
}
