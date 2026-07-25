import {
  anyTag,
  noDependencies,
  sameTag,
  SheriffConfig,
} from '@lambda-solutions/sheriff-core';

type Modules = NonNullable<SheriffConfig['modules']>;

/**
 * Scenario (h): the SAME slice shape and the SAME depRules as the project's
 * own `sheriff.config.ts` — it must stay a faithful copy, so that the runs
 * differ ONLY in the three settings below:
 *
 *   moduleIdentity: 'config'  — only the `modules` configuration creates
 *                               modules; a barrel file never does.
 *   barrelPolicy:   'forbid'  — a stray barrel is still reported, INCLUDING
 *   allowBarrelsIn: ['**\/api'] one that no longer creates a module.
 *
 * Copied in as sheriff.config.ts by integration-test.sh and removed again.
 */
const slice = (path: string, scope: string): Modules => ({
  [path]: [scope, 'type:feature', 'entry'],
  [`${path}/types`]: [scope, 'type:types'],
  [`${path}/utils`]: [scope, 'type:utils'],
  [`${path}/api`]: [scope, 'type:api', 'port'],
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

export const config: SheriffConfig = {
  enableBarrelLess: true,
  moduleIdentity: 'config',
  barrelPolicy: 'forbid',
  // the deliberate bucket-level port barrel stays legal
  allowBarrelsIn: ['**/api'],

  modules: {
    ...slice('apps/<app>/src/app/domains/<domain>', 'domain:<domain>'),
    ...slice('libs/domains/<domain>/src', 'domain:<domain>'),
  },

  depRules: {
    root: (ctx) => ctx.to === 'entry',
    noTag: noDependencies,

    entry: anyTag,
    port: anyTag,
    'feat-port': anyTag,

    'type:types': noDependencies,
    'type:utils': ['type:types', 'type:utils'],
    'type:api': ['type:types', 'type:utils', 'type:api'],
    'type:infra': ['type:types', 'type:utils', 'type:api', 'type:infra'],
    'type:data': ['type:types', 'type:utils', 'type:api', 'type:data'],
    'type:ui': ['type:types', 'type:utils', 'type:ui'],
    'type:feature': ({ to, fromFilePath }) =>
      to.startsWith('type:') &&
      (to !== 'type:infra' || !inAnyFeat(fromFilePath)),

    'domain:*': [
      (ctx) =>
        ctx.to.startsWith('domain:') &&
        ctx.from.split(':')[1] === ctx.to.split(':')[1],
      (ctx) => ctx.to === 'port',
    ],

    'feat:*': [
      sameTag,
      ({ toModulePath }) => !inAnyFeat(toModulePath),
      ({ to }) => to === 'feat-port',
    ],
  },
};
