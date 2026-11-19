// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP,
// speaking the 2026-07-28 revision (server/discover) and the legacy initialize handshake. Six
// tools act on the same store as REST and GraphQL, so an object made over MCP reads back over
// /api/v3 as the same object. Stateless: no session header is issued or required.

import {
  VIEWER,
  type RepoRec,
  type ItemRec,
  createRepo,
  findRepo,
  repoNameTaken,
  branchTip,
  nextEpochSec,
  allocDbId,
  commitOnBranch,
} from './store.ts';
import { repoView, issueView, pullView, pullMergeInfo } from './rest.ts';

const SERVER_INFO = Object.freeze({ name: 'forge', version: '1.0.0' });
const SUPPORTED_VERSIONS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- the tool catalogue

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Only issues in this state.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
]);

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------- tool implementations

function toolOk(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new RpcError(ERR_INVALID_PARAMS, `Missing or invalid required argument: ${key}`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function addressedRepo(args: Record<string, unknown>): RepoRec {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const found = findRepo(owner, repo);
  if (found === null) throw new RpcError(ERR_INVALID_PARAMS, `Repository ${owner}/${repo} not found`);
  return found;
}

function newItem(repo: RepoRec, kind: 'issue' | 'pull', title: string, body: string): ItemRec {
  const epoch = nextEpochSec();
  const item: ItemRec = {
    number: repo.nextNumber,
    kind,
    dbId: allocDbId(),
    title,
    body,
    state: 'open',
    labels: [],
    authorLogin: VIEWER.login,
    createdEpoch: epoch,
    updatedEpoch: epoch,
    headRef: '',
    baseRef: '',
    merged: false,
    mergedEpoch: null,
    mergeCommitSha: null,
  };
  repo.nextNumber += 1;
  repo.items.set(item.number, item);
  return item;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) throw new RpcError(ERR_INVALID_PARAMS, `Unknown tool: ${name}`);
  switch (name) {
    case 'create_repo': {
      const repoName = requireString(args, 'name');
      if (repoNameTaken(repoName)) return toolErr(`A repository named ${repoName} already exists.`);
      const repo = createRepo(repoName, optionalString(args, 'description'), args.private === true);
      return toolOk(repoView(repo));
    }
    case 'get_repo': {
      const repo = addressedRepo(args);
      return toolOk(repoView(repo));
    }
    case 'create_issue': {
      const repo = addressedRepo(args);
      const title = requireString(args, 'title');
      const item = newItem(repo, 'issue', title, optionalString(args, 'body'));
      return toolOk(issueView(repo, item));
    }
    case 'list_issues': {
      const repo = addressedRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      items.sort((a, b) => a.number - b.number);
      return toolOk(items.map((item) => issueView(repo, item)));
    }
    case 'create_pull_request': {
      const repo = addressedRepo(args);
      const title = requireString(args, 'title');
      const head = requireString(args, 'head');
      const base = requireString(args, 'base');
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) return toolErr(`Head branch "${head}" does not exist.`);
      if (baseTip === null) return toolErr(`Base branch "${base}" does not exist.`);
      if (headTip === baseTip) return toolErr(`No commits between ${base} and ${head}.`);
      const item = newItem(repo, 'pull', title, optionalString(args, 'body'));
      item.headRef = head;
      item.baseRef = base;
      return toolOk(pullView(repo, item));
    }
    case 'merge_pull_request': {
      const repo = addressedRepo(args);
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) throw new RpcError(ERR_INVALID_PARAMS, 'Missing or invalid required argument: pull_number');
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return toolErr(`Pull request #${number} not found.`);
      if (item.merged) return toolErr(`Pull request #${number} is already merged.`);
      const info = pullMergeInfo(repo, item);
      if (info === null || info.conflict || info.mergedTree === null) return toolErr(`Pull request #${number} has a merge conflict.`);
      const epoch = nextEpochSec();
      const title = `${item.title} (#${item.number})`;
      const full = item.body !== '' ? `${title}\n\n${item.body}` : title;
      const sha = commitOnBranch(repo, item.baseRef, info.mergedTree, full);
      item.merged = true;
      item.state = 'closed';
      item.mergedEpoch = epoch;
      item.mergeCommitSha = sha;
      item.updatedEpoch = epoch;
      return toolOk({ sha, merged: true, message: 'Pull Request successfully merged', number: item.number });
    }
    default:
      throw new RpcError(ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC dispatch

export interface McpResult {
  readonly status: number;
  readonly payload?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function dispatch(message: Record<string, unknown>): McpResult {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  if (method === '') {
    if (isNotification) return { status: 202 };
    return { status: 200, payload: rpcError(id, ERR_INVALID_REQUEST, 'A JSON-RPC method is required.') };
  }
  if (isNotification) return { status: 202 };
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'server/discover':
        return {
          status: 200,
          payload: rpcResult(id, {
            supportedVersions: [...SUPPORTED_VERSIONS],
            capabilities: { tools: {} },
            serverInfo: { ...SERVER_INFO },
            _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
          }),
        };
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        return {
          status: 200,
          payload: rpcResult(id, {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: { ...SERVER_INFO },
          }),
        };
      }
      case 'ping':
        return { status: 200, payload: rpcResult(id, {}) };
      case 'tools/list':
        return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        if (name === '') throw new RpcError(ERR_INVALID_PARAMS, 'tools/call requires a tool name');
        return { status: 200, payload: rpcResult(id, callTool(name, args)) };
      }
      default:
        return { status: 200, payload: rpcError(id, ERR_METHOD_NOT_FOUND, `Method not found: ${method}`) };
    }
  } catch (error) {
    if (error instanceof RpcError) return { status: 200, payload: rpcError(id, error.code, error.message) };
    return { status: 200, payload: rpcError(id, -32603, error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Handle one parsed JSON-RPC body (a single message or a batch array). The caller owns JSON
 * parsing (a parse failure is HTTP 400 with -32700) and authentication (401 before this runs).
 */
export function handleMcp(parsed: unknown): McpResult {
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        responses.push(rpcError(null, ERR_INVALID_REQUEST, 'A JSON-RPC message must be an object.'));
        continue;
      }
      const result = dispatch(entry as Record<string, unknown>);
      if (result.payload !== undefined) responses.push(result.payload);
    }
    return responses.length > 0 ? { status: 200, payload: responses } : { status: 202 };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, payload: rpcError(null, ERR_INVALID_REQUEST, 'A JSON-RPC message must be an object.') };
  }
  return dispatch(parsed as Record<string, unknown>);
}

export { ERR_PARSE };
