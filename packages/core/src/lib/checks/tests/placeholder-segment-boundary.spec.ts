import { describe, expect, it } from 'vitest';
import { testInit } from '../../test/test-init';
import { tsConfig } from '../../test/fixtures/ts-config';
import { sheriffConfig } from '../../test/project-configurator';
import { UserSheriffConfig } from '../../config/user-sheriff-config';
import { calcTagsForModule } from '../../tags/calc-tags-for-module';
import { toFsPath } from '../../file-info/fs-path';

/**
 * #72 follow-up: a placeholder matches exactly one path segment
 * (`src/lib/<domain>` docs semantics). `<domain>` must never swallow a path
 * separator and capture 'a/b'; a deeper directory is simply not a match for
 * the matcher, only the directory at the matcher's depth is tagged.
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
      lib: {
        a: {
          'index.ts': [],
          b: { 'index.ts': [] },
        },
      },
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

describe('placeholder segment boundary', () => {
  const modules = { 'src/lib/<domain>': 'domain:<domain>' };

  it('should tag the directory at the matcher depth with one segment', () => {
    expect(tagsFor('/project/src/lib/a', modules)).toEqual(['domain:a']);
  });

  it('should not let a placeholder capture across segments for deeper directories', () => {
    // over-capture would yield 'domain:a/b'
    expect(tagsFor('/project/src/lib/a/b', modules)).toEqual(['noTag']);
  });
});
