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
  deepImport: Map<string, string>;
  sourceCode: string;
  lintRun: object | undefined;
  firstRunConsumers: Set<DaemonRule>;
}

type DaemonRule = 'dependency' | 'encapsulation' | 'deep-import';

// Bound the per-process cache so a long-running ESLint session linting many
// files does not grow it without limit; the oldest entry is evicted first.
const MAX_CACHED_FILES = 512;
const messagesByFilename = new Map<string, DaemonLintMessages>();

export function daemonDependencyMessage(
  filename: string,
  importValue: string,
  isFirstRun: boolean,
  sourceCode: string,
  lintRun?: object,
): string | undefined {
  const messages = getDaemonLintMessages(
    filename,
    isFirstRun,
    sourceCode,
    'dependency',
    lintRun,
  );
  return messages?.dependency.get(importValue) ?? (messages ? '' : undefined);
}

export function daemonEncapsulationMessage(
  filename: string,
  importValue: string,
  isFirstRun: boolean,
  sourceCode: string,
  lintRun?: object,
): string | undefined {
  const messages = getDaemonLintMessages(
    filename,
    isFirstRun,
    sourceCode,
    'encapsulation',
    lintRun,
  );
  return (
    messages?.encapsulation.get(importValue) ?? (messages ? '' : undefined)
  );
}

export function daemonDeepImportMessage(
  filename: string,
  importValue: string,
  isFirstRun: boolean,
  sourceCode: string,
  lintRun?: object,
): string | undefined {
  const messages = getDaemonLintMessages(
    filename,
    isFirstRun,
    sourceCode,
    'deep-import',
    lintRun,
  );
  return messages?.deepImport.get(importValue) ?? (messages ? '' : undefined);
}

function getDaemonLintMessages(
  filename: string,
  isFirstRun: boolean,
  sourceCode: string,
  consumer: DaemonRule,
  lintRun: object | undefined,
): DaemonLintMessages | undefined {
  if (!isDaemonBridgeEnabled()) {
    return undefined;
  }

  if (isFirstRun) {
    const cached = takeValidCachedMessages(filename, sourceCode, lintRun);
    if (cached && !cached.firstRunConsumers.has(consumer)) {
      cached.firstRunConsumers.add(consumer);
      return cached;
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

    messages.sourceCode = sourceCode;
    messages.lintRun = lintRun;
    messages.firstRunConsumers.add(consumer);

    messagesByFilename.set(filename, messages);
    evictOldestWhenOverCapacity();
    return messages;
  }

  // A later node of a file the daemon already linted. The entry must be
  // validated exactly like on the first run: an evicted entry is absent and a
  // stale one belongs to a different source text or lint run, and returning
  // either would check this node against a result that is not this file's.
  // `undefined` makes the rule fall back in-process, which primes itself.
  return takeValidCachedMessages(filename, sourceCode, lintRun);
}

/**
 * Return the cached messages for `filename` only when they belong to this exact
 * source text and lint run, touching the entry so the file cache is a true LRU
 * rather than FIFO. Touching on every hit — not just on the first run — keeps a
 * file that is still being linted from being evicted by its own lint pass.
 */
function takeValidCachedMessages(
  filename: string,
  sourceCode: string,
  lintRun: object | undefined,
): DaemonLintMessages | undefined {
  const cached = messagesByFilename.get(filename);
  if (cached?.sourceCode !== sourceCode || cached.lintRun !== lintRun) {
    return undefined;
  }

  messagesByFilename.delete(filename);
  messagesByFilename.set(filename, cached);
  return cached;
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
  const deepImport = new Map<string, string>();

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
    deepImport.set(
      rawImport,
      "Deep import is not allowed. Use the module's index.ts or path.",
    );
  }

  // Unresolvable relative imports must produce the SAME message the in-process
  // rules emit, or the daemon-on violation set diverges from the default.
  for (const rawImport of result.unresolvableImports ?? []) {
    const message = `import ${rawImport} cannot be resolved`;
    dependency.set(rawImport, message);
    encapsulation.set(rawImport, message);
    deepImport.set(rawImport, message);
  }

  return {
    dependency,
    encapsulation,
    deepImport,
    sourceCode: '',
    lintRun: undefined,
    firstRunConsumers: new Set(),
  };
}

export function resetDaemonLintCacheForTests(): void {
  messagesByFilename.clear();
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
