export interface LintFileResult {
  dependencyRuleViolations: {
    fromTag: string;
    toTags: string[];
    rawImport: string;
  }[];
  encapsulationViolations: string[];
  externalRuleViolations: {
    fromTag: string;
    externalLibrary: string;
  }[];
}

export type SheriffViolationKind =
  | 'dependency-rule'
  | 'encapsulation'
  | 'external-rule';

export interface PlainDiagnostic {
  line: number;
  character: number;
  endCharacter: number;
  message: string;
  source: 'sheriff';
  kind: SheriffViolationKind;
}

/**
 * Converts daemon violation descriptors without depending on the VS Code runtime.
 * The RPC does not return exact source locations, so every violation is attached
 * to a range covering the document's first line.
 */
export function lintResultToDiagnostics(
  result: LintFileResult,
): PlainDiagnostic[] {
  const dependencyDiagnostics = result.dependencyRuleViolations.map(
    ({ fromTag, toTags, rawImport }): PlainDiagnostic =>
      firstLineDiagnostic(
        `Dependency rule violation: '${fromTag}' is not allowed to import '${rawImport}' (allowed tags: ${toTags.join(', ') || 'none'}).`,
        'dependency-rule',
      ),
  );

  const encapsulationDiagnostics = result.encapsulationViolations.map(
    (violation): PlainDiagnostic =>
      firstLineDiagnostic(
        `Encapsulation violation: '${violation}' is not part of the public API.`,
        'encapsulation',
      ),
  );

  const externalDiagnostics = result.externalRuleViolations.map(
    ({ fromTag, externalLibrary }): PlainDiagnostic =>
      firstLineDiagnostic(
        `External dependency rule violation: '${fromTag}' is not allowed to import external library '${externalLibrary}'.`,
        'external-rule',
      ),
  );

  return [
    ...dependencyDiagnostics,
    ...encapsulationDiagnostics,
    ...externalDiagnostics,
  ];
}

/** Builds the daemon-backed module summary shown by the hover provider. */
export function projectEntryToHoverMarkdown(
  entry: { module: string; tags: string[]; moduleType?: string } | undefined,
): string | undefined {
  if (!entry) {
    return undefined;
  }

  const tags = entry.tags.map((tag) => `\`${tag}\``).join(', ') || 'none';
  return `**Sheriff module:** \`${entry.module}\`\n\n**Tags:** ${tags}`;
}

function firstLineDiagnostic(
  message: string,
  kind: SheriffViolationKind,
): PlainDiagnostic {
  return {
    line: 0,
    character: 0,
    endCharacter: Number.MAX_SAFE_INTEGER,
    message,
    source: 'sheriff',
    kind,
  };
}
