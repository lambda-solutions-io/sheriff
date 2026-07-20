// https://www.delftstack.com/howto/javascript/wildcard-string-comparison-in-javascript

const wildcardRegexCache = new Map<string, RegExp>();

export const wildcardToRegex = (wildcardRule: string): RegExp => {
  const cachedRegex = wildcardRegexCache.get(wildcardRule);
  if (cachedRegex) {
    return cachedRegex;
  }

  const escapeRegex = (str: string) =>
    str.replace(/([.*+?^=!:${}()|[\]/\\])/g, '\\$1');
  const regexpString = `^${wildcardRule
    .split('*')
    .map(escapeRegex)
    .join('.*')}$`;
  const regex = new RegExp(regexpString);
  wildcardRegexCache.set(wildcardRule, regex);
  return regex;
};
