import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { GraphDataProvider } from '../data/data-provider';
import { buildGraph } from '../graph/build-graph';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export type UiServerOptions = {
  provider: GraphDataProvider;
  port: number;
  entryFile?: string;
  /** Directory of the static frontend; defaults to the shipped `public/`. */
  publicDir?: string;
};

export type UiServer = {
  port: number;
  close: () => Promise<void>;
};

/** A freshly built graph plus its content hash. */
type BuiltGraph = { hash: string; body: string };

/**
 * Coalesce concurrent/rapid `/api/graph` builds. Every request otherwise runs
 * `fetchSnapshot` + `buildGraph` + stringify + sha256; a burst of 2s polls (and
 * multiple open tabs) would each pay that cost. We share ONE in-flight build and
 * cache its result for a sub-second TTL, so freshness cannot meaningfully
 * regress (the daemon watcher still drives real changes).
 */
class GraphBuildCache {
  private inFlight: Promise<BuiltGraph> | null = null;
  private cached: BuiltGraph | null = null;
  private cachedAt = 0;

  constructor(
    private readonly build: () => Promise<BuiltGraph>,
    private readonly ttlMs = 250,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<BuiltGraph> {
    if (this.cached && this.now() - this.cachedAt < this.ttlMs) {
      return Promise.resolve(this.cached);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const pending = this.build().then(
      (result) => {
        this.cached = result;
        this.cachedAt = this.now();
        this.inFlight = null;
        return result;
      },
      (error) => {
        // Never cache failures: a 503 must not stick for the whole TTL.
        this.inFlight = null;
        throw error;
      },
    );
    this.inFlight = pending;
    return pending;
  }
}

export function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const publicDir = path.resolve(
    options.publicDir ?? path.join(__dirname, '../../../public'),
  );

  const cache = new GraphBuildCache(() => buildSnapshotGraph(options));

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options, publicDir, cache);
  });
  // Node's default 5s keep-alive close races the browser's 2s polling and
  // surfaces as sporadic connection resets; keep sockets open far longer.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: UiServerOptions,
  publicDir: string,
  cache: GraphBuildCache,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/graph') {
    await serveGraph(url, response, cache);
    return;
  }

  serveStatic(url.pathname, response, publicDir);
}

async function buildSnapshotGraph(
  options: UiServerOptions,
): Promise<BuiltGraph> {
  const snapshot = await options.provider.fetchSnapshot(options.entryFile);
  const graph = buildGraph(
    snapshot.entries,
    snapshot.verification,
    snapshot.rootDir,
  );
  const body = JSON.stringify(graph);
  const hash = createHash('sha256').update(body).digest('hex');
  return { hash, body };
}

async function serveGraph(
  url: URL,
  response: http.ServerResponse,
  cache: GraphBuildCache,
): Promise<void> {
  try {
    const { hash, body } = await cache.get();
    // Splice the pre-built graph body into the envelope without re-parsing it.
    const payload =
      url.searchParams.get('hash') === hash
        ? JSON.stringify({ hash, changed: false })
        : '{"hash":' +
          JSON.stringify(hash) +
          ',"changed":true,"graph":' +
          body +
          '}';
    sendJson(response, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 503, JSON.stringify({ error: message }));
  }
}

function serveStatic(
  pathname: string,
  response: http.ServerResponse,
  publicDir: string,
): void {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(publicDir, relativePath);
  const extension = path.extname(filePath);

  if (
    !filePath.startsWith(publicDir + path.sep) ||
    !(extension in CONTENT_TYPES) ||
    !fs.existsSync(filePath)
  ) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extension],
    // a dev tool must never serve a stale frontend after an upgrade
    'cache-control': 'no-cache',
  });
  response.end(fs.readFileSync(filePath));
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}
