# MeteorPower

Estensione VS Code per navigare progetti **Meteor 3** e **Blaze** come se i nomi fossero simboli veri e non stringhe.

Indicizza tutto il workspace e collega i pezzi **per nome**, quindi funziona anche se HTML, JS, metodi e costanti stanno in cartelle diverse.

## Metodi e publication

| Dove | Cosa fa |
|---|---|
| `Meteor.call/callAsync/apply/applyAsync('nome')` | **Ctrl+Click / F12**: vai alla definizione in `Meteor.methods` o `new ValidatedMethod({ name })` |
| `Meteor.subscribe('nome')`, `this.subscribe(...)` | vai a `Meteor.publish('nome')` (anche nella forma a oggetto) |
| Sulla definizione | **Ctrl+Click / Shift+F12**: elenco di tutte le chiamate |
| Dentro la stringa | **autocompletamento** dei nomi con parametri e documentazione |
| Hover | firma, ambiente (server/client), file, JSDoc, numero di chiamate |
| CodeLens | `N chiamate` sopra ogni metodo, `N subscribe` sopra ogni publication |
| Diagnostica | warning su chiamate a metodi o publication inesistenti |

I nomi possono essere anche **costanti**, risolte in tutto il progetto:
`Meteor.callAsync(USERS_METHODS.RESET)`, `[USERS_METHODS.RESET]() {}`, `import * as C ...; C.USERS_METHODS.RESET`, enum TypeScript e `Object.freeze({...})`.

## Blaze

| Dove | Cosa fa |
|---|---|
| `{{helper}}` nell'HTML | vai a `Template.x.helpers({ helper })`, altrimenti a `Template.registerHelper('helper')` |
| `{{> nome}}`, `{{#nome}}`, `{{> Template.dynamic template="nome"}}` | vai a `<template name="nome">` |
| `<template name="x">` | vai al JS del template (helpers/events/onCreated…) |
| `Template.x` nel JS | vai all'HTML |
| `BlazeLayout.render('layout', { main: 'page' })` | vai ai template |
| Chiave di un event map `'click .js-save'` | vai agli elementi con quella classe/id nell'HTML |
| Sulla definizione di un helper | trova dove è usato nell'HTML |
| Dentro `{{ }}` | autocompletamento degli helper del template corrente e di quelli globali; dopo `{{>` dei template |
| **Alt+O** | passa dall'HTML al JS del template (e viceversa) |

Le variabili locali (`{{#each item in items}}`, `{{#let}}`) e i campi del data context non vengono segnalati come errori.

## Pannello laterale

Icona MeteorPower nella Activity Bar:

- **Metodi**: albero per namespace (`users.profile.save` → users › profile › save), con ambiente, numero di chiamate e la lista dei punti in cui sono chiamati. Un gruppo a parte raccoglie le chiamate a metodi non definiti.
- **Publication**: stessa struttura, con le subscribe.
- **Template**:
  - vista **gerarchica**, cioè l'albero delle inclusioni `{{> …}}`
  - vista **piatta**
  - per ogni template: helper, eventi, lifecycle; pulsanti per aprire HTML o JS; gruppo degli helper globali

Comandi rapidi (Ctrl+Shift+P): *MeteorPower: Vai al metodo… / alla publication… / al template…*.
Anche **Ctrl+T** trova metodi, publication e template.

## Impostazioni

- `meteorpower.include` / `meteorpower.exclude`: quali file indicizzare.
- `meteorpower.diagnostics.enabled`, `meteorpower.diagnostics.severity`: attiva le segnalazioni e ne sceglie la gravità.
- `meteorpower.diagnostics.ignoreMethods` / `ignorePublications` / `ignoreTemplates`: nomi forniti da pacchetti, da non segnalare. Supportano `*`, es. `"accounts.*"`.
- `meteorpower.codeLens.enabled`: mostra o nasconde i CodeLens.

## Sviluppo

```bash
npm install
npm test                  # test unitari sul core (parser + indice)
npm run test:integration  # test dentro VS Code (usa il VS Code installato)
npm run package           # crea meteorpower-<versione>.vsix
```

Per provarla in debug: apri questa cartella in VS Code e premi **F5**.
