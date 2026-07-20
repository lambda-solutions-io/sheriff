import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { UserSheriffConfig } from '../../core/src/lib/config/user-sheriff-config';
import { generateOracle } from '../../core/src/tools/engine-oracle';
import type { EngineOracle } from '../../core/src/tools/engine-oracle';
import {
  createOracleFixture,
  oracleFixtures,
} from '../../core/src/tools/tests/oracle-fixtures';
import type {
  EngineErrorOutput,
  EngineInput,
  EngineOutput,
} from '../index.js';

const require = createRequire(import.meta.url);
const { analyzeProject } = require('../index.js') as typeof import('../index.js');
const { nativeBinaryName } = require('../platform.js') as {
  nativeBinaryName: () => string;
};
const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const nativePath = path.join(packageDir, 'native', nativeBinaryName());
const nativeRequested = process.env.SHERIFF_ENGINE_NATIVE === '1';
const nativeAvailable = existsSync(nativePath);
const nativeEnabled = nativeRequested && nativeAvailable;
const nativeSkipReason = nativeRequested
  ? `native artefact absent at ${nativePath}`
  : 'SHERIFF_ENGINE_NATIVE is not set to 1';

reportScenarioPlan();

describe
  .skipIf(!nativeEnabled)
  .sequential(
    `sheriff Rust engine conformance${nativeEnabled ? '' : ` — ${nativeSkipReason}`}`,
    () => {
      for (const fixture of oracleFixtures) {
        const functionPaths = findFunctionPaths(fixture.config);
        if (functionPaths.length > 0) {
          it.skip(
            `${fixture.name} — requires R3 function-rule materialisation (${functionPaths.join(', ')})`,
            () => {},
          );
          continue;
        }

        it(fixture.name, () => {
          createOracleFixture(fixture);
          const oracle = generateOracle(fixture.entry);
          const input = createEngineInput(oracle, fixture.config);
          const output = JSON.parse(analyzeProject(input)) as
            | EngineOutput
            | EngineErrorOutput;

          expect(output).not.toHaveProperty('error');
          if ('error' in output) return;

          expect({
            modules: output.modules,
            violations: output.violations,
          }).toEqual({
            modules: oracle.modules,
            violations: oracle.violations,
          });
        });
      }
    },
  );

function createEngineInput(
  oracle: EngineOracle,
  config: UserSheriffConfig,
): EngineInput {
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
    moduleConfig: (config.modules ?? {}) as EngineInput['moduleConfig'],
    autoTagging: config.autoTagging ?? true,
    depRules: config.depRules as EngineInput['depRules'],
    denyRules: (config.denyRules ?? {}) as EngineInput['denyRules'],
    externalRules: (config.externalRules ?? {}) as EngineInput['externalRules'],
    encapsulationPattern: config.encapsulationPattern ?? 'internal',
    enableBarrelLess: config.enableBarrelLess ?? false,
    excludeRoot: config.excludeRoot ?? false,
    barrelFileName: config.barrelFileName ?? 'index.ts',
  };
}

function findFunctionPaths(
  value: unknown,
  currentPath = 'config',
  seen = new Set<object>(),
): string[] {
  if (typeof value === 'function') return [currentPath];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];

  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findFunctionPaths(entry, `${currentPath}[${index}]`, seen),
    );
  }

  return Object.entries(value).flatMap(([key, entry]) =>
    findFunctionPaths(entry, `${currentPath}.${key}`, seen),
  );
}

function reportScenarioPlan(): void {
  for (const fixture of oracleFixtures) {
    const functionPaths = findFunctionPaths(fixture.config);
    const status =
      functionPaths.length > 0
        ? `SKIPPED — requires R3 function-rule materialisation (${functionPaths.join(', ')})`
        : nativeEnabled
          ? 'RUN'
          : `SKIPPED — ${nativeSkipReason}`;
    console.info(`[sheriff-engine conformance] ${status}: ${fixture.name}`);
  }
}
