import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { calcTagsForModule } from '../../tags/calc-tags-for-module';
import { toFsPath } from '../../file-info/fs-path';

/**
 * #72: placeholder matchers were compiled to unanchored, unescaped regexes.
 * `feat-<name>` must only tag directories that fully match the pattern
 * (`feat-booking`, not `my-feat-x`) and literal regex metacharacters in a
 * matcher (`+feat-<name>`) must be taken literally instead of being live
 * regex syntax.
 */
function projectInfoFor(modules: UserSheriffConfig['modules']) {
  return testInit('src/main.ts', {
    'tsconfig.json': tsConfig(),
    'sheriff.config.ts': sheriffConfig({
      depRules: { '*': '*' },
      modules,
    }),
    src: {
      'main.ts': [],
      'feat-booking': { 'index.ts': [] },
      'my-feat-x': { 'index.ts': [] },
      '+feat-customers': { 'index.ts': [] },
    },
  });
}

function tagsFor(moduleDir: string, modules: UserSheriffConfig['modules']) {
  const projectInfo = projectInfoFor(modules);
  return calcTagsForModule(
    toFsPath(moduleDir),
    projectInfo.rootDir,
    projectInfo.config.modules,
    projectInfo.config.autoTagging,
  );
}

describe('placeholder matcher anchoring', () => {
  const modules = { src: { 'feat-<name>': 'feature:<name>' } };

  it('should not tag a directory that only contains the matcher', () => {
    expect(tagsFor('/project/src/my-feat-x', modules)).toEqual(['noTag']);
  });

  it('should tag a directory that fully matches the matcher', () => {
    expect(tagsFor('/project/src/feat-booking', modules)).toEqual([
      'feature:booking',
    ]);
  });

  it('should treat regex metacharacters in the matcher literally', () => {
    expect(
      tagsFor('/project/src/+feat-customers', {
        src: { '+feat-<name>': 'feature:<name>' },
      }),
    ).toEqual(['feature:customers']);
  });
});
