import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig } from '../define-config';
import { parseConfig } from '../parse-config';
import { toFsPath } from '../../file-info/fs-path';
import getFs, { useVirtualFs } from '../../fs/getFs';
import { anyTag } from '../../checks/any-tag';
import '../../test/expect.extensions';

describe('defineConfig', () => {
  it('should return the same object reference', () => {
    const config = { depRules: {} };

    expect(defineConfig(config)).toBe(config);
  });

  // a generic `<T extends UserSheriffConfig>` would infer the literal type
  // and silently drop excess-property checking, so a typo'd option would
  // compile and quietly disable the rule it was meant to configure
  it('should reject an unknown property', () => {
    // @ts-expect-error 'modulez' is not a Sheriff option
    expect(defineConfig({ depRules: {}, modulez: {} })).toBeDefined();
  });

  it('should keep every property untouched', () => {
    const config = defineConfig({
      modules: { 'src/app': 'app' },
      depRules: { app: anyTag },
      enableBarrelLess: true,
      barrelPolicy: 'forbid',
    });

    expect(config).toEqual({
      modules: { 'src/app': 'app' },
      depRules: { app: anyTag },
      enableBarrelLess: true,
      barrelPolicy: 'forbid',
    });
  });

  describe('within a sheriff.config.ts', () => {
    beforeEach(() => {
      useVirtualFs();
      getFs().reset();
    });

    it('should be parsed like an annotated config', () => {
      const configFile = '/project/sheriff.config.ts';
      getFs().writeFile(
        configFile,
        `import { defineConfig } from '@lambda-solutions/sheriff-core';

         export const config = defineConfig({
           modules: { 'src/app': 'app' },
           depRules: { app: () => true },
         });`,
      );

      const parsedConfig = parseConfig(toFsPath(configFile));

      expect(parsedConfig.modules).toEqual({ 'src/app': 'app' });
      expect(parsedConfig.autoTagging).toBe(true);
    });

    // a value import survives transpilation and becomes a real `require`,
    // which `eval` resolves relative to parse-config, not to the config file
    it('should resolve other value imports from Sheriff too', () => {
      const configFile = '/project/sheriff.config.ts';
      getFs().writeFile(
        configFile,
        `import { anyTag, defineConfig } from '@lambda-solutions/sheriff-core';

         export const config = defineConfig({
           modules: { 'src/app': 'app' },
           depRules: { app: anyTag },
         });`,
      );

      const parsedConfig = parseConfig(toFsPath(configFile));

      expect(parsedConfig.depRules['app']).toBe(anyTag);
    });
  });
});
