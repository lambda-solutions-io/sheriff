import { ProjectData, Options } from '../api/get-project-data';
import { UserSheriffConfig } from '../config/user-sheriff-config';

export interface DependencyViolationInfo {
  fromTag: string;
  toTags: string[];
  rawImport: string;
}

export interface FileViolations {
  encapsulationViolations: string[];
  dependencyRuleViolations: DependencyViolationInfo[];
}

export interface VerificationResult {
  success: boolean;
  encapsulationViolationCount: number;
  dependencyRuleViolationCount: number;
  filesWithViolationsCount: number;
  violations: Record<string, FileViolations>;
}

export type ProjectDataOptions = Pick<Options, 'includeExternalLibraries'>;

export interface SheriffPluginAPI {
  verify(entryFile?: string): VerificationResult;
  getProjectData(entryFile?: string, options?: ProjectDataOptions): ProjectData;
  getConfig(): UserSheriffConfig;
  log(message: string): void;
  logError(message: string): void;
}
