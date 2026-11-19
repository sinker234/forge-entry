// store.ts — the forge's in-memory data model and git object store.
//
// Everything lives in process memory: git objects keyed by their SHA-1 (content-addressed, so one
// global object map serves every repository), repositories keyed by owner/name, and each repo's
// refs, labels, issues and pull requests. Issues and pull requests share one number sequence per
// repository, exactly like GitHub. A logical clock (never the wall clock) stamps created_at fields
// so two runs of the suite see identical state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- identity

/** The account the suite's bearer token names (wire.ts's seeded viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** Logins the scenario knows that are not the viewer: repositories under them are 404 for us. */
export const OTHER_LOGINS: ReadonlySet<string> = new Set(['quinnkeller', 'olgabauer', 'faint-meadow-org']);

/** The git identity server-side commits (contents writes, merges) are authored and committed by. */
export const AUTHOR_NAME = VIEWER.name;
export const AUTHOR_EMAIL = VIEWER.email;

// ---------------------------------------------------------------- logical clock

const BASE_EPOCH = (() => {
  const fromEnv = Number(process.env.MAKEFUN_TRIAL_NOW ?? '');
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.trunc(fromEnv) : 1735689600;
})();

let clockTick = 0;

/** The next deterministic timestamp, in epoch seconds: base + a per-process counter. */
export function nextEpochSec(): number {
  clockTick += 1;
  return BASE_EPOCH + clockTick;
}

/** An ISO-8601 string for an epoch-second value. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** The git author-line timestamp suffix for an epoch-second value. */
export function gitStamp(epochSec: number): string {
  return `${epochSec} +0000`;
}

// ---------------------------------------------------------------- git object store

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

const objects = new Map<string, GitObject>();

/** SHA-1 of an object's canonical encoding (`<type> <len>\0<payload>`), without storing it. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object (idempotent: content addressing makes a second store a no-op) and return its sha. */
export function writeObject(type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

/** Read an object by sha, or undefined when the store does not hold it. */
export function readObject(sha: string): GitObject | undefined {
  return objects.get(sha);
}

/** Whether the store holds an object. */
export function hasObject(sha: string): boolean {
  return objects.has(sha);
}

/** How many objects the store holds (diagnostics only). */
export function objectCount(): number {
  return objects.size;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's payload. Throws on a malformed payload. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit object has no tree');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's payload. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`, '', info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Read and parse a commit, or null when the sha is not a stored commit. Parses are cached:
 *  objects are immutable, and history walks re-read the same commits constantly. */
const commitCache = new Map<string, CommitInfo | null>();

export function readCommit(sha: string): CommitInfo | null {
  const cached = commitCache.get(sha);
  if (cached !== undefined) return cached;
  const obj = objects.get(sha);
  let parsed: CommitInfo | null = null;
  if (obj !== undefined && obj.type === 'commit') {
    try {
      parsed = parseCommit(obj.data);
    } catch {
      parsed = null;
    }
  }
  commitCache.set(sha, parsed);
  return parsed;
}

/** The author identity line (`Name <email> <epoch> +0000`) for a server-made commit at a tick. */
export function identityLine(epochSec: number): string {
  return `${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${gitStamp(epochSec)}`;
}

/** Split a git identity line into name/email/epoch for API views. */
export function parseIdentity(line: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', epochSec: BASE_EPOCH };
  return { name: match[1]!, email: match[2]!, epochSec: Number(match[3]) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** Parse a tree object's payload into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree object');
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree object');
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree entry order: by name, with directories sorting as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's payload from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Read a tree's entries, or null when the sha is not a stored tree. Parses are cached. */
const treeCache = new Map<string, TreeEntry[] | null>();

export function readTree(sha: string): TreeEntry[] | null {
  const cached = treeCache.get(sha);
  if (cached !== undefined) return cached;
  const obj = objects.get(sha);
  let parsed: TreeEntry[] | null = null;
  if (obj !== undefined && obj.type === 'tree') {
    try {
      parsed = parseTree(obj.data);
    } catch {
      parsed = null;
    }
  }
  treeCache.set(sha, parsed);
  return parsed;
}

/** One file in a flattened tree: its blob sha and mode. */
export interface FlatEntry {
  readonly sha: string;
  readonly mode: string;
}

/** Flatten a tree (recursively) into a path -> blob map. An empty map for a missing tree. */
export function flattenTree(treeSha: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (sha: string, prefix: string): void => {
    const entries = readTree(sha);
    if (entries === null) return;
    for (const entry of entries) {
      if (entry.mode === '40000') walk(entry.sha, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { sha: entry.sha, mode: entry.mode });
    }
  };
  walk(treeSha, '');
  return out;
}

/** Build (and store) the tree hierarchy for a flat path -> blob map; returns the root tree sha. */
export function treeFromFlat(flat: ReadonlyMap<string, FlatEntry>): string {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let next = dir.dirs.get(part);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ mode: entry.mode, name: parts[parts.length - 1]!, sha: entry.sha });
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [...dir.files];
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    return writeObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The empty tree's sha (stored on first use). */
export function emptyTreeSha(): string {
  return writeObject('tree', Buffer.alloc(0));
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
}

/** Parse an annotated tag object's payload, or null when malformed. */
export function parseTag(data: Buffer): TagInfo | null {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return object === '' ? null : { object, type, tag };
}

/** Peel a sha through annotated tags to the object it ultimately names (a commit for commit tags). */
export function peelToCommit(sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const tag = parseTag(obj.data);
    if (tag === null) return null;
    current = tag.object;
  }
  return null;
}

// ---------------------------------------------------------------- history walking

/** Every commit reachable from `tip` (inclusive), mapped to its distance (shortest path) from the tip. */
export function commitDistances(tip: string): Map<string, number> {
  return commitDistancesUpTo(tip, Number.POSITIVE_INFINITY);
}

/** Like commitDistances, but the walk stops `maxDepth` generations out (for shallow fetches). */
export function commitDistancesUpTo(tip: string, maxDepth: number): Map<string, number> {
  const distances = new Map<string, number>();
  if (readCommit(tip) === null) return distances;
  distances.set(tip, 0);
  let frontier = [tip];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    depth += 1;
    const next: string[] = [];
    for (const sha of frontier) {
      const commit = readCommit(sha);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!distances.has(parent) && readCommit(parent) !== null) {
          distances.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return distances;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return commitDistances(descendant).has(ancestor);
}

/**
 * A merge base of two commits: a common ancestor that is not itself an ancestor of any other common
 * ancestor (the first one a breadth-first walk from `b` meets inside `a`'s history, at the greatest
 * distance from `b`'s tip that still qualifies — good enough for the histories this forge serves).
 */
export function mergeBase(a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = commitDistances(a);
  if (fromA.size === 0) return null;
  if (readCommit(b) === null) return null;
  // Breadth-first from b, shallowest first: the first common commit with no common descendant is a base.
  const common = new Set<string>();
  const seen = new Set<string>([b]);
  let frontier = [b];
  const ordered: string[] = [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (fromA.has(sha)) {
        common.add(sha);
        ordered.push(sha);
      }
      const commit = readCommit(sha);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  for (const candidate of ordered) {
    let shadowed = false;
    for (const other of common) {
      if (other !== candidate && isAncestor(candidate, other)) {
        shadowed = true;
        break;
      }
    }
    if (!shadowed) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------- three-way tree merge

export interface MergeOutcome {
  readonly merged: Map<string, FlatEntry> | null;
  readonly conflictPaths: readonly string[];
}

/**
 * Merge two flat trees against their common base, file by file: a path changed on only one side
 * takes that side; changed identically on both takes either; changed differently on both (including
 * modified on one side and deleted on the other) is a conflict.
 */
export function mergeFlatTrees(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOT = o?.sha === t?.sha && o?.mode === t?.mode;
    if (sameOT) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    if (b?.sha === o?.sha && b?.mode === o?.mode) {
      if (t !== undefined) merged.set(path, t);
      continue;
    }
    if (b?.sha === t?.sha && b?.mode === t?.mode) {
      if (o !== undefined) merged.set(path, o);
      continue;
    }
    conflicts.push(path);
  }
  return conflicts.length > 0 ? { merged: null, conflictPaths: conflicts } : { merged, conflictPaths: [] };
}

// ---------------------------------------------------------------- repositories

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export type ItemKind = 'issue' | 'pull';

export interface ItemRec {
  /** The shared per-repo number (issues and pulls draw from one sequence). */
  number: number;
  kind: ItemKind;
  /** A forge-wide numeric id (GraphQL databaseId, REST id). */
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdEpoch: number;
  updatedEpoch: number;
  /** Pull requests only. */
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedEpoch: number | null;
  mergeCommitSha: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdEpoch: number;
  updatedEpoch: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Full ref name (refs/heads/..., refs/tags/...) -> object sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, ItemRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
  createdEpoch: number;
  updatedEpoch: number;
}

const repos = new Map<string, RepoRec>();
const repoOrder: RepoRec[] = [];
let nextRepoId = 1;
let nextDbId = 1;
let nextCommentId = 1;

/** Allocate a forge-wide numeric id (issues, pull requests, comments). */
export function allocDbId(): number {
  const id = nextDbId;
  nextDbId += 1;
  return id;
}

/** Allocate a comment id. */
export function allocCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Create a repository record owned by the viewer. The caller checks name availability first. */
export function createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
  const epoch = nextEpochSec();
  const repo: RepoRec = {
    id: nextRepoId,
    owner: VIEWER.login,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    items: new Map(),
    comments: new Map(),
    nextNumber: 1,
    createdEpoch: epoch,
    updatedEpoch: epoch,
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, name), repo);
  repoOrder.push(repo);
  return repo;
}

/**
 * Look a repository up the way the suite's token sees the world: only the viewer's own repositories
 * exist; the same name under any other owner (known or not) is not found.
 */
export function findRepo(owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

/** Whether a repository name is taken under the viewer's account. */
export function repoNameTaken(name: string): boolean {
  return repos.has(repoKey(VIEWER.login, name));
}

/** Delete a repository (its objects stay in the shared store; they are content-addressed). */
export function deleteRepo(repo: RepoRec): void {
  repos.delete(repoKey(repo.owner, repo.name));
  const at = repoOrder.indexOf(repo);
  if (at !== -1) repoOrder.splice(at, 1);
}

/** Every repository the viewer owns, in creation order. */
export function listRepos(): readonly RepoRec[] {
  return repoOrder;
}

/** The commit sha a branch ref names, or null. */
export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The tree sha at a branch's tip, or null when the branch has no commit. */
export function branchTree(repo: RepoRec, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const commit = readCommit(tip);
  return commit === null ? null : commit.tree;
}

/** The flattened file map at a branch's tip (empty when unborn). */
export function branchFiles(repo: RepoRec, branch: string): Map<string, FlatEntry> {
  const tree = branchTree(repo, branch);
  return tree === null ? new Map() : flattenTree(tree);
}

/**
 * Commit a new tree on a branch: builds the commit with the viewer's identity at the next logical
 * tick, points the branch ref at it, and returns the commit sha. `parent` is the branch's current
 * tip (null for an unborn branch).
 */
export function commitOnBranch(repo: RepoRec, branch: string, treeSha: string, message: string, extraParents: readonly string[] = []): string {
  const epoch = nextEpochSec();
  const tip = branchTip(repo, branch);
  const parents = [...(tip === null ? [] : [tip]), ...extraParents];
  const line = identityLine(epoch);
  const sha = writeObject('commit', buildCommit({ tree: treeSha, parents, author: line, committer: line, message }));
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedEpoch = epoch;
  return sha;
}
