# @lambda-solutions/sheriff-ui

Live module-graph UI plugin for [Sheriff](https://github.com/michaelbe812/sheriff).

Serves a browser UI that renders the project's module/dependency graph and
keeps it current: the page polls the sheriff daemon, whose filesystem watcher
invalidates the analysis cache on every change.

## Usage

```ts
// sheriff.config.ts
import { SheriffConfig } from '@lambda-solutions/sheriff-core';
import { SheriffUiPlugin } from '@lambda-solutions/sheriff-ui';

export const config: SheriffConfig = {
  // ...
  plugins: [new SheriffUiPlugin()],
};
```

```sh
npx sheriff ui                     # serve UI at http://localhost:7654, open browser
npx sheriff ui --port 8080         # custom port
npx sheriff ui --no-open           # do not open the browser
npx sheriff ui --entry-file src/main.ts
npx sheriff ui --json              # print one graph snapshot as JSON and exit
```

Constructor options: `new SheriffUiPlugin({ port, open })`.

## Features

- Module-level graph: files aggregated into modules, edges = cross-module
  imports (weighted), tag-based coloring
- Drill-down: expand a module to its files and file-level edges
- Violations overlay: `verify` results highlight offending modules/edges in
  red with details in a side panel
- External libraries as separate, toggleable nodes
- Live updates via hash-based polling; a paused daemon is respawned on demand

## Third-party

The UI bundles [Cytoscape.js](https://js.cytoscape.org/) 3.34.0 (MIT license,
see `public/vendor/CYTOSCAPE-LICENSE`) as `public/vendor/cytoscape.min.js`.
