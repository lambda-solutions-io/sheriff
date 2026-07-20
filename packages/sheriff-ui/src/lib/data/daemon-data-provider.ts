import {
  DaemonClient,
  ProjectData,
  SheriffConfig,
  VerificationResult,
} from '@lambda-solutions/sheriff-core';
import type { ProjectDataPerEntry } from '../graph/build-graph';
import { GraphDataProvider, GraphSnapshot } from './data-provider';

export type DaemonDataProviderOptions = {
  rootDir: string;
  /** Sheriff CLI entry script, used to spawn a daemon when none runs. */
  cliBinPath: string;
};

/**
 * Fetches graph data from the sheriff daemon over its socket. The daemon's
 * filesystem watcher keeps its cache fresh, so every poll sees the current
 * state of the project. A dropped connection (e.g. the daemon's idle
 * timeout) is answered with one reconnect + retry.
 */
export class DaemonDataProvider implements GraphDataProvider {
  #client: DaemonClient | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #rootDir: string;
  readonly #cliBinPath: string;

  constructor(options: DaemonDataProviderOptions) {
    this.#rootDir = options.rootDir;
    this.#cliBinPath = options.cliBinPath;
  }

  /**
   * Snapshots are serialized: concurrent browser polls share one daemon
   * connection, and an error-triggered reconnect must never destroy the
   * socket under another in-flight request.
   */
  fetchSnapshot(entryFile?: string): Promise<GraphSnapshot> {
    const run = this.#queue.then(() => this.#fetchSnapshot(entryFile));
    this.#queue = run.catch(() => void 0);
    return run;
  }

  async #fetchSnapshot(entryFile?: string): Promise<GraphSnapshot> {
    const entryFiles = entryFile
      ? [entryFile]
      : await this.#resolveEntryFiles();

    const entries: ProjectDataPerEntry[] = [];
    for (const file of entryFiles) {
      const projectData = (await this.#request('getProjectData', {
        entryFile: file,
        options: { includeExternalLibraries: true },
      })) as ProjectData;
      entries.push({
        projectName: projectNameOf(projectData),
        projectData,
      });
    }

    const verification = (await this.#request('verify', {
      entryFile,
    })) as VerificationResult;

    return { entries, verification, rootDir: this.#rootDir };
  }

  close(): void {
    this.#client?.close();
    this.#client = undefined;
  }

  /**
   * A multi-project setup (`entryPoints`) needs one `getProjectData` call
   * per entry — the daemon only serves the first entry otherwise.
   */
  async #resolveEntryFiles(): Promise<(string | undefined)[]> {
    const config = (await this.#request('getConfig')) as SheriffConfig;
    const entryPoints = config.entryPoints;
    if (entryPoints && Object.keys(entryPoints).length > 0) {
      return Object.values(entryPoints);
    }
    return [undefined];
  }

  async #request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const client = await this.#ensureClient();
    try {
      return await client.request(method, params);
    } catch (error) {
      // the daemon exits on idle timeout or config change; reconnect once
      this.close();
      const freshClient = await this.#ensureClient();
      try {
        return await freshClient.request(method, params);
      } catch (retryError) {
        this.close();
        throw retryError instanceof Error ? retryError : error;
      }
    }
  }

  async #ensureClient(): Promise<DaemonClient> {
    if (this.#client) {
      return this.#client;
    }
    const client = await DaemonClient.connect(this.#rootDir, {
      spawnIfMissing: true,
      cliBinPath: this.#cliBinPath,
    });
    if (!client) {
      throw new Error('sheriff daemon unreachable');
    }
    this.#client = client;
    return client;
  }
}

function projectNameOf(projectData: ProjectData): string {
  for (const entry of Object.values(projectData)) {
    return entry.projectName;
  }
  return '';
}
