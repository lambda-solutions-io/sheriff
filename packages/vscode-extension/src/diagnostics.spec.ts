import { dirname, join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { resolveCliBinPath } from './cli-bin-path';
import {
  lintResultToDiagnostics,
  projectEntryToHoverMarkdown,
} from './diagnostics';

describe('lintResultToDiagnostics', () => {
  it('maps every daemon violation kind to a first-line diagnostic', () => {
    const diagnostics = lintResultToDiagnostics({
      dependencyRuleViolations: [
        {
          fromTag: 'feature',
          toTags: ['data', 'shared'],
          rawImport: '@app/admin',
        },
      ],
      encapsulationViolations: ['@app/data/internal'],
      externalRuleViolations: [
        { fromTag: 'domain', externalLibrary: 'lodash' },
      ],
    });

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(({ kind }) => kind)).toEqual([
      'dependency-rule',
      'encapsulation',
      'external-rule',
    ]);
    expect(diagnostics.map(({ message }) => message)).toEqual([
      "Dependency rule violation: 'feature' is not allowed to import '@app/admin' (allowed tags: data, shared).",
      "Encapsulation violation: '@app/data/internal' is not part of the public API.",
      "External dependency rule violation: 'domain' is not allowed to import external library 'lodash'.",
    ]);
    expect(
      diagnostics.every(
        ({ line, character, endCharacter, source }) =>
          line === 0 &&
          character === 0 &&
          endCharacter === Number.MAX_SAFE_INTEGER &&
          source === 'sheriff',
      ),
    ).toBe(true);
  });

  it('uses none when a dependency rule has no allowed tags', () => {
    const diagnostics = lintResultToDiagnostics({
      dependencyRuleViolations: [
        { fromTag: 'isolated', toTags: [], rawImport: '@app/shared' },
      ],
      encapsulationViolations: [],
      externalRuleViolations: [],
    });

    expect(diagnostics[0]?.message).toContain('(allowed tags: none).');
  });

  it('returns no diagnostics for an empty result', () => {
    expect(
      lintResultToDiagnostics({
        dependencyRuleViolations: [],
        encapsulationViolations: [],
        externalRuleViolations: [],
      }),
    ).toEqual([]);
  });
});

describe('projectEntryToHoverMarkdown', () => {
  it('includes the module and its tags', () => {
    const markdown = projectEntryToHoverMarkdown({
      module: 'src/orders',
      moduleType: 'barrel',
      tags: ['domain:orders', 'type:feature'],
    });

    expect(markdown).toContain('`src/orders`');
    expect(markdown).toContain('`domain:orders`');
    expect(markdown).toContain('`type:feature`');
  });

  it('returns undefined when there is no project entry', () => {
    expect(projectEntryToHoverMarkdown(undefined)).toBeUndefined();
  });
});

describe('resolveCliBinPath', () => {
  it('resolves the sheriff bin declared by the workspace core package', () => {
    const manifestPath = resolve(__dirname, '../../core/package.json');
    let requestedId: string | undefined;

    const cliBinPath = resolveCliBinPath('/workspace', (id) => {
      requestedId = id;
      return manifestPath;
    });

    expect(requestedId).toBe('@lambda-solutions/sheriff-core/package.json');
    expect(cliBinPath).toBe(join(dirname(manifestPath), './src/bin/main.js'));
  });
});
