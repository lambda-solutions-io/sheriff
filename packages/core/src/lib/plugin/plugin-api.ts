import { ProjectData, Options } from '../api/get-project-data';
import { UserSheriffConfig } from '../config/user-sheriff-config';

export interface DependencyViolationInfo {
  fromTag: string;
  toTags: string[];
  rawImport: string;
}

export interface ExternalRuleViolationInfo {
  fromTag: string;
  externalLibrary: string;
}

export interface FileViolations {
  encapsulationViolations: string[];
  dependencyRuleViolations: DependencyViolationInfo[];
  externalRuleViolations: ExternalRuleViolationInfo[];
}

export interface VerificationResult {
  success: boolean;
  encapsulationViolationCount: number;
  dependencyRuleViolationCount: number;
  externalRuleViolationCount: number;
  filesWithViolationsCount: number;
  violations: Record<string, FileViolations>;
}

export type ProjectDataOptions = Pick<Options, 'includeExternalLibraries'>;

export interface SheriffPluginAPI {
  verify(entryFile?: string): VerificationResult;
  /**
   * Returns the project data of a single project. In a multi-project setup
   * (`entryPoints`), the first entry point is used unless `entryFile`
   * selects a specific one.
   */
  getProjectData(entryFile?: string, options?: ProjectDataOptions): ProjectData;
  getConfig(): UserSheriffConfig;
  log(message: string): void;
  logError(message: string): void;
}
