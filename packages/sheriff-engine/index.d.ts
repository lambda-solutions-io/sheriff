export type EngineImportKind = 'module' | 'external' | 'unresolvable';

export interface EngineImport {
  raw: string;
  kind: EngineImportKind;
  resolvedPath?: string | null;
}

export interface EngineFile {
  path: string;
  imports: EngineImport[];
}

export type EngineTagValue = string | string[];

export interface EngineModuleDefinition {
  tags: EngineTagValue;
  exports?: string[];
}

export interface EngineModuleConfig {
  [pathMatcher: string]:
    | EngineTagValue
    | EngineModuleDefinition
    | EngineModuleConfig;
}

export interface EngineModulePath {
  path: string;
  isBarrel: boolean;
  encapsulatedFolder?: string;
  exports?: string[];
}

export interface EngineInput {
  schemaVersion: 1;
  rootDir: string;
  files: EngineFile[];
  moduleConfig: EngineModuleConfig;
  modulePaths: EngineModulePath[];
  autoTagging: boolean;
  depRules: Record<string, string | string[]>;
  denyRules: Record<string, string | string[]>;
  externalRules: Record<string, string[]>;
  encapsulationPattern?: string | null;
  enableBarrelLess?: boolean;
  excludeRoot?: boolean;
  barrelFileName?: string;
}

export interface EngineModule {
  path: string;
  tags: string[];
  isBarrel: boolean;
}

export interface EngineDependencyViolation {
  file: string;
  rawImport: string;
  fromModulePath: string;
  toModulePath: string;
  toFilePath: string;
  fromTag: string;
  toTags: string[];
  cause?: 'deny-rule';
}

export interface EngineEncapsulationViolation {
  file: string;
  rawImport: string;
  toFilePath: string;
}

export interface EngineExternalViolation {
  file: string;
  externalLibrary: string;
  fromTag: string;
}

export interface EngineOutput {
  schemaVersion: 1;
  modules: EngineModule[];
  violations: {
    dependency: EngineDependencyViolation[];
    encapsulation: EngineEncapsulationViolation[];
    external: EngineExternalViolation[];
  };
}

export interface EngineErrorOutput {
  schemaVersion: 1;
  error: {
    code: string;
    message: string;
  };
}

export declare class EngineUnsupportedConfigError extends Error {
  readonly code: 'SHERIFF_ENGINE_UNSUPPORTED_CONFIG';
}

export declare function analyzeProject(inputJson: string): string;
export declare function analyzeProject(input: EngineInput): string;
