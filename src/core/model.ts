export interface Pos {
  line: number;
  character: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export interface Loc {
  file: string;
  range: Range;
}

/** Where a piece of code runs, guessed from the folder (server/, client/) or an enclosing `if (Meteor.isServer)`. */
export type Env = 'server' | 'client' | 'both';

/**
 * A Meteor name (method, publication) as written in the code: either a literal (`name`) or a reference to a
 * constant (`nameExpr`, e.g. `USERS_METHODS.RESET`) that is resolved later against the whole workspace.
 */
export interface NameSource {
  name?: string;
  nameExpr?: string;
  /**
   * How the name is written at `loc`, which decides how to rename it:
   * `string` → the text inside quotes, `ident` → an identifier (object key, `Template.foo`),
   * `expr` → a reference to a constant (the constant's string is renamed instead).
   */
  nameKind: NameKind;
}

export type NameKind = 'string' | 'ident' | 'expr';

export interface MethodDef extends NameSource {
  kind: 'method' | 'validated' | 'publication';
  /** The name itself (object key or string literal). */
  loc: Loc;
  /** The whole definition. */
  fullLoc: Loc;
  params: string[];
  isAsync: boolean;
  env: Env;
  doc?: string;
  snippet: string;
}

export interface CallSite extends NameSource {
  /** `callAsync`, `call`, `subscribe`, ... */
  fn: string;
  loc: Loc;
  env: Env;
  lineText: string;
}

export interface Member {
  name: string;
  nameKind: NameKind;
  loc: Loc;
  fullLoc: Loc;
  params: string[];
  isAsync: boolean;
  snippet: string;
  doc?: string;
}

export type TemplatePartKind = 'helpers' | 'events' | 'onCreated' | 'onRendered' | 'onDestroyed';

/** A `Template.foo.helpers({...})`, `Template.foo.events({...})`, `Template.foo.onCreated(...)` call. */
export interface TemplatePart {
  template: string;
  kind: TemplatePartKind;
  /** The `foo` in `Template.foo`. */
  nameLoc: Loc;
  fullLoc: Loc;
  members: Member[];
}

/**
 * aldeed:template-extension calls linking two templates: `Template.foo.inheritsHelpersFrom('bar')`,
 * `inheritsEventsFrom`, `inheritsHooksFrom`, `Template.foo.replaces('bar')`, `Template.foo.copyAs('bar')`.
 */
export type TemplateLinkKind = 'inheritsHelpersFrom' | 'inheritsEventsFrom' | 'inheritsHooksFrom' | 'replaces' | 'copyAs';

export interface TemplateLink {
  /** The `foo` in `Template.foo`. */
  template: string;
  kind: TemplateLinkKind;
  /** The template named in the argument (`bar`). */
  other: string;
  nameLoc: Loc;
  /** Inside the quotes of `'bar'`. */
  otherLoc: Loc;
  fullLoc: Loc;
}

/** Any reference to a template from JS: `Template.foo`, `BlazeLayout.render('foo', { main: 'bar' })`. */
export interface TemplateRef {
  template: string;
  nameKind: NameKind;
  loc: Loc;
  lineText: string;
}

/** `<template name="foo">...</template>` */
export interface TemplateHtml {
  name: string;
  loc: Loc;
  fullLoc: Loc;
}

export type HtmlUsageKind = 'helper' | 'inclusion' | 'block';

/** A name used inside a Spacebars tag: `{{foo}}`, `{{> foo}}`, `{{#foo}}`. */
export interface HtmlUsage {
  template: string;
  name: string;
  /** The full path as written, e.g. `user.profile.name`. */
  path: string;
  kind: HtmlUsageKind;
  loc: Loc;
  lineText: string;
  /** True when the name is a local variable (`{{#each item in items}}`, `{{#let x=...}}`). */
  local: boolean;
}

/** `{{/foo}}`: the end of a block, renamed together with `{{#foo}}`. */
export interface HtmlClose {
  template: string;
  name: string;
  loc: Loc;
}

/** A class or id attribute value inside a template, used to link event maps to the HTML. */
export interface HtmlMark {
  template: string;
  kind: 'class' | 'id';
  name: string;
  loc: Loc;
}

export interface FileFacts {
  file: string;
  methods: MethodDef[];
  publications: MethodDef[];
  calls: CallSite[];
  subscriptions: CallSite[];
  /** String constants declared at top level: `X` and flattened objects `X.Y.Z`. */
  constants: Record<string, string>;
  /** `export default` as constants: `''` for a string, `Y.Z` for an object; resolved by file path. */
  defaultExport: Record<string, string>;
  /** Where each constant / default export string is written (text inside the quotes), for renaming. */
  constantLocs: Record<string, Loc>;
  defaultExportLocs: Record<string, Loc>;
  templateParts: TemplatePart[];
  templateRefs: TemplateRef[];
  templateLinks: TemplateLink[];
  globalHelpers: Member[];
  templates: TemplateHtml[];
  htmlUsages: HtmlUsage[];
  htmlMarks: HtmlMark[];
  htmlCloses: HtmlClose[];
}

export function emptyFacts(file: string): FileFacts {
  return {
    file,
    methods: [],
    publications: [],
    calls: [],
    subscriptions: [],
    constants: {},
    defaultExport: {},
    constantLocs: {},
    defaultExportLocs: {},
    templateParts: [],
    templateRefs: [],
    templateLinks: [],
    globalHelpers: [],
    templates: [],
    htmlUsages: [],
    htmlMarks: [],
    htmlCloses: [],
  };
}
