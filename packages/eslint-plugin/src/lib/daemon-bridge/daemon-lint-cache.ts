import {
  disableDaemonBridge,
  isDaemonBridgeEnabled,
  lintFileViaDaemon,
} from './daemon-bridge';
import type {
  DaemonLintResult,
  DependencyRuleViolationInfo,
  ExternalRuleViolationInfo,
} from './daemon-bridge';

interface DaemonLintMessages {
  dependency: Map<string, string>;
  encapsulation: Map<string, string>;
}

interface DaemonLintCacheEntry {
  sourceCode: string;
  messages: DaemonLintMessages;
}

// Bound the per-process cache so a long-running ESLint session linting many
// files does not grow it without limit; the oldest entry is evicted first.
const MAX_CACHED_FILES = 512;
const messagesByFilename = new Map<string, DaemonLintCacheEntry>();

export function daemonDependencyMessage(
  filename: string,
  importValue: string,
  _isFirstRun: boolean,
  sourceCode: string,
): string | undefined {
  const messages = getDaemonLintMessages(filename, sourceCode);
  return messages?.dependency.get(importValue) ?? (messages ? '' : undefined);
}

export function daemonEncapsulationMessage(
  filename: string,
  importValue: string,
  _isFirstRun: boolean,
  sourceCode: string,
): string | undefined {
  const messages = getDaemonLintMessages(filename, sourceCode);
  return (
    messages?.encapsulation.get(importValue) ?? (messages ? '' : undefined)
  );
}

function getDaemonLintMessages(
  filename: string,
  sourceCode: string,
): DaemonLintMessages | undefined {
  if (!isDaemonBridgeEnabled()) {
    return undefined;
  }

  const cached = messagesByFilename.get(filename);
  // Both ESLint rules report `isFirstRun` independently. The source buffer is
  // the shared identity that distinguishes their duplicate first calls from a
  // later lint pass after the editor content changed.
  if (cached?.sourceCode === sourceCode) {
    return cached.messages;
  }

  const result = lintFileViaDaemon(filename, sourceCode);
  if (!result) {
    messagesByFilename.delete(filename);
    return undefined;
  }

  // The worker return value is an unchecked cast over the wire; a malformed
  // daemon response must never throw into ESLint's createRule. On any
  // structurally invalid result, treat it as a bridge failure: disable the
  // bridge and fall back in-process instead of surfacing a spurious
  // "(internal error)" diagnostic.
  let messages: DaemonLintMessages;
  try {
    messages = buildDaemonLintMessages(result);
  } catch {
    disableDaemonBridge();
    messagesByFilename.delete(filename);
    return undefined;
  }

  messagesByFilename.set(filename, { sourceCode, messages });
  evictOldestWhenOverCapacity();
  return messages;
}

/** Test-only: prevents retained daemon messages from leaking between specs. */
export function clearDaemonLintCacheForTests(): void {
  messagesByFilename.clear();
}

function evictOldestWhenOverCapacity(): void {
  while (messagesByFilename.size > MAX_CACHED_FILES) {
    const oldest = messagesByFilename.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    messagesByFilename.delete(oldest);
  }
}

function buildDaemonLintMessages(
  result: DaemonLintResult,
): DaemonLintMessages {
  // Validate the RPC result shape up front. A missing/non-array field or a
  // malformed violation would otherwise throw mid-map (e.g. on `.map` or
  // `toTags.join`), so reject the whole result and let the caller fall back.
  assertValidLintResult(result);

  const dependency = new Map<string, string>();
  const encapsulation = new Map<string, string>();

  for (const violation of result.dependencyRuleViolations) {
    // The daemon omits module paths, so identify the import in the prefix.
    dependency.set(
      violation.rawImport,
      `module import '${violation.rawImport}' violates the dependency rule. Tag ${violation.fromTag} has no clearance for tags ${violation.toTags.join(', ')}`,
    );
  }

  for (const violation of result.externalRuleViolations) {
    dependency.set(
      violation.externalLibrary,
      `module cannot import external library ${violation.externalLibrary}. Tag ${violation.fromTag} has no clearance in externalRules`,
    );
  }

  for (const rawImport of result.encapsulationViolations) {
    // The daemon does not distinguish barrel from barrel-less violations, so
    // use the existing non-barrel wording for both cases.
    encapsulation.set(
      rawImport,
      `'${rawImport}' cannot be imported. It is encapsulated.`,
    );
  }

  // Unresolvable relative imports must produce the SAME message the in-process
  // rules emit, or the daemon-on violation set diverges from the default.
  for (const rawImport of result.unresolvableImports ?? []) {
    const message = `import ${rawImport} cannot be resolved`;
    dependency.set(rawImport, message);
    encapsulation.set(rawImport, message);
  }

  return { dependency, encapsulation };
}

function assertValidLintResult(
  result: DaemonLintResult,
): asserts result is DaemonLintResult {
  if (result === null || typeof result !== 'object') {
    throw new Error('malformed daemon lint result');
  }
  isStringArray(result.encapsulationViolations, 'encapsulationViolations');
  assertUnresolvableImports(result.unresolvableImports);
  assertArray(result.dependencyRuleViolations, 'dependencyRuleViolations');
  for (const violation of result.dependencyRuleViolations) {
    assertDependencyViolation(violation);
  }
  assertArray(result.externalRuleViolations, 'externalRuleViolations');
  for (const violation of result.externalRuleViolations) {
    assertExternalViolation(violation);
  }
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`daemon lint result field ${field} is not an array`);
  }
}

function isStringArray(value: unknown, field: string): void {
  assertArray(value, field);
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`daemon lint result field ${field} has a non-string entry`);
    }
  }
}

function assertUnresolvableImports(value: unknown): void {
  // Optional over the wire (older daemons omit it); when present it must be a
  // string array so the mapping above never throws.
  if (value === undefined) {
    return;
  }
  isStringArray(value, 'unresolvableImports');
}

function assertDependencyViolation(
  value: unknown,
): asserts value is DependencyRuleViolationInfo {
  if (value === null || typeof value !== 'object') {
    throw new Error('malformed dependency violation');
  }
  const violation = value as Record<string, unknown>;
  if (typeof violation['fromTag'] !== 'string') {
    throw new Error('dependency violation is missing fromTag');
  }
  if (typeof violation['rawImport'] !== 'string') {
    throw new Error('dependency violation is missing rawImport');
  }
  isStringArray(violation['toTags'], 'dependencyRuleViolations.toTags');
}

function assertExternalViolation(
  value: unknown,
): asserts value is ExternalRuleViolationInfo {
  if (value === null || typeof value !== 'object') {
    throw new Error('malformed external violation');
  }
  const violation = value as Record<string, unknown>;
  if (typeof violation['fromTag'] !== 'string') {
    throw new Error('external violation is missing fromTag');
  }
  if (typeof violation['externalLibrary'] !== 'string') {
    throw new Error('external violation is missing externalLibrary');
  }
}
