import { describe, expect, it } from 'vitest';
import { generateOracle } from '../engine-oracle';
import { createOracleFixture, oracleFixtures } from './oracle-fixtures';

describe('generateOracle', () => {
  for (const fixture of oracleFixtures) {
    it(fixture.name, () => {
      createOracleFixture(fixture);
      expect(generateOracle(fixture.entry)).toMatchSnapshot();
    });
  }
});
