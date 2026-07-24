// Lives inside a nested `internal` folder of the barrel-less
// `customers/contract` module (see tests/nested-internal.config.ts) and must
// therefore not be importable from outside the module. Not imported anywhere
// under the main sheriff.config.ts, so it stays out of the other golden files.
export const secret = 'nested internal secret';
