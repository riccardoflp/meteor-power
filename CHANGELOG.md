# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Files reachable through symlinked folders (e.g. shared imports linked into several apps) are indexed once, under their real path, instead of once per link: no more duplicated methods, publications and templates

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
