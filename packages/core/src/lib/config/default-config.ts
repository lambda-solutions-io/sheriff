import { Configuration } from './configuration';
import { defaultIgnoreFileExtensions } from './default-file-extensions';

export const defaultConfig: Configuration = {
  version: 1,
  autoTagging: true,
  modules: {},
  depRules: {},
  denyRules: {},
  externalRules: {},
  configs: {},
  excludeRoot: false,
  enableBarrelLess: false,
  barrelPolicy: 'allow',
  allowBarrelsIn: [],
  moduleIdentity: 'auto',
  encapsulationPattern: 'internal',
  log: false,
  entryFile: '',
  isConfigFileMissing: false,
  barrelFileName: 'index.ts',
  entryPoints: undefined,
  ignoreFileExtensions: defaultIgnoreFileExtensions,
};
