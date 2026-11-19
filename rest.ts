// rest.ts — the REST v3 surface under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests (including squash merges), in GitHub's shapes. app.ts owns
// the wire discipline (JSON everywhere, X-GitHub-Request-Id, auth, 400 on malformed JSON); this
// module is a pure dispatch from (method, path segments, query, body) to (status, body, headers).

import {
  VIEWER,
  type RepoRec,
  type ItemRec,
  type CommentRec,
  createRepo,
  findRepo,
  repoNameTaken,
  deleteRepo,
  listRepos,
  branchTip,
  branchFiles,
  commitOnBranch,
  readObject,
  readCommit,
  readTree,
  flattenTree,
  treeFromFlat,
  writeObject,
  emptyTreeSha,
  parseIdentity,
  isoOf,
  nextEpochSec,
  allocDbId,
  allocCommentId,
  mergeBase,
  mergeFlatTrees,
  type FlatEntry,
} from './store.ts';

export interface RestRequest {
  readonly method: string;
  /** Path segments after /api/v3, percent-decoded, empties removed. */
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown> | null;
  readonly host: string;
  /** The full request path (for pagination Link URLs). */
  readonly path: string;
}

export interface RestResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const ok = (body: unknown, status = 200): RestResult => ({ status, body });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });
const notFound = (): RestResult => fail(404, 'Not Found');

// ---------------------------------------------------------------- views

export function userView(login: string = VIEWER.login): Record<string, unknown> {
  const isViewer = login === VIEWER.login;
  return {
    login,
    id: isViewer ? VIEWER.id : 0,
    node_id: '',
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `/${login}`,
    type: 'User',
    site_admin: false,
    name: isViewer ? VIEWER.name : login,
    email: isViewer ? VIEWER.email : null,
  };
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  let openIssues = 0;
  for (const item of repo.items.values()) if (item.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(repo.owner),
    private: repo.isPrivate,
    html_url: `/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoOf(repo.createdEpoch),
    updated_at: isoOf(repo.updatedEpoch),
    pushed_at: isoOf(repo.updatedEpoch),
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(repo: RepoRec, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return {
    id: Math.abs(hash) + 1,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function labelsView(repo: RepoRec, names: readonly string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of names) {
    const view = labelView(repo, name);
    if (view !== null) out.push(view);
  }
  return out;
}

export function issueView(repo: RepoRec, item: ItemRec): Record<string, unknown> {
  const comments = repo.comments.get(item.number)?.length ?? 0;
  return {
    id: item.dbId,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${item.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${item.number}`,
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    user: userView(item.authorLogin),
    labels: labelsView(repo, item.labels),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments,
    created_at: isoOf(item.createdEpoch),
    updated_at: isoOf(item.updatedEpoch),
    closed_at: item.state === 'closed' ? isoOf(item.updatedEpoch) : null,
    author_association: 'OWNER',
  };
}

export function commentView(repo: RepoRec, itemNumber: number, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${itemNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${itemNumber}`,
    body: comment.body,
    user: userView(comment.authorLogin),
    created_at: isoOf(comment.createdEpoch),
    updated_at: isoOf(comment.updatedEpoch),
    author_association: 'OWNER',
  };
}

/** The line-level change counts between two flat trees (for pull request files and stats). */
export function diffFileStats(baseFiles: ReadonlyMap<string, FlatEntry>, headFiles: ReadonlyMap<string, FlatEntry>): Array<{
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  patch: string;
}> {
  const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; sha: string; patch: string }> = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base?.sha === head?.sha) continue;
    const baseLines = base === undefined ? [] : linesOf(base.sha);
    const headLines = head === undefined ? [] : linesOf(head.sha);
    const { additions, deletions, patch } = lineDiff(baseLines, headLines, path);
    out.push({
      filename: path,
      status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: head?.sha ?? '',
      patch,
    });
  }
  return out;
}

function linesOf(blobSha: string): string[] {
  const obj = readObject(blobSha);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A small LCS line diff: exact addition/deletion counts and a unified-diff-flavoured patch. */
export function lineDiff(oldLines: readonly string[], newLines: readonly string[], path: string): { additions: number; deletions: number; patch: string } {
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths table (files in this forge are small; the table is at most a few hundred square).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let additions = 0;
  let deletions = 0;
  const patchLines: string[] = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${n} +1,${m} @@`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      patchLines.push(` ${oldLines[i]}`);
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      patchLines.push(`-${oldLines[i]}`);
      deletions += 1;
      i += 1;
    } else {
      patchLines.push(`+${newLines[j]}`);
      additions += 1;
      j += 1;
    }
  }
  while (i < n) {
    patchLines.push(`-${oldLines[i]}`);
    deletions += 1;
    i += 1;
  }
  while (j < m) {
    patchLines.push(`+${newLines[j]}`);
    additions += 1;
    j += 1;
  }
  return { additions, deletions, patch: patchLines.join('\n') };
}

/** The merge situation of a pull request right now: base/head tips, their base, and the outcome. */
export interface PullMergeInfo {
  readonly baseTip: string;
  readonly headTip: string;
  readonly base: string | null;
  readonly conflict: boolean;
  readonly mergedTree: string | null;
}

export function pullMergeInfo(repo: RepoRec, item: ItemRec): PullMergeInfo | null {
  const baseTip = branchTip(repo, item.baseRef);
  const headTip = branchTip(repo, item.headRef);
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(baseTip, headTip);
  const baseFiles = base === null ? new Map<string, FlatEntry>() : flattenTree(readCommit(base)?.tree ?? emptyTreeSha());
  const ourFiles = branchFiles(repo, item.baseRef);
  const theirFiles = branchFiles(repo, item.headRef);
  const outcome = mergeFlatTrees(baseFiles, ourFiles, theirFiles);
  return {
    baseTip,
    headTip,
    base,
    conflict: outcome.merged === null,
    mergedTree: outcome.merged === null ? null : treeFromFlat(outcome.merged),
  };
}

export function pullView(repo: RepoRec, item: ItemRec): Record<string, unknown> {
  const headTip = branchTip(repo, item.headRef);
  const baseTip = branchTip(repo, item.baseRef);
  const info = item.merged ? null : pullMergeInfo(repo, item);
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  let commits = 0;
  if (info !== null) {
    const baseFiles = info.base === null ? new Map<string, FlatEntry>() : flattenTree(readCommit(info.base)?.tree ?? emptyTreeSha());
    const stats = diffFileStats(baseFiles, branchFiles(repo, item.headRef));
    changedFiles = stats.length;
    for (const stat of stats) {
      additions += stat.additions;
      deletions += stat.deletions;
    }
    if (info.base !== null) {
      // Count the commits on the head side of the merge base.
      const seen = new Set<string>();
      const queue = [info.headTip];
      seen.add(info.headTip);
      while (queue.length > 0) {
        const sha = queue.pop()!;
        if (sha === info.base) continue;
        commits += 1;
        const commit = readCommit(sha);
        if (commit === null) continue;
        for (const parent of commit.parents) {
          if (!seen.has(parent)) {
            seen.add(parent);
            queue.push(parent);
          }
        }
      }
    }
  }
  const refView = (ref: string, tip: string | null): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: tip ?? '',
    user: userView(repo.owner),
    repo: repoView(repo),
  });
  return {
    id: item.dbId,
    node_id: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${item.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${item.number}`,
    number: item.number,
    state: item.state,
    locked: false,
    title: item.title,
    body: item.body,
    user: userView(item.authorLogin),
    created_at: isoOf(item.createdEpoch),
    updated_at: isoOf(item.updatedEpoch),
    closed_at: item.state === 'closed' ? isoOf(item.updatedEpoch) : null,
    merged_at: item.merged && item.mergedEpoch !== null ? isoOf(item.mergedEpoch) : null,
    merge_commit_sha: item.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: labelsView(repo, item.labels),
    draft: false,
    head: refView(item.headRef, headTip),
    base: refView(item.baseRef, baseTip),
    merged: item.merged,
    mergeable: item.merged ? true : info === null ? null : !info.conflict,
    mergeable_state: item.merged ? 'clean' : info === null ? 'unknown' : info.conflict ? 'dirty' : 'clean',
    comments: repo.comments.get(item.number)?.length ?? 0,
    commits,
    additions,
    deletions,
    changed_files: changedFiles,
  };
}

function commitView(sha: string): Record<string, unknown> | null {
  const commit = readCommit(sha);
  if (commit === null) return null;
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  const person = (parsed: { name: string; email: string; epochSec: number }): Record<string, unknown> => ({
    name: parsed.name,
    email: parsed.email,
    date: isoOf(parsed.epochSec),
  });
  return {
    sha,
    node_id: '',
    url: `/api/v3/repos/x/commits/${sha}`,
    commit: {
      author: person(author),
      committer: person(committer),
      message: commit.message,
      tree: { sha: commit.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    author: author.email === VIEWER.email ? userView() : null,
    committer: committer.email === VIEWER.email ? userView() : null,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  readonly items: unknown[];
  readonly headers: Readonly<Record<string, string>>;
}

function paginate(req: RestRequest, items: readonly unknown[]): Page {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const pageRaw = Number(req.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (items.length > 0 && page <= lastPage) {
    const urlFor = (p: number): string => {
      const params = new URLSearchParams(req.query);
      params.set('page', String(p));
      params.set('per_page', String(perPage));
      return `<http://${req.host}${req.path}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < lastPage) {
      links.push(`${urlFor(page + 1)}; rel="next"`);
      links.push(`${urlFor(lastPage)}; rel="last"`);
    }
    if (page > 1) {
      links.push(`${urlFor(1)}; rel="first"`);
      links.push(`${urlFor(page - 1)}; rel="prev"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

function pageResult(req: RestRequest, items: readonly unknown[]): RestResult {
  const page = paginate(req, items);
  return { status: 200, body: page.items, headers: page.headers };
}

// ---------------------------------------------------------------- small helpers

function bodyString(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === 'string' ? value : null;
}

function bodyBool(body: Record<string, unknown> | null, key: string): boolean | null {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : null;
}

/** Label names out of an issue/pull body: strings, or objects with a name. */
function bodyLabels(body: Record<string, unknown> | null): string[] | null {
  const raw = body?.labels;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** Resolve the repository addressed by segments [repos, owner, name, ...]. */
function addressedRepo(segments: readonly string[]): RepoRec | null {
  if (segments.length < 3 || segments[0] !== 'repos') return null;
  return findRepo(segments[1]!, segments[2]!);
}

// ---------------------------------------------------------------- dispatch

export function handleRest(req: RestRequest): RestResult {
  const { method, segments } = req;

  // The API root and meta are answered before any repository routing.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues?q={query}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-forge',
      platform: 'makefun-forge',
    });
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok({ ...userView(), name: VIEWER.name, email: VIEWER.email });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return pageResult(req, listRepos().map(repoView));
    if (method === 'POST') return createRepository(req);
    return notFound();
  }

  const repo = addressedRepo(segments);
  if (repo === null) return notFound();
  const rest = segments.slice(3);
  return handleRepoRoute(req, repo, rest);
}

function createRepository(req: RestRequest): RestResult {
  const name = bodyString(req.body, 'name');
  if (name === null || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return fail(422, 'Repository creation failed: a valid name is required.');
  }
  if (repoNameTaken(name)) {
    return {
      status: 422,
      body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] },
    };
  }
  const description = bodyString(req.body, 'description') ?? '';
  const isPrivate = bodyBool(req.body, 'private') ?? false;
  const repo = createRepo(name, description, isPrivate);
  const defaultBranch = bodyString(req.body, 'default_branch');
  if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  return ok(repoView(repo), 201);
}

// ---------------------------------------------------------------- per-repository routes

function handleRepoRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  const { method } = req;

  if (rest.length === 0) {
    if (method === 'GET') return ok(repoView(repo));
    if (method === 'PATCH') {
      const description = bodyString(req.body, 'description');
      if (description !== null) repo.description = description;
      const isPrivate = bodyBool(req.body, 'private');
      if (isPrivate !== null) repo.isPrivate = isPrivate;
      const defaultBranch = bodyString(req.body, 'default_branch');
      if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      const name = bodyString(req.body, 'name');
      if (name !== null && name !== '' && name !== repo.name && !repoNameTaken(name)) {
        // Rename: re-key the registry entry by rebuilding the record under the new name.
        const old = { ...repo };
        deleteRepo(repo);
        const renamed = createRepo(name, old.description, old.isPrivate);
        renamed.id = old.id;
        renamed.defaultBranch = old.defaultBranch;
        renamed.refs = old.refs;
        renamed.labels = old.labels;
        renamed.items = old.items;
        renamed.comments = old.comments;
        renamed.nextNumber = old.nextNumber;
        renamed.createdEpoch = old.createdEpoch;
        return ok(repoView(renamed));
      }
      repo.updatedEpoch = nextEpochSec();
      return ok(repoView(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  switch (rest[0]) {
    case 'branches':
      return branchesRoute(req, repo, rest.slice(1));
    case 'commits':
      return commitsRoute(req, repo, rest.slice(1));
    case 'git':
      return gitDataRoute(req, repo, rest.slice(1));
    case 'contents':
      return contentsRoute(req, repo, rest.slice(1).join('/'));
    case 'labels':
      return labelsRoute(req, repo, rest.slice(1));
    case 'issues':
      return issuesRoute(req, repo, rest.slice(1));
    case 'pulls':
      return pullsRoute(req, repo, rest.slice(1));
    default:
      return notFound();
  }
}

function branchesRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  if (rest.length === 0) {
    if (req.method !== 'GET') return notFound();
    const branches: Record<string, unknown>[] = [];
    for (const [ref, sha] of repo.refs) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return pageResult(req, branches);
  }
  if (req.method !== 'GET') return notFound();
  const branch = rest.join('/');
  const sha = branchTip(repo, branch);
  if (sha === null) return notFound();
  return ok({ name: branch, commit: { sha, url: '' }, protected: false });
}

function commitsRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  if (rest.length === 1) {
    if (req.method !== 'GET') return notFound();
    const view = commitView(rest[0]!);
    return view === null ? notFound() : ok(view);
  }
  if (rest.length !== 0 || req.method !== 'GET') return notFound();
  const shaParam = req.query.get('sha');
  let tip: string | null;
  if (shaParam === null || shaParam === '') {
    tip = branchTip(repo, repo.defaultBranch);
    if (tip === null) return fail(409, 'Git Repository is empty.');
  } else if (readCommit(shaParam) !== null) {
    tip = shaParam;
  } else {
    tip = branchTip(repo, shaParam);
    if (tip === null) return notFound();
  }
  const distances = new Map<string, number>();
  {
    const start = tip;
    distances.set(start, 0);
    let frontier = [start];
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      for (const sha of frontier) {
        const commit = readCommit(sha);
        if (commit === null) continue;
        for (const parent of commit.parents) {
          if (!distances.has(parent)) {
            distances.set(parent, depth);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
  }
  const ordered = [...distances.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => commitView(sha)!).filter((view) => view !== null);
  return pageResult(req, ordered);
}

function gitDataRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  if (rest[0] === 'refs') {
    if (rest.length === 1) {
      if (req.method === 'GET') {
        const refs: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          const obj = readObject(sha);
          refs.push({ ref, node_id: '', object: { sha, type: obj?.type ?? 'commit', url: '' } });
        }
        refs.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
        return ok(refs);
      }
      if (req.method === 'POST') {
        const ref = bodyString(req.body, 'ref');
        const sha = bodyString(req.body, 'sha');
        if (ref === null || sha === null || !ref.startsWith('refs/')) return fail(422, 'Invalid ref or sha.');
        const obj = readObject(sha);
        if (obj === undefined) return fail(422, `Object ${sha} does not exist.`);
        if (repo.refs.has(ref)) return fail(422, 'Reference already exists.');
        repo.refs.set(ref, sha);
        return ok({ ref, node_id: '', object: { sha, type: obj.type, url: '' } }, 201);
      }
      return notFound();
    }
    const refName = rest.slice(1).join('/');
    const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
    if (req.method === 'GET') {
      const sha = repo.refs.get(full);
      if (sha === undefined) return notFound();
      const obj = readObject(sha);
      return ok({ ref: full, node_id: '', object: { sha, type: obj?.type ?? 'commit', url: '' } });
    }
    if (req.method === 'DELETE') {
      if (!repo.refs.has(full)) return notFound();
      repo.refs.delete(full);
      return { status: 204 };
    }
    return notFound();
  }
  if (rest[0] === 'trees' && rest.length === 2 && req.method === 'GET') {
    const treeSha = rest[1]!;
    if (readTree(treeSha) === null) return notFound();
    const recursive = req.query.get('recursive') === '1';
    if (!recursive) {
      const entries = readTree(treeSha)!.map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.sha,
        ...(entry.mode === '40000' ? {} : { size: readObject(entry.sha)?.data.length ?? 0 }),
        url: '',
      }));
      return ok({ sha: treeSha, url: '', tree: entries, truncated: false });
    }
    const flat = flattenTree(treeSha);
    const entries = [...flat.entries()].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: entry.sha, size: readObject(entry.sha)?.data.length ?? 0, url: '' }));
    return ok({ sha: treeSha, url: '', tree: entries, truncated: false });
  }
  if (rest[0] === 'commits' && rest.length === 2 && req.method === 'GET') {
    const commit = readCommit(rest[1]!);
    if (commit === null) return notFound();
    const author = parseIdentity(commit.author);
    const committer = parseIdentity(commit.committer);
    return ok({
      sha: rest[1],
      tree: { sha: commit.tree, url: '' },
      parents: commit.parents.map((sha) => ({ sha, url: '' })),
      author: { name: author.name, email: author.email, date: isoOf(author.epochSec) },
      committer: { name: committer.name, email: committer.email, date: isoOf(committer.epochSec) },
      message: commit.message,
    });
  }
  if (rest[0] === 'blobs' && rest.length === 2 && req.method === 'GET') {
    const obj = readObject(rest[1]!);
    if (obj === undefined || obj.type !== 'blob') return notFound();
    return ok({ sha: rest[1], size: obj.data.length, encoding: 'base64', content: obj.data.toString('base64') });
  }
  return notFound();
}

// ---------------------------------------------------------------- contents

/** The tree sha a contents ref (branch name or commit sha) resolves to, or null. */
function resolveRefTree(repo: RepoRec, ref: string | null): string | null {
  if (ref === null) {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip === null ? null : readCommit(tip)?.tree ?? null;
  }
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return readCommit(byBranch)?.tree ?? null;
  const commit = readCommit(ref);
  return commit === null ? null : commit.tree;
}

/** Walk a tree to a path; returns the entry found (blob or tree) with its sha. */
function walkTree(treeSha: string, path: string): { kind: 'blob' | 'tree'; sha: string; mode: string } | null {
  if (path === '') return { kind: 'tree', sha: treeSha, mode: '40000' };
  const parts = path.split('/');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = readTree(current);
    if (entries === null) return null;
    const entry = entries.find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000' ? { kind: 'tree', sha: entry.sha, mode: entry.mode } : { kind: 'blob', sha: entry.sha, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}

function fileContentView(repo: RepoRec, path: string, blobSha: string): Record<string, unknown> {
  const obj = readObject(blobSha);
  const data = obj?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    name,
    path,
    sha: blobSha,
    size: data.length,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
    _links: { self: '', git: '', html: '' },
  };
}

function contentsRoute(req: RestRequest, repo: RepoRec, path: string): RestResult {
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  if (req.method === 'GET') {
    const ref = req.query.get('ref');
    const treeSha = resolveRefTree(repo, ref);
    if (treeSha === null) return notFound();
    const found = walkTree(treeSha, cleanPath);
    if (found === null) return notFound();
    if (found.kind === 'blob') return ok(fileContentView(repo, cleanPath, found.sha));
    const entries = readTree(found.sha) ?? [];
    const listing = entries.map((entry) => {
      const childPath = cleanPath === '' ? entry.name : `${cleanPath}/${entry.name}`;
      const isDir = entry.mode === '40000';
      return {
        name: entry.name,
        path: childPath,
        sha: entry.sha,
        size: isDir ? 0 : readObject(entry.sha)?.data.length ?? 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
        html_url: '',
        git_url: '',
        type: isDir ? 'dir' : 'file',
        _links: { self: '', git: '', html: '' },
      };
    });
    listing.sort((a, b) => a.name.localeCompare(b.name));
    return ok(listing);
  }

  if (req.method === 'PUT' || req.method === 'DELETE') {
    const message = bodyString(req.body, 'message');
    if (message === null || message === '') return fail(422, 'A commit message is required.');
    const branch = bodyString(req.body, 'branch') ?? repo.defaultBranch;
    const files = branchFiles(repo, branch);
    const existing = files.get(cleanPath);

    if (req.method === 'PUT') {
      const contentB64 = bodyString(req.body, 'content');
      if (contentB64 === null) return fail(422, 'Content is required.');
      const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
      const shaGiven = bodyString(req.body, 'sha');
      if (existing !== undefined) {
        if (shaGiven === null) return fail(422, '"sha" wasn\'t supplied.');
        if (shaGiven !== existing.sha) return fail(409, 'The sha does not match the current file.');
      }
      const blobSha = writeObject('blob', data);
      files.set(cleanPath, { sha: blobSha, mode: existing?.mode ?? '100644' });
      const treeSha = treeFromFlat(files);
      const commitSha = commitOnBranch(repo, branch, treeSha, message);
      const commit = readCommit(commitSha)!;
      return ok(
        {
          content: fileContentView(repo, cleanPath, blobSha),
          commit: {
            sha: commitSha,
            node_id: '',
            url: '',
            html_url: '',
            author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(repo.updatedEpoch) },
            committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(repo.updatedEpoch) },
            tree: { sha: commit.tree, url: '' },
            message: commit.message,
            parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
          },
        },
        existing !== undefined ? 200 : 201,
      );
    }

    // DELETE
    if (existing === undefined) return notFound();
    const shaGiven = bodyString(req.body, 'sha');
    if (shaGiven === null) return fail(422, '"sha" wasn\'t supplied.');
    if (shaGiven !== existing.sha) return fail(409, 'The sha does not match the current file.');
    files.delete(cleanPath);
    const treeSha = treeFromFlat(files);
    const commitSha = commitOnBranch(repo, branch, treeSha, message);
    return ok({ content: null, commit: { sha: commitSha, message, tree: { sha: treeSha, url: '' }, parents: [] } });
  }

  return notFound();
}

// ---------------------------------------------------------------- labels

function labelsRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const views = [...repo.labels.keys()].sort().map((name) => labelView(repo, name)!).filter((view) => view !== null);
      return pageResult(req, views);
    }
    if (req.method === 'POST') {
      const name = bodyString(req.body, 'name');
      if (name === null || name === '') return fail(422, 'A label name is required.');
      const color = (bodyString(req.body, 'color') ?? 'ededed').replace(/^#/, '').toLowerCase();
      const description = bodyString(req.body, 'description') ?? '';
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        existing.color = color;
        existing.description = description;
      } else {
        repo.labels.set(name, { name, color, description });
      }
      return ok(labelView(repo, name)!, 201);
    }
    return notFound();
  }
  const name = rest.join('/');
  const label = repo.labels.get(name);
  if (req.method === 'GET') {
    if (label === undefined) return notFound();
    return ok(labelView(repo, name)!);
  }
  if (req.method === 'PATCH') {
    if (label === undefined) return notFound();
    const newName = bodyString(req.body, 'new_name');
    const color = bodyString(req.body, 'color');
    const description = bodyString(req.body, 'description');
    if (color !== null) label.color = color.replace(/^#/, '').toLowerCase();
    if (description !== null) label.description = description;
    if (newName !== null && newName !== '' && newName !== name) {
      repo.labels.delete(name);
      label.name = newName;
      repo.labels.set(newName, label);
      for (const item of repo.items.values()) {
        item.labels = item.labels.map((entry) => (entry === name ? newName : entry));
      }
      return ok(labelView(repo, newName)!);
    }
    return ok(labelView(repo, name)!);
  }
  if (req.method === 'DELETE') {
    if (label === undefined) return notFound();
    repo.labels.delete(name);
    return { status: 204 };
  }
  return notFound();
}

// ---------------------------------------------------------------- issues and comments

function newItem(repo: RepoRec, kind: 'issue' | 'pull', title: string, body: string, labels: string[]): ItemRec {
  const epoch = nextEpochSec();
  const item: ItemRec = {
    number: repo.nextNumber,
    kind,
    dbId: allocDbId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
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

/** Validate label names against the repo's labels; returns an error result or null. */
function labelError(repo: RepoRec, names: readonly string[]): RestResult | null {
  for (const name of names) {
    if (!repo.labels.has(name)) return fail(422, `Label "${name}" does not exist in this repository.`);
  }
  return null;
}

function issuesRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  // /issues/comments/{id} (GitHub's comment-by-id routes)
  if (rest[0] === 'comments' && rest.length === 2) {
    const id = Number(rest[1]);
    for (const [number, comments] of repo.comments) {
      const comment = comments.find((entry) => entry.id === id);
      if (comment === undefined) continue;
      if (req.method === 'GET') return ok(commentView(repo, number, comment));
      if (req.method === 'PATCH') {
        const body = bodyString(req.body, 'body');
        if (body === null) return fail(422, 'A comment body is required.');
        comment.body = body;
        comment.updatedEpoch = nextEpochSec();
        return ok(commentView(repo, number, comment));
      }
      if (req.method === 'DELETE') {
        repo.comments.set(number, comments.filter((entry) => entry.id !== id));
        return { status: 204 };
      }
      return notFound();
    }
    return notFound();
  }

  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = bodyString(req.body, 'title');
      if (title === null || title === '') return fail(422, 'A title is required.');
      const labels = bodyLabels(req.body) ?? [];
      const invalid = labelError(repo, labels);
      if (invalid !== null) return invalid;
      const item = newItem(repo, 'issue', title, bodyString(req.body, 'body') ?? '', labels);
      return ok(issueView(repo, item), 201);
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const labelFilter = (req.query.get('labels') ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      if (labelFilter.length > 0) items = items.filter((item) => labelFilter.every((name) => item.labels.includes(name)));
      const direction = req.query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return pageResult(req, items.map((item) => issueView(repo, item)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;

  if (rest.length === 1) {
    if (item === undefined || item.kind !== 'issue') return notFound();
    if (req.method === 'GET') return ok(issueView(repo, item));
    if (req.method === 'PATCH') {
      const title = bodyString(req.body, 'title');
      if (title !== null) item.title = title;
      const body = bodyString(req.body, 'body');
      if (body !== null) item.body = body;
      const labels = bodyLabels(req.body);
      if (labels !== null) {
        const invalid = labelError(repo, labels);
        if (invalid !== null) return invalid;
        item.labels = labels;
      }
      const state = bodyString(req.body, 'state');
      if (state === 'closed' || state === 'open') item.state = state;
      item.updatedEpoch = nextEpochSec();
      return ok(issueView(repo, item));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (item === undefined) return notFound();
    if (rest.length === 2) {
      if (req.method === 'GET') {
        const comments = repo.comments.get(item.number) ?? [];
        return pageResult(req, comments.map((comment) => commentView(repo, item.number, comment)));
      }
      if (req.method === 'POST') {
        const body = bodyString(req.body, 'body');
        if (body === null || body === '') return fail(422, 'A comment body is required.');
        const epoch = nextEpochSec();
        const comment: CommentRec = { id: allocCommentId(), body, authorLogin: VIEWER.login, createdEpoch: epoch, updatedEpoch: epoch };
        const list = repo.comments.get(item.number) ?? [];
        list.push(comment);
        repo.comments.set(item.number, list);
        return ok(commentView(repo, item.number, comment), 201);
      }
      return notFound();
    }
    if (rest.length === 3) {
      const id = Number(rest[2]);
      const comments = repo.comments.get(item.number) ?? [];
      const comment = comments.find((entry) => entry.id === id);
      if (comment === undefined) return notFound();
      if (req.method === 'GET') return ok(commentView(repo, item.number, comment));
      if (req.method === 'PATCH') {
        const body = bodyString(req.body, 'body');
        if (body === null) return fail(422, 'A comment body is required.');
        comment.body = body;
        comment.updatedEpoch = nextEpochSec();
        return ok(commentView(repo, item.number, comment));
      }
      if (req.method === 'DELETE') {
        repo.comments.set(item.number, comments.filter((entry) => entry.id !== id));
        return { status: 204 };
      }
      return notFound();
    }
  }

  if (rest[1] === 'labels') {
    if (item === undefined || item.kind !== 'issue') return notFound();
    if (req.method === 'GET') return ok(labelsView(repo, item.labels));
    if (req.method === 'POST') {
      const labels = bodyLabels(req.body) ?? (bodyString(req.body, 'name') !== null ? [bodyString(req.body, 'name')!] : []);
      const invalid = labelError(repo, labels);
      if (invalid !== null) return invalid;
      for (const name of labels) if (!item.labels.includes(name)) item.labels.push(name);
      item.updatedEpoch = nextEpochSec();
      return ok(labelsView(repo, item.labels));
    }
    if (req.method === 'DELETE' && rest.length === 3) {
      const name = rest[2]!;
      item.labels = item.labels.filter((entry) => entry !== name);
      return ok(labelsView(repo, item.labels));
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- pull requests

function stripRefQualifier(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

function pullsRoute(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResult {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const title = bodyString(req.body, 'title');
      if (title === null || title === '') return fail(422, 'A title is required.');
      const headRaw = bodyString(req.body, 'head');
      const baseRaw = bodyString(req.body, 'base');
      if (headRaw === null || baseRaw === null) return fail(422, 'Head and base are required.');
      const head = stripRefQualifier(headRaw);
      const base = stripRefQualifier(baseRaw);
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (headTip === null) return fail(422, `Head ref "${head}" does not exist.`);
      if (baseTip === null) return fail(422, `Base ref "${base}" does not exist.`);
      if (headTip === baseTip) return fail(422, `No commits between ${base} and ${head}.`);
      for (const existing of repo.items.values()) {
        if (existing.kind === 'pull' && existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return fail(422, `A pull request already exists for ${head} into ${base}.`);
        }
      }
      const item = newItem(repo, 'pull', title, bodyString(req.body, 'body') ?? '', []);
      item.headRef = head;
      item.baseRef = base;
      const labels = bodyLabels(req.body);
      if (labels !== null) {
        const invalid = labelError(repo, labels);
        if (invalid !== null) return invalid;
        item.labels = labels;
      }
      return ok(pullView(repo, item), 201);
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
      if (state === 'open') items = items.filter((item) => item.state === 'open');
      else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
      const direction = req.query.get('direction') ?? 'desc';
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return pageResult(req, items.map((item) => pullView(repo, item)));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (item === undefined || item.kind !== 'pull') return notFound();

  if (rest.length === 1) {
    if (req.method === 'GET') return ok(pullView(repo, item));
    if (req.method === 'PATCH') {
      const title = bodyString(req.body, 'title');
      if (title !== null) item.title = title;
      const body = bodyString(req.body, 'body');
      if (body !== null) item.body = body;
      const state = bodyString(req.body, 'state');
      if (state === 'closed' || state === 'open') item.state = state;
      const base = bodyString(req.body, 'base');
      if (base !== null) item.baseRef = stripRefQualifier(base);
      item.updatedEpoch = nextEpochSec();
      return ok(pullView(repo, item));
    }
    return notFound();
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (req.method !== 'GET') return notFound();
    const info = pullMergeInfo(repo, item);
    if (info === null) return notFound();
    const baseFiles = info.base === null ? new Map<string, FlatEntry>() : flattenTree(readCommit(info.base)?.tree ?? emptyTreeSha());
    const stats = diffFileStats(baseFiles, branchFiles(repo, item.headRef));
    return pageResult(
      req,
      stats.map((stat) => ({
        sha: stat.sha,
        filename: stat.filename,
        status: stat.status,
        additions: stat.additions,
        deletions: stat.deletions,
        changes: stat.changes,
        patch: stat.patch,
      })),
    );
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (req.method === 'GET') {
      return item.merged ? { status: 204 } : notFound();
    }
    if (req.method === 'PUT') return mergePull(req, repo, item);
    return notFound();
  }

  return notFound();
}

/** Perform a pull request merge (squash by default; a true merge commit when asked). */
function mergePull(req: RestRequest, repo: RepoRec, item: ItemRec): RestResult {
  if (item.merged) return fail(405, 'Pull Request is not mergeable.');
  if (item.state !== 'open') return fail(405, 'Pull Request is not mergeable.');
  const info = pullMergeInfo(repo, item);
  if (info === null) return fail(405, 'Pull Request is not mergeable.');
  if (info.conflict || info.mergedTree === null) return fail(405, 'Pull Request has a merge conflict.');
  const method = bodyString(req.body, 'merge_method') ?? 'squash';
  const epoch = nextEpochSec();
  let sha: string;
  if (method === 'merge') {
    const title = bodyString(req.body, 'commit_title') ?? `Merge pull request #${item.number} from ${item.headRef}`;
    sha = commitOnBranch(repo, item.baseRef, info.mergedTree, title, [info.headTip]);
  } else {
    const title = bodyString(req.body, 'commit_title') ?? `${item.title} (#${item.number})`;
    const message = bodyString(req.body, 'commit_message');
    const full = message !== null && message !== '' ? `${title}\n\n${message}` : item.body !== '' ? `${title}\n\n${item.body}` : title;
    sha = commitOnBranch(repo, item.baseRef, info.mergedTree, full);
  }
  item.merged = true;
  item.state = 'closed';
  item.mergedEpoch = epoch;
  item.mergeCommitSha = sha;
  item.updatedEpoch = epoch;
  return ok({ sha, merged: true, message: 'Pull Request successfully merged' });
}
