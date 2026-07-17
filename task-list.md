# Task List: Architecture Rules

Vier additive Features für `packages/core`, abgeleitet aus dem Bau zweier realer
Blueprints (hexagonal + vertical-slice) in einem Nx/Angular-Monorepo. Jeder Punkt
markiert eine Stelle, an der wir **gegen** das Werkzeug arbeiten mussten.

**Vorgehen:** Tests zuerst (rot), Implementierung danach durch einen separaten Agenten.
Alle Tasks sind unabhängig; Reihenfolge = Priorität.

**Rahmen** (aus `agents.md` + `CONTRIBUTING.md`):
- Zero-Dependency-Policy — kein Vorschlag hier braucht ein neues Paket.
- 100 % Unit-Test-Abdeckung, Integration-Tests, JSDoc für public members, Doku-Update.
- Conventional Commits, Scope `core` / `eslint-plugin` / `docs` / `test-projects`.
- `yarn lint:all`, `yarn test`, `yarn build:all` und `run-integration-tests.sh` müssen grün sein.
- **v1 ist raus** → alles strikt additiv, keine Breaking Changes.

**Baseline vor Beginn:** 352 Tests grün, 43 Dateien (`npx vitest run --config vitest.config.ts`, ~4s).

**Zwei Vorbilder aus der Historie:**

- `0488bdc` (`feat: provide catch-all function to process dep rule (#246)`) — der schlanke Fall,
  nur `DependencyRulesConfig`/`DependencyCheckContext`: 4 Dateien
  (`checks/check-for-dependency-rule-violation.ts`, `checks/is-dependency-allowed.ts`, dessen Spec,
  `config/dependency-rules-config.ts`). Keine Doku, kein Integration-Test — nur eine große Spec-Erweiterung.
  ⚠️ `7a33e36` war der Folge-Fix dazu („restore RuleMatcherFn intersection type") — **Änderungen an
  `RuleMatcherFn` sind historisch die Stelle, an der es kaputtging.**
- `cd468a1` (`feat: add ignoreFileExtensions option (#228)`) — **das Vorbild für eine neue Config-Option**,
  21 Dateien, +599/−33. Strukturell identisch zu Task 1–4.

### Kanonische Reihenfolge für eine additive Config-Option (aus `cd468a1`)

1. `config/user-sheriff-config.ts` — neues optionales Member + JSDoc mit `@example`
2. `config/configuration.ts` — Narrowing-Override im `& {}`-Intersection, falls der aufgelöste Typ abweicht
3. `config/default-config.ts` — Default-Wert (**Pflicht**, s. Falle 3)
4. `config/parse-config.ts` — Validierung (`UserError` werfen) und/oder Normalisierung
5. ggf. neues Geschwister-Modul für Konstanten/Logik
6. Consumer-Verdrahtung — **als expliziter Parameter durchreichen, nicht global lesen**
7. `test/project-creator.ts` — Serialisierung, falls der Wert Funktion/RegExp sein kann (s. Falle 2)
8. Tests: `config/tests/parse-config.spec.ts` + Consumer-Spec
9. **`parse-config.spec.ts`: `Object.keys()`-Liste und Default-`toEqual` anpassen** (s. Falle 1)
10. `sheriff.full-spec.ts`, falls sich eine Call-Signatur ändert
11. Integration: `test-projects/angular-iv/` (s.u.)
12. Docs: `configuration.md` + `release-notes/0.20.md` + `release-notes/index.md`

---

## ⚠️ Fallen — vom Test-Agenten VOR dem ersten Test zu lesen

Diese vier haben nichts mit den Features zu tun; sie sind Eigenheiten der Codebasis, die
still fehlschlagen.

**Falle 1 — `parse-config.spec.ts` hat zwei brüchige Ganz-Config-Assertions.**
Der Test `'should the sheriff config'` prüft die **exakte, geordnete** `Object.keys()`-Liste von
`Configuration`; `'should set default values'` ein vollständiges `toEqual({...})`. **Jeder neue
Key in `defaultConfig` bricht beide.** Das Anpassen ist selbst ein legitimer roter Test —
also bewusst mit anfassen, nicht als Kollateralschaden.

**Falle 2 — `test/project-creator.ts` kann keine beliebigen Funktionen serialisieren.**
Es serialisiert `depRules`-Funktionen über `α…ω`-Marker und `encapsulationPattern`-RegExp über
`Δ…Δ`. Ein `sheriffConfig({ denyRules: { 'x': () => true } })` erzeugt **stillschweigend eine
kaputte Config-Datei**, solange `project-creator.ts` nicht erweitert ist. `cd468a1` musste dort
+18 Zeilen ergänzen. **Betrifft Task 1 und 2 direkt.**

**Falle 3 — `Configuration = Required<Omit<UserSheriffConfig, …>>`.**
Ein optionales User-Feld wird intern **required**. Fehlt der Eintrag in `defaultConfig`, ist das
ein Compile-Fehler, kein Testfehler. Weicht der aufgelöste Typ vom User-Typ ab (User: `A | B`,
intern: `A`), gehört ein Override in die `& {}`-Intersection — Präzedenz: `ignoreFileExtensions`.

**Falle 4 — `createAssertsForConfig` reicht `fromTags` NICHT durch.**
Der Helfer setzt nur `toTags`; `fromTags` bleibt `[]`. Tests, die `fromTags` brauchen, rufen
`isDependencyAllowed` direkt mit vollem `createMockDependencyCheckContext({ fromTags, toTags })`
auf — genau das macht der `describe('fromTags and toTags')`-Block. **Betrifft Task 1.**

**Nicht in `*.full-spec.ts` schreiben** — läuft nur in CI (`vitest.config.ci.ts`) und braucht
gebaute Pakete.

### Test-Konventionen (verbindlich)

- Explizite vitest-Imports: `import { describe, expect, test, it } from 'vitest';` — keine Globals.
- `import '../../test/expect.extensions';` in jeder Spec, die `toThrowUserError` o.ä. nutzt
  (steht zwar in `setupFiles`, wird aber überall re-importiert — spiegeln).
- Unit-Tests unter `src/lib/<area>/tests/*.spec.ts`.
- Lokale Factory-Helfer (`createAssertsForConfig`, `assertProject`) werden **in der Spec-Datei**
  definiert, nicht geteilt.
- Fake-Projektbaum: `testInit('src/main.ts', { 'tsconfig.json': tsConfig(), 'sheriff.config.ts':
  sheriffConfig({...}), src: {...} })` — Vorbild: `checks/tests/encapsulation-barrel-less.spec.ts`.
- Config-**Parsing** dagegen testet man mit `getFs().writeFile('sheriff.config.ts', \`…roher TS-String…\`)`
  — Vorbild: `config/tests/parse-config.spec.ts`.
- Neue `UserError`-Klassen brauchen einen eindeutigen `code` und werden per
  `expect(() => …).toThrowUserError(new XError())` geprüft.

### Integration-Tests

`run-integration-tests.sh` rsynct `test-projects/` in ein temporäres Verzeichnis und fährt
`angular-i`, `angular-iv`, `typescript-i`. **`test-projects/angular-iv` ist das Ziel** (Angular 18,
Flat Config, dort landete auch `ignoreFileExtensions`).

Muster (Golden-File-Diff): violierende Datei + Varianten-Config aus `tests/` einspielen →
`npx ng lint --force --format json --output-file tests/actual/<name>.json` →
`../remove-paths.mjs` → `diff actual expected` → Original zurück. `set -e` lässt jeden Diff fehlschlagen.

Praktisch für uns: `angular-iv` hat bereits **`customers/api`** mit eigenem Tag
(`'customers/api': ['type:api', 'domain:customers:api']`) — ein `customers/infra` daneben ist
eine kleine, natürliche Erweiterung.

⚠️ **Golden-Files (`tests/expected/*.json`) NICHT von Hand schreiben** — sie entstehen aus einem
echten Lauf. Das ist Aufgabe des **Impl-Agenten** (grün), nicht des Test-Agenten (rot).
Integration-Tests brauchen zudem `yarn link:sheriff` (Build + yalc).

---

## Kontext: Zwei davon stehen schon auf der Roadmap

`docs/docs/roadmap.md` listet unter *Future plans*:

- **"Excluding third-party libraries: Exclude third-party libraries to be used in modules"**
  → das ist **Task 2** (`externalRules`). Geplant, aber ohne Design. Höchste Chance auf Upstream-Merge.
- **"decorators @private/@public"** (unter Barrel-less, ☑️ offen)
  → verwandt mit **Task 3**, anderer Mechanismus. Task 3 sollte sich dazu verhalten.

**Task 1 (`denyRules`) und Task 4 (Multi-Config) stehen NICHT auf der Roadmap.** Sie brauchen
mehr Begründung — die Evidenz unten ist deshalb Teil der Task, nicht Beiwerk.

---

## Task 1 — `denyRules`: Regeln, die einschränken können

**Priorität: hoch.** Wurzelproblem; Task 3 und Teile von Task 1's Workarounds sind Symptome.

### Problem

`depRules`-Keys können nur **erlauben**. `isDependencyAllowed` iteriert **jeden** Key, dessen
Wildcard auf den `from`-Tag passt, und verknüpft die Ergebnisse mit ODER — das erste
`return true` gewinnt. Kein "spezifischster Key gewinnt".

Das ist **beabsichtigt und getestet** — siehe `is-dependency-allowed.spec.ts:176`
*"should run multiple checks, if tag is configured multiple times"*:

```ts
'domain:*': ({ from, to }) => from === to,     // verbietet cross-domain
'domain:bookings': 'domain:customers:api',     // erlaubt — und gewinnt
```

Konsequenz: **Ein Modul mit mehreren Tags kann nie enger werden, nur weiter.** Jeder
zusätzliche Tag bringt seine eigenen — erlaubenden — Keys mit und ist damit ein potenzielles
Schlupfloch.

### Evidenz aus der Praxis

`noDependencies` auf einem Domain-Kern war **wirkungslos**: Ein Modul mit
`['domain:booking', 'type:domain']` durfte `shared` importieren. `type:domain` verbot es,
aber `domain:booking` matchte die `'*'`-Regel und gewann. Gemessen gegen die echte Engine,
bevor Code existierte.

Zwei Config-Umbauten waren nötig, um es zu umschiffen:
1. `'*'`-Catch-all komplett streichen; `shared`-Erlaubnis auf die Type-Achse verlagern.
2. Eine künstliche Scope-Achse `core:<slice>` einführen — deren einziger Zweck ist, dass die
   permissive `domain:*`-Regel den Kern nicht erreicht.

Beide Workarounds existieren nur, weil man nicht *verbieten* kann.

### Vorgeschlagene API (additiv)

```ts
// user-sheriff-config.ts
/**
 * Rules that FORBID dependencies. A matching denyRule always wins over any
 * depRules match — deny beats allow, regardless of key order.
 *
 * Use this when a tag must restrict, not widen: `depRules` keys are OR-combined,
 * so a module carrying several tags can only ever gain clearance, never lose it.
 */
denyRules?: DependencyRulesConfig;
```

Semantik:
- Wird **nach** `depRules` ausgewertet: erlaubt `depRules` den Import und matcht eine
  `denyRule` → **verboten**.
- Matcht keine `denyRule` → Ergebnis von `depRules` bleibt.
- `denyRules` allein macht nichts erlaubt (kein implizites allow).
- Kein `NoDependencyRuleForTagError` für `denyRules` — ein Tag ohne deny-Regel ist normal.

Beispiel — der Kern wird zum Dreizeiler statt zur Achsen-Akrobatik:

```ts
denyRules: {
  'type:domain': ({ to }) => to !== 'type:domain',
}
```

### Outcome

- `denyRules` ist optional in `SheriffConfig`; bestehende Configs verhalten sich **bit-identisch**.
- Ein `denyRule`-Treffer erzeugt eine Violation, auch wenn `depRules` erlaubt.
- Fehlermeldung nennt die deny-Regel als Ursache (unterscheidbar von "keine Clearance").
- `docs/docs/dependency-rules.md`: neue Sektion + die OR-Semantik erstmals erklärt (s. Task 5).

### Verifikation

```bash
yarn vitest run -t "denyRules"                    # neue Unit-Tests grün
npx vitest run --config vitest.config.ts          # 352 Alt-Tests weiterhin grün
./run-integration-tests.sh
```

Manuell — der Beweis, dass das Wurzelproblem weg ist:
```ts
// diese Config MUSS den Import blocken, obwohl '*' ihn erlaubt
modules: { 'src/domain': ['domain:booking', 'type:domain'], 'src/shared': ['shared'] }
depRules: { '*': 'shared', 'type:domain': 'type:domain', 'domain:*': 'shared' }
denyRules: { 'type:domain': ({ to }) => to !== 'type:domain' }
// -> src/domain darf src/shared NICHT importieren
```

**Mutationsprobe (Pflicht):** `denyRules` aus der Config entfernen → derselbe Test muss rot
werden. Sonst testet er die Regel nicht.

### Betroffene Dateien

- `packages/core/src/lib/config/user-sheriff-config.ts` (Option + JSDoc)
- `packages/core/src/lib/config/parse-config.ts` (durchreichen)
- `packages/core/src/lib/config/default-config.ts` (Default `{}`)
- `packages/core/src/lib/checks/is-dependency-allowed.ts` **oder** neu `is-dependency-denied.ts`
- `packages/core/src/lib/checks/check-for-dependency-rule-violation.ts` (Aufruf + Violation-Grund)
- `packages/core/src/lib/config/configuration.ts` (interner Typ)
- Tests: `checks/tests/` + `config/tests/`
- `docs/docs/dependency-rules.md`, `docs/docs/configuration.md`

---

## Task 2 — `externalRules`: Regeln für node_modules-Imports

**Priorität: hoch.** Steht als *"Excluding third-party libraries"* auf der Roadmap.

### Problem

Sheriffs Regeln gelten für **Modul-zu-Modul**. `import { Injectable } from '@angular/core'`
landet in `node_modules` und fällt komplett aus dem Tag-System. Für eine
"Der-Kern-kennt-kein-Framework"-Regel — den Kern jeder hexagonalen Architektur — ist das
genau die falsche Lücke.

### Evidenz aus der Praxis

Musste `no-restricted-imports` in ESLint nachrüsten. Dabei: **meine eigene Absicherung feuerte
nicht** — projekt-relatives Glob, Nx lintet vom Root. Die Regel war reine Dekoration, bis ich
sie geprobt habe. Im zweiten Blueprint ist dieselbe Lücke bis heute offen: gemessen, dass
`@angular/core` in einem `type:types`-Modul grün durchläuft.

**Die Daten liegen bereits vor.** `UnassignedFileInfo` pflegt `#externalLibraries`,
`sheriff export` gibt sie aus:

```json
"apps/hexagonal-demo/src/main.ts": {
  "tags": ["root"],
  "externalLibraries": ["@angular/platform-browser"]   // erfasst, nie geprüft
}
```

Sie werden nur nie gegen Regeln gehalten. Das ist Anzapfen vorhandener Daten, kein Neubau.

### Vorgeschlagene API (additiv)

```ts
/**
 * Rules for imports from node_modules (external libraries). Keys are matched
 * against the importing module's tags; values are wildcard patterns matched
 * against the package name.
 *
 * A tag without an entry is unrestricted — external imports stay allowed by
 * default, so existing projects are unaffected.
 */
externalRules?: Record<string, string[] | ExternalRuleMatcherFn>;
```

```ts
externalRules: {
  'type:domain': [],                      // Kern: keine externen Deps
  'type:api': ['@angular/core'],          // Ports: nur DI-Token
  'type:infra': ['@angular/*', 'rxjs'],   // Adapter: darf alles
}
```

Offene Design-Fragen (der Impl-Agent soll sie **entscheiden und begründen**, nicht offenlassen):
- Matching auf Package-Name (`@angular/core`) oder auch Subpath (`@angular/core/testing`)?
  → Vorschlag: Wildcard über den vollen Import-String, konsistent mit `wildcardToRegex`.
- Semantik bei mehreren Tags: AND (jeder Tag muss erlauben) — konsistent mit `fromTags`-Semantik
  in `check-for-dependency-rule-violation.ts`.
- `[]` = nichts erlaubt vs. fehlender Key = alles erlaubt. Muss dokumentiert sein.

### Outcome

- Ein `import` aus `node_modules`, das gegen `externalRules` verstößt, erzeugt eine Violation
  über CLI **und** ESLint-Plugin.
- Ohne `externalRules` in der Config: null Verhaltensänderung.
- Sheriff braucht keinen zweiten Linter mehr für "Kern ohne Framework".

### Verifikation

```bash
yarn vitest run -t "externalRules"
npx vitest run --config vitest.config.ts     # Alt-Tests grün
./run-integration-tests.sh
```

Integration: ein test-project mit `import { Injectable } from '@angular/core'` in einem
Modul mit `externalRules: { 'type:domain': [] }` → muss violaten. Gegenprobe: derselbe Import
in `type:infra` mit `['@angular/*']` → grün.

### Betroffene Dateien

- `packages/core/src/lib/config/user-sheriff-config.ts`, `parse-config.ts`, `default-config.ts`
- `packages/core/src/lib/checks/` — neu, z.B. `check-for-external-rule-violation.ts`
- `packages/core/src/lib/file-info/unassigned-file-info.ts` (`externalLibraries` bereits da — nur lesen)
- Verdrahtung in CLI-`verify` und `packages/eslint-plugin/src/lib/rules/dependency-rule.ts`
  (oder neue Rule `external-rule` — **Entscheidung begründen**)
- `docs/docs/configuration.md`, `docs/docs/dependency-rules.md`, `roadmap.md` (Haken setzen)

---

## Task 3 — Sichtbarkeit unterhalb der Ordner-Ebene

**Priorität: mittel.** Verwandt mit dem Roadmap-Punkt *"decorators @private/@public"*.

### Problem

Ein Modul ist ein Ordner; Tags hängen am Ordner. Zwei Dateien im selben Ordner sind für
Sheriff ununterscheidbar. Modulinterne Importe werden **nie** geprüft
(`check-for-dependency-rule-violation.ts`: `.filter(fi => fi.moduleInfo.path !== …)`).

### Evidenz aus der Praxis

Ziel: Ein Port soll **Contract** (Interface + Token) sein, die HTTP-Implementierung daneben
darf für niemanden sichtbar sein — auch nicht für den Contract selbst.

Beide naheliegenden Wege scheitern, gemessen:

| Variante | fremde Domain → Impl | Contract → eigene Impl | Slice-Root → Impl (Wiring) |
|---|---|---|---|
| **gewünscht** | blockt | **blockt** | **erlaubt** |
| beide Dateien in `api/` | ❌ erlaubt | ❌ erlaubt | ✓ |
| `api/internal/` | ✓ blockt | ❌ **erlaubt** (modulintern!) | ❌ **blockt** |
| eigener Ordner `infra/` + Tag | ✓ | ✓ | ✓ |

`internal/` regelt **Sichtbarkeit nach außen**. Gebraucht wird **Kopplungsrichtung nach
innen**. Zwei verschiedene Fragen — Kapselung beantwortet nur die erste.

Ergebnis: ein `infra/`-Ordner, den es fachlich nicht bräuchte. Er existiert **nur**, damit
ein Tag daran hängen kann.

### Vorgeschlagener Ansatz

```ts
'domains/<domain>/api': {
  tags: ['type:api', 'port'],
  exports: ['*.port.ts'],      // nur diese Dateien sind von außen importierbar
}
```

Die positive Form von `internal/`: statt "alles außer diesem Ordner" ein "genau das hier".

**Wichtig — erst entscheiden, dann bauen:** Die Roadmap nennt `@private`/`@public`-Decorators
für dasselbe Problemfeld. Der Impl-Agent muss die beiden Ansätze gegeneinander abwägen und
die Wahl begründen (Decorators wirken pro Symbol, `exports` pro Datei; letzteres ist statisch
billiger und braucht keinen AST-Durchgriff auf Symbolebene).

⚠️ `ModuleConfig` erlaubt heute `TagConfigValue | ModuleConfig` pro Key. Ein Objekt mit
`tags`/`exports` kollidiert potenziell mit dem verschachtelten `ModuleConfig`-Fall. Der
Impl-Agent muss zuerst prüfen, ob das eindeutig unterscheidbar ist (`SingleTag`/`MultiTags`
in `module-config.ts` deuten auf eine bereits angedachte Objekt-Form hin) — falls nicht, ist
ein anderer Schlüsselname nötig. **Diese Prüfung ist Teil der Task.**

### Outcome

- Ein Modul kann deklarieren, welche Dateien öffentlich sind.
- Import einer nicht-exportierten Datei von außerhalb → `encapsulation`-Violation.
- Ohne `exports`: unverändert (alles öffentlich außer `internal/`).

### Verifikation

```bash
yarn vitest run -t "exports"
npx vitest run --config vitest.config.ts
./run-integration-tests.sh
```

Integration: Modul mit `exports: ['*.port.ts']`; Import von `http-x.ts` von außen → violation,
Import von `x.port.ts` → grün.

### Betroffene Dateien

- `packages/core/src/lib/config/module-config.ts` (Typ — **Kollision prüfen!**)
- `packages/core/src/lib/config/parse-config.ts`
- `packages/core/src/lib/checks/has-encapsulation-violations.ts`
- `packages/core/src/lib/modules/` (Modul-Erkennung)
- `docs/docs/module_boundaries.md`, `docs/docs/configuration.md`

---

## Task 4 — Mehrere Configs pro Workspace

**Priorität: mittel–niedrig.** Nicht auf der Roadmap. Eingriffstiefster Punkt.

### Problem

```ts
// packages/core/src/lib/config/find-config.ts — vollständig
export const findConfig = (rootDir: FsPath): FsPath | undefined => {
  const configFilePath = fs.join(rootDir, 'sheriff.config.ts');
  return fs.exists(configFilePath) ? configFilePath : undefined;
};
```

Kein Hochlaufen, keine "nächstgelegene gewinnt"-Logik. `rootDir` kommt aus der nächsten
`tsconfig.json` — im Nx-Monorepo also fast immer der Repo-Root. **Ein Workspace, eine Config.**

### Evidenz aus der Praxis

Der Plan sah einen zweiten Blueprint **neben** dem bestehenden vor — technisch unmöglich.
`apps/hexagonal-demo/sheriff.config.ts` wurde nie gelesen; der Code wurde stillschweigend von
der fremden Root-Config bewertet, mit deren Vokabular. Aufgefallen nur, weil `sheriff list`
falsche Tags zeigte. Lösung war ein separater git-Worktree — für zwei Architekturen in einem
Repo gibt es keine.

Realistisch für Monorepos, in denen ein Team hexagonal und eines vertikal schneidet.

### Vorgeschlagener Ansatz

Zwei Optionen — **der Impl-Agent wählt und begründet**:

**A) "Nächstgelegene Config gewinnt"** (Muster von ESLint, tsconfig, Prettier):
`findConfig` läuft vom File aufwärts bis `rootDir`. Intuitiv, aber ändert das Verhalten
bestehender Setups, sobald jemand eine zweite Config anlegt → **potenziell breaking**, v1 beachten.

**B) `configs`-Feld in der Root-Config** (explizit, additiv, nicht-breaking):
```ts
export const config: SheriffConfig = {
  configs: {
    'apps/hexagonal-demo': './apps/hexagonal-demo/sheriff.config.ts',
  },
  modules: { /* … */ },
  depRules: { /* … */ },
};
```

**Empfehlung: B.** v1 ist raus; A würde die Semantik existierender Workspaces still ändern.

### Outcome

- Zwei Architekturen in einem Workspace, jede mit eigenem Vokabular.
- Bestehende Single-Config-Setups: unverändert.
- `sheriff list`/`verify` zeigen, **welche** Config je Datei galt (sonst debuggt man blind —
  genau daran habe ich Stunden verloren).

### Verifikation

```bash
yarn vitest run -t "config resolution"
npx vitest run --config vitest.config.ts
./run-integration-tests.sh
```

Integration: test-project mit zwei Configs; eine Datei unter `apps/a` mit Tags aus Config A,
eine unter `apps/b` aus Config B. `sheriff list` muss je Datei die richtigen Tags zeigen.

### Betroffene Dateien

- `packages/core/src/lib/config/find-config.ts`
- `packages/core/src/lib/main/init.ts` (`getConfig(tsData.rootDir)`)
- `packages/core/src/lib/config/user-sheriff-config.ts`
- CLI-Ausgabe (`list`, `verify`)
- `docs/docs/configuration.md`

---

## Task 5 — Doku: die OR-Semantik erklären

**Priorität: hoch. Aufwand: minimal.** Kein Code.

### Problem

Die wichtigste Design-Entscheidung der Engine — **alle passenden `depRules`-Keys werden
ausgewertet und OR-verknüpft, erster Treffer gewinnt** — steht **nirgends in der Doku**.
Geprüft: `docs/docs/dependency-rules.md` erwähnt weder "multiple", "first match" noch "order".
Sie existiert nur als Unit-Test (`is-dependency-allowed.spec.ts:176`).

Genau diese Lücke hat mich zwei Config-Umbauten gekostet. Wer eine mehrachsige Config baut,
läuft hinein.

### Outcome

`docs/docs/dependency-rules.md` erklärt:
1. Mehrere Keys können auf denselben `from`-Tag matchen → **alle** werden ausgewertet, OR.
2. **Source-Tags dagegen sind AND** (`check-for-dependency-rule-violation.ts`: Schleife über
   `fromTags`), Target-Tags sind ANY. Der Kontrast ist der Kern und muss explizit dastehen.
3. Konsequenz: Ein permissiver `'*'`-Key hebelt restriktivere Regeln aus, weil er über einen
   *anderen* Tag greift. Mit Beispiel.
4. Verweis auf `denyRules` (Task 1) als Lösung, sobald vorhanden.

### Wo genau

`docs/docs/dependency-rules.md` hat bereits die Sektion **`## depRules Functions & Wildcards`**
(aktuell Zeile 366) — dort gehört es hin, als Unterabschnitt. Die vorhandenen Sektionen sind:
`Introduction` (7), `Automatic Tagging` (118), `The root Tag` (164), `Manual Tagging` (219),
`Nested Paths` (292), `Placeholders` (321), `depRules Functions & Wildcards` (366).

Zusätzlich: `docs/docs/configuration.md` folgt dem Muster „eine Sektion pro Option mit Anker"
(`### \`entryFile\` {#entryfile}` usw.) — neue Optionen aus Task 1/2/4 dort in derselben Form.

### Verifikation

Review durch einen Menschen; `yarn build:all` (Docusaurus baut).
Prüffrage: Erklärt die Seite, warum `noDependencies` bei einem Modul mit zwei Tags
wirkungslos sein kann? Wenn nein → Task nicht erfüllt.

---

## Nice-to-have — `is-dependency-allowed.ts` lesbarer machen

Kein eigener Task, aber Teil von Task 1, da dort ohnehin angefasst:

```ts
let isAllowed: boolean | undefined;
// … Schleife über alle passenden Keys …
      isAllowed = false;          // wird gesetzt …
  }
  if (isAllowed === undefined) throw new NoDependencyRuleForTagError(from);
  return false;                   // … und hier ignoriert. Nicht `return isAllowed`.
```

Funktional identisch (an der Stelle *ist* `isAllowed` immer `false`), aber die Variable
existiert nur noch, um den "kein-Key-passt"-Fehler auszulösen. Ein `return isAllowed ?? false`
plus ein Kommentar *"erster Treffer gewinnt; Keys sind OR-verknüpft"* dokumentiert die
wichtigste Entscheidung der Engine dort, wo sie fällt.

---

## Für den Implementierungs-Agenten: wo du anfängst

Die Tests sind **vor** der Implementierung geschrieben und **rot**. Das ist Absicht, kein Defekt.

1. `npx vitest run --config vitest.config.ts` — die roten Tests sind deine Spezifikation.
   Was sie behaupten, ist verbindlicher als die Prosa oben.
2. Ein roter Test soll grün werden, **weil das Feature funktioniert** — nicht weil du den Test
   angepasst hast. Test ändern ist erlaubt, wenn er nachweislich falsch ist; dann aber
   **begründen**, nicht stillschweigend.
3. Die Typen und `defaultConfig`-Einträge sind ggf. schon da (der Test-Agent musste sie anlegen,
   sonst kompiliert nichts — Falle 3). **Verhalten ist keins implementiert.**
4. Golden-Files für Integration-Tests erzeugst **du** aus einem echten Lauf, nicht von Hand.
5. Nach jedem Task: die 352 Alt-Tests müssen grün bleiben. Wenn nicht, ist es eine Regression —
   kein „passt schon".

**Mutationsprobe ist Teil jedes Tasks**, nicht optional: Feature/Regel wieder entfernen, prüfen
dass der zugehörige Test rot wird, wieder einbauen. Ein Test, der auch ohne das Feature grün ist,
testet nichts. (Wir haben das in der Praxis gebraucht — ein Import-Guard war monatelang reine
Dekoration, weil ihn nie jemand geprobt hat.)

---

## Definition of Done (pro Task)

- [ ] Alle neuen Tests grün, **alle 352 Alt-Tests weiterhin grün**
- [ ] Mutationsprobe: Regel/Feature entfernen → zugehöriger Test wird rot
- [ ] `yarn lint:all`, `yarn test`, `yarn build:all` grün
- [ ] `./run-integration-tests.sh` grün
- [ ] JSDoc an jedem neuen public member
- [ ] Doku aktualisiert (`configuration.md` + betroffene Seite; `roadmap.md` bei Task 2)
- [ ] Conventional Commit, Scope `core` (bzw. `docs`), atomar
- [ ] Bestehende Configs ohne die neue Option: **bit-identisches Verhalten**
