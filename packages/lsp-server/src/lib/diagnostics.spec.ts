import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearProjectCache } from '@lambda-solutions/sheriff-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDefaultFs } from '../../../core/src/lib/fs/getFs';
import * as fileInfoGenerator from '../../../core/src/lib/file-info/generate-unassigned-file-info';
import {
  createSheriffDiagnostics,
  extractImportSpecifiers,
} from './diagnostics';
import { filePathToUri } from './uri';

describe('Sheriff diagnostics', () => {
  let tmpDirs: string[] = [];

  beforeEach(() => {
    tmpDirs = [];
    useDefaultFs();
    clearProjectCache();
  });

  afterEach(() => {
    clearProjectCache();
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns no diagnostics when no Sheriff config is present', () => {
    const project = createFixtureProject({ withConfig: false });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));

    expect(createSheriffDiagnostics(uri, "import '../shared';\n")).toEqual([]);
  });

  it('uses the root config discovered through an extended tsconfig', () => {
    const project = createFixtureProject({
      withConfig: true,
      withNestedTsconfig: true,
    });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));

    expect(createSheriffDiagnostics(uri, "import '../shared';\n")).toHaveLength(
      1,
    );
  });

  it('analyzes a document only once for all Sheriff rule families', () => {
    const project = createFixtureProject({ withConfig: true });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const analysisSpy = vi.spyOn(
      fileInfoGenerator,
      'generateUnassignedFileInfo',
    );

    createSheriffDiagnostics(uri, "import '../shared';\n");

    expect(analysisSpy).toHaveBeenCalledTimes(1);
  });

  it('extracts real imports without matching comments or strings', () => {
    const text = [
      "// import '../commented';",
      `const source = "export * from '../string';";`,
      "const lazy = import(/* webpackChunkName: 'real' */ '../real');",
    ].join('\n');

    expect(extractImportSpecifiers(text)).toEqual([
      {
        value: '../real',
        range: {
          start: { line: 2, character: 52 },
          end: { line: 2, character: 59 },
        },
      },
    ]);
  });

  it('maps import ranges after lone carriage-return line endings', () => {
    expect(
      extractImportSpecifiers("const value = 1;\rimport '../shared';\r"),
    ).toEqual([
      {
        value: '../shared',
        range: {
          start: { line: 1, character: 8 },
          end: { line: 1, character: 17 },
        },
      },
    ]);
  });

  function createFixtureProject(options: {
    withConfig: boolean;
    withNestedTsconfig?: boolean;
  }): string {
    const project = mkdtempSync(join(tmpdir(), 'sheriff-lsp-'));
    tmpDirs.push(project);

    mkdirSync(join(project, 'src/app'), { recursive: true });
    mkdirSync(join(project, 'src/shared'), { recursive: true });
    writeFileSync(
      join(project, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          strict: true,
          target: 'es2016',
        },
      }),
    );
    if (options.withNestedTsconfig) {
      writeFileSync(
        join(project, 'src/app/tsconfig.json'),
        JSON.stringify({ extends: '../../tsconfig.json' }),
      );
    }
    if (options.withConfig) {
      writeFileSync(
        join(project, 'sheriff.config.ts'),
        `export const config = {
  modules: {
    'src/app': 'app',
    'src/shared': 'shared',
  },
  depRules: {
    app: [],
  },
  enableBarrelLess: true,
};`,
      );
    }

    writeFileSync(join(project, 'src/app/main.ts'), "import './local';\n");
    writeFileSync(join(project, 'src/app/local.ts'), '');
    writeFileSync(join(project, 'src/shared/index.ts'), '');

    return project;
  }
});
