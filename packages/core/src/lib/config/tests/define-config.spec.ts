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
        `const defineConfig = (config) => config;
         export const config = defineConfig({
           modules: { 'src/app': 'app' },
           depRules: { app: () => true },
         });`,
      );

      const parsedConfig = parseConfig(toFsPath(configFile));

      expect(parsedConfig.modules).toEqual({ 'src/app': 'app' });
      expect(parsedConfig.autoTagging).toBe(true);
    });
  });
});
