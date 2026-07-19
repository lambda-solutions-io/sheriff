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

export function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const publicDir = path.resolve(
    options.publicDir ?? path.join(__dirname, '../../../public'),
  );

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options, publicDir);
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
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (url.pathname === '/api/graph') {
    await serveGraph(url, response, options);
    return;
  }

  serveStatic(url.pathname, response, publicDir);
}

async function serveGraph(
  url: URL,
  response: http.ServerResponse,
  options: UiServerOptions,
): Promise<void> {
  try {
    const snapshot = await options.provider.fetchSnapshot(options.entryFile);
    const graph = buildGraph(
      snapshot.entries,
      snapshot.verification,
      snapshot.rootDir,
    );
    const body = JSON.stringify(graph);
    const hash = createHash('sha256').update(body).digest('hex');

    const payload =
      url.searchParams.get('hash') === hash
        ? { hash, changed: false }
        : { hash, changed: true, graph };
    sendJson(response, 200, JSON.stringify(payload));
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
