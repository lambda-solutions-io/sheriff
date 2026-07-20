'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- napi package loader is intentionally CommonJS. */

const path = require('node:path');

class EngineUnsupportedConfigError extends Error {
  constructor(configPath) {
    super(
      `Sheriff Rust engine v1 only supports static configuration; found a function at ${configPath}.`,
    );
    this.name = 'EngineUnsupportedConfigError';
    this.code = 'SHERIFF_ENGINE_UNSUPPORTED_CONFIG';
  }
}

function assertStaticConfig(value, configPath = 'input') {
  if (typeof value === 'function' || value instanceof RegExp) {
    throw new EngineUnsupportedConfigError(configPath);
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

const binaryName = `sheriff-engine.${process.platform}-${process.arch}.node`;
const binaryPath = path.join(__dirname, 'native', binaryName);

function loadNative() {
  try {
    return require(binaryPath);
  } catch (error) {
    const missingError = new Error(
      `Sheriff native engine is unavailable for ${process.platform}-${process.arch}. ` +
        `Expected ${binaryPath}. Run \"npm run build:native\" in packages/sheriff-engine.`,
      { cause: error },
    );
    missingError.code = 'SHERIFF_ENGINE_NATIVE_MISSING';
    throw missingError;
  }
}

function analyzeProject(inputJson) {
  if (typeof inputJson === 'string') {
    return loadNative().analyzeProject(inputJson);
  }

  assertStaticConfig(inputJson);
  return loadNative().analyzeProject(JSON.stringify(inputJson));
}

module.exports = {
  analyzeProject,
  EngineUnsupportedConfigError,
};
