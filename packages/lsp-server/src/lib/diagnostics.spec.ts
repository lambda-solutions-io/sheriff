import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearProjectCache } from '@lambda-solutions/sheriff-core';
import { useDefaultFs } from '../../../core/src/lib/fs/getFs';
import { extractImportSpecifiers } from './diagnostics';
import { createSheriffLspServer } from './lsp-server';
import { JsonRpcMessage } from './message-codec';
import { filePathToUri } from './uri';

describe('diagnostics handler', () => {
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

  it('publishes diagnostics for unsaved didChange content', () => {
    const project = createFixtureProject({ withConfig: true });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const messages: JsonRpcMessage[] = [];
    const server = createSheriffLspServer({
      connection: {
        send: (message) => messages.push(message),
        exit: () => undefined,
      },
    });
    initialize(server);

    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: "import './local';\n",
        },
      },
    });
    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: "import '../shared';\n" }],
      },
    });

    const diagnostics = getLastDiagnostics(messages);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: 1,
      source: 'sheriff',
      message: expect.stringContaining('cannot access'),
      range: {
        start: { line: 0, character: 8 },
        end: { line: 0, character: 17 },
      },
    });
  });

  it('publishes empty diagnostics when no Sheriff config is present', () => {
    const project = createFixtureProject({ withConfig: false });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const messages: JsonRpcMessage[] = [];
    const server = createSheriffLspServer({
      connection: {
        send: (message) => messages.push(message),
        exit: () => undefined,
      },
    });
    initialize(server);

    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: "import '../shared';\n",
        },
      },
    });

    expect(getLastDiagnostics(messages)).toEqual([]);
  });

  it('uses the root config discovered through an extended tsconfig', () => {
    const project = createFixtureProject({
      withConfig: true,
      withNestedTsconfig: true,
    });
    const uri = filePathToUri(join(project, 'src/app/main.ts'));
    const messages: JsonRpcMessage[] = [];
    const server = createSheriffLspServer({
      connection: {
        send: (message) => messages.push(message),
        exit: () => undefined,
      },
    });
    initialize(server);

    server.handleMessage({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri,
          languageId: 'typescript',
          version: 1,
          text: "import '../shared';\n",
        },
      },
    });

    expect(getLastDiagnostics(messages)).toHaveLength(1);
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

function initialize(server: ReturnType<typeof createSheriffLspServer>): void {
  server.handleMessage({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {},
  });
}

function getLastDiagnostics(messages: JsonRpcMessage[]): unknown[] {
  const message = messages.at(-1) as
    | {
        params?: {
          diagnostics?: unknown[];
        };
      }
    | undefined;
  return message?.params?.diagnostics ?? [];
}
