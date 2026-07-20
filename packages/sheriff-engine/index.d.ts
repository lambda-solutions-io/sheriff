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

export interface EngineRegExp {
  source: string;
  flags: string;
}

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
  depRules: Record<string, string | string[] | null>;
  denyRules: Record<string, string | string[] | null>;
  externalRules: Record<string, string[]>;
  encapsulationPattern?: string | RegExp | EngineRegExp | null;
  enableBarrelLess: boolean;
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

export interface ResolveProjectInput {
  schemaVersion: 1;
  tsConfigPath: string;
  files: string[];
  ignoreFileExtensions?: string[];
  /** Measure Rust even when fallback eligibility has already failed. */
  shadowMode?: boolean;
}

export interface ResolvedProjectImport extends EngineImport {
  resolvedPath: string | null;
  /** UTF-8 byte offsets inside the module string literal. */
  start: number;
  end: number;
}

export interface ResolveProjectOutput {
  schemaVersion: 1;
  rootDir: string;
  files: Array<{ file: string; imports: ResolvedProjectImport[] }>;
  fallback: boolean;
  fallbackReasons: string[];
  sourceConfigPaths: string[];
}

/** Shadow-only R2 API. TypeScript remains the production resolver. */
export declare function resolveProjectImports(inputJson: string): string;
export declare function resolveProjectImports(
  input: ResolveProjectInput,
): string;
