# Draft: Modul-Definition per Datei-Pattern/Glob

**Status: umgesetzt (AP0–AP3, siehe § 10) — Draft bleibt als Design-Dokumentation erhalten.**

Ziel-Feature: Module sollen in `sheriff.config.ts` über Patterns/Globs definiert werden
können, statt nur über Pfade mit exakter Segmentanzahl.

**Rahmen** (wie `task-list.md`): Zero-Dependency-Policy (kein `minimatch`/`picomatch` —
`segment-pattern.ts` wird erweitert), strikt additiv (v1 ist raus), 100 % Unit-Tests,
Integration-Tests, JSDoc, Doku.

---

## 0. Scope-Entscheidung — zuerst lesen

„Modul via file pattern/glob definieren" hat drei mögliche Lesarten.

> **Entschieden (2026-08-05):** Lesart **A und B werden beide umgesetzt** — A als
> Phase 1, B als Phase 2, in dieser Reihenfolge. C bleibt Non-Goal. Datei-Module werden
> **implizit** erkannt (das Traversal probiert auch Dateien, kein `kind: 'file'`-Marker);
> Companion-/Spec-Dateien bekommen **keine Sonderbehandlung**; der `*`-Drift-Fix (§ 3.4)
> läuft als **separater `fix(core)`-Commit vorweg**. Vorgehen: Tests zuerst (rot), dann
> Implementierung — Arbeitspakete in § 10.

| | Lesart | Beispiel | Bewertung |
|---|---|---|---|
| **A** | **Verzeichnis-Globs**: Modul-Keys dürfen `**` enthalten und matchen Verzeichnisse in beliebiger Tiefe | `'libs/**/feature-*': ['type:feature']` | **Empfohlener Kern (Phase 1).** Erhält alle Invarianten: Modul = Verzeichnis, Datei-Zuordnung über tiefsten Vorfahren, Exposure-Modell unverändert. |
| **B** | **Datei-Module**: ein Key, dessen letztes Segment Dateien matcht, macht jede Treffer-Datei zu einem eigenen (Ein-Datei-)Modul | `'src/stores/<name>.store.ts': ['type:store', 'store:<name>']` | **Phase 2 (§ 4).** Bricht „Modul = Verzeichnis" kontrolliert; Zuordnung und Exposure bleiben definierbar. Für flache Strukturen wertvoll. |
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
   hebt diesen Schutz auf. **Geprüft (2026-08-05):** `DefaultFs.readDirectory`
   (`default-fs.ts:23-31`) filtert **nichts** — der Skip ist damit bestätigter Teil
   dieses Features (nur im `**`-Pfad, um bestehendes Verhalten nicht anzufassen; wer
   heute `'node_modules/<x>'` als Key hat, will das so).
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
  (Mit eigenem Regressionstest festnageln.) **Entschieden:** dieser Fix läuft als
  separater `fix(core)`-Commit **vor** dem Feature (Arbeitspaket AP0, § 10).
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

## 4. Phase 2 — Datei-Module (ausgearbeitet)

Ein Key, dessen letztes Segment eine **Datei** matcht, macht jede Treffer-Datei zu einem
eigenen Modul (Modulpfad = Dateipfad):

```ts
modules: {
  // jede *.store.ts-Datei ist ihr eigenes Modul; <name> capturet den Dateinamens-Stamm
  'src/app/stores/<name>.store.ts': ['type:store', 'store:<name>'],
  // kombinierbar mit ** (Phase 1): Store-Dateien in beliebiger Tiefe
  'libs/**/<name>.store.ts':        ['type:store'],
}
```

### 4.1 Semantik — die verbindlichen Entscheidungen

1. **Implizite Erkennung über die Datei-Endung** *(entschieden, präzisiert)*: Es gibt
   keinen `kind: 'file'`-Marker. Ein Key definiert Datei-Module genau dann, wenn sein
   **letztes Segment literal auf eine analysierte Quelldatei-Endung endet**
   (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`). Solche Keys matchen
   **nur Dateien**, alle anderen Keys — wie bisher — **nur Verzeichnisse**.
   *Warum die Präzisierung gegenüber „Terminal-Knoten probieren einfach auch Dateien":*
   ein generischer Terminal-Matcher wie `'src/<domain>'` würde sonst plötzlich auch
   Dateien matchen und in Bestandsprojekten neue Module erzeugen — das verletzt die
   Bit-Identisch-Garantie. Die Endungs-Regel hält die Erkennung implizit UND additiv.
   Ein Verzeichnis, das wie eine Datei heißt (`x.ts/`), wird von einem Datei-Key
   bewusst nicht gematcht (pathologisch, dokumentiert).
2. **Nur als letztes Segment.** Ein Datei-Match kann nie „mitten im Pattern" passieren —
   `'a/<x>.ts/b'` ist ein gewöhnlicher Verzeichnis-Key (Dateien haben keine Kinder).
3. **Modulpfad = Dateipfad.** `Module.path` zeigt auf die Datei. `findClosestModulePath`
   (`create-modules.ts:76`) funktioniert unverändert: die Datei findet sich selbst als
   tiefsten Treffer im Set; Nachbardateien klettern an ihr vorbei zum Eltern-Modul.
4. **Exposure = die Datei selbst.** Ein Datei-Modul ist trivially public — seine einzige
   Datei ist seine Public API. `encapsulationPattern`/`internal`-Logik und Barrel-Probe
   werden für Datei-Module übersprungen (`Module.exposes` bekommt einen Datei-Modul-Ast).
   `exports` an einem Key, der eine Datei matcht, ist widersprüchlich → `UserError`
   (SH-023-Familie) beim Erzeugen des Moduls, nicht stillschweigend ignorieren.
5. **Tagging über denselben Matcher** (§ 3.4): Der Modulpfad inkl. Dateinamens-Segment
   läuft durch `calcTagsForModule`; Placeholder im Dateinamen (`<name>.store.ts` →
   `([^/]+)\.store\.ts`) funktionieren wie heute Placeholder in Ordnersegmenten
   (`handlePlaceholderMatching` ist bereits segmentintern). `**` links davon: Regel § 3.2.
6. **Companion-/Spec-Dateien: keine Sonderbehandlung** *(entschieden)*.
   `user.store.spec.ts` gehört zum umgebenden Verzeichnis-/Root-Modul; ihr Import von
   `user.store.ts` ist ein normaler Cross-Module-Import und braucht eine `depRule`.
   Via ESLint-Plugin (lintet alle Dateien) sofort sichtbar, via CLI nur bei
   Erreichbarkeit vom Entry. Doku-Pflicht mit Beispiel-Regel (z. B. `root`-Regel oder
   Spec-Ausschluss über den Entry-Scope). Ein `includes`-Mechanismus ist bewusst NICHT
   Teil des Features; falls der Schmerz real wird, ist das ein eigener Draft.
7. **Wirksam wie Verzeichnis-Discovery:** Datei-Module entstehen im config-basierten
   Discovery-Pfad. Der läuft heute nur unter `enableBarrelLess: true` bzw.
   `moduleIdentity: 'config'` (`find-module-paths.ts:57-87`). Damit ein Datei-Modul-Key
   in einem reinen Barrel-Projekt nicht **still** wirkungslos bleibt (fail-open),
   läuft die Discovery künftig auch dort, sobald `modules` konfiguriert ist —
   beschränkt auf Datei-Treffer (Verzeichnis-Identität bleibt in Barrel-Projekten
   unverändert barrel-getrieben). Additiv: solche Keys matchen heute schlicht nichts.
8. **Kein Barrel-Bezug:** `hasBarrel = false`, `barrelPolicy`/`allowBarrelsIn`
   betreffen Datei-Module nicht.

### 4.2 Technik

- **Traversal:** an Terminal-Knoten zusätzlich `fs.readDirectory(dir, 'none')` und
  Datei-Kandidaten gegen das letzte Segment matchen (`matchesFileSegmentPattern`-
  Semantik existiert in `segment-pattern.ts:98`). Kostenmodell: ein Datei-Listing pro
  Terminal-Verzeichnis — nur dort, wo Patterns ohnehin hinzeigen.
- **`ModulePathMap`:** Werte tragen bereits `ModulePathInfo` — wird um die Information
  „ist Datei" erweitert (oder abgeleitet via `fs`), damit `createModules` den
  Exposure-Ast wählen kann, ohne erneut zu statten.
- **Ausgaben:** `sheriff list`/`export`/LSP-Hover (`getProjectData`) zeigen Datei-Module
  mit ihrem Dateipfad; `Module.kind` bekommt die Ausprägung `'file'` (heute
  `'barrel' | 'barrel-less'`) — rein informativ, keine Zugriffs-Entscheidung (Issue #37).
- **Cache-Key:** unverändert (Keys sind Strings); Gegentest wie § 3.6.

### 4.3 Abgrenzung

Phase 2 beginnt erst, wenn Phase 1 fertig ist — sie erbt den gemeinsamen Matcher, das
NFA-Traversal und die Testinfrastruktur. Lesart C (mehrere verstreute Dateien als EIN
Modul) bleibt Non-Goal; Regel 1 erzeugt bewusst **ein Modul pro Treffer-Datei**.

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

**Phase 2 zusätzlich:** Datei-Modul-Discovery (Terminal-Knoten, Datei+Verzeichnis-Mix
aus einem Key, `**`-Kombination), Tagging mit Placeholder im Dateinamen, Exposure
(Datei-Modul importierbar, Nachbardatei-Import cross-module mit/ohne depRule),
`exports`-an-Datei-Key-Fehler, Barrel-Projekt-Fall (§ 4.1 Regel 7), `sheriff list`-
Ausgabe. Gleiche Spec-Orte, gleiche Mutationsprobe (Datei-Key entfernen → rot).

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

**Zusätzlich in Phase 2:** `find-module-paths.ts` (Datei-Pass auch im Barrel-Modus,
`ModulePathInfo`), `find-module-paths-without-barrel.ts` (Datei-Probe an
Terminal-Knoten), `module.ts` (Exposure-Ast + `kind: 'file'`), `create-modules.ts`
(Datei-Modul-Konstruktion, `exports`-Fehler), `api/get-project-data.ts` u. Ä.
(Ausgaben), Doku wie Phase 1.

---

## 8. Beantwortete Fragen (2026-08-05)

1. **Scope:** Phase 1 **und** Phase 2 werden umgesetzt, in dieser Reihenfolge.
   Datei-Module werden **implizit** erkannt (§ 4.1 Regel 1), kein `kind: 'file'`.
2. **`fs.readDirectory`:** filtert nichts (geprüft, `default-fs.ts:23-31`) —
   `node_modules`-/Dot-Skip ist Teil von Phase 1 (§ 3.2 Regel 9).
3. **`*`-Tagging-Drift:** separater `fix(core)`-Commit vor dem Feature (AP0).
4. **Companion-/Spec-Dateien:** keine Sonderbehandlung (§ 4.1 Regel 6).
5. **Vorgehen:** Tests zuerst (rot), Implementierung danach — pro Arbeitspaket.

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

Für Phase 2 gilt dieselbe Liste analog (Mutationsprobe: Datei-Modul-Key entfernen →
zugehöriger Test rot; bestehende Configs ohne Datei-Keys bit-identisch).

---

## 10. Arbeitspakete (Umsetzungsreihenfolge)

Jedes AP: erst Specs (rot, inkl. eingebauter Mutationsprobe über grüne Nachbartests),
dann Implementierung, dann atomarer Commit. Alt-Tests müssen nach jedem AP grün sein.

| AP | Inhalt | Commit |
|---|---|---|
| **AP0** ✅ | `*`-Tagging-Drift: rohes `*` matcht auch beim Tagging (§ 3.4) | `fix(core): match raw folder wildcards in tagging` |
| **AP1** ✅ | #56: Multi-Pattern-Descent in `traverseAndMatch` (alle matchenden Patterns verfolgen) | `fix(core): descend into all matching module patterns (#56)` |
| **AP2** ✅ | Phase 1: `**` in Discovery (NFA) + Tagging + Spezifität, `node_modules`-Skip, Doku | `feat(core): support ** globs in module paths` |
| **AP3** ✅ | Phase 2: Datei-Module (Endungs-Erkennung, Exposure, SH-023, Barrel-Modus), Doku, Release Notes | `feat(core): define single-file modules via file patterns` |

Anmerkung zu AP2: SH-023 ist in AP3 gelandet (`exports` an Datei-Modul-Keys) — für `**`
selbst war keine Validierung nötig, jede Key-Form hat wohldefinierte Semantik (Regel 1).
Der Bench aus der DoD ist nachgezogen: `tools/perf` hat zwei Barrel-less-Glob-Szenarien
(`1.8k-glob`, `9k-glob`) mit `'src/app/**/<type>'`-Config; ohne `**` in der Config ist
der Traversal-Aufwand unverändert (identische Baumbeschneidung).
