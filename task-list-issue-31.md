# Task List: Issue #31 — Vier stille Enforcement-Lücken

Abgeleitet aus [Issue #31](https://github.com/lambda-solutions-io/sheriff/issues/31)
(Blueprint-Härtung, sheriff 0.19.6). Gemeinsamer Nenner aller Findings: **die Config ist
korrekt, aber das, was enforced wird, ist nicht das, was der Autor denkt** — und nichts
wird rot.

**Entscheidungen** (Punkt-für-Punkt-Review am 2026-07-24):

| Issue-Punkt | Entscheidung |
| --- | --- |
| 1. `fromTags`/`toTags` im Rule-Context | **Keine Fork-Arbeit.** Im Fork vollständig vorhanden (`DependencyCheckContext`, `check-for-dependency-rule-violation.ts`). Der Rest des Punkts adressiert Upstream; „unbekanntes Context-Feld soll werfen" ist ohne Proxy-Wrapper in JS nicht abbildbar. Optional: Upstream-PR anbieten — außerhalb dieses Plans. |
| 2. Verschachteltes `internal/` ignoriert | **Any-depth-Matching für String-`encapsulationPattern`** (Task 1). Bewusste Verhaltensänderung, prominent in die Release-Notes. |
| 3. Verirrte `index.ts` kippt Barrel-less-Modul | **`barrelPolicy` mit Scope-Ausnahmen** (`allowBarrelsIn`) (Task 2). |
| 4. Staler Build des Config-Pakets | **Provenance ausgeben** (Task 3). Staleness-Check und Source-Resolution bewusst verworfen (heuristisch bzw. zu invasiv). |
| Querschnitt | **`sheriff doctor`-Kommando** bündelt die Diagnosen (Task 4). |

**Rahmen:** identisch zu `task-list.md` — Zero-Dependency, 100 % Unit-Coverage,
Integration-Tests, JSDoc, Conventional Commits, strikt additiv (Ausnahme: Task 1,
s. dort). Die dort dokumentierten **Fallen 1–3** (brüchige `parse-config.spec.ts`-
Assertions, `project-creator.ts`-Serialisierung, `Configuration = Required<…>`) und die
**kanonische Reihenfolge für additive Config-Optionen** (`cd468a1`-Muster) gelten
unverändert und werden hier nicht wiederholt.

**Reihenfolge:** Task 1–3 sind unabhängig voneinander. Task 4 baut auf 2 und 3 auf
(nutzt deren Checks) und kommt zuletzt.

---

## Task 1 — `encapsulationPattern` (String): Matching auf beliebiger Tiefe

*Issue-Punkt 2, Severity high.*

### Problem

`has-encapsulation-violations.ts` prüft für String-Patterns nur
`relativePath.startsWith(encapsulationPattern)` — ein `internal/` unterhalb der
Modulwurzel (`data/foo/internal/secret.ts`) ist **stillschweigend öffentlich**, obwohl
der Ordnername eine Sicherheitszusage ist. Regex-Patterns können heute schon beliebige
Tiefe (`/(^|\/)_/`), nur der String-Default nicht.

### Semantik (entschieden)

Eine Datei ist encapsulated, wenn

1. `relativePath.startsWith(pattern)` — **bisheriges Verhalten, bleibt erhalten**, oder
2. ein **Verzeichnis-Segment** des relativen Pfads exakt `pattern` entspricht
   (Dateiname zählt nicht als Segment).

Bewusst **OR statt Ersatz**: `startsWith('internal')` matcht heute auch
`internals/…` und `internal-utils/…`. Reines Segment-Matching würde diese Pfade
stillschweigend **öffnen** — exakt die Fehlerklasse, die das Issue anprangert. Mit OR
ist die Änderung strikt verschärfend: es wird nie weniger encapsulated als vorher.

Verhaltensänderung dennoch real (bisher öffentliche, tief liegende `internal/`-Dateien
werden privat → bestehende Builds können rot werden). Kein neues Config-Flag — das
alte Verhalten ist ein Bug im mentalen Modell, kein Feature. Prominenter Eintrag in
den Release-Notes mit Migrationshinweis (Ordner umbenennen oder Import fixen).

### Verifikation

- Spec-Fälle: top-level `internal/` (bestehend), verschachtelt `a/internal/b.ts`
  (neu: encapsulated), `internals/x.ts` (weiter encapsulated, Prefix),
  `a/internals/x.ts` (öffentlich — Segment ≠ Pattern), Datei namens `internal.ts`
  auf Tiefe (öffentlich — Dateiname zählt nicht), Zusammenspiel mit
  `exportedFilePatterns` (haben Vorrang, unverändert).
- Repro aus dem Issue als e2e: `./data/foo/internal/secret` muss die
  Encapsulation-Meldung liefern (⚠️ Falle 5 aus `task-list.md`: braucht
  `enableBarrelLess: true` + `root: '*'`).

### Betroffene Dateien

- `packages/core/src/lib/checks/has-encapsulation-violations.ts` —
  `accessesExposedFileForBarrelLessModules`
- `packages/core/src/lib/eslint/tests/violates-encapsulation-rule.spec.ts`
- `docs/…/configuration.md` (JSDoc in `user-sheriff-config.ts` synchron halten —
  die Beispiele dort dokumentieren aktuell das Top-Level-Verhalten)
- `docs/release-notes/0.20.md` — Abschnitt „Behavior Change"
- Integration: `test-projects/`

---

## Task 2 — `barrelPolicy` + `allowBarrelsIn`: verirrte `index.ts` wird laut

*Issue-Punkt 3, Severity high — „gefährlichster Footgun im Barrel-less-Modus".*

### Problem

Im Barrel-less-Modus ist die **Abwesenheit** von `index.ts` tragende Konfiguration.
Eine einzige von IDE/Schematic/Gewohnheit erzeugte `index.ts` macht aus einem Bucket
lautlos ein Barrel-Modul: `sheriff list` unverändert, ESLint grün, `verify` grün — und
die Layer-Matrix des Moduls ist weg. Gleichzeitig sind **bewusste** Bucket-Barrels
(z. B. `api/index.ts` als Port mit kurzem Import) legitim und im Blueprint im Einsatz;
eine Policy ohne Ausnahmen wäre dort unbrauchbar.

### API (additiv)

```ts
export interface UserSheriffConfig {
  /**
   * Only with `enableBarrelLess: true`: controls whether barrel files
   * (`index.ts` / `barrelFileName`) are allowed inside the module tree.
   * 'allow' (default) keeps the current behaviour, 'warn' reports without
   * failing, 'forbid' turns every barrel into a violation.
   */
  barrelPolicy?: 'allow' | 'warn' | 'forbid';

  /**
   * Glob patterns (relative to the project root, matched against the module
   * path) for barrels that stay legal despite `barrelPolicy`, e.g.
   * `['libs/domains/*/src/api']` for intentional bucket-level ports.
   */
  allowBarrelsIn?: string[];
}
```

Defaults: `barrelPolicy: 'allow'`, `allowBarrelsIn: []` (Falle 3: beide in
`defaultConfig` eintragen). Validierung in `parse-config.ts` (jeweils `UserError`):

- `barrelPolicy` ≠ `'allow'` ohne `enableBarrelLess: true` → Fehler (die Policy hätte
  sonst stillschweigend keine Wirkung — genau das Muster, das dieses Issue bekämpft).
- `allowBarrelsIn` gesetzt, aber `barrelPolicy` fehlt/`'allow'` → Fehler (tote Config).

### Enforcement (zwei Oberflächen)

1. **Core-Check** `checkForBarrelPolicyViolation` (neu, `packages/core/src/lib/checks/`):
   liefert alle Module mit `hasBarrel === true`, deren Modulpfad kein
   `allowBarrelsIn`-Glob matcht (Matching via vorhandenem `segment-pattern`-Utility).
   Meldungstext benennt die Konsequenz, nicht nur den Fund:
   „`index.ts` turns a barrel-less module into a barrel module and changes its
   encapsulation semantics. Remove it or add the module to `allowBarrelsIn`."
2. **`sheriff verify`**: `'forbid'` → Violation (Exit ≠ 0), `'warn'` → Warnzeile.
3. **ESLint** (neue Rule `barrel-policy` via `create-rule.ts`-Factory, analog
   `encapsulation`): meldet auf der Barrel-Datei selbst, sobald sie gelintet wird —
   damit ist der Fund im Editor und im CI-Lint rot, nicht erst bei `verify`.

Damit ist auch die Issue-Unterscheidung abgedeckt: Bucket-Barrel
(`libs/domains/booking/src/api/index.ts`) → per Glob erlaubt; Lib-Barrel
(`libs/domains/booking/src/index.ts`) → Violation.

### Verifikation

- Unit: Policy-Matrix (`allow`/`warn`/`forbid` × Barrel vorhanden/nicht ×
  Glob-Match/kein Match), beide `UserError`-Fälle, `barrelFileName`-Abweichung
  (`public-api.ts`).
- Repro aus dem Issue als Integration-Test: `echo "export …" > ui/index.ts` →
  `verify` schlägt fehl, ESLint meldet auf `ui/index.ts`; mit
  `allowBarrelsIn: ['**/api']` bleibt `api/index.ts` grün und `ui → api` weiterhin
  per Dependency-Rule geblockt.
- Falle 1: `parse-config.spec.ts` (`Object.keys()`-Liste + Default-`toEqual`) gehört
  zum roten Test.

### Betroffene Dateien

Kanonische Reihenfolge aus `task-list.md`, plus:

- `packages/core/src/lib/checks/check-for-barrel-policy-violation.ts` (+ Spec)
- `packages/core/src/lib/cli/verify.ts`
- `packages/eslint-plugin/src/lib/rules/barrel-policy.ts` (+ Registrierung in
  `index.ts`, + Tests)
- Docs: `configuration.md`, `release-notes/0.20.md`, `test-projects/`

---

## Task 3 — Config-Provenance: „laufe ich die Regeln, die ich denke?"

*Issue-Punkt 4, Severity medium-high — bewusst nur Vorschlag (2) aus dem Issue.*

### Problem

`parse-config.ts` transpiliert nur `sheriff.config.ts` selbst und `eval`t das Ergebnis;
Imports der Config (z. B. `@berger-engineering/sheriff-blueprint`) laufen über das
ambient `require` des Core-Pakets gegen den **gebauten** Stand in `node_modules`. Ist
`dist/` stale, wird eine alte Architektur enforced — ohne jedes Signal. Vier
Boundaries gingen im Issue-Repro von „offen" auf „enforced" allein durch `npm run build`.

### Ansatz

1. **Erfassen:** In `computeParsedConfig` das `eval` durch einen Function-Wrapper
   ersetzen, der ein eigenes `require` hereinreicht: delegiert an das echte `require`,
   zeichnet aber pro Specifier den via `require.resolve` aufgelösten Pfad **und dessen
   `fs.realpathSync`** auf (pnpm-/Workspace-Symlinks werden so als
   `→ ../../packages/blueprint/dist/index.js` sichtbar — das ist die eigentliche
   Antwort auf „welchen Build fahre ich?"). Fehlschlagende Auflösungen mit Fehlertext
   erfassen statt nur werfen zu lassen.
2. **Ablegen:** `Configuration` erhält `configImports: ConfigImport[]`
   (`{ specifier, resolvedPath, realPath }`); Default `[]` (Falle 3). Rein
   informativ — keinerlei Einfluss auf Rule-Auswertung, damit der Cache-Key von
   `getOrCompute` unverändert tragfähig bleibt.
3. **Ausgeben:** `sheriff list` und `sheriff verify` drucken im Header den Pfad der
   aufgelösten `sheriff.config.ts` (heute nicht sichtbar) und bei `--verbose`
   zusätzlich die `configImports`-Tabelle. `sheriff doctor` (Task 4) zeigt sie immer.

Bekannte Eigenheit, im Zuge dessen dokumentieren: durch das `eval` löst `require`
relativ zum Core-Paket auf, nicht relativ zur Config-Datei. Für `node_modules`-Pakete
im selben Workspace praktisch identisch, aber relevant für relative Importe — `doctor`
kann fehlgeschlagene Auflösungen als Finding melden.

### Verifikation

- Unit: Config mit Paket-Import → `configImports` enthält Specifier + Pfade; Config
  ohne Imports → `[]`; Symlink-Fall (virtuelles FS bzw. Integration); Auflösung
  schlägt fehl → Fehler unverändert, aber Provenance bis dahin erfasst.
- Integration in `test-projects/`: Config, die aus einem workspace-gelinkten Paket
  importiert; `sheriff verify --verbose` zeigt den Realpath.

### Betroffene Dateien

- `packages/core/src/lib/config/parse-config.ts`, `configuration.ts`,
  `default-config.ts`
- `packages/core/src/lib/cli/list.ts`, `verify.ts` (Header + `--verbose`)
- Specs: `parse-config.spec.ts` (inkl. Falle 1), CLI-Tests
- Docs: `configuration.md`, `release-notes/0.20.md`

---

## Task 4 — `sheriff doctor`: ein CI-Kommando statt vier stiller Lücken

*Querschnitt aus dem Issue; baut auf Task 2 + 3 auf.*

### Ansatz

Neues Builtin-Kommando (`BUILTIN_COMMANDS`, `main.ts`-Switch, Help-Text,
`packages/core/src/lib/cli/doctor.ts`), Signatur `sheriff doctor [main.ts]` analog
`verify`. Läuft alle Checks und gibt einen gruppierten Report aus:

| # | Check | Quelle |
| --- | --- | --- |
| 1 | Module, die auf `noTag` auflösen | bestehende Tag-Berechnung |
| 2 | `internal/`-Ordner (bzw. `encapsulationPattern`-Treffer), die **nicht** enforced werden: Modul hat Barrel, `enableBarrelLess: false`, oder Ordner liegt außerhalb jedes Moduls | neu; nach Task 1 bleibt genau diese Restklasse übrig |
| 3 | Barrel-Dateien in Barrel-less-Modulbäumen — auch bei `barrelPolicy: 'allow'` als Hinweis, bei `warn`/`forbid` mit Policy-Ergebnis | Task 2-Check, wiederverwendet |
| 4 | Config-Provenance: Config-Pfad + `configImports` mit Realpaths, fehlgeschlagene Auflösungen als Finding | Task 3 |
| 5 | Entry-Points ohne auffindbare `tsconfig.json` | bestehende Entry-Point-Auflösung |

Exit-Code: `1` bei Findings der Checks 1, 2, 3 (nur `warn`/`forbid`) und 5 — damit
ist `doctor` CI-tauglich („wir würden es neben `sheriff verify` in jedem Projekt
fahren"). Check 4 ist rein informativ. `--json` für maschinenlesbare Ausgabe von
Anfang an mitnehmen (Struktur analog `export`), damit CI-Pipelines nicht Text parsen.

### Verifikation

- CLI-Spec analog `verify`-Tests: je Check ein positiver + negativer Fall,
  Exit-Code-Matrix, `--json`-Snapshot.
- Integration: Projekt mit allen vier Lücken gleichzeitig → ein Lauf, vier Findings.

### Betroffene Dateien

- `packages/core/src/lib/cli/doctor.ts` (+ Spec), `main.ts`,
  `internal/builtin-commands.ts`
- neue Checks unter `packages/core/src/lib/checks/` für 2 und 5
- Docs: CLI-Doku, `release-notes/0.20.md`
