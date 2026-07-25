import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { hasEncapsulationViolations } from '../has-encapsulation-violations';
import { toFsPath } from '../../file-info/fs-path';

/**
 * Characterization tests for a real-world layout observed in a consumer
 * repo (sheriff-demos, branch feat/inverted-domain-ports): a workspace with
 * `enableBarrelLess: true` that still contains real barrel files at the
 * bucket level (`.../api/index.ts`), plus an `internal/` bucket
 * (`.../data/internal`).
 *
 * Each "domain" is broken into bucket-level modules (`api`, `data`,
 * `feature`, ...) - the module boundary is the bucket folder, not the
 * domain folder - which is exactly the shape that makes the `api` bucket's
 * `index.ts` turn it into a barrel module even though the workspace is
 * barrel-less overall (see `findModulePathsWithBarrel`, which scans every
 * directory for the configured barrel filename independently of the
 * `modules` config / `enableBarrelLess`).
 *
 * The same bucket layout is duplicated once under `libs/domains/<domain>`
 * and once under `apps/client/src/app/domains/<domain>` to prove
 * `hasEncapsulationViolations` treats both identically - there is nothing
 * in `Module.exposes` that special-cases app-internal vs. extracted-lib
 * paths.
 */
function domainFileTree() {
  return {
    api: {
      // A stray `index.ts` inside an `enableBarrelLess` workspace: this
      // bucket becomes a barrel module, not a barrel-less one.
      'index.ts': ['./port.ts'],
      'port.ts': [],
    },
    data: {
      'store.ts': [],
      internal: {
        'mapper.ts': [],
      },
    },
    feature: {
      'feature.ts': [
        '../api/index.ts',
        '../api/port.ts',
        '../data/store.ts',
        '../data/internal/mapper.ts',
      ],
    },
  };
}

function createProjectInfo() {
  return testInit('main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      modules: {
        'libs/domains/<domain>/<bucket>': ['domain:<domain>', 'type:<bucket>'],
        'apps/client/src/app/domains/<domain>/<bucket>': [
          'domain:<domain>',
          'type:<bucket>',
        ],
      },
      depRules: { '*': '*' },
      enableBarrelLess: true,
    } as UserSheriffConfig),
    'main.ts': [
      './libs/domains/lib-domain/feature/feature.ts',
      './apps/client/src/app/domains/app-domain/feature/feature.ts',
    ],
    libs: {
      domains: {
        'lib-domain': domainFileTree(),
      },
    },
    apps: {
      client: {
        src: {
          app: {
            domains: {
              'app-domain': domainFileTree(),
            },
          },
        },
      },
    },
  });
}

function violatedImportsFor(featureFilePath: string) {
  const projectInfo = createProjectInfo();
  return Object.keys(
    hasEncapsulationViolations(toFsPath(featureFilePath), projectInfo),
  );
}

const LIB_FEATURE = '/project/libs/domains/lib-domain/feature/feature.ts';
const APP_FEATURE =
  '/project/apps/client/src/app/domains/app-domain/feature/feature.ts';

describe('encapsulation across mixed barrel modes (barrel-less workspace with real barrel buckets)', () => {
  it("a) allows importing another barrel-less module's non-encapsulated file", () => {
    // `data/store.ts` is not under `data/internal`, so the barrel-less
    // `data` module exposes it to the `feature` module.
    expect(violatedImportsFor(LIB_FEATURE)).not.toContain('../data/store.ts');
  });

  it('b) reports a violation for an import of a file under internal/', () => {
    expect(violatedImportsFor(LIB_FEATURE)).toContain(
      '../data/internal/mapper.ts',
    );
  });

  it('c) stray index.ts: a bucket with an index.ts becomes a barrel module - deep import is a violation, importing the barrel is allowed (issue #31, finding 3)', () => {
    // This is the exact scenario PR #38 exists for: `api/` was not declared
    // as a barrel module anywhere, it merely happens to contain an
    // `index.ts`. `Module.exposes` must treat it as a barrel module
    // regardless, i.e. only `api/index.ts` is importable from `feature`,
    // not `api/port.ts` directly.
    const violations = violatedImportsFor(LIB_FEATURE);
    expect(violations).toContain('../api/port.ts');
    expect(violations).not.toContain('../api/index.ts');
  });

  it('d) treats an app-internal domain and an extracted lib with identical bucket structure identically', () => {
    // Same relative imports, same bucket shape, only the path prefix
    // differs (`apps/client/src/app/domains/...` vs `libs/domains/...`).
    // `Module.exposes` has no notion of "app" or "lib" - the violations
    // must come out exactly the same for both.
    expect(violatedImportsFor(APP_FEATURE)).toEqual(
      violatedImportsFor(LIB_FEATURE),
    );
    expect(violatedImportsFor(APP_FEATURE)).toEqual([
      '../api/port.ts',
      '../data/internal/mapper.ts',
    ]);
  });
});
