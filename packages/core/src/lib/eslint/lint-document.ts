import { createHash } from 'crypto';
import {
  checkForDependencyRuleViolation,
  DependencyRuleViolation,
} from '../checks/check-for-dependency-rule-violation';
import {
  checkForExternalRuleViolation,
  ExternalRuleViolation,
} from '../checks/check-for-external-rule-violation';
import {
  BarrelPolicyViolation,
  checkForBarrelPolicyViolation,
} from '../checks/check-for-barrel-policy-violation';
import { hasEncapsulationViolations } from '../checks/has-encapsulation-violations';
import {
  DEFAULT_STRUCTURE_CACHE_TTL_MS,
  deleteProjectCacheEntry,
  getOrCompute,
} from '../cache/project-cache';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { generateTsData } from '../file-info/generate-ts-data';
import getFs from '../fs/getFs';
import { init } from '../main/init';
import { FileInfo } from '../modules/file.info';
import {
  DependencyViolationInfo,
  ExternalRuleViolationInfo,
} from '../plugin/plugin-api';
import { isRelativeImport } from './is-relative-import';

/** Plain, serializable Sheriff violations found in one document. */
export interface DocumentLintResult {
  /** Whether no Sheriff configuration was found for the document. */
  configFileIsMissing: boolean;
  dependencyRuleViolations: DependencyViolationInfo[];
  encapsulationViolations: string[];
  externalRuleViolations: ExternalRuleViolationInfo[];
  unresolvableImports: string[];
}

type InternalDocumentLintResult = {
  dependencyRuleViolations: DependencyRuleViolation[];
  encapsulationViolations: Record<string, FileInfo>;
  externalRuleViolations: ExternalRuleViolation[];
  barrelPolicyViolations: BarrelPolicyViolation[];
  unresolvableImports: string[];
};

type DocumentLintAnalysis = {
  result: InternalDocumentLintResult;
  rootDir?: FsPath;
  configFileIsMissing: boolean;
  getDependencyRuleViolation: (
    importCommand: string,
  ) => DependencyRuleViolation | undefined;
  getExternalRuleViolation: (
    importCommand: string,
  ) => ExternalRuleViolation | undefined;
  isUnresolvableImport: (importCommand: string) => boolean;
};

type CachedDocumentAnalysis = {
  get: (returnOnMissingConfig: boolean) => DocumentLintAnalysis;
  dependencies: () => FsPath[];
};

let lastCacheKey:
  | { filename: string; fileContent: string | undefined; key: string }
  | undefined;

// Each unsaved buffer revision has a distinct content hash. Keep only the
// hottest analyses so a daemon/editor process cannot retain every revision it
// has ever seen. Map insertion order is the LRU order (oldest first).
const MAX_DOCUMENT_ANALYSES = 16;
const documentAnalysisLru = new Map<string, undefined>();

/**
 * Analyses one document for every check used by Sheriff's ESLint rules.
 * Repeated calls for the same filename and content version share the result.
 *
 * @param filename Absolute path of the document to lint.
 * @param fileContent Optional editor content. When omitted, the file is read
 * from disk and kept in a separate cache entry from supplied content.
 */
export function lintDocument(
  filename: string,
  fileContent?: string,
): DocumentLintResult {
  return createPublicDocumentLintResult(
    getDocumentLintAnalysis(filename, fileContent, true),
  );
}

export function getDocumentLintAnalysis(
  filename: string,
  fileContent: string | undefined,
  returnOnMissingConfig: boolean,
): DocumentLintAnalysis {
  const entryFile = toFsPath(filename);
  const cacheKey = createCacheKey(filename, fileContent);
  const cachedAnalysis = getOrCompute(
    cacheKey,
    () => {
      const value = createCachedDocumentAnalysis(entryFile, fileContent);
      value.get(returnOnMissingConfig);

      return {
        value,
        dependencies: value.dependencies(),
      };
    },
    { ttlMs: DEFAULT_STRUCTURE_CACHE_TTL_MS },
  );

  touchDocumentAnalysis(cacheKey);
  return cachedAnalysis.get(returnOnMissingConfig);
}

function createCachedDocumentAnalysis(
  entryFile: FsPath,
  fileContent: string | undefined,
): CachedDocumentAnalysis {
  // `init(..., { returnOnMissingConfig: true })` deliberately returns before
  // generating FileInfo. Resolve the tsconfig chain separately so even that
  // lightweight missing-config result carries complete dependency stamps.
  const tsConfigPath = toFsPath(
    getFs().findNearestParentFile(entryFile, 'tsconfig.json'),
  );
  const baseDependencies = uniqueDependencies([
    ...(fileContent === undefined ? [entryFile] : []),
    ...generateTsData(tsConfigPath).sourceConfigPaths,
  ]);
  let dependencies = baseDependencies;
  let analysis: DocumentLintAnalysis | undefined;
  let configFileIsMissing = false;

  return {
    get: (returnOnMissingConfig) => {
      if (analysis) {
        return analysis;
      }
      if (configFileIsMissing && returnOnMissingConfig) {
        return emptyMissingConfigAnalysis();
      }

      const projectInfo = init(entryFile, {
        traverse: false,
        entryFileContent: fileContent,
        returnOnMissingConfig,
      });

      if (!projectInfo) {
        configFileIsMissing = true;
        return emptyMissingConfigAnalysis();
      }

      configFileIsMissing = projectInfo.config.isConfigFileMissing;
      dependencies = uniqueDependencies([
        ...baseDependencies,
        ...(projectInfo.configFilePath ? [projectInfo.configFilePath] : []),
        ...projectInfo.tsData.sourceConfigPaths,
      ]);
      const result = createInternalDocumentLintResult(entryFile, projectInfo);
      analysis = {
        result,
        rootDir: projectInfo.rootDir,
        configFileIsMissing,
        ...createViolationLookups(result),
      };
      return analysis;
    },
    dependencies: () => dependencies,
  };
}

function touchDocumentAnalysis(cacheKey: string): void {
  documentAnalysisLru.delete(cacheKey);
  documentAnalysisLru.set(cacheKey, undefined);

  while (documentAnalysisLru.size > MAX_DOCUMENT_ANALYSES) {
    const oldestKey = documentAnalysisLru.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    documentAnalysisLru.delete(oldestKey);
    deleteProjectCacheEntry(oldestKey);
  }
}

function uniqueDependencies(dependencies: FsPath[]): FsPath[] {
  return [...new Set(dependencies)];
}

function createViolationLookups(
  result: InternalDocumentLintResult,
): Pick<
  DocumentLintAnalysis,
  | 'getDependencyRuleViolation'
  | 'getExternalRuleViolation'
  | 'isUnresolvableImport'
> {
  let dependencyRuleViolations: Map<string, DependencyRuleViolation>;
  let externalRuleViolations: Map<string, ExternalRuleViolation>;
  const unresolvableImports = new Set(result.unresolvableImports);

  return {
    getDependencyRuleViolation: (importCommand) => {
      dependencyRuleViolations ??= new Map(
        result.dependencyRuleViolations.map((violation) => [
          violation.rawImport,
          violation,
        ]),
      );
      return dependencyRuleViolations.get(importCommand);
    },
    getExternalRuleViolation: (importCommand) => {
      externalRuleViolations ??= new Map(
        result.externalRuleViolations.map((violation) => [
          violation.externalLibrary,
          violation,
        ]),
      );
      return externalRuleViolations.get(importCommand);
    },
    isUnresolvableImport: (importCommand) =>
      unresolvableImports.has(importCommand),
  };
}

function createInternalDocumentLintResult(
  entryFile: FsPath,
  projectInfo: Exclude<ReturnType<typeof init>, undefined>,
): InternalDocumentLintResult {
  let dependencyRuleViolations: DependencyRuleViolation[] | undefined;
  let encapsulationViolations: Record<string, FileInfo> | undefined;
  let externalRuleViolations: ExternalRuleViolation[] | undefined;
  let barrelPolicyViolations: BarrelPolicyViolation[] | undefined;

  return {
    get dependencyRuleViolations() {
      dependencyRuleViolations ??= checkForDependencyRuleViolation(
        entryFile,
        projectInfo,
      );
      return dependencyRuleViolations;
    },
    get encapsulationViolations() {
      encapsulationViolations ??= hasEncapsulationViolations(
        entryFile,
        projectInfo,
      );
      return encapsulationViolations;
    },
    get externalRuleViolations() {
      externalRuleViolations ??= checkForExternalRuleViolation(
        entryFile,
        projectInfo,
      );
      return externalRuleViolations;
    },
    get barrelPolicyViolations() {
      // The ESLint surface only reports under `barrelPolicy: 'forbid'`;
      // `'warn'` is verify-only and must not turn into editor errors.
      barrelPolicyViolations ??=
        projectInfo.config.barrelPolicy === 'forbid'
          ? checkForBarrelPolicyViolation(projectInfo)
          : [];
      return barrelPolicyViolations;
    },
    unresolvableImports: projectInfo.fileInfo.unresolvableImports.filter(
      (importCommand) => isRelativeImport(importCommand),
    ),
  };
}

function createPublicDocumentLintResult(
  analysis: DocumentLintAnalysis,
): DocumentLintResult {
  const { result } = analysis;
  return {
    configFileIsMissing: analysis.configFileIsMissing,
    dependencyRuleViolations: result.dependencyRuleViolations.map(
      ({ fromTag, toTags, rawImport }) => ({
        fromTag,
        toTags: [...toTags],
        rawImport,
      }),
    ),
    encapsulationViolations: Object.keys(result.encapsulationViolations),
    externalRuleViolations: result.externalRuleViolations.map(
      ({ fromTag, externalLibrary }) => ({ fromTag, externalLibrary }),
    ),
    unresolvableImports: [...result.unresolvableImports],
  };
}

function emptyMissingConfigAnalysis(): DocumentLintAnalysis {
  return {
    result: {
      dependencyRuleViolations: [],
      encapsulationViolations: {},
      externalRuleViolations: [],
      barrelPolicyViolations: [],
      unresolvableImports: [],
    },
    configFileIsMissing: true,
    getDependencyRuleViolation: () => undefined,
    getExternalRuleViolation: () => undefined,
    isUnresolvableImport: () => false,
  };
}

function createCacheKey(
  filename: string,
  fileContent: string | undefined,
): string {
  if (
    fileContent !== undefined &&
    lastCacheKey?.filename === filename &&
    lastCacheKey.fileContent === fileContent
  ) {
    return lastCacheKey.key;
  }

  const contentSource = fileContent === undefined ? 'disk' : 'supplied';
  const content = fileContent ?? getFs().readFile(toFsPath(filename));
  const contentHash = createHash('sha256').update(content).digest('hex');
  const key = `lint-document\0${contentSource}\0${filename}\0${contentHash}`;
  lastCacheKey = { filename, fileContent, key };
  return key;
}
