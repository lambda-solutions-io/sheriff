import { getDocumentLintAnalysis } from './lint-document';

/**
 * This is the adapter for the ESLint plugin
 *
 * ESLint calls this adapter once per import. The shared document analysis
 * keeps those calls and the other Sheriff rules on the same cached project.
 *
 * @param filename Name of the file
 * @param importCommand Import command
 * @param isFirstRun If this is the first run
 * @param fileContent Content of the file
 * @param isLegacyDeepImport If this is coming from the deep import rule
 */
export const violatesEncapsulationRule = (
  filename: string,
  importCommand: string,
  isFirstRun: boolean,
  fileContent: string,
  isLegacyDeepImport: boolean,
): string => {
  void isFirstRun;
  const { result, isUnresolvableImport } = getDocumentLintAnalysis(
    filename,
    fileContent,
    false,
  );

  if (isUnresolvableImport(importCommand)) {
    return `import ${importCommand} cannot be resolved`;
  }

  const importFileInfo = result.encapsulationViolations[importCommand];
  if (!importFileInfo) {
    return '';
  }

  if (isLegacyDeepImport) {
    return "Deep import is not allowed. Use the module's index.ts or path.";
  } else {
    return importFileInfo.moduleInfo.kind === 'barrel'
      ? `'${importCommand}' is a deep import from a barrel module. Use the module's barrel file (index.ts) instead.`
      : `'${importCommand}' cannot be imported. It is encapsulated.`;
  }
};
