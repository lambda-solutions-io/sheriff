import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { hasEncapsulationViolations } from '../has-encapsulation-violations';
import { toFsPath } from '../../file-info/fs-path';

/**
 * Regression tests for issue #70: barrel discovery matched the configured
 * barrel filename case-insensitively while `Module.exposes` compares the
 * barrel path case-sensitively. A case-variant barrel file (e.g. `index.ts`
 * on disk with `barrelFileName: 'Index.ts'`) therefore produced a barrel
 * module whose own barrel was never exposed - every import of that module
 * was an unsatisfiable violation.
 *
 * Chosen semantics: discovery is case-SENSITIVE, matching the exposure
 * side and TypeScript import semantics. A case-variant file is simply not
 * a barrel; its directory falls back to the surrounding module.
 */
function violatedImportsForMain() {
  const projectInfo = testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      depRules: { '*': '*' },
      barrelFileName: 'Index.ts',
    }),
    src: {
      'main.ts': [
        './customers/index.ts',
        './holidays/Index.ts',
        './holidays/holiday.component.ts',
      ],
      customers: {
        // case variant of the configured barrel filename -> NOT a barrel
        'index.ts': ['./customer.component.ts'],
        'customer.component.ts': [],
      },
      holidays: {
        // exact-case match of the configured barrel filename -> barrel
        'Index.ts': ['./holiday.component.ts'],
        'holiday.component.ts': [],
      },
    },
  });

  return Object.keys(
    hasEncapsulationViolations(toFsPath('/project/src/main.ts'), projectInfo),
  );
}

describe('barrel discovery vs. exposure casing (issue #70)', () => {
  it('does not turn a case-variant barrel file into a barrel module; its files stay importable via the root module', () => {
    // Before the fix, `customers` was discovered as a barrel module whose
    // barrel path (`Index.ts`) never matched the actual file (`index.ts`):
    // the module exposed nothing, including its own barrel.
    expect(violatedImportsForMain()).not.toContain('./customers/index.ts');
  });

  it('discovers an exact-case barrel and exposes the barrel itself', () => {
    expect(violatedImportsForMain()).not.toContain('./holidays/Index.ts');
  });

  it('reports a deep import into an exact-case barrel module as a violation', () => {
    expect(violatedImportsForMain()).toContain(
      './holidays/holiday.component.ts',
    );
  });
});
