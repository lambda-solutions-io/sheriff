import type { TSESLint } from '@typescript-eslint/utils';
import rules from '../rules';

const commonConfig: TSESLint.FlatConfig.Config = {
  files: ['**/*.ts', '**/*.js'],
  ignores: ['sheriff.config.ts'],
  languageOptions: {
    sourceType: 'module',
  },
  plugins: {
    '@lambda-solutions/sheriff': {
      rules,
    },
  },
};

export const barrelModulesOnly: TSESLint.FlatConfig.Config = {
  ...commonConfig,
  rules: {
    '@lambda-solutions/sheriff/dependency-rule': 'error',
    '@lambda-solutions/sheriff/deep-import': 'error',
  },
};

export const all: TSESLint.FlatConfig.Config = {
  ...commonConfig,
  rules: {
    '@lambda-solutions/sheriff/dependency-rule': 'error',
    '@lambda-solutions/sheriff/encapsulation': 'error',
  },
};
