// app.ts — the HTTP server: routing, bearer auth, and the wire discipline every surface shares
// (JSON replies, a non-empty X-GitHub-Request-Id on REST answers, JSON 404s, 400 on malformed
// JSON). The surfaces themselves live in rest.ts (REST v3), git.ts (smart HTTP), graphql.ts
// (GraphQL v4) and mcp.ts (MCP). main.ts owns the lifecycle and stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { findRepo } from './store.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { advertise, uploadPack, receivePack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}`;
}

/** Whether the request carries the suite's bearer token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (match === null || match[1]!.trim() === '') return false;
  const presented = match[1]!.trim();
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return presented === expected;
  return presented.length > 0;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

const MESSAGE_NOT_FOUND = { message: 'Not Found' };
const MESSAGE_UNAUTHORIZED = { message: 'Requires authentication' };

// ---------------------------------------------------------------- REST v3

async function serveRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  const restPath = pathname.slice('/api/v3'.length);
  const segments = segmentsOf(restPath);
  const method = req.method ?? 'GET';

  // The API root and meta answer without a token (as api.github.com's do); everything else
  // under /api/v3 requires the suite's bearer token.
  const isPublic = method === 'GET' && (segments.length === 0 || (segments.length === 1 && segments[0] === 'meta'));
  if (!isPublic && !authorized(req)) {
    sendJson(res, 401, MESSAGE_UNAUTHORIZED);
    return;
  }

  let body: Record<string, unknown> | null = null;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body is not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON in the request body.' });
        return;
      }
    }
  }

  const restRequest: RestRequest = {
    method,
    segments,
    query,
    body,
    host: req.headers.host ?? 'localhost',
    path: pathname,
  };
  const result = handleRest(restRequest);
  sendJson(res, result.status, result.body, result.headers ?? {});
}

// ---------------------------------------------------------------- GraphQL

async function serveGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, MESSAGE_NOT_FOUND);
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, MESSAGE_UNAUTHORIZED);
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in the request body.' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    // A batched body answers one result per operation, in order.
    const results = parsed.map((entry) => {
      const result = executeGraphQL((typeof entry === 'object' && entry !== null ? entry : {}) as { query?: unknown });
      return result.payload;
    });
    sendJson(res, 200, results);
    return;
  }
  const result = executeGraphQL((typeof parsed === 'object' && parsed !== null ? parsed : {}) as { query?: unknown; variables?: unknown; operationName?: unknown });
  sendJson(res, result.status, result.payload);
}

// ---------------------------------------------------------------- MCP

async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, MESSAGE_UNAUTHORIZED);
    return;
  }
  const result = handleMcp(parsed);
  if (result.payload === undefined) {
    res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, result.status, result.payload);
}

// ---------------------------------------------------------------- git smart HTTP

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function serveGit(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams): Promise<void> {
  const match = GIT_PATH.exec(pathname);
  if (match === null) {
    sendJson(res, 404, MESSAGE_NOT_FOUND);
    return;
  }
  const decode = (segment: string): string => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  const owner = decode(match[1]!);
  const repoName = decode(match[2]!);
  const endpoint = match[3]!;
  const method = req.method ?? 'GET';

  if (!authorized(req)) {
    sendJson(res, 401, MESSAGE_UNAUTHORIZED);
    return;
  }
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, MESSAGE_NOT_FOUND);
    return;
  }
  const protocolHeader = req.headers['git-protocol'];
  const protocolV2 = typeof protocolHeader === 'string' && protocolHeader.split(':').includes('version=2');

  if (endpoint === 'info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'A service parameter (git-upload-pack or git-receive-pack) is required.' });
      return;
    }
    const result = advertise(repo, service, protocolV2);
    sendBuffer(res, result.status, result.contentType, result.body);
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const body = await readBody(req);
  try {
    const result = endpoint === 'git-upload-pack' ? uploadPack(repo, body, protocolV2) : receivePack(repo, body);
    sendBuffer(res, result.status, result.contentType, result.body);
  } catch {
    sendJson(res, 400, { message: 'Malformed git protocol request.' });
  }
}

// ---------------------------------------------------------------- the server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const { pathname, query } = pathOf(req);
    const method = req.method ?? 'GET';
    const run = async (): Promise<void> => {
      // The env's boot probe: no token, always available.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        await serveRest(req, res, pathname, query);
        return;
      }
      if (pathname === '/api/graphql') {
        await serveGraphQL(req, res);
        return;
      }
      if (pathname === '/mcp') {
        await serveMcp(req, res);
        return;
      }
      if (GIT_PATH.test(pathname)) {
        await serveGit(req, res, pathname, query);
        return;
      }
      sendJson(res, 404, MESSAGE_NOT_FOUND);
    };
    run().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  server.maxRequestsPerSocket = 0;
  return server;
}
