'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- napi package loader is intentionally CommonJS. */

const path = require('node:path');
const { nativeBinaryName, nativeTriple } = require('./platform.js');

class EngineUnsupportedConfigError extends Error {
  constructor(configPath, valueKind = 'function') {
    super(
      `Sheriff Rust engine v1 only supports static configuration; found an unsupported ${valueKind} at ${configPath}.`,
    );
    this.name = 'EngineUnsupportedConfigError';
    this.code = 'SHERIFF_ENGINE_UNSUPPORTED_CONFIG';
  }
}

function assertStaticConfig(value, configPath = 'input') {
  if (typeof value === 'function') {
    throw new EngineUnsupportedConfigError(configPath, 'function');
  }

  if (value instanceof RegExp) {
    if (configPath === 'input.encapsulationPattern') return;
    throw new EngineUnsupportedConfigError(configPath, 'RegExp');
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertStaticConfig(entry, `${configPath}[${index}]`),
    );
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertStaticConfig(entry, `${configPath}.${key}`);
    }
  }
}

const binaryName = nativeBinaryName();
const binaryPath = path.join(__dirname, 'native', binaryName);

function loadNative() {
  try {
    return require(binaryPath);
  } catch (error) {
    const expectedPathIsMissing =
      error?.code === 'MODULE_NOT_FOUND' &&
      (error?.path === binaryPath || error?.message?.includes(binaryPath));
    const loadError = new Error(
      expectedPathIsMissing
        ? `Sheriff native engine is unavailable for ${nativeTriple()}. ` +
            `Expected ${binaryPath}. Run \"npm run build:native\" in packages/sheriff-engine.`
        : `Sheriff native engine for ${nativeTriple()} exists but failed to load from ${binaryPath}: ${error?.message ?? error}`,
      { cause: error },
    );
    loadError.code = expectedPathIsMissing
      ? 'SHERIFF_ENGINE_NATIVE_MISSING'
      : 'SHERIFF_ENGINE_NATIVE_LOAD_FAILED';
    throw loadError;
  }
}

function analyzeProject(inputJson) {
  if (typeof inputJson === 'string') {
    return loadNative().analyzeProject(inputJson);
  }

  assertStaticConfig(inputJson);
  const serializableInput =
    inputJson.encapsulationPattern instanceof RegExp
      ? {
          ...inputJson,
          encapsulationPattern: {
            source: inputJson.encapsulationPattern.source,
            flags: inputJson.encapsulationPattern.flags,
          },
        }
      : inputJson;
  return loadNative().analyzeProject(JSON.stringify(serializableInput));
}

module.exports = {
  analyzeProject,
  EngineUnsupportedConfigError,
};
