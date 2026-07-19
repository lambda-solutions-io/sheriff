import { DaemonClient } from '@lambda-solutions/sheriff-core';
import type { LintFileResult } from './diagnostics';

export interface ProjectDataEntry {
  module: string;
  moduleType: 'barrel' | 'barrel-less';
  tags: string[];
  imports: string[];
  externalLibraries?: string[];
  unresolvedImports: string[];
  projectName: string;
}

export type ProjectData = Record<string, ProjectDataEntry>;

/** Message a healthy socket rejects with when the daemon connection drops. */
const TRANSPORT_ERROR_MESSAGE = 'daemon connection closed';

/** Owns one reconnectable connection to the daemon serving this workspace. */
export class SheriffDaemon {
  private client: DaemonClient | undefined;
  private connecting: Promise<DaemonClient | undefined> | undefined;

  constructor(
    private readonly rootDir: string,
    private readonly cliBinPath: string,
  ) {}

  async lintFile(
    filename: string,
    fileContent?: string,
  ): Promise<LintFileResult | undefined> {
    return this.request<LintFileResult>('lintFile', {
      filename,
      fileContent,
    });
  }

  async getProjectData(entryFile?: string): Promise<ProjectData | undefined> {
    return this.request<ProjectData>('getProjectData', { entryFile });
  }

  dispose(): void {
    this.dropClient();
  }

  private async request<Result>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result | undefined> {
    const client = await this.getClient();
    if (!client) {
      return undefined;
    }

    try {
      return (await client.request(method, params)) as Result;
    } catch (error: unknown) {
      // Only a broken transport must force a reconnect. A server-reported
      // application error (e.g. missing sheriff.config.ts) leaves the shared
      // socket healthy and must not tear down concurrent in-flight RPCs.
      if (isTransportError(error)) {
        this.dropClient();
      }
      throw error;
    }
  }

  private async getClient(): Promise<DaemonClient | undefined> {
    // Reuse the live client, but never a closed one: a client whose socket
    // has dropped (e.g. after the daemon's idle-shutdown) would otherwise be
    // handed out and its requests would reject or hang.
    if (this.client && !this.client.closed) {
      return this.client;
    }
    if (this.client?.closed) {
      this.client = undefined;
    }

    // Memoize the in-flight connect so concurrent callers (activation lints
    // several open documents at once) share one connect and one daemon spawn
    // instead of each spawning a detached daemon and leaking the losers.
    if (!this.connecting) {
      this.connecting = this.connect();
    }

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<DaemonClient | undefined> {
    try {
      this.client = await DaemonClient.connect(this.rootDir, {
        spawnIfMissing: true,
        cliBinPath: this.cliBinPath,
      });
      return this.client;
    } catch {
      this.client = undefined;
      return undefined;
    }
  }

  private dropClient(): void {
    this.client?.close();
    this.client = undefined;
  }
}

/**
 * Transport errors (socket closed/destroyed/connection failures) mean the
 * shared client is dead and must be dropped. Application errors thrown by the
 * daemon come back as arbitrary server messages and leave the socket usable.
 */
function isTransportError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(TRANSPORT_ERROR_MESSAGE)
  );
}
