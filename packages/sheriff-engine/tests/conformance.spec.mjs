import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { noDependencies } from '../../core/src/lib/checks/no-dependencies';
import { sameTag } from '../../core/src/lib/checks/same-tag';
import { tsConfig } from '../../core/src/lib/test/fixtures/ts-config';
import { createProject } from '../../core/src/lib/test/project-creator';
import { sheriffConfig } from '../../core/src/lib/test/project-configurator';
import { generateOracle } from '../../core/src/tools/engine-oracle';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nativePath = path.join(
  packageDir,
  'native',
  `sheriff-engine.${process.platform}-${process.arch}.node`,
);
const enabled =
  process.env.SHERIFF_ENGINE_NATIVE === '1' && existsSync(nativePath);
const require = createRequire(import.meta.url);

const fixtures = [
  {
    name: 'barrel modules and deep imports',
    entry: '/project',
    config: {
      modules: { 'src/feature': 'type:feature' },
      depRules: { '*': '*' },
      entryFile: 'src/main.ts',
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./feature', './feature/internal.ts'],
        feature: {
          'index.ts': ['./public.ts'],
          'public.ts': [],
          'internal.ts': [],
        },
      },
    },
  },
  {
    name: 'barrel-less encapsulation',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      },
      depRules: { '*': '*' },
      enableBarrelLess: true,
      encapsulationPattern: 'private',
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': [
          './customer/feature/customer.ts',
          './customer/data/private/secret.ts',
        ],
        customer: {
          feature: { 'customer.ts': ['../data/public.ts'] },
          data: {
            'public.ts': [],
            private: { 'secret.ts': [] },
          },
        },
      },
    },
  },
  {
    name: 'placeholder tags and dependency violations',
    entry: '/project/src/main.ts',
    config: {
      modules: {
        'src/<domain>/<type>': ['domain:<domain>', 'type:<type>'],
      },
      depRules: {
        root: 'type:feature',
        'domain:*': sameTag,
        'type:feature': 'type:data',
        'type:data': noDependencies,
      },
      denyRules: { 'type:feature': 'type:data' },
    },
    tree: {
      'tsconfig.json': tsConfig(),
      src: {
        'main.ts': ['./customers/feature'],
        customers: {
          feature: { 'index.ts': ['../data', '../../holidays/data'] },
          data: { 'index.ts': [] },
        },
        holidays: { data: { 'index.ts': [] } },
      },
    },
  },
  {
    name: 'external and unresolvable imports',
    entry: '/project/src/main.ts',
    config: {
      modules: { 'src/domain': 'type:domain' },
      depRules: { '*': '*' },
      externalRules: { 'type:domain': ['@angular/*'] },
      enableBarrelLess: true,
    },
    tree: {
      'tsconfig.json': tsConfig(),
      node_modules: {
        '@angular': { core: { 'index.ts': [] } },
        rxjs: { 'index.ts': [] },
      },
      src: {
        'main.ts': ['./domain/booking.ts'],
        domain: {
          'booking.ts': ['rxjs', '@angular/core', './missing.ts'],
        },
      },
    },
  },
];

describe.skipIf(!enabled).sequential('sheriff Rust engine conformance', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      createProject({
        ...fixture.tree,
        'sheriff.config.ts': sheriffConfig(fixture.config),
      });
      const oracle = generateOracle(fixture.entry);
      const input = createEngineInput(oracle, fixture.config);
      const { analyzeProject } = require('../index.js');
      const output = JSON.parse(analyzeProject(JSON.stringify(input)));

      expect(output.error).toBeUndefined();
      expect({
        modules: output.modules,
        violations: output.violations,
      }).toEqual({ modules: oracle.modules, violations: oracle.violations });
    });
  }
});

function createEngineInput(oracle, config) {
  return {
    schemaVersion: 1,
    rootDir: oracle.rootDir,
    files: oracle.files.map(({ path: filePath, imports }) => ({
      path: filePath,
      imports,
    })),
    modulePaths: oracle.modules
      .filter((module) => module.path !== '.')
      .map((module) => ({ path: module.path, isBarrel: module.isBarrel })),
    moduleConfig: config.modules ?? {},
    autoTagging: config.autoTagging ?? true,
    depRules: staticDependencyRules(config.depRules, oracle.modules),
    denyRules: staticDependencyRules(config.denyRules ?? {}, oracle.modules),
    externalRules: config.externalRules ?? {},
    encapsulationPattern: config.encapsulationPattern ?? 'internal',
    enableBarrelLess: config.enableBarrelLess ?? false,
    excludeRoot: config.excludeRoot ?? false,
    barrelFileName: config.barrelFileName ?? 'index.ts',
  };
}

function staticDependencyRules(rules, modules) {
  const output = {};
  const knownTags = new Set(modules.flatMap((module) => module.tags));

  for (const [fromPattern, rawMatchers] of Object.entries(rules)) {
    const matchers = Array.isArray(rawMatchers) ? rawMatchers : [rawMatchers];
    if (matchers.some((matcher) => typeof matcher === 'function')) {
      if (matchers.length !== 1 || matchers[0] !== sameTag) {
        throw new TypeError(
          `Conformance input cannot lower function rule ${fromPattern}`,
        );
      }
      for (const tag of knownTags) {
        if (wildcardMatch(fromPattern, tag)) output[tag] = tag;
      }
      continue;
    }
    output[fromPattern] = rawMatchers;
  }
  return output;
}

function wildcardMatch(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(value);
}
