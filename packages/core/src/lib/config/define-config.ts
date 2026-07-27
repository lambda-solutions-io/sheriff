import { UserSheriffConfig } from './user-sheriff-config';

/**
 * Identity helper for **sheriff.config.ts** which types the config without an
 * explicit type annotation.
 *
 * It returns the passed object unchanged. Its only purpose is to give editors
 * autocompletion and type checking, in the same way as `defineConfig` from
 * ESLint or Vite.
 *
 * Both styles are equivalent, so annotating with
 * {@link UserSheriffConfig | SheriffConfig} stays supported:
 *
 * ```typescript
 * import { defineConfig } from '@lambda-solutions/sheriff-core';
 *
 * export const config = defineConfig({
 *   modules: {
 *     'src/app': {
 *       'feature/<feature>': 'feature:<feature>',
 *       shared: 'shared',
 *     },
 *   },
 *   depRules: {
 *     'feature:*': 'shared',
 *   },
 * });
 * ```
 *
 * @param config the Sheriff configuration
 * @returns the same configuration object
 */
export const defineConfig = (config: UserSheriffConfig): UserSheriffConfig =>
  config;
