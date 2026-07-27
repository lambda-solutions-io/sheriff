import {
  anyTag,
  defineConfig,
  noDependencies,
  sameTag,
  SheriffConfig,
} from '@lambda-solutions/sheriff-core';

type Modules = NonNullable<SheriffConfig['modules']>;

/**
 * Trimmed down from a real consumer's `@berger-engineering/sheriff-blueprint`
 * package (see the sheriff-demos repo, branch feat/inverted-domain-ports,
 * docs/architecture.md). Everything is a "slice" with the SAME internal
 * layer matrix; access from outside a slice only through a port:
 *
 *   <domain>/api/   -> tag `port`      PUBLIC PORT of the domain — contract
 *                                      only (interface/abstract class), no
 *                                      implementation.
 *   <domain>/infra/ -> type:infra      the port's IMPLEMENTATION. Not tagged
 *                                      `port`, so it is invisible outside the
 *                                      slice. `type:api` has no clearance
 *                                      towards `type:infra` — the dependency
 *                                      inversion is structural, not a matter
 *                                      of discipline.
 *   <domain>/feat-<feat>/  -> private sub-slice, same shape, own `api/`
 *                             tagged `feat-port` (visible to sibling feats
 *                             only, never outside the domain).
 *
 * The SAME `slice()` shape is applied to an app-internal domain
 * (apps/<app>/src/app/domains/<domain>) and an extracted Nx lib
 * (libs/domains/<domain>/src) — extraction is a folder move, not a rule
 * change; nothing here is app- or lib-specific.
 */
const slice = (path: string, scope: string): Modules => ({
  [path]: [scope, 'type:feature', 'entry'], // <slice>.routes.ts / .providers.ts
  [`${path}/types`]: [scope, 'type:types'],
  [`${path}/utils`]: [scope, 'type:utils'],
  // PUBLIC PORT: contract only. Consumers (own data/, foreign domains) bind
  // to this and nothing else.
  [`${path}/api`]: [scope, 'type:api', 'port'],
  // The port's implementation — NOT tagged `port`, invisible outside slice.
  [`${path}/infra`]: [scope, 'type:infra'],
  [`${path}/data`]: [scope, 'type:data'],
  [`${path}/ui`]: [scope, 'type:ui'],
  [`${path}/feat-<feat>`]: [scope, 'feat:<feat>', 'type:feature'],
  [`${path}/feat-<feat>/types`]: [scope, 'feat:<feat>', 'type:types'],
  [`${path}/feat-<feat>/utils`]: [scope, 'feat:<feat>', 'type:utils'],
  [`${path}/feat-<feat>/api`]: [scope, 'feat:<feat>', 'type:api', 'feat-port'],
  [`${path}/feat-<feat>/infra`]: [scope, 'feat:<feat>', 'type:infra'],
  [`${path}/feat-<feat>/data`]: [scope, 'feat:<feat>', 'type:data'],
  [`${path}/feat-<feat>/ui`]: [scope, 'feat:<feat>', 'type:ui'],
});

/** `feat-<name>/` is load-bearing: it drives the path-based feat isolation. */
const inAnyFeat = (path: string): boolean => /\/feat-[^/]+(\/|$)/.test(path);

export const config = defineConfig({
  enableBarrelLess: true,
  // encapsulationPattern: 'internal' is the default — every module gets a
  // private top-level `internal/` folder for free, module-private, no tag
  // needed. NOTE: only the TOP level counts, see data/foo/internal/ below.

  // CLI cross-check per project (ESLint would be the authority in a real
  // consumer repo; this test project only exercises the CLI).
  entryPoints: {
    client: 'apps/client/src/main.ts',
    'domain-booking': 'libs/domains/booking/src/booking.routes.ts',
  },

  modules: {
    ...slice('apps/<app>/src/app/domains/<domain>', 'domain:<domain>'),
    ...slice('libs/domains/<domain>/src', 'domain:<domain>'),
  },

  depRules: {
    // main.ts only composes slices via their entry (routes/providers).
    root: (ctx) => ctx.to === 'entry',
    noTag: noDependencies, // unconfigured modules surface immediately

    // marker tags are transparent as FROM tags — constraints come from the
    // other axes (AND semantics across every tag of the importing module)
    entry: anyTag,
    port: anyTag,
    'feat-port': anyTag,

    // type axis — the layer matrix within a slice
    'type:types': noDependencies,
    'type:utils': ['type:types', 'type:utils'],
    // The port is a CONTRACT: it may name its own types, never its impl.
    'type:api': ['type:types', 'type:utils', 'type:api'],
    // The impl side: implements the contract. May NOT reach data/ or ui/.
    'type:infra': ['type:types', 'type:utils', 'type:api', 'type:infra'],
    // Stores bind to the PORT, never to infra directly.
    'type:data': ['type:types', 'type:utils', 'type:api', 'type:data'],
    'type:ui': ['type:types', 'type:utils', 'type:ui'], // NOT api, NOT data
    // Smart containers: broad by design — but NOT towards `type:infra`,
    // unless this IS the slice root (not a feat-<x>/) wiring its own impl.
    'type:feature': ({ to, fromFilePath }) =>
      to.startsWith('type:') &&
      (to !== 'type:infra' || !inAnyFeat(fromFilePath)),

    // scope axis — own domain freely, foreign domain only via its port
    'domain:*': [
      (ctx) => ctx.to.startsWith('domain:') && ctx.from.split(':')[1] === ctx.to.split(':')[1],
      (ctx) => ctx.to === 'port',
    ],

    // feat axis — feats are private towards their siblings
    'feat:*': [
      sameTag, // own feat
      ({ toModulePath }) => !inAnyFeat(toModulePath), // domain-shared modules
      ({ to }) => to === 'feat-port', // sibling feats only via their api
    ],
  },
});
