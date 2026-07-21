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

export interface EngineTagMatcherContext {
  segment: string;
  regexMatch?: RegExpMatchArray | null;
}

export type EngineTagMatcher = (
  placeholders: Record<string, string>,
  context: EngineTagMatcherContext,
) => string | string[];

export type EngineTagValue = string | string[] | EngineTagMatcher;

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
  depRules: Record<
    string,
    EngineDependencyRuleMatcher | EngineDependencyRuleMatcher[]
  >;
  denyRules: Record<
    string,
    EngineDependencyRuleMatcher | EngineDependencyRuleMatcher[]
  >;
  externalRules: Record<string, string[] | EngineExternalRuleMatcher>;
  encapsulationPattern?: string | RegExp | EngineRegExp | null;
  enableBarrelLess: boolean;
  excludeRoot?: boolean;
  barrelFileName?: string;
}

export interface EngineDependencyCheckContext {
  from: string;
  to: string;
  fromModulePath: string;
  toModulePath: string;
  fromFilePath: string;
  toFilePath: string;
  fromTags: string[];
  toTags: string[];
}

export type EngineDependencyRuleMatcher =
  | string
  | null
  | ((context: EngineDependencyCheckContext) => boolean);

export interface EngineExternalCheckContext {
  from: string;
  fromTags: string[];
  fromModulePath: string;
  fromFilePath: string;
  externalLibrary: string;
}

export type EngineExternalRuleMatcher = (
  context: EngineExternalCheckContext,
) => boolean;

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
  /** Reached files and their imports, in source order within each file. */
  files: EngineFile[];
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

/** The callback must be evaluated by Sheriff's TypeScript compatibility engine. */
export declare class EngineImpureCallbackError extends Error {
  readonly code: 'SHERIFF_ENGINE_IMPURE_CALLBACK';
  readonly fallback: true;
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

export interface ResolveProjectErrorOutput extends EngineErrorOutput {
  /** Resolution errors always require the TypeScript fallback. */
  fallback: true;
}

export interface ProjectHandleInput
  extends Omit<EngineInput, 'rootDir' | 'files'> {
  /** Absolute path, or a path resolved once against process.cwd() at construction. */
  entryFile: string;
  /** Absolute path, or a path resolved once against process.cwd() at construction. */
  tsConfigPath: string;
  ignoreFileExtensions?: string[];
  /**
   * Evaluated Sheriff config inputs to stamp. Relative paths are resolved once
   * against process.cwd(); changes and overlays require a replacement handle.
   */
  sheriffConfigPaths?: string[];
  /** Continue for differential measurement when the resolver fallback gate fires. */
  shadowMode?: boolean;
}

export type ProjectChangeEvent =
  | { kind: 'created' | 'modified' | 'deleted' | 'directory'; path: string }
  | { kind: 'renamed'; oldPath: string; path: string }
  | { kind: 'overlaySet'; path: string; content: string }
  | { kind: 'overlayClear'; path: string }
  | { kind: 'sheriffConfig'; path: string };

export interface ApplyProjectChangesInput {
  schemaVersion: 1;
  events: ProjectChangeEvent[];
  /**
   * Updated Node-discovered modules. Required when events contains created,
   * deleted, renamed, or directory because those events can change module
   * membership and barrel status.
   */
  modulePaths?: EngineModulePath[];
}

/** Persistent native graph. Methods return the same serialized schema as analyzeProject. */
export declare class ProjectHandle {
  constructor(input: ProjectHandleInput | string);
  applyChanges(input: ApplyProjectChangesInput | string): string;
  setOverlay(path: string, content: string): string;
  clearOverlay(path: string): string;
  getResult(): string;
  getReachedFiles(): string;
}

/** Shadow-only R2 API. TypeScript remains the production resolver. */
export declare function resolveProjectImports(inputJson: string): string;
export declare function resolveProjectImports(
  input: ResolveProjectInput,
): string;

/** Test-only R2 seam retaining external-library paths for differential checks. */
export declare function resolveModuleNameForEngineShadow(input: {
  schemaVersion: 1;
  tsConfigPath: string;
  containingFile: string;
  specifier: string;
}): string;
