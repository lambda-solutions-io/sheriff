import type { VerificationResult } from '@lambda-solutions/sheriff-core';
import type { ProjectDataPerEntry } from '../graph/build-graph';

export type GraphSnapshot = {
  entries: ProjectDataPerEntry[];
  verification: VerificationResult | undefined;
  rootDir: string;
};

/**
 * Source of graph data. The daemon-backed implementation is the default;
 * tests inject fakes so no daemon is required.
 */
export interface GraphDataProvider {
  fetchSnapshot(entryFile?: string): Promise<GraphSnapshot>;
  close(): void | Promise<void>;
}
