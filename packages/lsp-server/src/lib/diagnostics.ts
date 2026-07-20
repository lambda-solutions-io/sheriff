import { existsSync } from 'fs';
import { dirname, join, parse } from 'path';
import {
  violatesDependencyRule,
  violatesEncapsulationRule,
} from '@lambda-solutions/sheriff-core';
import { uriToFilePath } from './uri';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export enum DiagnosticSeverity {
  Error = 1,
}

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  source: 'sheriff';
  message: string;
}

export interface ImportSpecifier {
  value: string;
  range: Range;
}

export interface SheriffRuleCheckers {
  dependencyRule: (
    filename: string,
    importCommand: string,
    isFirstRun: boolean,
    fileContent: string,
  ) => string;
  encapsulationRule: (
    filename: string,
    importCommand: string,
    isFirstRun: boolean,
    fileContent: string,
    isLegacyDeepImport: boolean,
  ) => string;
}

const defaultCheckers: SheriffRuleCheckers = {
  dependencyRule: violatesDependencyRule,
  encapsulationRule: violatesEncapsulationRule,
};

export function createSheriffDiagnostics(
  uri: string,
  text: string,
  checkers: SheriffRuleCheckers = defaultCheckers,
): Diagnostic[] {
  const filename = uriToFilePath(uri);
  const imports = extractImportSpecifiers(text);
  if (imports.length === 0 || !hasSheriffConfig(filename)) {
    return [];
  }

  try {
    return imports.flatMap((importSpecifier, index) => {
      const isFirstRun = index === 0;
      return [
        checkers.dependencyRule(
          filename,
          importSpecifier.value,
          isFirstRun,
          text,
        ),
        checkers.encapsulationRule(
          filename,
          importSpecifier.value,
          isFirstRun,
          text,
          false,
        ),
      ]
        .filter((message) => message.length > 0)
        .map((message) => ({
          range: importSpecifier.range,
          severity: DiagnosticSeverity.Error,
          source: 'sheriff' as const,
          message,
        }));
    });
  } catch {
    return [];
  }
}

export function extractImportSpecifiers(text: string): ImportSpecifier[] {
  const lineStarts = createLineStarts(text);
  const matches = [
    ...extractMatches(
      /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?(['"])([^'"\r\n]+)\1/g,
      text,
      lineStarts,
    ),
    ...extractMatches(
      /\bexport\s+(?:type\s+)?(?:\*\s+from|[^'";]*?\s+from)\s*(['"])([^'"\r\n]+)\1/g,
      text,
      lineStarts,
    ),
    ...extractMatches(
      /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
      text,
      lineStarts,
    ),
  ];

  return matches.sort(
    (left, right) =>
      positionToSortKey(left.range.start) -
      positionToSortKey(right.range.start),
  );
}

function extractMatches(
  expression: RegExp,
  text: string,
  lineStarts: number[],
): ImportSpecifier[] {
  const imports: ImportSpecifier[] = [];
  for (const match of text.matchAll(expression)) {
    const quote = match[1];
    const value = match[2];
    if (!quote || !value || match.index === undefined) {
      continue;
    }

    const quotedSpecifier = `${quote}${value}${quote}`;
    const specifierStart =
      match.index + match[0].lastIndexOf(quotedSpecifier) + 1;
    imports.push({
      value,
      range: {
        start: offsetToPosition(specifierStart, lineStarts),
        end: offsetToPosition(specifierStart + value.length, lineStarts),
      },
    });
  }

  return imports;
}

function hasSheriffConfig(filename: string): boolean {
  const tsconfigDir = findNearestParentFileDir(filename, 'tsconfig.json');
  return (
    tsconfigDir !== undefined &&
    existsSync(join(tsconfigDir, 'sheriff.config.ts'))
  );
}

function findNearestParentFileDir(
  filename: string,
  basename: string,
): string | undefined {
  let current = dirname(filename);
  const root = parse(current).root;

  while (true) {
    if (existsSync(join(current, basename))) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}

function createLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function offsetToPosition(offset: number, lineStarts: number[]): Position {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle];
    if (lineStart === undefined) {
      break;
    }

    const nextLineStart = lineStarts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < lineStart) {
      high = middle - 1;
    } else if (offset >= nextLineStart) {
      low = middle + 1;
    } else {
      return { line: middle, character: offset - lineStart };
    }
  }

  return { line: 0, character: 0 };
}

function positionToSortKey(position: Position): number {
  return position.line * 1_000_000 + position.character;
}
