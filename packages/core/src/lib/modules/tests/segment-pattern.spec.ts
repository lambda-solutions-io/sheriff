import { describe, expect, it } from 'vitest';
import { matchesFolderPathGlob } from '../internal/segment-pattern';

describe('matchesFolderPathGlob', () => {
  it.each([
    // exact segments
    ['src/api', 'src/api', true],
    ['src/api', 'src/ui', false],
    ['src/api', 'src/api/sub', false],
    ['src/api/sub', 'src/api', false],
    // single-segment wildcard stays segment-local
    ['src/*/api', 'src/customers/api', true],
    ['src/*/api', 'src/customers/sub/api', false],
    // partial wildcards match digits and dots (#46)
    ['src/feat-*', 'src/feat-v2', true],
    ['src/domain-*/api', 'src/domain-2/api', true],
    ['src/lib-*', 'src/lib-v2.5', true],
    ['src/feat-*', 'src/other-v2', false],
    // globstar matches any number of segments, including none
    ['**/api', 'api', true],
    ['**/api', 'src/api', true],
    ['**/api', 'libs/domains/booking/src/api', true],
    ['**/api', 'src/api/sub', false],
    ['**/api', 'src/apis', false],
    // globstar in the middle and at the end
    ['libs/**/api', 'libs/api', true],
    ['libs/**/api', 'libs/domains/booking/api', true],
    ['libs/**/api', 'apps/domains/booking/api', false],
    ['src/**', 'src', true],
    ['src/**', 'src/a/b', true],
    ['src/**', 'lib/a', false],
    ['**', 'any/path/at/all', true],
    // windows separators are normalized
    ['src\\api', 'src/api', true],
    // leading/trailing separators in the pattern are ignored
    ['src/api/', 'src/api', true],
    ['/src/api', 'src/api', true],
    ['/src/api/', 'src/api', true],
    ['src\\api\\', 'src/api', true],
    ['**/api/', 'libs/booking/api', true],
  ])('should match %s against %s -> %s', (pattern, path, expected) => {
    expect(matchesFolderPathGlob(pattern, path)).toBe(expected);
  });
});
