// graphql.ts — the GraphQL v4 surface at /api/graphql: a small hand-written parser and executor
// covering the documents gh and github-mcp-server send (viewer, repository, issues and pull
// request connections, node(), the mutations, and __type introspection). It resolves against the
// same store as REST, so an object created on one surface reads back identically on the other.

import {
  VIEWER,
  type RepoRec,
  type ItemRec,
  type CommentRec,
  findRepo,
  listRepos,
  branchTip,
  branchFiles,
  readCommit,
  flattenTree,
  emptyTreeSha,
  isoOf,
  nextEpochSec,
  allocDbId,
  allocCommentId,
  commitOnBranch,
} from './store.ts';
import { pullMergeInfo, diffFileStats } from './rest.ts';

// ---------------------------------------------------------------- object wrappers

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

const gid = (key: string): string => Buffer.from(key, 'utf8').toString('base64');

function repoObj(repo: RepoRec): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: RepoRec, item: ItemRec): GqlObject {
  return { __typename: 'Issue', repo, item };
}

function pullObj(repo: RepoRec, item: ItemRec): GqlObject {
  return { __typename: 'PullRequest', repo, item };
}

function commentObj(repo: RepoRec, itemNumber: number, comment: CommentRec): GqlObject {
  return { __typename: 'IssueComment', repo, itemNumber, comment };
}

function userObj(): GqlObject {
  return { __typename: 'User', login: VIEWER.login };
}

function findRepoById(id: number): RepoRec | null {
  for (const repo of listRepos()) if (repo.id === id) return repo;
  return null;
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { type: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function nodeById(id: string): GqlObject | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = findRepoById(Number(decoded.parts[0]));
    return repo === null ? null : repoObj(repo);
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const repo = findRepoById(Number(decoded.parts[0]));
    if (repo === null) return null;
    const item = repo.items.get(Number(decoded.parts[1]));
    if (item === undefined) return null;
    if (decoded.type === 'Issue') return item.kind === 'issue' ? issueObj(repo, item) : null;
    return item.kind === 'pull' ? pullObj(repo, item) : null;
  }
  if (decoded.type === 'IssueComment') {
    const commentId = Number(decoded.parts[0]);
    for (const repo of listRepos()) {
      for (const [number, comments] of repo.comments) {
        const comment = comments.find((entry) => entry.id === commentId);
        if (comment !== undefined) return commentObj(repo, number, comment);
      }
    }
    return null;
  }
  if (decoded.type === 'User') {
    return Number(decoded.parts[0]) === VIEWER.id ? userObj() : null;
  }
  return null;
}

// ---------------------------------------------------------------- connections

interface ConnectionArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

function connection(typename: string, items: readonly GqlObject[], args: ConnectionArgs): GqlObject {
  let start = 0;
  if (args.after !== null && args.after !== undefined) start = indexOfCursor(args.after) + 1;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __typename: typename,
    nodes: slice,
    edges: slice.map((node, i) => ({ __typename: `${typename.replace(/Connection$/, '')}Edge`, node, cursor: cursorOf(start + i) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      endCursor: slice.length > 0 ? cursorOf(endIndex) : null,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------- field resolvers

type Resolver = (obj: GqlObject, args: Record<string, unknown>) => unknown;

const repoOf = (obj: GqlObject): RepoRec => obj.repo as RepoRec;
const itemOf = (obj: GqlObject): ItemRec => obj.item as ItemRec;

function issueState(item: ItemRec): string {
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(item: ItemRec): string {
  if (item.merged) return 'MERGED';
  return item.state === 'open' ? 'OPEN' : 'CLOSED';
}

const FIELDS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userObj(),
    repository: (_obj, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(owner, name);
      return repo === null ? null : repoObj(repo);
    },
    node: (_obj, args) => (typeof args.id === 'string' ? nodeById(args.id) : null),
    __type: (_obj, args) => typeObj(typeof args.name === 'string' ? args.name : ''),
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: Object.keys(TYPE_DEFS).map((name) => typeObj(name)),
    }),
  },
  Mutation: {
    createIssue: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.type !== 'Repository') throw new Error('createIssue: repositoryId does not name a repository');
      const repo = findRepoById(Number(decoded.parts[0]));
      if (repo === null) throw new Error('createIssue: repository not found');
      const epoch = nextEpochSec();
      const item: ItemRec = {
        number: repo.nextNumber,
        kind: 'issue',
        dbId: allocDbId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, item), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeById(String(input.issueId ?? ''));
      if (node === null || node.__typename !== 'Issue') throw new Error('closeIssue: issueId does not name an issue');
      const item = itemOf(node);
      item.state = 'closed';
      item.updatedEpoch = nextEpochSec();
      return { __typename: 'CloseIssuePayload', issue: node, clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.type !== 'Repository') throw new Error('createPullRequest: repositoryId does not name a repository');
      const repo = findRepoById(Number(decoded.parts[0]));
      if (repo === null) throw new Error('createPullRequest: repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) throw new Error(`createPullRequest: head ref "${head}" does not exist`);
      if (baseTip === null) throw new Error(`createPullRequest: base ref "${base}" does not exist`);
      if (headTip === baseTip) throw new Error('createPullRequest: no commits between head and base');
      const epoch = nextEpochSec();
      const item: ItemRec = {
        number: repo.nextNumber,
        kind: 'pull',
        dbId: allocDbId(),
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        authorLogin: VIEWER.login,
        createdEpoch: epoch,
        updatedEpoch: epoch,
        headRef: head,
        baseRef: base,
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
      };
      repo.nextNumber += 1;
      repo.items.set(item.number, item);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, item), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeById(String(input.pullRequestId ?? ''));
      if (node === null || node.__typename !== 'PullRequest') throw new Error('mergePullRequest: pullRequestId does not name a pull request');
      const repo = repoOf(node);
      const item = itemOf(node);
      if (item.merged) throw new Error('mergePullRequest: pull request is already merged');
      const info = pullMergeInfo(repo, item);
      if (info === null || info.conflict || info.mergedTree === null) throw new Error('mergePullRequest: pull request has a merge conflict');
      const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
      const epoch = nextEpochSec();
      let sha: string;
      if (method === 'MERGE') {
        sha = commitOnBranch(repo, item.baseRef, info.mergedTree, `Merge pull request #${item.number} from ${item.headRef}`, [info.headTip]);
      } else {
        const title = `${item.title} (#${item.number})`;
        const full = item.body !== '' ? `${title}\n\n${item.body}` : title;
        sha = commitOnBranch(repo, item.baseRef, info.mergedTree, full);
      }
      item.merged = true;
      item.state = 'closed';
      item.mergedEpoch = epoch;
      item.mergeCommitSha = sha;
      item.updatedEpoch = epoch;
      return { __typename: 'MergePullRequestPayload', pullRequest: node, clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_obj, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = nodeById(String(input.subjectId ?? ''));
      if (node === null || (node.__typename !== 'Issue' && node.__typename !== 'PullRequest')) {
        throw new Error('addComment: subjectId does not name an issue or pull request');
      }
      const repo = repoOf(node);
      const item = itemOf(node);
      const epoch = nextEpochSec();
      const comment: CommentRec = { id: allocCommentId(), body: String(input.body ?? ''), authorLogin: VIEWER.login, createdEpoch: epoch, updatedEpoch: epoch };
      const list = repo.comments.get(item.number) ?? [];
      list.push(comment);
      repo.comments.set(item.number, list);
      const commentGql = commentObj(repo, item.number, comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: commentGql, cursor: cursorOf(0) },
        subject: node,
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    id: () => gid(`User:${VIEWER.id}`),
    databaseId: () => VIEWER.id,
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    url: () => `/${VIEWER.login}`,
  },
  Repository: {
    id: (obj) => gid(`Repository:${repoOf(obj).id}`),
    databaseId: (obj) => repoOf(obj).id,
    name: (obj) => repoOf(obj).name,
    nameWithOwner: (obj) => `${repoOf(obj).owner}/${repoOf(obj).name}`,
    owner: () => userObj(),
    description: (obj) => repoOf(obj).description,
    isPrivate: (obj) => repoOf(obj).isPrivate,
    defaultBranchRef: (obj) => {
      const repo = repoOf(obj);
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip } };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: (obj) => isoOf(repoOf(obj).createdEpoch),
    updatedAt: (obj) => isoOf(repoOf(obj).updatedEpoch),
    url: (obj) => `/${repoOf(obj).owner}/${repoOf(obj).name}`,
    issue: (obj, args) => {
      const item = repoOf(obj).items.get(Number(args.number));
      return item !== undefined && item.kind === 'issue' ? issueObj(repoOf(obj), item) : null;
    },
    issues: (obj, args) => {
      const repo = repoOf(obj);
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) items = items.filter((item) => states.includes(issueState(item)));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction === 'DESC' ? 'desc' : 'asc';
      items.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      return connection('IssueConnection', items.map((item) => issueObj(repo, item)), args as ConnectionArgs);
    },
    pullRequest: (obj, args) => {
      const item = repoOf(obj).items.get(Number(args.number));
      return item !== undefined && item.kind === 'pull' ? pullObj(repoOf(obj), item) : null;
    },
    pullRequests: (obj, args) => {
      const repo = repoOf(obj);
      let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) items = items.filter((item) => states.includes(pullState(item)));
      else items = items.filter((item) => item.state === 'open' && !item.merged);
      items.sort((a, b) => a.number - b.number);
      return connection('PullRequestConnection', items.map((item) => pullObj(repo, item)), args as ConnectionArgs);
    },
  },
  Issue: {
    id: (obj) => gid(`Issue:${repoOf(obj).id}:${itemOf(obj).number}`),
    databaseId: (obj) => itemOf(obj).dbId,
    number: (obj) => itemOf(obj).number,
    title: (obj) => itemOf(obj).title,
    body: (obj) => itemOf(obj).body,
    state: (obj) => issueState(itemOf(obj)),
    closed: (obj) => itemOf(obj).state === 'closed',
    author: () => userObj(),
    repository: (obj) => repoObj(repoOf(obj)),
    createdAt: (obj) => isoOf(itemOf(obj).createdEpoch),
    updatedAt: (obj) => isoOf(itemOf(obj).updatedEpoch),
    url: (obj) => `/${repoOf(obj).owner}/${repoOf(obj).name}/issues/${itemOf(obj).number}`,
    labels: (obj, args) => {
      const repo = repoOf(obj);
      const nodes = itemOf(obj).labels.map((name) => ({ __typename: 'Label', id: gid(`Label:${repo.id}:${name}`), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' }));
      return connection('LabelConnection', nodes, args as ConnectionArgs);
    },
    comments: (obj, args) => {
      const repo = repoOf(obj);
      const comments = repo.comments.get(itemOf(obj).number) ?? [];
      return connection('IssueCommentConnection', comments.map((comment) => commentObj(repo, itemOf(obj).number, comment)), args as ConnectionArgs);
    },
  },
  PullRequest: {
    id: (obj) => gid(`PullRequest:${repoOf(obj).id}:${itemOf(obj).number}`),
    databaseId: (obj) => itemOf(obj).dbId,
    number: (obj) => itemOf(obj).number,
    title: (obj) => itemOf(obj).title,
    body: (obj) => itemOf(obj).body,
    state: (obj) => pullState(itemOf(obj)),
    merged: (obj) => itemOf(obj).merged,
    mergedAt: (obj) => (itemOf(obj).mergedEpoch !== null ? isoOf(itemOf(obj).mergedEpoch!) : null),
    mergeCommit: (obj) => (itemOf(obj).mergeCommitSha !== null ? { __typename: 'Commit', oid: itemOf(obj).mergeCommitSha } : null),
    headRefName: (obj) => itemOf(obj).headRef,
    baseRefName: (obj) => itemOf(obj).baseRef,
    headRefOid: (obj) => branchTip(repoOf(obj), itemOf(obj).headRef) ?? '',
    baseRefOid: (obj) => branchTip(repoOf(obj), itemOf(obj).baseRef) ?? '',
    author: () => userObj(),
    repository: (obj) => repoObj(repoOf(obj)),
    createdAt: (obj) => isoOf(itemOf(obj).createdEpoch),
    updatedAt: (obj) => isoOf(itemOf(obj).updatedEpoch),
    mergeable: (obj) => {
      const item = itemOf(obj);
      if (item.merged) return 'UNKNOWN';
      const info = pullMergeInfo(repoOf(obj), item);
      if (info === null) return 'UNKNOWN';
      return info.conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (obj, args) => {
      const repo = repoOf(obj);
      const item = itemOf(obj);
      const info = pullMergeInfo(repo, item);
      if (info === null) return connection('PullRequestChangedFileConnection', [], args as ConnectionArgs);
      const baseFiles = info.base === null ? new Map() : flattenTree(readCommit(info.base)?.tree ?? emptyTreeSha());
      const stats = diffFileStats(baseFiles, branchFiles(repo, item.headRef));
      const nodes = stats.map((stat) => ({
        __typename: 'PullRequestChangedFile',
        path: stat.filename,
        additions: stat.additions,
        deletions: stat.deletions,
        changeType: stat.status === 'added' ? 'ADDED' : stat.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return connection('PullRequestChangedFileConnection', nodes, args as ConnectionArgs);
    },
  },
  IssueComment: {
    id: (obj) => gid(`IssueComment:${(obj.comment as CommentRec).id}`),
    databaseId: (obj) => (obj.comment as CommentRec).id,
    body: (obj) => (obj.comment as CommentRec).body,
    author: () => userObj(),
    createdAt: (obj) => isoOf((obj.comment as CommentRec).createdEpoch),
    updatedAt: (obj) => isoOf((obj.comment as CommentRec).updatedEpoch),
  },
  Label: {
    id: (obj) => obj.id as string,
    name: (obj) => obj.name as string,
    color: (obj) => obj.color as string,
    description: (obj) => obj.description as string,
  },
  Ref: {
    name: (obj) => obj.name as string,
    prefix: (obj) => (obj.prefix as string) ?? 'refs/heads/',
    target: (obj) => obj.target as GqlObject,
  },
  Commit: {
    oid: (obj) => obj.oid as string,
    id: (obj) => gid(`Commit:${obj.oid as string}`),
  },
  CreateIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  },
  CloseIssuePayload: {
    issue: (obj) => obj.issue as GqlObject,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (obj) => obj.pullRequest as GqlObject,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  },
  AddCommentPayload: {
    commentEdge: (obj) => obj.commentEdge as GqlObject,
    subject: (obj) => obj.subject as GqlObject,
    clientMutationId: (obj) => (obj.clientMutationId as string | null) ?? null,
  },
  PullRequestChangedFile: {
    path: (obj) => obj.path as string,
    additions: (obj) => obj.additions as number,
    deletions: (obj) => obj.deletions as number,
    changeType: (obj) => obj.changeType as string,
  },
  PageInfo: {
    hasNextPage: (obj) => obj.hasNextPage as boolean,
    hasPreviousPage: (obj) => obj.hasPreviousPage as boolean,
    endCursor: (obj) => obj.endCursor as string | null,
    startCursor: (obj) => obj.startCursor as string | null,
  },
  __Type: {
    name: (obj) => obj.name as string | null,
    kind: (obj) => obj.kind as string,
    description: () => null,
    fields: (obj) => {
      const def = TYPE_DEFS[obj.name as string];
      if (def === undefined || def.fields === undefined) return null;
      return def.fields.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (obj) => {
      const def = TYPE_DEFS[obj.name as string];
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
    },
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (obj) => obj.name as string,
    description: () => null,
    args: () => [],
    type: () => ({ __typename: '__Type', name: null, kind: 'SCALAR' }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (obj) => obj.name as string,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: (obj) => obj.queryType as GqlObject,
    mutationType: (obj) => obj.mutationType as GqlObject,
    subscriptionType: () => null,
    types: (obj) => obj.types as GqlObject[],
    directives: () => [],
  },
};

// Connection edge objects carry the node under a generic typename; resolve their fields generically.
for (const edgeType of ['IssueEdge', 'PullRequestEdge', 'LabelEdge', 'IssueCommentEdge', 'PullRequestChangedFileEdge']) {
  FIELDS[edgeType] = {
    node: (obj) => obj.node as GqlObject,
    cursor: (obj) => obj.cursor as string,
  };
}
for (const connType of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection']) {
  FIELDS[connType] = {
    nodes: (obj) => obj.nodes as GqlObject[],
    edges: (obj) => obj.edges as GqlObject[],
    pageInfo: (obj) => obj.pageInfo as GqlObject,
    totalCount: (obj) => obj.totalCount as number,
  };
}

// ---------------------------------------------------------------- introspection data

const TYPE_DEFS: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url'] },
  Organization: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'closed', 'author', 'labels', 'comments', 'repository', 'createdAt', 'updatedAt', 'url'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'repository', 'createdAt', 'updatedAt'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

function typeObj(name: string): GqlObject | null {
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __typename: '__Type', name, kind: def.kind };
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: Value | null }>;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

function parseDocument(source: string): Document {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = (): { kind: string; value: string } => tokens[pos]!;
  const next = (): { kind: string; value: string } => tokens[pos++]!;
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.kind !== 'punct' || token.value !== value) throw new GqlSyntaxError(`expected "${value}", got "${token.value}"`);
  };
  const skipPunct = (value: string): boolean => {
    if (peek().kind === 'punct' && peek().value === value) {
      pos += 1;
      return true;
    }
    return false;
  };

  function parseValue(): Value {
    const token = next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = next();
      if (name.kind !== 'name') throw new GqlSyntaxError('expected a variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!skipPunct(']')) values.push(parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!skipPunct('}')) {
        const name = next();
        if (name.kind !== 'name') throw new GqlSyntaxError('expected an input field name');
        expectPunct(':');
        fields.push({ name: name.value, value: parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return /[.eE]/.test(token.value) ? { kind: 'float', value: Number(token.value) } : { kind: 'int', value: parseInt(token.value, 10) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlSyntaxError(`unexpected token "${token.value}" in a value`);
  }

  function parseTypeRef(): void {
    if (skipPunct('[')) {
      parseTypeRef();
      expectPunct(']');
    } else {
      const name = next();
      if (name.kind !== 'name') throw new GqlSyntaxError('expected a type name');
    }
    skipPunct('!');
  }

  function parseArgs(): Array<{ name: string; value: Value }> {
    const args: Array<{ name: string; value: Value }> = [];
    if (!skipPunct('(')) return args;
    while (!skipPunct(')')) {
      const name = next();
      if (name.kind !== 'name') throw new GqlSyntaxError('expected an argument name');
      expectPunct(':');
      args.push({ name: name.value, value: parseValue() });
    }
    return args;
  }

  function skipDirectives(): void {
    while (skipPunct('@')) {
      const name = next();
      if (name.kind !== 'name') throw new GqlSyntaxError('expected a directive name');
      parseArgs();
    }
  }

  function parseSelectionSet(): SelectionNode[] {
    expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!skipPunct('}')) {
      if (peek().kind === 'punct' && peek().value === '...') {
        next();
        const nameTok = peek();
        if (nameTok.kind === 'name' && nameTok.value === 'on') {
          next();
          const typeTok = next();
          if (typeTok.kind !== 'name') throw new GqlSyntaxError('expected a type condition');
          skipDirectives();
          selections.push({ kind: 'inline', typeCondition: typeTok.value, selectionSet: parseSelectionSet() });
        } else if (nameTok.kind === 'name') {
          next();
          skipDirectives();
          selections.push({ kind: 'spread', name: nameTok.value });
        } else {
          throw new GqlSyntaxError('malformed fragment selection');
        }
        continue;
      }
      const first = next();
      if (first.kind !== 'name') throw new GqlSyntaxError(`expected a field name, got "${first.value}"`);
      let name = first.value;
      let alias: string | null = null;
      if (skipPunct(':')) {
        alias = name;
        const fieldTok = next();
        if (fieldTok.kind !== 'name') throw new GqlSyntaxError('expected a field name after an alias');
        name = fieldTok.value;
      }
      const args = parseArgs();
      skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      if (peek().kind === 'punct' && peek().value === '{') selectionSet = parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    return selections;
  }

  const operations: Operation[] = [];
  const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
  while (peek().kind !== 'eof') {
    const token = peek();
    if (token.kind === 'punct' && token.value === '{') {
      operations.push({ type: 'query', name: null, variableDefinitions: [], selectionSet: parseSelectionSet() });
      continue;
    }
    if (token.kind !== 'name') throw new GqlSyntaxError(`unexpected token "${token.value}"`);
    if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
      next();
      let name: string | null = null;
      if (peek().kind === 'name') name = next().value;
      const variableDefinitions: Array<{ name: string; defaultValue: Value | null }> = [];
      if (skipPunct('(')) {
        while (!skipPunct(')')) {
          expectPunct('$');
          const varTok = next();
          if (varTok.kind !== 'name') throw new GqlSyntaxError('expected a variable name');
          expectPunct(':');
          parseTypeRef();
          let defaultValue: Value | null = null;
          if (skipPunct('=')) defaultValue = parseValue();
          skipDirectives();
          variableDefinitions.push({ name: varTok.value, defaultValue });
        }
      }
      skipDirectives();
      operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, variableDefinitions, selectionSet: parseSelectionSet() });
      continue;
    }
    if (token.value === 'fragment') {
      next();
      const nameTok = next();
      if (nameTok.kind !== 'name') throw new GqlSyntaxError('expected a fragment name');
      const onTok = next();
      if (onTok.kind !== 'name' || onTok.value !== 'on') throw new GqlSyntaxError('expected "on" in a fragment');
      const typeTok = next();
      if (typeTok.kind !== 'name') throw new GqlSyntaxError('expected a fragment type condition');
      skipDirectives();
      fragments.set(nameTok.value, { typeCondition: typeTok.value, selectionSet: parseSelectionSet() });
      continue;
    }
    throw new GqlSyntaxError(`unexpected definition "${token.value}"`);
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Document['fragments'];
  errors: Array<{ message: string }>;
}

function valueOf(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => valueOf(entry, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function executeSelectionSet(obj: GqlObject | null, typeName: string, selections: readonly SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(obj, typeName, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelectionSet(obj, typeName, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const typeFields = FIELDS[typeName];
    const resolver = typeFields?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx);
    let value: unknown;
    try {
      value = obj === null ? null : resolver(obj, args);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (typeof value === 'object') {
    const obj = value as GqlObject;
    if (typeof obj.__typename === 'string' && selection.selectionSet !== null) {
      return executeSelectionSet(obj, obj.__typename, selection.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

/** Execute one GraphQL operation document (already-parsed JSON body fields). */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): { status: number; payload: unknown } {
  if (typeof body.query !== 'string' || body.query === '') {
    return { status: 400, payload: { errors: [{ message: 'A query string is required.' }] } };
  }
  let document: Document;
  try {
    document = parseDocument(body.query);
  } catch (error) {
    return { status: 400, payload: { errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operationName !== null ? document.operations.find((op) => op.name === operationName) : document.operations[0];
  if (operation === undefined) {
    return { status: 400, payload: { errors: [{ message: 'No operation to execute.' }] } };
  }
  const variables: Record<string, unknown> = {};
  if (typeof body.variables === 'object' && body.variables !== null) {
    for (const [key, value] of Object.entries(body.variables as Record<string, unknown>)) variables[key] = value;
  }
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  for (const def of operation.variableDefinitions) {
    if (variables[def.name] === undefined && def.defaultValue !== null) variables[def.name] = valueOf(def.defaultValue, ctx);
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  const data = executeSelectionSet(root, rootType, operation.selectionSet, ctx);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return { status: 200, payload };
}
