import {
  clearProjectCache,
  getCacheStats,
  resetCacheStats,
} from '../cache/project-cache';
import { FsPath, toFsPath } from '../file-info/fs-path';
import { useVirtualFs } from '../fs/getFs';
import { init } from '../main/init';

export interface SyntheticProjectOptions {
  domains: number;
  modulesPerDomain: number;
  filesPerModule: number;
}

export interface SyntheticProject {
  entryFile: FsPath;
  fileCount: number;
  moduleCount: number;
  modulePaths: FsPath[];
  sourceFilePaths: FsPath[];
}

/**
 * Builds a barrel-module project in Sheriff's existing virtual filesystem.
 * Every generated source file is reachable from `src/main.ts`.
 */
export function createSyntheticProject(
  options: SyntheticProjectOptions,
): SyntheticProject {
  validateOptions(options);

  const { domains, modulesPerDomain, filesPerModule } = options;
  const fs = useVirtualFs();
  fs.reset();

  const modulePaths: FsPath[] = [];
  const sourceFilePaths: FsPath[] = [];
  const mainImports: string[] = [];

  for (let domain = 0; domain < domains; domain++) {
    mainImports.push(`import './app/domain-${domain}/module-0';`);

    for (let module = 0; module < modulesPerDomain; module++) {
      const rawModulePath = `/project/src/app/domain-${domain}/module-${module}`;
      fs.createDir(rawModulePath);
      const modulePath = toFsPath(rawModulePath);
      modulePaths.push(modulePath);

      const barrelImports: string[] = [];
      for (let file = 0; file < filesPerModule; file++) {
        const rawFilePath = `${modulePath}/file-${file}.ts`;
        const imports = siblingImports(file, filesPerModule);

        if (file === 0 && module + 1 < modulesPerDomain) {
          imports.push(`import '../module-${module + 1}';`);
        }

        fs.writeFile(
          rawFilePath,
          `${imports.join('\n')}\nexport const value = ${file};\n`,
        );
        barrelImports.push(`import './file-${file}';`);
        sourceFilePaths.push(toFsPath(rawFilePath));
      }

      const rawBarrelPath = `${modulePath}/index.ts`;
      fs.writeFile(
        rawBarrelPath,
        `${barrelImports.join('\n')}\nexport const api = ${domain};\n`,
      );
      sourceFilePaths.push(toFsPath(rawBarrelPath));
    }
  }

  fs.writeFile('/project/src/main.ts', `${mainImports.join('\n')}\n`);
  const entryFile = toFsPath('/project/src/main.ts');
  sourceFilePaths.push(entryFile);
  fs.writeFile(
    '/project/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        strict: true,
      },
    }),
  );
  fs.writeFile(
    '/project/sheriff.config.ts',
    `export const config = {
  version: 1,
  entryFile: 'src/main.ts',
  tagging: {
    'src/app': {
      '<domain>/<type>': ['domain:<domain>', 'type:<type>'],
    },
  },
  depRules: { '*': '*' },
};
`,
  );

  return {
    entryFile,
    fileCount: sourceFilePaths.length,
    moduleCount: modulePaths.length,
    modulePaths,
    sourceFilePaths,
  };
}

/** Runs a cold `init` and returns its opt-in cache instrumentation. */
export function initSyntheticProject(project: SyntheticProject) {
  clearProjectCache();
  resetCacheStats();
  const projectInfo = init(project.entryFile);
  return { projectInfo, cacheStats: getCacheStats() };
}

function siblingImports(file: number, filesPerModule: number): string[] {
  const imports: string[] = [];
  const siblingCount = Math.min(3, filesPerModule - 1);

  for (let offset = 1; offset <= siblingCount; offset++) {
    imports.push(`import './file-${(file + offset) % filesPerModule}';`);
  }

  return imports;
}

function validateOptions(options: SyntheticProjectOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
