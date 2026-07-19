import { createRequire } from 'module';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// The helpers ship as a plain-JS UMD-ish file loaded in the browser; here we
// load it through a real CommonJS require so the pure logic is covered under
// Node/Vitest without a build step.
const require = createRequire(__filename);
const helpers = require(path.join(
  __dirname,
  '../../../../public/graph-helpers.js',
));

const PALETTE = ['#a', '#b', '#c', '#d'];

function graphFixture() {
  return {
    modules: [
      {
        id: 'auth',
        label: 'auth',
        tags: ['domain', 'auth'],
        moduleType: 'barrel',
        projectNames: ['app'],
        fileCount: 3,
        hasViolations: true,
      },
      {
        id: 'ui',
        label: 'ui',
        tags: ['shared'],
        moduleType: 'barrel-less',
        projectNames: ['lib'],
        fileCount: 2,
        hasViolations: false,
      },
    ],
    files: [
      { id: 'auth/login.ts', parent: 'auth', hasViolations: true },
      { id: 'ui/button.ts', parent: 'ui', hasViolations: false },
    ],
    externals: [{ id: 'ext:rxjs', label: 'rxjs' }],
    moduleEdges: [
      {
        id: 'auth->ui',
        source: 'auth',
        target: 'ui',
        importCount: 2,
        violations: [
          {
            type: 'dependency-rule',
            fromTag: 'domain',
            toTags: ['shared'],
            rawImport: '@app/ui',
            sourceFile: 'auth/login.ts',
          },
        ],
      },
    ],
    fileEdges: [
      {
        id: 'auth/login.ts->ui/button.ts',
        source: 'auth/login.ts',
        target: 'ui/button.ts',
        // same violation as the module edge above -> must dedupe to one
        violations: [
          {
            type: 'dependency-rule',
            fromTag: 'domain',
            toTags: ['shared'],
            rawImport: '@app/ui',
            sourceFile: 'auth/login.ts',
          },
        ],
      },
    ],
    violationSummary: {
      encapsulation: 1,
      dependencyRule: 1,
      externalRule: 0,
      filesWithViolations: 1,
    },
    unassignedViolations: [
      {
        type: 'encapsulation',
        rawImport: './deep',
        sourceFile: 'auth/login.ts',
      },
    ],
  };
}

describe('assignTagColors', () => {
  it('is deterministic and alphabetical regardless of module order', () => {
    const graph = graphFixture();
    const forward = helpers.assignTagColors(graph.modules, PALETTE);
    const reversed = helpers.assignTagColors(
      [...graph.modules].reverse(),
      PALETTE,
    );
    // sorted tags: auth, domain, shared
    expect(forward.get('auth')).toBe('#a');
    expect(forward.get('domain')).toBe('#b');
    expect(forward.get('shared')).toBe('#c');
    expect(Array.from(reversed.entries())).toEqual(
      Array.from(forward.entries()),
    );
  });

  it('wraps around the palette when tags exceed it', () => {
    const modules = [
      { tags: ['t0', 't1', 't2', 't3', 't4'] },
    ] as never[];
    const colors = helpers.assignTagColors(modules, PALETTE);
    expect(colors.get('t4')).toBe(PALETTE[0]);
  });
});

describe('filterModuleIds', () => {
  const graph = graphFixture();

  it('returns all modules with empty filters', () => {
    const ids = helpers.filterModuleIds(graph, {});
    expect(ids).toEqual(new Set(['auth', 'ui']));
  });

  it('ORs within a tag group', () => {
    const ids = helpers.filterModuleIds(graph, { tags: ['shared', 'auth'] });
    expect(ids).toEqual(new Set(['auth', 'ui']));
  });

  it('ANDs across facet groups', () => {
    const ids = helpers.filterModuleIds(graph, {
      tags: ['domain'],
      projects: ['lib'],
    });
    // auth has tag domain but project app; ui has project lib but no domain tag
    expect(ids).toEqual(new Set());
  });

  it('filters by module type', () => {
    expect(
      helpers.filterModuleIds(graph, { moduleTypes: ['barrel-less'] }),
    ).toEqual(new Set(['ui']));
  });

  it('violationOnly keeps only modules with violations', () => {
    expect(helpers.filterModuleIds(graph, { violationOnly: true })).toEqual(
      new Set(['auth']),
    );
  });

  it('accepts Set-valued facets', () => {
    expect(
      helpers.filterModuleIds(graph, { tags: new Set(['shared']) }),
    ).toEqual(new Set(['ui']));
  });
});

describe('isExternalVisible', () => {
  it('is false when master toggle is off', () => {
    expect(helpers.isExternalVisible('ext:rxjs', false, new Set())).toBe(false);
  });

  it('is true when shown and not hidden', () => {
    expect(helpers.isExternalVisible('ext:rxjs', true, new Set())).toBe(true);
  });

  it('is false for a per-library hidden external', () => {
    expect(
      helpers.isExternalVisible('ext:rxjs', true, new Set(['ext:rxjs'])),
    ).toBe(false);
  });

  it('accepts an array hidden set', () => {
    expect(helpers.isExternalVisible('ext:rxjs', true, ['ext:rxjs'])).toBe(
      false,
    );
  });
});

describe('flattenViolations', () => {
  const graph = graphFixture();

  it('dedupes the same violation across file and module edges', () => {
    const flat = helpers.flattenViolations(graph);
    const depRule = flat.filter(
      (v: { type: string }) => v.type === 'dependency-rule',
    );
    expect(depRule).toHaveLength(1);
    expect(depRule[0].locate).toEqual({ kind: 'moduleEdge', id: 'auth->ui' });
  });

  it('includes unassigned violations located on their owning module', () => {
    const flat = helpers.flattenViolations(graph);
    const encap = flat.find((v: { type: string }) => v.type === 'encapsulation');
    expect(encap).toBeTruthy();
    expect(encap.locate).toEqual({ kind: 'module', id: 'auth' });
  });

  it('empty graph yields no violations', () => {
    expect(
      helpers.flattenViolations({
        moduleEdges: [],
        fileEdges: [],
        files: [],
        unassignedViolations: [],
      }),
    ).toEqual([]);
  });
});

describe('rowMatchesQuery', () => {
  it('matches everything for an empty or blank query', () => {
    expect(helpers.rowMatchesQuery('domain', '')).toBe(true);
    expect(helpers.rowMatchesQuery('domain', '   ')).toBe(true);
    expect(helpers.rowMatchesQuery('domain', undefined)).toBe(true);
  });

  it('is a case-insensitive substring match', () => {
    expect(helpers.rowMatchesQuery('Shared UI', 'ui')).toBe(true);
    expect(helpers.rowMatchesQuery('domain', 'xyz')).toBe(false);
  });
});

describe('clampDepth / normalizeDirection', () => {
  it('clamps depth to [1, MAX_FOCUS_DEPTH]', () => {
    expect(helpers.clampDepth(0)).toBe(1);
    expect(helpers.clampDepth(-3)).toBe(1);
    expect(helpers.clampDepth(NaN)).toBe(1);
    expect(helpers.clampDepth(3)).toBe(3);
    expect(helpers.clampDepth(999)).toBe(helpers.MAX_FOCUS_DEPTH);
  });

  it('normalizes direction to a known value', () => {
    expect(helpers.normalizeDirection('in')).toBe('in');
    expect(helpers.normalizeDirection('out')).toBe('out');
    expect(helpers.normalizeDirection('both')).toBe('both');
    expect(helpers.normalizeDirection('sideways')).toBe('both');
    expect(helpers.normalizeDirection(null)).toBe('both');
  });
});

describe('encodeUiState / decodeUiState', () => {
  it('round-trips a full state', () => {
    const state = {
      selectedId: 'auth',
      search: 'log',
      showExternals: true,
      hiddenExternals: ['ext:rxjs'],
      expanded: ['auth', 'ui'],
      activeTab: 'violations',
      filters: {
        tags: ['domain'],
        projects: ['app'],
        moduleTypes: ['barrel'],
        violationOnly: true,
      },
      focus: { id: 'auth', depth: 2, direction: 'in' },
    };
    const decoded = helpers.decodeUiState(helpers.encodeUiState(state));
    expect(decoded.selectedId).toBe('auth');
    expect(decoded.search).toBe('log');
    expect(decoded.showExternals).toBe(true);
    expect(decoded.hiddenExternals).toEqual(['ext:rxjs']);
    expect(decoded.expanded).toEqual(['auth', 'ui']);
    expect(decoded.activeTab).toBe('violations');
    expect(decoded.filters).toEqual(state.filters);
    expect(decoded.focus).toEqual(state.focus);
  });

  it('tolerates a leading # and empty hash', () => {
    const empty = helpers.decodeUiState('#');
    expect(empty.selectedId).toBeNull();
    expect(empty.filters.tags).toEqual([]);
    expect(empty.showExternals).toBe(false);
    expect(empty.expanded).toEqual([]);
    expect(empty.activeTab).toBe('details');
    expect(empty.focus).toBeNull();
  });

  it('omits inactive fields from the encoded string', () => {
    const encoded = helpers.encodeUiState({ filters: {} });
    expect(encoded).toBe('');
  });

  it('defaults the active tab to details when absent', () => {
    expect(helpers.decodeUiState('').activeTab).toBe('details');
  });

  it('defaults focus depth and direction sensibly', () => {
    const decoded = helpers.decodeUiState('focus=auth');
    expect(decoded.focus).toEqual({ id: 'auth', depth: 1, direction: 'both' });
  });

  it('clamps a hostile focus depth and normalizes a bad direction', () => {
    const decoded = helpers.decodeUiState('focus=auth&focusDepth=999&focusDir=weird');
    expect(decoded.focus.depth).toBe(helpers.MAX_FOCUS_DEPTH);
    expect(decoded.focus.direction).toBe('both');
  });
});
