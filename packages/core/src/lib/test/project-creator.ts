import { FileTree, isSheriffConfigContent } from './project-configurator';
import { EOL } from 'os';
import * as crypto from 'crypto';
import getFs, { useVirtualFs } from '../fs/getFs';
import { toFsPath } from '../file-info/fs-path';

import { defaultConfig } from '../config/default-config';
import { Fs } from '../fs/fs';
import { UserSheriffConfig } from '../config/user-sheriff-config';

export function createProject(
  fileTree: FileTree,
  testDirName = '/project',
): Fs {
  const fs = useVirtualFs();
  fs.reset();

  new ProjectCreator().create(fileTree, testDirName);
  return fs;
}

class ProjectCreator {
  fs = getFs();
  create = (fileTree: FileTree, testDirName?: string) => {
    if (testDirName === undefined) {
      testDirName = this.fs.join(
        this.fs.tmpdir(),
        'sheriff',
        crypto.randomUUID(),
      );
    } else if (this.fs.exists(testDirName)) {
      this.fs.removeDir(toFsPath(testDirName));
    }

    this.fs.createDir(testDirName);
    this.traverseFileTree(testDirName, fileTree);
  };

  traverseFileTree = (currentDir: string, fileTree: FileTree) => {
    this.fs.createDir(currentDir);
    for (const child in fileTree) {
      const value = fileTree[child];
      if (Array.isArray(value)) {
        this.fs.writeFile(
          `${currentDir}/${child}`,
          value.map((imp) => `import '${imp}';`).join(EOL),
        );
      } else if (typeof value === 'string') {
        this.fs.writeFile(`${currentDir}/${child}`, value);
      } else if (isSheriffConfigContent(value)) {
        let serializedConfig = JSON.stringify(
          serializeEncapsulationPattern(serializeDepRules(value.content)),
        );

        if (value.content.encapsulationPattern instanceof RegExp) {
          serializedConfig = serializedConfig.replace(
            /"Δ.*Δ"/,
            value.content.encapsulationPattern.toString(),
          );
        }

        // Unwrap the `α…ω` markers back into real code. JSON.stringify has
        // escaped the function source, so string literals inside the body
        // (e.g. `to !== 'x'`) must be unescaped again, otherwise the emitted
        // config file is not valid JavaScript.
        serializedConfig = serializedConfig.replace(
          /"α([^ω]+)ω"/g,
          (_match, fnSource: string) => unescapeJsonString(fnSource),
        );
        this.fs.writeFile(
          `${currentDir}/${child}`,
          `export const config = ${serializedConfig};`,
        );
      } else {
        this.traverseFileTree(`${currentDir}/${child}`, value);
      }
    }
  };
}

/**
 * Reverses the escaping which `JSON.stringify` applied to a function's source
 * code, so that it can be emitted as executable JavaScript again.
 */
function unescapeJsonString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Replaces every function matcher with a `α…ω` marker, so that it survives
 * `JSON.stringify` and can be unwrapped back into real code afterwards.
 */
function serializeRules<T extends Record<string, unknown>>(rules: T): T {
  return Object.entries(rules).reduce(
    (current, [from, tos]) => ({
      ...current,
      [from]: (Array.isArray(tos) ? tos : [tos]).map((matcher) =>
        typeof matcher === 'function' ? `α${matcher.toString()}ω` : matcher,
      ),
    }),
    {},
  ) as T;
}

/**
 * Replaces external matcher functions without changing their scalar shape.
 */
function serializeExternalRules<T extends Record<string, unknown>>(
  rules: T,
): T {
  return Object.entries(rules).reduce(
    (current, [from, matcher]) => ({
      ...current,
      [from]:
        typeof matcher === 'function' ? `α${matcher.toString()}ω` : matcher,
    }),
    {},
  ) as T;
}

/**
 * Serializes the config exactly as the test author wrote it — the defaults
 * are deliberately NOT merged in.
 *
 * A generated `sheriff.config.ts` therefore contains only the options which
 * were actually set, just like a hand-written one. That distinction is
 * load-bearing: `sheriff doctor` reports options a sub-config silently
 * inherits from the defaults, and it can only see them if an unset option is
 * absent from the file rather than spelled out with its default value.
 */
function serializeDepRules(config: UserSheriffConfig): UserSheriffConfig {
  const ignoreFileExtensions =
    typeof config.ignoreFileExtensions === 'function'
      ? config.ignoreFileExtensions(defaultConfig.ignoreFileExtensions)
      : config.ignoreFileExtensions;

  return {
    ...config,
    ...(config.depRules ? { depRules: serializeRules(config.depRules) } : {}),
    ...(config.denyRules
      ? { denyRules: serializeRules(config.denyRules) }
      : {}),
    ...(config.externalRules
      ? { externalRules: serializeExternalRules(config.externalRules) }
      : {}),
    ...(ignoreFileExtensions ? { ignoreFileExtensions } : {}),
  };
}

function serializeEncapsulationPattern(
  config: UserSheriffConfig,
): UserSheriffConfig {
  if (config.encapsulationPattern instanceof RegExp) {
    // unwrapped back into a real RegExp literal after `JSON.stringify`
    return {
      ...config,
      encapsulationPattern: `Δ${config.encapsulationPattern.toString()}Δ`,
    };
  }
  return config;
}
