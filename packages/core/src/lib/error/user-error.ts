export type UserErrorCode =
  | 'SH-001'
  | 'SH-002'
  | 'SH-003'
  | 'SH-004'
  | 'SH-005'
  | 'SH-006'
  | 'SH-007'
  | 'SH-008'
  | 'SH-009'
  | 'SH-010'
  | 'SH-011'
  | 'SH-012'
  | 'SH-013'
  | 'SH-014'
  | 'SH-015'
  | 'SH-016'
  | 'SH-017'
  | 'SH-018'
  | 'SH-019'
  | 'SH-020'
  | 'SH-021'
  | 'SH-022';

export class UserError extends Error {
  constructor(
    public code: UserErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidPathError extends UserError {
  constructor(pathAlias: string, path: string) {
    super(
      'SH-001',
      `invalid path mapping detected: ${pathAlias}: ${path}. Please verify that the path exists.`,
    );
  }
}

export class NoDependencyRuleForTagError extends UserError {
  constructor(tag: string) {
    super(
      'SH-002',
      `No dependency rule for tag '${tag}' found in sheriff.config.ts`,
    );
  }
}

export class NoAssignedTagError extends UserError {
  constructor(moduleDir: string) {
    super('SH-003', `No assigned Tag for '${moduleDir}' in sheriff.config.ts`);
  }
}

export class TagWithoutValueError extends UserError {
  constructor(path: string) {
    super(
      'SH-004',
      `Tag configuration '/${path}' in sheriff.config.ts has no value`,
    );
  }
}

export class ExistingTagPlaceholderError extends UserError {
  constructor(placeholder: string) {
    super(
      'SH-005',
      `placeholder for value "${placeholder}" does already exist`,
    );
  }
}

export class InvalidPlaceholderError extends UserError {
  constructor(placeholder: string, path: string) {
    super(
      'SH-006',
      `cannot find a placeholder for "${placeholder}" in tag configuration. Module: ${path}`,
    );
  }
}

export class MissingModulesWithoutAutoTaggingError extends UserError {
  constructor() {
    super(
      'SH-007',
      'sheriff.config.ts must have either modules or autoTagging set to true',
    );
  }
}

export class TaggingAndModulesError extends UserError {
  constructor() {
    super(
      'SH-008',
      'sheriff.config.ts contains both tagging and modules. Use only modules.',
    );
  }
}

export class CollidingEncapsulationSettings extends UserError {
  constructor() {
    super(
      'SH-009',
      'sheriff.config.ts contains both encapsulatedFolderNameForBarrelLess and encapsulationPatternForBarrellLess. Use encapsulationPatternForBarrellLess.',
    );
  }
}

export class TsExtendsResolutionError extends UserError {
  constructor(tsConfigPath: string, extendsPath: string) {
    super(
      'SH-010',
      `Cannot resolve path ${extendsPath} of "extends" property in ${tsConfigPath}. Please verify that the path exists.`,
    );
  }
}

export class CollidingEntrySettings extends UserError {
  constructor() {
    super(
      'SH-011',
      'sheriff.config.ts contains both entryFile and entryPoints. Use only one of them.',
    );
  }
}

export class NoEntryPointsFoundError extends UserError {
  constructor() {
    super('SH-012', 'No entryPoints defined in sheriff.config.ts.');
  }
}

export class InvalidConfigsDirectoryError extends UserError {
  constructor(directory: string) {
    super(
      'SH-013',
      `Invalid configs directory '${directory}' in sheriff.config.ts. Configs keys must be workspace-relative directories that stay inside the workspace root.`,
    );
  }
}

export class RootConfigsDirectoryError extends UserError {
  constructor(directory: string) {
    super(
      'SH-022',
      `Configs key '${directory}' in sheriff.config.ts maps the workspace root itself, which no file could ever resolve to. The root sheriff.config.ts already governs the root; move the rules into the root config or map a sub-directory.`,
    );
  }
}

export class SheriffConfigNotFoundError extends UserError {
  constructor(directory: string, configPath: string) {
    super(
      'SH-014',
      `Cannot resolve configs entry '${directory}' to '${configPath}'. Please verify that the Sheriff config file exists.`,
    );
  }
}

export class PluginNotFoundError extends UserError {
  constructor(pluginName: string) {
    super(
      'SH-015',
      `Plugin '${pluginName}' not found. Make sure to register it in sheriff.config.ts.`,
    );
  }
}

export class PluginInvalidError extends UserError {
  constructor(details: string, index?: number) {
    const pluginReference =
      index === undefined ? 'plugin' : `plugin at index ${index}`;
    super('SH-016', `Invalid ${pluginReference}: ${details}.`);
  }
}

export class PluginExecutionError extends UserError {
  constructor(pluginName: string, errorMessage: string) {
    super(
      'SH-017',
      `Plugin '${pluginName}' failed during execution: ${errorMessage}`,
    );
  }
}

export class DuplicatePluginNameError extends UserError {
  constructor(pluginName: string) {
    super(
      'SH-018',
      `Plugin '${pluginName}' is registered more than once. Plugin names must be unique.`,
    );
  }
}

export class BarrelPolicyWithoutBarrelLessError extends UserError {
  constructor(barrelPolicy: string) {
    super(
      'SH-019',
      `sheriff.config.ts sets barrelPolicy: '${barrelPolicy}' without enableBarrelLess: true. The policy would silently have no effect. Enable barrel-less mode or remove barrelPolicy.`,
    );
  }
}

export class AllowBarrelsInWithoutBarrelPolicyError extends UserError {
  constructor() {
    super(
      'SH-020',
      `sheriff.config.ts sets allowBarrelsIn while barrelPolicy is absent or 'allow'. The exceptions would be dead configuration. Set barrelPolicy to 'warn' or 'forbid' or remove allowBarrelsIn.`,
    );
  }
}

export class ModuleIdentityConfigWithoutBarrelLessError extends UserError {
  constructor() {
    super(
      'SH-021',
      `sheriff.config.ts sets moduleIdentity: 'config' without enableBarrelLess: true. Without barrel-less mode modules are defined by barrel files by definition, so the setting is meaningless. Enable barrel-less mode or remove moduleIdentity.`,
    );
  }
}
