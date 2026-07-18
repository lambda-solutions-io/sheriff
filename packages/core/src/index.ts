export { violatesEncapsulationRule } from './lib/eslint/violates-encapsulation-rule';
export { violatesDependencyRule } from './lib/eslint/violates-dependency-rule';
export { anyTag } from './lib/checks/any-tag';
export { sameTag } from './lib/checks/same-tag';
export { noDependencies } from './lib/checks/no-dependencies';
export { UserSheriffConfig as SheriffConfig } from './lib/config/user-sheriff-config';
export {
  UserError,
  PluginNotFoundError,
  PluginInvalidError,
  PluginExecutionError,
  DuplicatePluginNameError,
} from './lib/error/user-error';
export { getProjectData, ProjectData } from './lib/api/get-project-data';
export {
  SheriffPlugin,
  SheriffPluginAPI,
  VerificationResult,
  FileViolations,
  DependencyViolationInfo,
  ExternalRuleViolationInfo,
  ProjectDataOptions,
} from './lib/plugin';
