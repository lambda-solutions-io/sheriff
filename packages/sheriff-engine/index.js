'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- napi package loader is intentionally CommonJS. */

const path = require('node:path');
const ts = require('typescript');
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
  const callbackId = callbacks.length;
  callbacks.push({ callback, configPath, kind });
  return { __sheriffEngineCallbackId: callbackId };
}

function obviousImpurityReason(callback) {
  const source = Function.prototype.toString.call(callback);
  if (source.includes('[native code]'))
    return 'native function source is opaque';
  const parsed = parseCallbackSource(source);
  if (typeof parsed === 'string') return parsed;
  if (unsupportedLexicalKeyword(parsed.callback)) {
    return 'a super or meta-property reference was detected';
  }
  let freeIdentifier;
  const visit = (node) => {
    if (freeIdentifier) return;
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      freeIdentifier = 'this';
      return;
    }
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      // A named function expression declares its own name inside the callback,
      // but reading that binding enables persistent self-mutation such as
      // `decision.calls++`. Recursive callbacks are conservatively routed to
      // the compatibility engine for the same reason.
      if (
        ts.isFunctionExpression(parsed.callback) &&
        parsed.callback.name?.text === node.text &&
        parsed.callback.name !== node
      ) {
        freeIdentifier = node.text;
        return;
      }
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? parsed.checker.getShorthandAssignmentValueSymbol(node.parent)
        : parsed.checker.getSymbolAtLocation(node);
      const declarations = symbol?.declarations;
      if (
        !declarations?.some(
          (declaration) =>
            declaration.pos >= parsed.callback.pos &&
            declaration.end <= parsed.callback.end,
        )
      ) {
        freeIdentifier = node.text;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.callback);

  return freeIdentifier
    ? `free identifier '${freeIdentifier}' is referenced`
    : undefined;
}

function parseCallbackSource(source) {
  const fileName = '/__sheriff_callback__.js';
  const text = `const __sheriffCallback = (${source}\n);`;
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const options = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = {
    fileExists: (requested) => requested === fileName,
    readFile: (requested) => (requested === fileName ? text : undefined),
    getSourceFile: (requested) =>
      requested === fileName ? sourceFile : undefined,
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    getCanonicalFileName: (requested) => requested,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram([fileName], options, host);
  if (program.getSyntacticDiagnostics(sourceFile).length > 0) {
    return 'function source could not be parsed conservatively';
  }

  const statement = sourceFile.statements[0];
  const declaration = ts.isVariableStatement(statement)
    ? statement.declarationList.declarations[0]
    : undefined;
  const callback = declaration?.initializer
    ? ts.skipParentheses(declaration.initializer)
    : undefined;
  if (
    !callback ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    return 'function source form could not be analyzed conservatively';
  }

  return { callback, checker: program.getTypeChecker() };
}

function isIdentifierReference(node) {
  const parent = node.parent;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    return true;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) {
    return false;
  }
  if (ts.isQualifiedName(parent) && parent.right === node) {
    return false;
  }
  if (
    (ts.isBreakStatement(parent) ||
      ts.isContinueStatement(parent) ||
      ts.isLabeledStatement(parent)) &&
    parent.label === node
  ) {
    return false;
  }
  return !ts.isDeclarationName(node);
}

function unsupportedLexicalKeyword(node) {
  if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)) {
    return true;
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && unsupportedLexicalKeyword(child)) {
      found = true;
    }
  });
  return found;
}

function assertProvablyPure(callbackEntry) {
  if (!Object.hasOwn(callbackEntry, 'impureReason')) {
    callbackEntry.impureReason = obviousImpurityReason(callbackEntry.callback);
  }
  if (callbackEntry.impureReason) {
    throw new EngineImpureCallbackError(
      callbackEntry.configPath,
      callbackEntry.impureReason,
    );
  }
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

function evaluateOnce(callbackEntry, args, normalize) {
  assertProvablyPure(callbackEntry);
  const frozenArgs = args.map((argument) => deepFreeze(argument));
  try {
    return normalize(callbackEntry.callback(...frozenArgs), callbackEntry);
  } catch (error) {
    if (isFrozenArgumentMutationError(error)) {
      throw new EngineImpureCallbackError(
        callbackEntry.configPath,
        'callback mutated its arguments',
      );
    }
    throw error;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    seen.has(value)
  ) {
    return value;
  }

  seen.add(value);
  for (const propertyValue of Object.values(value)) {
    deepFreeze(propertyValue, seen);
  }
  return Object.freeze(value);
}

function isFrozenArgumentMutationError(error) {
  return (
    error instanceof TypeError &&
    /(?:read only|not extensible|Cannot delete property|Cannot redefine property)/u.test(
      error.message,
    )
  );
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
    return evaluateOnce(
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
    return evaluateOnce(
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
    return require('./native/binding.js');
  } catch (error) {
    const expectedPathIsMissing = nativeBindingIsMissing(error);
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

function nativeBindingIsMissing(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current.code && current.code !== 'MODULE_NOT_FOUND') {
      return false;
    }
    current = current.cause;
  }
  return true;
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

class ProjectHandle {
  constructor(inputJson) {
    const prepared =
      typeof inputJson === 'string'
        ? { callbacks: [], serializableInput: JSON.parse(inputJson) }
        : prepareInput(inputJson);
    const NativeProjectHandle = loadNative().ProjectHandle;
    this.callbacks = prepared.callbacks;
    this.nativeHandle = new NativeProjectHandle(
      JSON.stringify(prepared.serializableInput),
    );
    this.latestResult = this.settle(this.nativeHandle.getResult());
  }

  applyChanges(eventsJson) {
    const serialized =
      typeof eventsJson === 'string' ? eventsJson : JSON.stringify(eventsJson);
    this.latestResult = this.settle(this.nativeHandle.applyChanges(serialized));
    return this.latestResult;
  }

  setOverlay(path, content) {
    this.latestResult = this.settle(
      this.nativeHandle.setOverlay(path, content),
    );
    return this.latestResult;
  }

  clearOverlay(path) {
    this.latestResult = this.settle(this.nativeHandle.clearOverlay(path));
    return this.latestResult;
  }

  getResult() {
    return this.latestResult;
  }

  getReachedFiles() {
    return this.nativeHandle.getReachedFiles();
  }

  settle(serializedOutput) {
    for (let pass = 0; pass < 3; pass += 1) {
      const output = JSON.parse(serializedOutput);
      if (output.tagCallbackCandidates) {
        serializedOutput = this.nativeHandle.provideCallbackResults(
          JSON.stringify({
            schemaVersion: 1,
            results: materializeTagCallbacks(
              output.tagCallbackCandidates,
              this.callbacks,
            ),
          }),
        );
        continue;
      }
      if (output.ruleCallbackCandidates) {
        serializedOutput = this.nativeHandle.provideCallbackResults(
          JSON.stringify({
            schemaVersion: 1,
            results: materializeRuleCallbacks(
              output.ruleCallbackCandidates,
              this.callbacks,
            ),
          }),
        );
        continue;
      }
      return serializedOutput;
    }
    throw new Error(
      'Sheriff Rust ProjectHandle callback materialization did not converge',
    );
  }
}

module.exports = {
  analyzeProject,
  ProjectHandle,
  resolveProjectImports,
  resolveModuleNameForEngineShadow,
  EngineUnsupportedConfigError,
  EngineImpureCallbackError,
};
