# Draft: Modul-Definition per Datei-Pattern/Glob

**Status: Entwurf zur Diskussion — noch keine Implementierung, keine Tests.**

Ziel-Feature: Module sollen in `sheriff.config.ts` über Patterns/Globs definiert werden
können, statt nur über Pfade mit exakter Segmentanzahl.

**Rahmen** (wie `task-list.md`): Zero-Dependency-Policy (kein `minimatch`/`picomatch` —
`segment-pattern.ts` wird erweitert), strikt additiv (v1 ist raus), 100 % Unit-Tests,
Integration-Tests, JSDoc, Doku.

---

## 0. Scope-Entscheidung — zuerst lesen

„Modul via file pattern/glob definieren" hat drei mögliche Lesarten. Der Draft empfiehlt
eine Phasierung; **Lesart A ist als Kern angenommen** und unten voll ausgearbeitet.
Falls primär B gemeint war: B ist als Phase 2 skizziert und kann vorgezogen werden —
dann bitte Rückmeldung, bevor Tests geschrieben werden.

| | Lesart | Beispiel | Bewertung |
|---|---|---|---|
| **A** | **Verzeichnis-Globs**: Modul-Keys dürfen `**` enthalten und matchen Verzeichnisse in beliebiger Tiefe | `'libs/**/feature-*': ['type:feature']` | **Empfohlener Kern (Phase 1).** Erhält alle Invarianten: Modul = Verzeichnis, Datei-Zuordnung über tiefsten Vorfahren, Exposure-Modell unverändert. |
| **B** | **Datei-Module**: ein Key, dessen letztes Segment Dateien matcht, macht jede Treffer-Datei zu einem eigenen (Ein-Datei-)Modul | `'src/stores/<name>.store.ts': { tags: ['type:store', 'store:<name>'] }` | **Phase 2 (skizziert, § 4).** Bricht „Modul = Verzeichnis" kontrolliert; Zuordnung und Exposure bleiben definierbar. Für flache Strukturen wertvoll. |
| **C** | **Verstreute Datei-Menge als EIN Modul**: alle `**/*.store.ts` bilden zusammen ein Modul | — | **Non-Goal.** Bricht `findClosestModulePath` (`create-modules.ts:76`) fundamental: Datei-Zuordnung ist reines Pfad-Präfix-Matching. Ein Modul ohne zusammenhängenden Teilbaum hat keinen Pfad, keine module-relative Exposure, keine sinnvolle `list`-Ausgabe. Nicht bauen. |

Warum A vor B: A löst den häufigeren Schmerz (Monorepo-Tiefe, s. § 1), ist für Barrel-
**und** Barrel-less-Projekte wirksam und erzwingt nebenbei die Reparatur eines echten
Bugs (#56, s. § 2.3). B baut auf der in A extrahierten Matcher-Infrastruktur auf.

---

## 1. Problem

### 1.1 Exakte Segmentanzahl erzwingt Enumeration

Modul-Keys matchen heute **segmentweise mit exakter Anzahl** — `*`, `<placeholder>` und
`/regex/` gelten je für genau ein Segment (`matchesFolderPathPattern`,
`segment-pattern.ts:26-39`; `matchSegment`, `calc-tags-for-module.ts:222`). Ein Nx-Monorepo
mit variabler Tiefe braucht deshalb pro Tiefe einen eigenen Key:

```ts
modules: {
  'libs/<domain>/feature-<name>':          ['type:feature', 'domain:<domain>'],
  'libs/<scope>/<domain>/feature-<name>':  ['type:feature', 'domain:<domain>'],
  // dritte Ebene? -> dritter Key. Vergessen? -> Modul existiert stillschweigend nicht.
}
```

Das Scheitern ist **fail-open**: ein Verzeichnis unterhalb einer nicht abgedeckten Tiefe
wird kein Modul, seine Dateien fallen ins Eltern-/Root-Modul, dessen Regeln gelten — grün
aus dem falschen Grund. Dieselbe Fail-open-Klasse wie #46/#56.

### 1.2 Discovery und Tagging matchen bereits heute unterschiedlich

Es gibt **zwei getrennte Matching-Implementierungen** über dieselben Config-Keys:

| | Discovery (Barrel-less) | Tagging |
|---|---|---|
| Code | `flatten-modules.ts` + `traverseAndMatch` (`find-module-paths-without-barrel.ts:46`) | `traverseModuleConfig`/`matchSegment` (`calc-tags-for-module.ts:56/222`) |
| `<placeholder>` | wird zu `*` normalisiert | Capture-Group `([^/]+)` |
| rohes `*` | matcht (via `matchesFolderSegmentPattern`) | **matcht NICHT** — ohne Placeholder gilt exakte String-Gleichheit (`calc-tags-for-module.ts:256`) |
| `/regex/` | matcht nur zufällig/gar nicht (wird wie Literal mit `*`-Ersetzung behandelt) | voll unterstützt |

Konsequenz heute: `'src/app/*': ['x']` erzeugt in Barrel-less-Mode Module, die dann
`noTag` tragen. Jede naive „nur an einer Stelle `**` einbauen"-Lösung vergrößert diese
Drift. **Der Draft macht die Vereinheitlichung des Matchings deshalb zum Teil des
Features, nicht zum Nebeneffekt** (§ 3.4).

---

## 2. Ist-Zustand: die vier Stellen, an denen Modul-Identität hängt

1. **Discovery (Barrel-less):** `findModulePathsWithoutBarrel` flacht die Config zu
   Pattern-Pfaden ab, baut einen Pattern-Baum (`create-module-path-patterns-tree.ts`) und
   läuft den Dateibaum **segmentweise** ab — nur Verzeichnisse, keine Dateien
   (`find-module-paths-without-barrel.ts:67`).
2. **Discovery (Barrel):** jedes Verzeichnis mit `index.ts` wird automatisch Modul —
   config-unabhängig (`find-module-paths.ts:89`; abgeschaltet unter
   `moduleIdentity: 'config'`).
3. **Tagging:** `calcTagsForModule` läuft dieselbe Config **erneut** gegen den Modulpfad
   (First-Match in Key-Reihenfolge, Nested-Configs rekursiv, Placeholder-Capture).
4. **Datei-Zuordnung:** `findClosestModulePath` (`create-modules.ts:76`) — tiefster
   Vorfahr im `modulePaths`-Set, reines Präfix-Kürzen. Kennt keine Patterns; arbeitet
   nur auf dem fertigen Pfad-Set. **Bleibt in Phase 1 unangetastet.**

### 2.3 Vorbedingung: Bug #56 (Single-Match-Descent)

`traverseAndMatch` steigt pro Verzeichnis nur in das **erste** matchende Pattern ab
(`patterns.find`, `find-module-paths-without-barrel.ts:72`) — Sibling-Patterns gehen
stillschweigend verloren (Repro in #56). Mit `**` werden überlappende Patterns vom
Sonderfall zum Normalfall (`'libs/**'` überlappt mit *jedem* anderen `libs/...`-Key).
**#56 muss daher als erster Schritt dieses Features gefixt werden** (`find` → alle
matchenden Patterns verfolgen); der NFA-Umbau aus § 3.3 erledigt das strukturell mit.

---

## 3. Phase 1 — `**` in Modul-Keys (ausgearbeitet)

### 3.1 API (additiv, keine neue Config-Option)

Keine neue Option in `SheriffConfig` — die Fähigkeit landet in der bestehenden
`modules`-Syntax:

```ts
export const config: SheriffConfig = {
  modules: {
    // jede feature-*-Directory unterhalb von libs, beliebig tief
    'libs/**/feature-<name>': ['type:feature', 'feature:<name>'],
    // Placeholder rechts von ** funktionieren unverändert
    'libs/**/<domain>/api':   ['type:api', 'domain:<domain>'],
    // auch in verschachtelten Configs
    'apps/<app>': {
      '**/data': ['type:data'],
    },
  },
  enableBarrelLess: true,
};
```

### 3.2 Semantik — die verbindlichen Entscheidungen

1. **`**` nur als vollständiges Segment.** `a**b` behält seine heutige Bedeutung
   (Single-Segment-Wildcard, `[^/]*[^/]*`) — kein Breaking Change. Nur ein Segment, das
   exakt `**` ist, bekommt Multi-Segment-Semantik.
2. **`**` matcht null oder mehr Segmente** — konsistent mit dem existierenden
   `matchesFolderPathGlob` (`segment-pattern.ts:49`, genutzt von `allowBarrelsIn`).
   `'libs/**/api'` matcht also auch `libs/api`. Zwei Glob-Semantiken im selben Tool wären
   nicht vermittelbar.
3. **`**` ist non-capturing.** Es bindet keinen Placeholder; `<domain>` bleibt strikt
   ein Segment (Anker-Fix #72 bleibt gültig). Ein „Rest-Placeholder" (`<...path>`) ist
   bewusst NICHT Teil dieses Drafts.
4. **First-Match-Semantik des Taggings bleibt.** `traverseModuleConfig` nimmt weiterhin
   den ersten matchenden Key in Config-Reihenfolge. Doku-Pflicht: spezifischere Keys vor
   `**`-Keys stellen. (Eine Spezifitäts-Sortierung wie in `getSpecificity` wäre eine
   stille Verhaltensänderung für bestehende Configs — verworfen.)
5. **Kürzester `**`-Span gewinnt** (mit Backtracking): matcht ein Key mit dem Rest des
   Pfads nicht, wird der `**`-Span verlängert, bevor der nächste Key probiert wird.
   Deterministisch und deckungsgleich mit `matchesSegments` (`segment-pattern.ts:58`).
6. **Konsekutive `**` werden normalisiert** (`'a/**/**/b'` ≡ `'a/**/b'`). Kein Fehler.
7. **Ein `**`-Key kann viele Module erzeugen — auch verschachtelte.** `'libs/**'` macht
   jedes Verzeichnis unter `libs` (inkl. `libs` selbst, Regel 2) zum Modul. Die
   Zuordnung über den tiefsten Vorfahren handhabt Verschachtelung bereits heute; kein
   neuer Mechanismus.
8. **`rootDir` selbst wird nie über ein Pattern zum Modul** — das implizite Root-Modul
   (`create-modules.ts:44`) bleibt die einzige Quelle für `root`.
9. **Discovery-Traversal überspringt `node_modules` und Dot-Verzeichnisse** (`.git`,
   `.nx`, …), sobald ein `**` aktiv ist. Heute schützt die exakte Segmentanzahl faktisch
   davor, dass jemand versehentlich `node_modules` durchläuft; `'src/**'` oder `'**'`
   hebt diesen Schutz auf. ⚠️ Vorher prüfen, ob `fs.readDirectory` bereits filtert —
   falls nein, ist der Skip Teil dieses Features (nur im `**`-Pfad, um bestehendes
   Verhalten nicht anzufassen; wer heute `'node_modules/<x>'` als Key hat, will das so).
10. **Wirksam in beiden Modi:** Barrel-Projekte nutzen `**`-Keys fürs Tagging
    auto-erkannter Barrel-Module; Barrel-less (und `moduleIdentity: 'config'`) zusätzlich
    für die Discovery. `moduleIdentity: 'config'` + `'src/**'` ist die explizite
    „jeder Ordner ist ein Modul"-Konfiguration — dokumentieren, nicht verhindern.

### 3.3 Discovery-Umbau: Pattern-Baum → aktive Pattern-Menge

`traverseAndMatch` wird von „ein Pattern-Knoten pro Verzeichnis" auf **Menge aktiver
Pattern-Knoten** umgestellt (NFA-Prinzip):

- Pro Verzeichnisebene wird jeder aktive Knoten gegen das Segment geprüft; **alle**
  Treffer bleiben aktiv (fixt #56 strukturell).
- Ein `**`-Knoten hat eine Selbstschleife (matcht jedes Segment und bleibt aktiv) und
  eine ε-Transition auf seinen Nachfolger (Null-Segment-Fall, Regel 2) — beim Betreten
  des `**`-Knotens wird der Nachfolger sofort mit-aktiviert.
- Ein Verzeichnis wird Modul, wenn irgendein aktiver Knoten terminal ist
  (bestehende `addAsModule`-Logik inkl. Barrel-Probe #70 unverändert).

Kostenmodell: ohne `**` identisch zu heute (gleiche Baumbeschneidung). Mit `**` wird der
Teilbaum unterhalb des Ankers voll gelesen — das ist inhärent und opt-in; der bestehende
TTL-Cache (`find-module-paths.ts:57`) und Benchmark-Guards (`tools/perf/`) fangen es ab.
Ein Bench-Szenario mit `**`-Config in `tools/perf/gen-bench.mjs` gehört zur DoD.

### 3.4 Ein gemeinsamer Matcher für Discovery und Tagging

Neues internes Modul (Arbeitstitel `tags/module-path-matcher.ts`), das **eine** Semantik
für Modul-Keys kapselt: Literal, `*`, `a*b`, `<placeholder>` (capture), `/regex/`, `**`.
Konsumenten:

- `calc-tags-for-module.ts` → `matchSegment` delegiert (statt eigener Exakt-Gleichheit).
  Nebeneffekt, bewusst: **rohes `*` matcht dann auch beim Tagging** — behebt die
  Drift aus § 1.2. Das ist eine Verhaltensänderung nur für Configs, die heute `*` ohne
  Placeholder schreiben und dafür `noTag` bekommen — also fail-open-Reparatur, kein Bruch.
  (Mit eigenem Regressionstest festnageln.)
- `find-module-paths-without-barrel.ts` → Segment-Prüfung im NFA.
- `findExportsForModulePath` (`find-module-paths.ts:142`) → `matchesFolderPathPattern`
  wird `**`-fähig; `getSpecificity` (`:184`) wertet `**` als unspezifischstes Element:
  Sortierung zuerst nach Anzahl `**` aufsteigend, dann wie bisher.

### 3.5 Validierung & Fehler

- Neuer `UserError` (nächster freier Code: **SH-023**), z. B. `InvalidModulePathError`,
  für: `**` innerhalb eines `/regex/`-Segments und `**` als einziger Inhalt eines
  Keys in einer *verschachtelten* Config-Ebene, deren Parent bereits mit `**` endet
  (nicht auflösbare Doppel-Globs über Ebenen hinweg — Detailentscheidung beim Impl).
- Kein Fehler für `'**'` als Top-Level-Key (legitim unter `moduleIdentity: 'config'`).

### 3.6 Cache & Serialisierung

- **Cache-Key:** Modul-Keys stehen als Strings im Cache-Key
  (`stringifyModulesForCacheKey`, `find-module-paths.ts:136`) — `**` braucht dort
  nichts Neues. Gegentest trotzdem in `find-module-paths-cache.spec.ts` (Lehre aus #45).
- **Falle 2 (`project-creator.ts`):** keine neuen Funktions-/RegExp-Werte — `**` ist ein
  gewöhnlicher String-Key, Serialisierung unverändert. Keine neue Config-Option ⇒
  **Falle 1 und 3 werden nicht ausgelöst** (kein neuer `defaultConfig`-Key).

---

## 4. Phase 2 — Datei-Module (Skizze, eigener Task vor Implementierung)

Ein Key, dessen letztes Segment eine Datei matcht, macht **jede Treffer-Datei zu einem
eigenen Modul** (Modulpfad = Dateipfad):

```ts
modules: {
  'src/app/stores/<name>.store.ts': { tags: ['type:store', 'store:<name>'] },
}
```

Was trägt: `findClosestModulePath` funktioniert unverändert (die Datei findet sich selbst
im Set); Exposure ist trivial (die Datei ist ihre eigene Public API); Tagging läuft über
denselben Matcher aus § 3.4 (Placeholder inkl. Dateinamens-Anteil, z. B. `<name>` in
`<name>.store.ts` — `matchesFilePathPattern`-Semantik existiert schon).

Was entschieden werden muss, bevor Phase 2 startet:

1. **Erkennung:** Woran erkennt Sheriff, dass ein Key Dateien meint? Optionen: (a) beim
   Traversal auch Dateien probieren, (b) expliziter Marker in `ModuleDefinition`
   (z. B. `kind: 'file'`). Tendenz: (b) — explizit, kollisionsfrei, und der
   Diskriminator-Falle von Task 3 wird direkt begegnet (`moduleDefinitionKeys` in
   `module-config.ts:80` erweitern, sonst wird `{ tags, kind }` still zur Nested-Config).
2. **Companion-Dateien:** `user.store.spec.ts` neben `user.store.ts` wird zum
   *modulfremden* Import — via ESLint-Plugin (das alle Dateien lintet) sofort sichtbar,
   via CLI nur bei Erreichbarkeit vom Entry. Braucht eine Antwort (Konvention,
   `exports`-Analogon, oder bewusst „Spec gehört ins Root-Modul und braucht eine Regel").
3. **Discovery-Kosten:** Datei-Listing statt nur Verzeichnis-Listing im Traversal
   (`fs.readDirectory`-Erweiterung, `default-fs.ts` + `virtual-fs.ts`).
4. **`sheriff list`/`export`/LSP-Hover:** Ein-Datei-Module müssen in allen Ausgaben
   sinnvoll erscheinen (`getProjectData`).

Phase 2 wird **nicht** begonnen, bevor Phase 1 gemerged ist — sie erbt Matcher, NFA und
Testinfrastruktur.

---

## 5. Wechselwirkungen

- **#56** — Vorbedingung, wird durch § 3.3 strukturell gefixt. Der bestehende Repro aus
  dem Issue wird als Regressionstest übernommen.
- **#46** — bereits gefixt (`[^/]`-Semantik); `**` baut darauf auf, keine Interaktion.
- **#45 (Cache-Key)** — Gegentest, s. § 3.6.
- **Issue #37 (config-getriebene Modul-Identität)** — dieses Feature macht
  `moduleIdentity: 'config'` erst ergonomisch: ohne `**` heißt „Identität nur aus der
  Config" heute „jede Tiefe enumerieren". Im Issue nachtragen.
- **Task 5 / Doku der First-Match-Semantik** — Regel 4 aus § 3.2 gehört in dieselbe
  Doku-Stelle (Key-Reihenfolge ist jetzt auch für `modules` relevant, nicht nur
  `depRules`).
- **Upstream-Tauglichkeit:** kein Fork-Spezifikum; sauberer Kandidat für einen
  Upstream-PR nach Reifung (README-Versprechen „strictly additive" bleibt erfüllt).

---

## 6. Teststrategie (Konventionen aus `task-list.md` § Test-Konventionen)

**Reihenfolge: Tests zuerst (rot), Implementierung separat** — wie Task 1–4.

| Bereich | Spec | prüft |
|---|---|---|
| Matcher | `modules/tests/segment-pattern.spec.ts` (erweitern) + neue Matcher-Spec | Regeln 1, 2, 5, 6 isoliert; `a**b` bleibt Single-Segment (Regressionswächter) |
| Discovery | `modules/tests/find-module-paths-without-barrel.spec.ts` (`assertProject`-Builder) | `**` mitte/anfang/ende, Null-Segment-Match, verschachtelte Configs, Sibling-Patterns (#56-Repro), `node_modules`-Skip |
| Tagging | `tags/calc-tags-for-module.spec.ts` | Placeholder rechts/links von `**`, First-Match-Reihenfolge, rohes `*` (Drift-Fix § 3.4), `InvalidPlaceholderError` unverändert |
| Identity | `modules/tests/module-identity.spec.ts` | jede `**`-Szenerie in **beiden** `moduleIdentity`-Modi (bestehendes Muster) |
| Exports | `modules/tests/`- + `checks/tests/module-exports.spec.ts` | `exports` an einem `**`-Key; Spezifität mit `**` |
| Cache | `modules/tests/find-module-paths-cache.spec.ts` | zwei Configs, die sich nur im `**` unterscheiden, kollidieren nicht |
| e2e | `checks/tests/` neu, mit `testInit` | **Falle 5 beachten:** `enableBarrelLess: true` + `root: '*'`-Regel, sonst grün aus falschem Grund. Violation über ein per `**` definiertes Modul; Mutationsprobe: `**`-Key entfernen → rot |
| Parsing | `config/tests/parse-config.spec.ts` | SH-023-Fälle via `toThrowUserError` |

Integration: `test-projects/angular-iv` — `customers/**`-Variante der bestehenden
`customers/api`-Config, Golden-File aus echtem Lauf (Impl-Agent, nie von Hand).

**Mutationsprobe (Pflicht, pro Szenario):** `**`-Key aus der Config nehmen → zugehöriger
Test muss rot werden.

---

## 7. Betroffene Dateien (Phase 1)

- `packages/core/src/lib/modules/internal/segment-pattern.ts` — `**`-Segment-Semantik
- `packages/core/src/lib/tags/module-path-matcher.ts` — **neu**, gemeinsamer Matcher (§ 3.4)
- `packages/core/src/lib/tags/calc-tags-for-module.ts` — `matchSegment` delegiert; Backtracking für variable Spans
- `packages/core/src/lib/modules/internal/find-module-paths-without-barrel.ts` — NFA-Traversal (§ 3.3, fixt #56)
- `packages/core/src/lib/modules/internal/create-module-path-patterns-tree.ts` — `**`-Knoten (Selbstschleife/ε)
- `packages/core/src/lib/modules/internal/flatten-modules.ts` — `**` durchreichen (heute schon transparent, absichern)
- `packages/core/src/lib/modules/find-module-paths.ts` — `findExportsForModulePath`/`getSpecificity` `**`-fähig
- `packages/core/src/lib/error/user-error.ts` — SH-023
- `packages/core/src/lib/config/parse-config.ts` — Key-Validierung (§ 3.5)
- Docs: `configuration.md` (Sektion unter `modules`), `dependency-rules.md` („Nested Paths"/„Placeholders" ergänzen), `module_boundaries.md`, `release-notes/`, `roadmap.md`
- **Unverändert:** `create-modules.ts` (`findClosestModulePath`), `module.ts` (Exposure), `user-sheriff-config.ts`/`default-config.ts` (keine neue Option)

---

## 8. Offene Fragen (vor Test-Phase zu klären)

1. **Scope-Bestätigung:** Ist Lesart A (Verzeichnis-Globs) der gewünschte Kern, oder war
   primär B (Datei-Module) gemeint? → entscheidet, ob Phase 2 vorgezogen wird.
2. Filtert `fs.readDirectory` bereits `node_modules`/Dot-Verzeichnisse? (Empirisch
   klären; Regel 9 hängt daran.)
3. Soll die `*`-Tagging-Drift (§ 3.4) im selben PR gefixt werden oder als separater
   `fix(core)` vorweg? Tendenz: vorweg, eigener Commit — dann ist der Feature-Diff sauber.

---

## 9. Definition of Done (Phase 1)

- [ ] Alle neuen Tests grün, alle Alt-Tests weiterhin grün
- [ ] Mutationsprobe pro Szenario bestanden
- [ ] #56-Repro als Regressionstest grün
- [ ] `yarn lint:all`, `yarn test`, `yarn build:all`, `./run-integration-tests.sh` grün
- [ ] Bench-Szenario mit `**`-Config, keine Regression in bestehenden Benches
- [ ] JSDoc an jedem neuen public member; Doku aktualisiert
- [ ] Bestehende Configs ohne `**`: **bit-identisches Verhalten**
- [ ] Conventional Commits, Scope `core`/`docs`, atomar
