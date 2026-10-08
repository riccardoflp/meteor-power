# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-08

### Added

- **Meteor methods**: go to definition, find references, hover and completion for `Meteor.call`, `callAsync`, `apply`, `applyAsync` and `ValidatedMethod`
- **Publications**: navigation between `Meteor.subscribe` / `this.subscribe` and `Meteor.publish` (string and object form)
- Method and publication names written as constants are resolved across files (`USERS_METHODS.RESET`, namespace imports, TypeScript enums, `Object.freeze`)
- **Blaze**: go to definition from `{{helper}}` to template or global helpers, from `{{> template}}` / `{{#template}}` / `Template.dynamic` to `<template name>`, between `Template.x` and the HTML, and from event map selectors to the matching HTML elements
- Completion of helpers inside `{{ }}` and of template names after `{{>`
- **Alt+O** switches between the HTML and the JS of the current template
- CodeLens with call counts on methods and publications, and HTML/JS links on templates
- Diagnostics for calls to unknown methods, publications and templates, with configurable ignore lists
- Side panel with methods grouped by namespace, publications, and templates in hierarchical (inclusion tree) or flat view
- Workspace symbols (Ctrl+T) for methods, publications, templates and global helpers
- Files reachable through symlinked folders (e.g. shared imports linked into several apps) are indexed once, under their real path
- Settings for your own wrapper functions that define or call methods and publications (`meteorPower.methods.defineFunctions`, `callFunctions`, `meteorPower.publications.defineFunctions`, `subscribeFunctions`)
- Constant names are also resolved through `import { X as Y }`, default imports (`import NAMES from './names'`) and destructuring (`const { RESET } = USERS_METHODS`)
- `public/` is excluded from indexing by default (static files, not Blaze)
- Files are parsed on worker threads, using several cores without blocking the extension host; minified bundles are skipped
- **Meteor Power: Show Log** shows how long indexing took, the slowest files and the heaviest folders
- **Rename (F2)** of methods, publications, templates and helpers across JS and HTML; names coming from constants are renamed in the constant
- **Several Meteor apps in one workspace**: every folder with `.meteor/release` is an app, and definitions, references, completion, diagnostics, CodeLens and rename are resolved inside the app(s) of the current file
  - shared code symlinked into several apps belongs to all of them; diagnostics report names missing in some of those apps
  - local packages belong to the apps using them in `.meteor/packages` (also through other local packages)
  - constants with the same name are resolved per app
  - side panel filter to show a single app
- `meteorPower.packageDirs` (and `METEOR_PACKAGE_DIRS`) to index local packages outside the workspace
- Calls through **ValidatedMethod objects** (`insertTask.call()`, `callAsync`, `callPromise`, `_execute`, namespace and aliased imports, `Meteor.callAsync(insertTask.name)`) are linked to the method: Ctrl+Click, references, CodeLens, hover and diagnostics
- **aldeed:template-extension**: `inheritsHelpersFrom`, `inheritsEventsFrom`, `replaces` and `copyAs` are followed by definitions, references, completion, rename and the side panel
