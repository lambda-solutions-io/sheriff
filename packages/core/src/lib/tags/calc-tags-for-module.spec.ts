import { calcTagsForModule } from './calc-tags-for-module';
import { describe, expect, it } from 'vitest';
import { FsPath } from '../file-info/fs-path';
import throwIfNull from '../util/throw-if-null';
import {
  ExistingTagPlaceholderError,
  InvalidPlaceholderError,
  NoAssignedTagError,
  TagWithoutValueError,
} from '../error/user-error';
import '../test/expect.extensions';

describe('calc tags for module', () => {
  const root = '/project' as FsPath;
  it('should identify root as root', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        abc: 'domain:abc',
      }),
    ).toEqual(['root']);
  });

  it('should calc for static value', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        abc: 'domain:abc',
      }),
    ).toEqual(['domain:abc']);
  });

  it('should match directory names with a - and +', () => {
    const moduleDir = '/project/+feat-booking' as FsPath;
    expect(
      calcTagsForModule(moduleDir, root, {
        '+feat-booking': 'feature:booking',
      }),
    ).toEqual(['feature:booking']);
  });

  it('should support digits in placeholder names', () => {
    const moduleDir = '/project/app-v2' as FsPath;
    expect(
      calcTagsForModule(moduleDir, root, {
        'app-<v2>': 'tag:<v2>',
      }),
    ).toEqual(['tag:v2']);
  });

  it('multiple tags', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        abc: ['domain:abc', 'type:generic'],
      }),
    ).toEqual(['domain:abc', 'type:generic']);
  });

  it('should throw if leaf has not tags', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc/def/ghj' as FsPath;

    expect(() =>
      calcTagsForModule(moduleDir, rootDir, {
        abc: {
          def: {
            ghj: {},
          },
        },
      }),
    ).toThrowUserError(new TagWithoutValueError('abc/def/ghj'));
  });

  it('should allow a function returning a string', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        abc: (_, { segment }) => `module:${segment}`,
      }),
    ).toEqual(['module:abc']);
  });

  it('should allow a function returning a string array', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        abc: (_, { segment }) => [`domain:${segment}`, 'type:lib'],
      }),
    ).toEqual(['domain:abc', 'type:lib']);
  });

  it('should support regular expressions', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/abc' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '/(\\w+)/': (_, { regexMatch }) =>
          `domain:${throwIfNull(regexMatch)[0]}`,
      }),
    ).toEqual(['domain:abc']);
  });

  it('should support a placeholder', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>': ({ domain }) => `domain:${domain}`,
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should support a placeholder with a dash', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/app1/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>/<sub-domain>': (tags) => [
          `domain:${tags['domain']}:${tags['sub-domain']}`,
        ],
      }),
    ).toEqual(['domain:app1:holidays']);
  });

  it('should support a placeholder with a dash underscore', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/app1/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<app-lib>/<_domain>': 'domain:<app-lib>:<_domain>',
      }),
    ).toEqual(['domain:app1:holidays']);
  });

  it('should support placeholders in both matcher and tag value', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>': 'domain:<domain>',
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should support multiple placeholders', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/feat-bookings' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<type>-<subdomain>': ['type:<type>', 'subdomain:<subdomain>'],
      }),
    ).toEqual(['type:feat', 'subdomain:bookings']);
  });

  it('should throw if a placeholder in the tag value does not exist', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/feat-bookings' as FsPath;

    expect(() =>
      calcTagsForModule(moduleDir, rootDir, {
        '<subdomain>': ['type:<type>', 'subdomain:<subdomain>'],
      }),
    ).toThrowUserError(
      new InvalidPlaceholderError('<type>', '/project/feat-bookings'),
    );
  });

  it('should support a full placeholder with directory names - or +', () => {
    const moduleDir = '/project/+feat-booking' as FsPath;
    expect(
      calcTagsForModule(moduleDir, root, {
        '<path>': 'feature:booking',
      }),
    ).toEqual(['feature:booking']);
  });

  it('should support a partial placeholder', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/feature-holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'feature-<domain>': ({ domain }) => `domain:${domain}`,
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should not match a partial placeholder inside a longer directory name', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/my-feat-x' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'feat-<name>': 'feature:<name>',
      }),
    ).toEqual(['noTag']);
  });

  it('should not match when the directory only starts with the matcher', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays-feature' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>-feat': 'domain:<domain>',
      }),
    ).toEqual(['noTag']);
  });

  it('should treat regex metacharacters in placeholder matchers literally', () => {
    const moduleDir = '/project/+feat-booking' as FsPath;

    expect(
      calcTagsForModule(moduleDir, root, {
        '+feat-<name>': 'feature:<name>',
      }),
    ).toEqual(['feature:booking']);
  });

  it('should not let a placeholder capture across path separators', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/libs/a/b' as FsPath;

    // <domain> is per-segment: it must never capture 'a/b'; 'libs/<domain>'
    // matches 'libs/a', the leftover segment 'b' makes it a non-match.
    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'libs/<domain>': 'domain:<domain>',
      }),
    ).toEqual(['noTag']);
  });

  it('should match a placeholder to exactly one segment in multi-segment matchers', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/libs/a/b/src' as FsPath;

    // over-capture would yield domain 'a/b'; per-segment semantics: no match
    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'libs/<domain>/src': 'domain:<domain>',
      }),
    ).toEqual(['noTag']);
  });

  it('should allow config key to have multiple paths', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src/app/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app/holidays': ['domain:holidays'],
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should return "noTag" on no match and enabled autoTagging', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app/holidays': { tags: ['domain:holidays'] },
      }),
    ).toEqual(['noTag']);
  });

  it('should throw an error if there is no match', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src' as FsPath;

    expect(() =>
      calcTagsForModule(
        moduleDir,
        rootDir,
        {
          'src/app/holidays': { tags: ['domain:holidays'] },
        },
        false,
      ),
    ).toThrowUserError(new NoAssignedTagError('/project/src'));
  });

  it('should skip rules that do not apply', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        customers: 'domain:customers',
        holidays: 'domain:holidays',
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should always pick the first rule that applies', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>': 'domain:holidays',
        holidays: 'scope:holidays',
      }),
    ).toEqual(['domain:holidays']);
  });

  it('should support multiple placeholders', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/domain/holidays/data' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'domain/<feature>/<type>': ({ feature, type }) => [
          `domain:${feature}`,
          `type:${type}`,
        ],
      }),
    ).toEqual(['domain:holidays', 'type:data']);
  });

  it('should allow nested paths', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src/app/domain/customers/ui' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app/domain': {
          '<domain>/<type>': ({ domain, type }) => [
            `domain:${domain}`,
            `type:${type}`,
          ],
        },
      }),
    ).toEqual(['domain:customers', 'type:ui']);
  });

  it('should allow nested paths with multiple matchers', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src/app/shared/ngrx-util' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app': {
          'shared/<type>': ({ type }) => [`type:${type}`],
          '<domain>/<type>': [],
        },
      }),
    ).toEqual(['type:ngrx-util']);
  });

  it('should support multiple partial placeholders', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir =
      '/project/src/app/domains/holidays/core/feature' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app': {
          domains: {
            '<domain>': {
              '<subDomain>': {
                '<type>': (placeholders) => [
                  `domain:${placeholders['domain']}`,
                  `subDomain:${placeholders['subDomain']}`,
                  `type:${placeholders['type']}`,
                ],
              },
            },
          },
        },
      }),
    ).toEqual(['domain:holidays', 'subDomain:core', 'type:feature']);
  });

  it('should return noTag on partial match', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/domain/holidays/feature' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        domain: '',
      }),
    ).toEqual(['noTag']);
  });

  it('should throw an error on partial match and disabled auto-tagging', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/domain/holidays/feature' as FsPath;

    expect(() =>
      calcTagsForModule(
        moduleDir,
        rootDir,
        {
          domain: '',
        },
        false,
      ),
    ).toThrowUserError(new NoAssignedTagError(moduleDir));
  });

  it('should throw an error if the placeholder already exists', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays/feature' as FsPath;

    expect(() =>
      calcTagsForModule(moduleDir, rootDir, {
        '<str>': {
          '<str>': ['noop'],
        },
      }),
    ).toThrowUserError(new ExistingTagPlaceholderError('str'));
  });

  it('should not treat a regex as catch-all matcher', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays-123' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '/(\\w+)/': 'regex',
        'holidays-123': 'simple match',
      }),
    ).toEqual(['simple match']);
  });

  it('should not treat a placeholder as catch-all matcher', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays-123' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<feature>_<id>': 'placeholder',
        'holidays-123': 'simple match',
      }),
    ).toEqual(['simple match']);
  });

  it('should match nested modules', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/libs/customers/src/lib/data' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'libs/customers': '',
        'libs/customers/src/lib/data': 'data',
      }),
    ).toEqual(['data']);
  });

  it('should not throw an error with nested modules and placeholders', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/libs/holidays/src/lib/data' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        libs: {
          '<domain>/src': 'nx-lib',
          '<domain>/src/lib/<type>': ['domain:<domain>', 'type:<type>'],
        },
      }),
    ).toEqual(['domain:holidays', 'type:data']);
  });

  it('should same placeholders in different configs', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/domain/holidays/data' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'domain/<feature>/<type>': ({ feature, type }) => [
          `domain:${feature}`,
          `type:${type}`,
        ],
      }),
    ).toEqual(['domain:holidays', 'type:data']);
  });

  it('should have the same placeholders in different rules rules', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/holidays/data' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        '<domain>': ['domain:holidays', 'type:feature'],
        '<domain>/data': ['domain:holidays', 'type:data'],
      }),
    ).toEqual(['domain:holidays', 'type:data']);
  });

  it('should treat tags plus another key as a nested module config', () => {
    const rootDir = '/project' as FsPath;
    const moduleDir = '/project/src/app/tags' as FsPath;

    expect(
      calcTagsForModule(moduleDir, rootDir, {
        'src/app': {
          tags: ['literal-tags-folder'],
          api: ['api'],
        },
      }),
    ).toEqual(['literal-tags-folder']);
  });

  // module discovery matches raw wildcards via matchesFolderSegmentPattern;
  // tagging must agree, otherwise a wildcard-defined module silently
  // becomes 'noTag' while the module itself exists (fail-open drift)
  describe('folder wildcards without placeholders', () => {
    const rootDir = '/project' as FsPath;

    it('should match a full wildcard segment', () => {
      expect(
        calcTagsForModule('/project/src/anything' as FsPath, rootDir, {
          'src/*': 'shared',
        }),
      ).toEqual(['shared']);
    });

    it('should match a partial wildcard segment', () => {
      expect(
        calcTagsForModule('/project/feat-booking' as FsPath, rootDir, {
          'feat-*': 'feature',
        }),
      ).toEqual(['feature']);
    });

    it('should match digits and dots like discovery does', () => {
      expect(
        calcTagsForModule('/project/feat-v2.1' as FsPath, rootDir, {
          'feat-*': 'feature',
        }),
      ).toEqual(['feature']);
    });

    it('should match a wildcard in a middle segment', () => {
      expect(
        calcTagsForModule('/project/libs/customers/data' as FsPath, rootDir, {
          'libs/*/data': ['type:data'],
        }),
      ).toEqual(['type:data']);
    });

    it('should not let a wildcard cross path separators', () => {
      expect(
        calcTagsForModule('/project/src/a/b' as FsPath, rootDir, {
          'src/*': 'shared',
        }),
      ).toEqual(['noTag']);
    });

    it('should combine a wildcard segment with a placeholder segment', () => {
      expect(
        calcTagsForModule('/project/libs/booking' as FsPath, rootDir, {
          '*/<domain>': ['domain:<domain>'],
        }),
      ).toEqual(['domain:booking']);
    });

    it('should combine a wildcard and a placeholder in the same segment', () => {
      expect(
        calcTagsForModule('/project/ui-buttons' as FsPath, rootDir, {
          '<type>-*': 'type:<type>',
        }),
      ).toEqual(['type:ui']);
    });

    it('should match wildcards in nested module configs', () => {
      expect(
        calcTagsForModule('/project/src/customers/data' as FsPath, rootDir, {
          src: {
            '*/data': ['type:data'],
          },
        }),
      ).toEqual(['type:data']);
    });

    it('should still not match a plain literal partially', () => {
      expect(
        calcTagsForModule('/project/source' as FsPath, rootDir, {
          src: 'shared',
        }),
      ).toEqual(['noTag']);
    });
  });

  // a `**` segment matches zero or more path segments, consistent with
  // matchesFolderPathGlob (allowBarrelsIn); `a**b` keeps its historical
  // single-segment wildcard meaning
  describe('recursive globs (**)', () => {
    const rootDir = '/project' as FsPath;

    it('should match any depth with a trailing **', () => {
      expect(
        calcTagsForModule('/project/libs/a/b' as FsPath, rootDir, {
          'libs/**': 'lib',
        }),
      ).toEqual(['lib']);
    });

    it('should match zero segments with a trailing **', () => {
      expect(
        calcTagsForModule('/project/libs' as FsPath, rootDir, {
          'libs/**': 'lib',
        }),
      ).toEqual(['lib']);
    });

    it('should match a segment after ** at any depth', () => {
      expect(
        calcTagsForModule('/project/libs/x/y/feature' as FsPath, rootDir, {
          'libs/**/feature': 'feat',
        }),
      ).toEqual(['feat']);
    });

    it('should match zero segments for ** in the middle', () => {
      expect(
        calcTagsForModule('/project/libs/feature' as FsPath, rootDir, {
          'libs/**/feature': 'feat',
        }),
      ).toEqual(['feat']);
    });

    it('should capture placeholders right of **', () => {
      expect(
        calcTagsForModule('/project/libs/a/b/booking/api' as FsPath, rootDir, {
          'libs/**/<domain>/api': ['domain:<domain>'],
        }),
      ).toEqual(['domain:booking']);
    });

    it('should backtrack ** until the rest of the matcher fits', () => {
      expect(
        calcTagsForModule('/project/a/m1/m2/n' as FsPath, rootDir, {
          'a/**/<p>': 'tag:<p>',
        }),
      ).toEqual(['tag:n']);
    });

    it('should extend a trailing ** into nested module configs', () => {
      expect(
        calcTagsForModule('/project/libs/z1/z2/data' as FsPath, rootDir, {
          'libs/**': { data: 'inner' },
        }),
      ).toEqual(['inner']);
    });

    it('should support ** inside nested module configs', () => {
      expect(
        calcTagsForModule('/project/src/x1/x2/data' as FsPath, rootDir, {
          src: { '**/data': 'd' },
        }),
      ).toEqual(['d']);
    });

    it('should collapse consecutive **', () => {
      expect(
        calcTagsForModule('/project/a/b' as FsPath, rootDir, {
          'a/**/**/b': 'x',
        }),
      ).toEqual(['x']);
    });

    it('should not match when the segment after ** differs', () => {
      expect(
        calcTagsForModule('/project/libs/a/apix' as FsPath, rootDir, {
          'libs/**/api': 'x',
        }),
      ).toEqual(['noTag']);
    });

    it('should keep first-match key order with overlapping ** keys', () => {
      expect(
        calcTagsForModule('/project/libs/a' as FsPath, rootDir, {
          'libs/**': 'generic',
          'libs/a': 'specific',
        }),
      ).toEqual(['generic']);
    });

    it('should throw for a placeholder that ** cannot provide', () => {
      expect(() =>
        calcTagsForModule('/project/libs/a' as FsPath, rootDir, {
          'libs/**': 'domain:<domain>',
        }),
      ).toThrowUserError(
        new InvalidPlaceholderError('<domain>', '/project/libs/a'),
      );
    });
  });

  // file modules: the module path is a file path; matchers work on the
  // filename segment like on any other segment
  describe('file module tagging', () => {
    const rootDir = '/project' as FsPath;

    it('should capture placeholders in the filename segment', () => {
      expect(
        calcTagsForModule('/project/src/stores/user.store.ts' as FsPath, rootDir, {
          'src/stores/<name>.store.ts': ['type:store', 'store:<name>'],
        }),
      ).toEqual(['type:store', 'store:user']);
    });

    it('should combine ** with a filename matcher', () => {
      expect(
        calcTagsForModule('/project/src/a/b/user.store.ts' as FsPath, rootDir, {
          'src/**/<name>.store.ts': 'store:<name>',
        }),
      ).toEqual(['store:user']);
    });
  });
});
