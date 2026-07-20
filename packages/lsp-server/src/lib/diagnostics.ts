import {
  lintDocument,
  violatesDependencyRule,
  violatesEncapsulationRule,
} from '@lambda-solutions/sheriff-core';
import * as ts from 'typescript';
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
  if (imports.length === 0) {
    return [];
  }

  try {
    // The default adapters share the lintDocument analysis. Priming it here
    // both avoids one init per rule family and preserves the LSP's no-config
    // behavior without a separate project discovery pass.
    if (
      checkers === defaultCheckers &&
      lintDocument(filename, text).configFileIsMissing
    ) {
      return [];
    }

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
  return ts.preProcessFile(text).importedFiles.map((importedFile) => ({
    value: importedFile.fileName,
    range:
      typeof importedFile.pos === 'number' &&
      typeof importedFile.end === 'number'
        ? {
            // TypeScript's preprocessor offsets span from the opening quote
            // through the last specifier character; LSP ranges exclude quotes.
            start: offsetToPosition(importedFile.pos + 1, lineStarts),
            end: offsetToPosition(importedFile.end + 1, lineStarts),
          }
        : fallbackRange(text, importedFile.fileName, lineStarts),
  }));
}

function fallbackRange(
  text: string,
  specifier: string,
  lineStarts: number[],
): Range {
  const offset = Math.max(0, text.indexOf(specifier));
  return {
    start: offsetToPosition(offset, lineStarts),
    end: offsetToPosition(offset + specifier.length, lineStarts),
  };
}

function createLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\r' && text[index + 1] === '\n') {
      lineStarts.push(index + 2);
      index++;
    } else if (text[index] === '\r' || text[index] === '\n') {
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
