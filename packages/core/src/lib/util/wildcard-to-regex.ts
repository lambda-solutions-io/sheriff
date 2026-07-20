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
  // patterns come from user config; the guard keeps pathological
  // configs from growing the cache without bound.
  if (wildcardRegexCache.size >= 10_000) {
    wildcardRegexCache.clear();
  }
  const regex = new RegExp(regexpString);
  wildcardRegexCache.set(wildcardRule, regex);
  return regex;
};
