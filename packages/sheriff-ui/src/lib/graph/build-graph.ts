import type {
  ProjectData,
  VerificationResult,
} from '@lambda-solutions/sheriff-core';
import {
  EXTERNAL_NODE_PREFIX,
  FileEdge,
  FileNode,
  GraphModel,
  GraphViolation,
  ModuleEdge,
  ModuleNode,
} from './graph-model';

export type ProjectDataPerEntry = {
  projectName: string;
  projectData: ProjectData;
};

type FileEntry = {
  module: string;
  moduleType: 'barrel' | 'barrel-less';
  tags: string[];
  imports: string[];
  externalLibraries: string[];
  projectNames: Set<string>;
};

/**
 * Merges per-entry project data and verification results into the graph
 * model served to the UI.
 *
 * The daemon returns project data with absolute paths but verification
 * violations keyed relative to the daemon's root directory — everything
 * is relativized against `rootDir` so the two can be joined.
 */
export function buildGraph(
  entries: ProjectDataPerEntry[],
  verification: VerificationResult | undefined,
  rootDir: string,
): GraphModel {
  const files = mergeEntries(entries, rootDir);
  const modules = buildModules(files);
  const externals = collectExternals(files);
  const fileEdges = buildFileEdges(files);
  const moduleEdges = buildModuleEdges(files, fileEdges);

  const unassignedViolations: GraphViolation[] = [];
  const violatingFiles = verification
    ? applyViolations(
        verification,
        files,
        modules,
        moduleEdges,
        fileEdges,
        unassignedViolations,
      )
    : new Set<string>();

  return {
    modules: [...modules.values()],
    files: buildFileNodes(files, violatingFiles),
    externals,
    moduleEdges,
    fileEdges,
    violationSummary: {
      encapsulation: verification?.encapsulationViolationCount ?? 0,
      dependencyRule: verification?.dependencyRuleViolationCount ?? 0,
      externalRule: verification?.externalRuleViolationCount ?? 0,
      filesWithViolations: verification?.filesWithViolationsCount ?? 0,
    },
    unassignedViolations,
  };
}

function normalizeRootDir(rootDir: string): string {
  return rootDir.replace(/\\/g, '/').replace(/\/+$/, '');
}

function relativize(path: string, rootDir: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (normalized === rootDir) {
    return '.';
  }
  if (normalized.startsWith(rootDir + '/')) {
    return normalized.slice(rootDir.length + 1);
  }
  return normalized;
}

function mergeEntries(
  entries: ProjectDataPerEntry[],
  rootDir: string,
): Map<string, FileEntry> {
  const root = normalizeRootDir(rootDir);
  const files = new Map<string, FileEntry>();

  for (const { projectName, projectData } of entries) {
    for (const [path, data] of Object.entries(projectData)) {
      const relPath = relativize(path, root);
      const existing = files.get(relPath);
      if (existing) {
        existing.projectNames.add(projectName);
        for (const imported of data.imports) {
          const relImport = relativize(imported, root);
          if (!existing.imports.includes(relImport)) {
            existing.imports.push(relImport);
          }
        }
        continue;
      }
      files.set(relPath, {
        module: relativize(data.module, root) || '.',
        moduleType: data.moduleType,
        tags: data.tags,
        imports: data.imports.map((imported) => relativize(imported, root)),
        externalLibraries: data.externalLibraries ?? [],
        projectNames: new Set([projectName]),
      });
    }
  }

  return files;
}

function buildModules(files: Map<string, FileEntry>): Map<string, ModuleNode> {
  const modules = new Map<string, ModuleNode>();

  for (const entry of files.values()) {
    const existing = modules.get(entry.module);
    if (existing) {
      existing.fileCount++;
      for (const projectName of entry.projectNames) {
        if (!existing.projectNames.includes(projectName)) {
          existing.projectNames.push(projectName);
        }
      }
      continue;
    }
    modules.set(entry.module, {
      id: entry.module,
      label: entry.module,
      tags: entry.tags,
      moduleType: entry.moduleType,
      projectNames: [...entry.projectNames],
      fileCount: 1,
      hasViolations: false,
    });
  }

  return modules;
}

function collectExternals(
  files: Map<string, FileEntry>,
): GraphModel['externals'] {
  const libraries = new Set<string>();
  for (const entry of files.values()) {
    for (const library of entry.externalLibraries) {
      libraries.add(library);
    }
  }
  return [...libraries]
    .sort((a, b) => a.localeCompare(b))
    .map((library) => ({
      id: EXTERNAL_NODE_PREFIX + library,
      label: library,
    }));
}

function buildFileNodes(
  files: Map<string, FileEntry>,
  violatingFiles: Set<string>,
): FileNode[] {
  return [...files.entries()].map(([path, entry]) => ({
    id: path,
    parent: entry.module,
    hasViolations: violatingFiles.has(path),
  }));
}

function buildFileEdges(files: Map<string, FileEntry>): FileEdge[] {
  const edges: FileEdge[] = [];
  for (const [path, entry] of files.entries()) {
    for (const imported of entry.imports) {
      if (files.has(imported)) {
        edges.push({
          id: `${path}->${imported}`,
          source: path,
          target: imported,
          violations: [],
        });
      }
    }
    for (const library of entry.externalLibraries) {
      edges.push({
        id: `${path}->${EXTERNAL_NODE_PREFIX}${library}`,
        source: path,
        target: EXTERNAL_NODE_PREFIX + library,
        violations: [],
      });
    }
  }
  return edges;
}

function buildModuleEdges(
  files: Map<string, FileEntry>,
  fileEdges: FileEdge[],
): ModuleEdge[] {
  const edges = new Map<string, ModuleEdge>();

  for (const fileEdge of fileEdges) {
    const sourceModule = files.get(fileEdge.source)?.module;
    const targetModule = fileEdge.target.startsWith(EXTERNAL_NODE_PREFIX)
      ? fileEdge.target
      : files.get(fileEdge.target)?.module;
    if (!sourceModule || !targetModule || sourceModule === targetModule) {
      continue;
    }

    const id = `${sourceModule}->${targetModule}`;
    const existing = edges.get(id);
    if (existing) {
      existing.importCount++;
    } else {
      edges.set(id, {
        id,
        source: sourceModule,
        target: targetModule,
        importCount: 1,
        violations: [],
      });
    }
  }

  return [...edges.values()];
}

/** Returns the set of violating file paths (for file-node styling). */
function applyViolations(
  verification: VerificationResult,
  files: Map<string, FileEntry>,
  modules: Map<string, ModuleNode>,
  moduleEdges: ModuleEdge[],
  fileEdges: FileEdge[],
  unassignedViolations: GraphViolation[],
): Set<string> {
  const violatingFiles = new Set<string>();

  for (const [sourceFile, fileViolations] of Object.entries(
    verification.violations,
  )) {
    const fileEntry = files.get(sourceFile);
    if (!fileEntry) {
      unassignedViolations.push(
        ...toGraphViolations(sourceFile, fileViolations),
      );
      continue;
    }
    violatingFiles.add(sourceFile);
    const sourceModule = modules.get(fileEntry.module);
    if (sourceModule) {
      sourceModule.hasViolations = true;
    }

    for (const violation of fileViolations.dependencyRuleViolations) {
      attachToEdge(
        {
          type: 'dependency-rule',
          fromTag: violation.fromTag,
          toTags: violation.toTags,
          rawImport: violation.rawImport,
          sourceFile,
        },
        findDependencyRuleEdge(
          fileEntry.module,
          violation.toTags,
          modules,
          moduleEdges,
        ),
        unassignedViolations,
      );
    }

    for (const violation of fileViolations.externalRuleViolations) {
      const externalTarget = EXTERNAL_NODE_PREFIX + violation.externalLibrary;
      const graphViolation: GraphViolation = {
        type: 'external-rule',
        fromTag: violation.fromTag,
        externalLibrary: violation.externalLibrary,
        sourceFile,
      };
      fileEdges
        .find(
          (edge) =>
            edge.source === sourceFile && edge.target === externalTarget,
        )
        ?.violations.push(graphViolation);
      attachToEdge(
        graphViolation,
        moduleEdges.find(
          (edge) =>
            edge.source === fileEntry.module && edge.target === externalTarget,
        ),
        unassignedViolations,
      );
    }

    for (const rawImport of fileViolations.encapsulationViolations) {
      // raw import strings cannot be resolved to a target file on this
      // side of the wire; the violation stays on the source file/module
      unassignedViolations.push({
        type: 'encapsulation',
        rawImport,
        sourceFile,
      });
    }
  }

  return violatingFiles;
}

function toGraphViolations(
  sourceFile: string,
  fileViolations: VerificationResult['violations'][string],
): GraphViolation[] {
  return [
    ...fileViolations.dependencyRuleViolations.map(
      (violation): GraphViolation => ({
        type: 'dependency-rule',
        fromTag: violation.fromTag,
        toTags: violation.toTags,
        rawImport: violation.rawImport,
        sourceFile,
      }),
    ),
    ...fileViolations.externalRuleViolations.map(
      (violation): GraphViolation => ({
        type: 'external-rule',
        fromTag: violation.fromTag,
        externalLibrary: violation.externalLibrary,
        sourceFile,
      }),
    ),
    ...fileViolations.encapsulationViolations.map(
      (rawImport): GraphViolation => ({
        type: 'encapsulation',
        rawImport,
        sourceFile,
      }),
    ),
  ];
}

function attachToEdge(
  violation: GraphViolation,
  edge: ModuleEdge | undefined,
  unassignedViolations: GraphViolation[],
): void {
  if (edge) {
    edge.violations.push(violation);
  } else {
    unassignedViolations.push(violation);
  }
}

/**
 * Best-effort: a dependency-rule violation names the tags of the imported
 * module. When exactly one outgoing edge of the source module leads to a
 * module carrying one of those tags, the violation belongs to that edge.
 */
function findDependencyRuleEdge(
  sourceModule: string,
  toTags: string[],
  modules: Map<string, ModuleNode>,
  moduleEdges: ModuleEdge[],
): ModuleEdge | undefined {
  const candidates = moduleEdges.filter((edge) => {
    if (edge.source !== sourceModule) {
      return false;
    }
    const target = modules.get(edge.target);
    return (
      target !== undefined && target.tags.some((tag) => toTags.includes(tag))
    );
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
