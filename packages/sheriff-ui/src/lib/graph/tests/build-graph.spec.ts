import { describe, expect, it } from 'vitest';
import type {
  ProjectData,
  VerificationResult,
} from '@lambda-solutions/sheriff-core';
import { buildGraph } from '../build-graph';

const ROOT = '/project';

function projectData(): ProjectData {
  return {
    [`${ROOT}/src/main.ts`]: {
      module: '.',
      moduleType: 'barrel-less',
      tags: ['root'],
      imports: [`${ROOT}/src/feature/index.ts`],
      externalLibraries: [],
      unresolvedImports: [],
      projectName: 'app',
    },
    [`${ROOT}/src/feature/index.ts`]: {
      module: `${ROOT}/src/feature`,
      moduleType: 'barrel',
      tags: ['type:feature'],
      imports: [
        `${ROOT}/src/feature/feature.ts`,
        `${ROOT}/src/shared/index.ts`,
      ],
      externalLibraries: [],
      unresolvedImports: [],
      projectName: 'app',
    },
    [`${ROOT}/src/feature/feature.ts`]: {
      module: `${ROOT}/src/feature`,
      moduleType: 'barrel',
      tags: ['type:feature'],
      imports: [`${ROOT}/src/shared/index.ts`],
      externalLibraries: ['lodash'],
      unresolvedImports: [],
      projectName: 'app',
    },
    [`${ROOT}/src/shared/index.ts`]: {
      module: `${ROOT}/src/shared`,
      moduleType: 'barrel',
      tags: ['type:shared'],
      imports: [],
      externalLibraries: [],
      unresolvedImports: [],
      projectName: 'app',
    },
  };
}

function emptyVerification(): VerificationResult {
  return {
    success: true,
    encapsulationViolationCount: 0,
    dependencyRuleViolationCount: 0,
    externalRuleViolationCount: 0,
    filesWithViolationsCount: 0,
    violations: {},
  };
}

describe('buildGraph', () => {
  it('relativizes absolute paths against rootDir', () => {
    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );

    expect(graph.files.map((file) => file.id)).toContain('src/main.ts');
    expect(graph.modules.map((module) => module.id).sort()).toEqual([
      '.',
      'src/feature',
      'src/shared',
    ]);
  });

  it('aggregates files into modules with counts and tags', () => {
    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );

    const feature = graph.modules.find(
      (module) => module.id === 'src/feature',
    );
    expect(feature).toMatchObject({
      fileCount: 2,
      tags: ['type:feature'],
      moduleType: 'barrel',
      projectNames: ['app'],
      hasViolations: false,
    });
  });

  it('aggregates cross-module imports into counted module edges', () => {
    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );

    const featureToShared = graph.moduleEdges.find(
      (edge) => edge.source === 'src/feature' && edge.target === 'src/shared',
    );
    expect(featureToShared?.importCount).toBe(2);
    // same-module import (index -> feature.ts) creates no module edge
    expect(
      graph.moduleEdges.filter((edge) => edge.source === edge.target),
    ).toEqual([]);
  });

  it('creates external nodes and edges', () => {
    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );

    expect(graph.externals).toEqual([{ id: 'ext:lodash', label: 'lodash' }]);
    expect(
      graph.moduleEdges.some(
        (edge) => edge.source === 'src/feature' && edge.target === 'ext:lodash',
      ),
    ).toBe(true);
  });

  it('merges multiple entries without duplicating shared modules', () => {
    const graph = buildGraph(
      [
        { projectName: 'app', projectData: projectData() },
        {
          projectName: 'admin',
          projectData: {
            [`${ROOT}/src/admin.ts`]: {
              module: '.',
              moduleType: 'barrel-less',
              tags: ['root'],
              imports: [`${ROOT}/src/shared/index.ts`],
              externalLibraries: [],
              unresolvedImports: [],
              projectName: 'admin',
            },
            [`${ROOT}/src/shared/index.ts`]: {
              module: `${ROOT}/src/shared`,
              moduleType: 'barrel',
              tags: ['type:shared'],
              imports: [],
              externalLibraries: [],
              unresolvedImports: [],
              projectName: 'admin',
            },
          },
        },
      ],
      emptyVerification(),
      ROOT,
    );

    const shared = graph.modules.filter(
      (module) => module.id === 'src/shared',
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].projectNames.sort()).toEqual(['admin', 'app']);
  });

  it('attaches dependency-rule violations to the unambiguous edge', () => {
    const verification: VerificationResult = {
      success: false,
      encapsulationViolationCount: 0,
      dependencyRuleViolationCount: 1,
      externalRuleViolationCount: 0,
      filesWithViolationsCount: 1,
      violations: {
        'src/feature/feature.ts': {
          encapsulationViolations: [],
          dependencyRuleViolations: [
            {
              fromTag: 'type:feature',
              toTags: ['type:shared'],
              rawImport: '../shared',
            },
          ],
          externalRuleViolations: [],
        },
      },
    };

    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      verification,
      ROOT,
    );

    const edge = graph.moduleEdges.find(
      (candidate) =>
        candidate.source === 'src/feature' && candidate.target === 'src/shared',
    );
    expect(edge?.violations).toHaveLength(1);
    expect(edge?.violations[0]).toMatchObject({
      type: 'dependency-rule',
      sourceFile: 'src/feature/feature.ts',
    });
    expect(
      graph.modules.find((module) => module.id === 'src/feature')
        ?.hasViolations,
    ).toBe(true);
    expect(
      graph.files.find((file) => file.id === 'src/feature/feature.ts')
        ?.hasViolations,
    ).toBe(true);
  });

  it('keeps encapsulation violations on the source (unassigned)', () => {
    const verification: VerificationResult = {
      ...emptyVerification(),
      success: false,
      encapsulationViolationCount: 1,
      filesWithViolationsCount: 1,
      violations: {
        'src/main.ts': {
          encapsulationViolations: ['../shared/internal'],
          dependencyRuleViolations: [],
          externalRuleViolations: [],
        },
      },
    };

    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      verification,
      ROOT,
    );

    expect(graph.unassignedViolations).toEqual([
      {
        type: 'encapsulation',
        rawImport: '../shared/internal',
        sourceFile: 'src/main.ts',
      },
    ]);
    expect(graph.violationSummary.encapsulation).toBe(1);
  });

  it('attaches external-rule violations to file and module edges', () => {
    const verification: VerificationResult = {
      ...emptyVerification(),
      success: false,
      externalRuleViolationCount: 1,
      filesWithViolationsCount: 1,
      violations: {
        'src/feature/feature.ts': {
          encapsulationViolations: [],
          dependencyRuleViolations: [],
          externalRuleViolations: [
            { fromTag: 'type:feature', externalLibrary: 'lodash' },
          ],
        },
      },
    };

    const graph = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      verification,
      ROOT,
    );

    const moduleEdge = graph.moduleEdges.find(
      (edge) => edge.target === 'ext:lodash',
    );
    const fileEdge = graph.fileEdges.find(
      (edge) =>
        edge.source === 'src/feature/feature.ts' &&
        edge.target === 'ext:lodash',
    );
    expect(moduleEdge?.violations).toHaveLength(1);
    expect(fileEdge?.violations).toHaveLength(1);
  });

  it('produces identical JSON for identical input (stable hash basis)', () => {
    const graphA = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );
    const graphB = buildGraph(
      [{ projectName: 'app', projectData: projectData() }],
      emptyVerification(),
      ROOT,
    );
    expect(JSON.stringify(graphA)).toBe(JSON.stringify(graphB));
  });
});
