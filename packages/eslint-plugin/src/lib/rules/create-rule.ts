import { Rule } from 'eslint';
import { Program } from 'estree';
import {Executor, ExecutorNode} from './executor';
import { UserError } from '@lambda-solutions/sheriff-core';

export type CreateRuleOptions = {
  /**
   * Also run the executor on the `Program` node, i.e. once per file even
   * when it contains no import or export at all.
   *
   * File-level rules like `barrel-policy` need this: an empty barrel file
   * has no import/export nodes, so it would otherwise never be checked.
   * The `Program` node is traversed first, so such an executor sees
   * `isFirstRun === true` exactly once per file.
   */
  checkOnProgramNode?: boolean;
};

/**
 * Factory function generating a rule that traverses
 * through `ImportExpression` and `ImportDeclaration` nodes.
 *
 * We keep the information, if the rule is executed for
 * the first time and pass it on to Sheriff which needs
 * this information for caching.
 *
 * In case Sheriff throws an error, we stop, show the error
 * in the first line, and don't process any further.
 */
export const createRule: (
  ruleName: string,
  executor: Executor,
  options?: CreateRuleOptions,
) => Rule.RuleModule = (ruleName, executor, options = {}) => ({
  create: (context) => {
    let isFirstRun = true;
    let hasInternalError = false;
    const lintRun = context.sourceCode ?? context.getSourceCode();
    const executeRuleWithContext = (
      node: ExecutorNode | Program,
    ) => {
      const filename = context.filename ?? context.getFilename();
      const sourceCode =
        context.sourceCode?.text ?? context.getSourceCode().text;

      if (!hasInternalError) {
        try {
          // don't process special export `export const value = {n: 1};`
          if (node.type !== 'Program' && !node.source) {
            return;
          }

          // a `Program` node only arrives with `checkOnProgramNode` opted
          // in; such executors are file-level and don't read `node.source`.
          executor(
            context,
            node as ExecutorNode,
            isFirstRun,
            filename,
            sourceCode,
            lintRun,
          );
        } catch (error) {
          hasInternalError = true;
          const message =
            error instanceof UserError
              ? `User Error: ${error.code} - ${error.message}`
              : `${ruleName} (internal error): ${
                  error instanceof Error ? error.message : String(error)
                }`;
          context.report({
            message,
            node,
          });
        }
        isFirstRun = false;
      }
    };

    return {
      ...(options.checkOnProgramNode
        ? { Program: executeRuleWithContext }
        : {}),
      ImportExpression: executeRuleWithContext,
      ImportDeclaration: executeRuleWithContext,
      ExportAllDeclaration: executeRuleWithContext,
      ExportNamedDeclaration: executeRuleWithContext,
    };
  },
});
