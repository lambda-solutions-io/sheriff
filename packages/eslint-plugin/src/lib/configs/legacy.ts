import { ESLint } from 'eslint';

export const legacyBarrelModulesOnly: ESLint.ConfigData = {
  parser: '@typescript-eslint/parser',
  plugins: ['@lambda-solutions/sheriff'],
  rules: {
    '@lambda-solutions/sheriff/dependency-rule': 'error',
    '@lambda-solutions/sheriff/deep-import': 'error',
  },
};

export const legacy: ESLint.ConfigData = {
  parser: '@typescript-eslint/parser',
  plugins: ['@lambda-solutions/sheriff'],
  rules: {
    '@lambda-solutions/sheriff/dependency-rule': 'error',
    '@lambda-solutions/sheriff/encapsulation': 'error',
  },
};
