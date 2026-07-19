/**
 * Graph model served to the frontend via `GET /api/graph`.
 * All paths are project-root-relative; module id '.' is the root module.
 */
export type GraphViolationType =
  | 'dependency-rule'
  | 'encapsulation'
  | 'external-rule';

export type GraphViolation = {
  type: GraphViolationType;
  fromTag?: string;
  toTags?: string[];
  rawImport?: string;
  externalLibrary?: string;
  sourceFile: string;
};

export type ModuleNode = {
  id: string;
  label: string;
  tags: string[];
  moduleType: 'barrel' | 'barrel-less';
  projectNames: string[];
  fileCount: number;
  hasViolations: boolean;
};

export type FileNode = {
  id: string;
  parent: string;
  hasViolations: boolean;
};

/** id is prefixed with 'ext:' so external names can never collide with paths. */
export type ExternalNode = {
  id: string;
  label: string;
};

export type ModuleEdge = {
  id: string;
  source: string;
  target: string;
  importCount: number;
  violations: GraphViolation[];
};

export type FileEdge = {
  id: string;
  source: string;
  target: string;
  violations: GraphViolation[];
};

export type ViolationSummary = {
  encapsulation: number;
  dependencyRule: number;
  externalRule: number;
  filesWithViolations: number;
};

export type GraphModel = {
  modules: ModuleNode[];
  files: FileNode[];
  externals: ExternalNode[];
  moduleEdges: ModuleEdge[];
  fileEdges: FileEdge[];
  violationSummary: ViolationSummary;
  /** Violations that could not be attached to a node or edge. */
  unassignedViolations: GraphViolation[];
};

export const EXTERNAL_NODE_PREFIX = 'ext:';
