'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- napi package loader is intentionally CommonJS. */

const path = require('node:path');
const { nativeBinaryName, nativeTriple } = require('./platform.js');

class EngineUnsupportedConfigError extends Error {
  constructor(configPath, valueKind = 'function') {
    super(
      `Sheriff Rust engine v1 found an unsupported ${valueKind} at ${configPath}.`,
    );
    this.name = 'EngineUnsupportedConfigError';
    this.code = 'SHERIFF_ENGINE_UNSUPPORTED_CONFIG';
  }
}

class EngineImpureCallbackError extends Error {
  constructor(configPath, reason) {
    super(
      `Sheriff Rust engine cannot safely batch the callback at ${configPath}: ${reason}. Use the TypeScript compatibility engine for this config.`,
    );
    this.name = 'EngineImpureCallbackError';
    this.code = 'SHERIFF_ENGINE_IMPURE_CALLBACK';
    this.fallback = true;
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

function callbackMarker(callbacks, callback, configPath, kind) {
  const impureReason = obviousImpurityReason(callback);
  if (impureReason) {
    throw new EngineImpureCallbackError(configPath, impureReason);
  }
  const callbackId = callbacks.length;
  callbacks.push({ callback, configPath, kind });
  return { __sheriffEngineCallbackId: callbackId };
}

function obviousImpurityReason(callback) {
  const source = Function.prototype.toString.call(callback);
  if (source.includes('[native code]'))
    return 'native function source is opaque';
  const localNames = new Set(
    [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    ),
  );
  const mutationTargets = [
    ...source.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*(?:\+\+|--|\+=|-=|\*=|\/=|%=|=(?!=|>))/g,
    ),
  ];
  if (mutationTargets.some((match) => !localNames.has(match[1]))) {
    return 'mutation of non-local state detected';
  }
  const propertyMutationTargets = [
    ...source.matchAll(
      /\b([A-Za-z_$][\w$]*)\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])+\s*(?:\+\+|--|\+=|-=|\*=|\/=|%=|=(?!=|>))/g,
    ),
  ];
  if (propertyMutationTargets.some((match) => !localNames.has(match[1]))) {
    return 'mutation of non-local object state detected';
  }
  if (
    /\b(?:Date|process|globalThis|require|eval|Function|performance)\b|Math\s*\.\s*random\b/.test(
      source,
    )
  ) {
    return 'an obvious ambient-state reference was detected';
  }
  return undefined;
}

function serializeModuleConfig(value, callbacks, configPath) {
  if (typeof value === 'function') {
    return callbackMarker(callbacks, value, configPath, 'tag');
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        throw new EngineUnsupportedConfigError(
          `${configPath}[${index}]`,
          typeof entry,
        );
      }
    });
    return value;
  }
  if (value && typeof value === 'object' && !(value instanceof RegExp)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        serializeModuleConfig(entry, callbacks, `${configPath}.${key}`),
      ]),
    );
  }
  throw new EngineUnsupportedConfigError(configPath, typeof value);
}

function serializeRuleValue(value, callbacks, configPath, kind) {
  if (typeof value === 'function') {
    return callbackMarker(callbacks, value, configPath, kind);
  }
  if (typeof value === 'string' || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (
        typeof entry !== 'function' &&
        typeof entry !== 'string' &&
        entry !== null
      ) {
        throw new EngineUnsupportedConfigError(
          `${configPath}[${index}]`,
          typeof entry,
        );
      }
      return typeof entry === 'function'
        ? callbackMarker(callbacks, entry, `${configPath}[${index}]`, kind)
        : entry;
    });
  }
  throw new EngineUnsupportedConfigError(configPath, typeof value);
}

function serializeRuleConfig(value, callbacks, configPath, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineUnsupportedConfigError(configPath, typeof value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      serializeRuleValue(entry, callbacks, `${configPath}.${key}`, kind),
    ]),
  );
}

function serializeExternalRules(value, callbacks, configPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineUnsupportedConfigError(configPath, typeof value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const entryPath = `${configPath}.${key}`;
      if (typeof entry === 'function') {
        return [key, callbackMarker(callbacks, entry, entryPath, 'external')];
      }
      if (
        !Array.isArray(entry) ||
        !entry.every((matcher) => typeof matcher === 'string')
      ) {
        throw new EngineUnsupportedConfigError(entryPath, typeof entry);
      }
      return [key, entry];
    }),
  );
}

function prepareInput(input) {
  const callbacks = [];
  const supportedFunctionProperties = new Set([
    'moduleConfig',
    'depRules',
    'denyRules',
    'externalRules',
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (!supportedFunctionProperties.has(key)) {
      assertStaticConfig(value, `input.${key}`);
    }
  }

  const serializableInput = {
    ...input,
    moduleConfig: serializeModuleConfig(
      input.moduleConfig ?? {},
      callbacks,
      'input.moduleConfig',
    ),
    depRules: serializeRuleConfig(
      input.depRules ?? {},
      callbacks,
      'input.depRules',
      'dependency',
    ),
    denyRules: serializeRuleConfig(
      input.denyRules ?? {},
      callbacks,
      'input.denyRules',
      'dependency',
    ),
    externalRules: serializeExternalRules(
      input.externalRules ?? {},
      callbacks,
      'input.externalRules',
    ),
    tagCallbackResults: undefined,
    ruleCallbackResults: undefined,
    encapsulationPattern:
      input.encapsulationPattern instanceof RegExp
        ? {
            source: input.encapsulationPattern.source,
            flags: input.encapsulationPattern.flags,
          }
        : input.encapsulationPattern,
  };
  return { callbacks, serializableInput };
}

function sameMaterializedValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evaluateTwice(callbackEntry, args, normalize) {
  const first = normalize(callbackEntry.callback(...args), callbackEntry);
  const second = normalize(callbackEntry.callback(...args), callbackEntry);
  if (!sameMaterializedValue(first, second)) {
    throw new EngineImpureCallbackError(
      callbackEntry.configPath,
      'two evaluations on the same concrete context returned different values',
    );
  }
  return first;
}

function normalizeTags(value, callbackEntry) {
  const tags = Array.isArray(value) ? value : [value];
  if (!tags.every((tag) => typeof tag === 'string')) {
    throw new EngineUnsupportedConfigError(
      callbackEntry.configPath,
      'tag callback return value',
    );
  }
  return tags;
}

function normalizeRuleDecision(value, callbackEntry) {
  if (typeof value !== 'boolean') {
    throw new EngineUnsupportedConfigError(
      callbackEntry.configPath,
      'non-boolean callback return value',
    );
  }
  return value;
}

function materializeTagCallbacks(candidates, callbacks) {
  return candidates.map((candidate, index) => {
    if (candidate.candidateIndex !== index) {
      throw new Error(
        'Sheriff Rust engine emitted a non-dense tag candidate index',
      );
    }
    const callbackEntry = callbacks[candidate.matcherId];
    if (!callbackEntry || callbackEntry.kind !== 'tag') {
      throw new Error(
        `Sheriff Rust engine emitted unknown tag matcher ${candidate.matcherId}`,
      );
    }
    const matcherContext = { segment: candidate.matcherContext.segment };
    if (candidate.matcherContext.regexSource !== undefined) {
      matcherContext.regexMatch = matcherContext.segment.match(
        new RegExp(candidate.matcherContext.regexSource),
      );
    }
    return evaluateTwice(
      callbackEntry,
      [Object.fromEntries(candidate.placeholders), matcherContext],
      normalizeTags,
    );
  });
}

function materializeRuleCallbacks(candidates, callbacks) {
  return candidates.map((candidate, index) => {
    if (candidate.candidateIndex !== index) {
      throw new Error(
        'Sheriff Rust engine emitted a non-dense rule candidate index',
      );
    }
    const callbackEntry = callbacks[candidate.matcherId];
    if (!callbackEntry || callbackEntry.kind === 'tag') {
      throw new Error(
        `Sheriff Rust engine emitted unknown rule matcher ${candidate.matcherId}`,
      );
    }
    return evaluateTwice(
      callbackEntry,
      [candidate.context],
      normalizeRuleDecision,
    );
  });
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

  const { callbacks, serializableInput } = prepareInput(inputJson);
  const native = loadNative();
  for (let pass = 0; pass < 3; pass += 1) {
    const serializedOutput = native.analyzeProject(
      JSON.stringify(serializableInput),
    );
    const output = JSON.parse(serializedOutput);
    if (output.tagCallbackCandidates) {
      serializableInput.tagCallbackResults = materializeTagCallbacks(
        output.tagCallbackCandidates,
        callbacks,
      );
      continue;
    }
    if (output.ruleCallbackCandidates) {
      serializableInput.ruleCallbackResults = materializeRuleCallbacks(
        output.ruleCallbackCandidates,
        callbacks,
      );
      continue;
    }
    return serializedOutput;
  }
  throw new Error(
    'Sheriff Rust engine callback materialization did not converge',
  );
}

function resolveProjectImports(inputJson) {
  const serialized =
    typeof inputJson === 'string' ? inputJson : JSON.stringify(inputJson);
  return loadNative().resolveProjectImports(serialized);
}

function resolveModuleNameForEngineShadow(inputJson) {
  const serialized =
    typeof inputJson === 'string' ? inputJson : JSON.stringify(inputJson);
  return loadNative().resolveModuleNameForEngineShadow(serialized);
}

module.exports = {
  analyzeProject,
  resolveProjectImports,
  resolveModuleNameForEngineShadow,
  EngineUnsupportedConfigError,
  EngineImpureCallbackError,
};
