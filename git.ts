// git.ts — git smart HTTP, implemented from the protocol up: pkt-lines, packfiles (read with
// ofs/ref delta resolution, write as full objects), SHA-1 object transfer for upload-pack
// protocol v2 (and the v0 fallback) and receive-pack v0. No git binary is ever spawned; every
// object moves through store.ts's content-addressed map.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  type RepoRec,
  readObject,
  writeObject,
  hashObject,
  readCommit,
  readTree,
  peelToCommit,
  commitDistances,
  commitDistancesUpTo,
  isAncestor,
  parseTag,
} from './store.ts';

export const ZERO_SHA = '0'.repeat(40);
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (payload up to 65516 bytes). */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' };

/** A sequential pkt-line reader over a request body. Throws on malformed framing. */
export class PktReader {
  private offset = 0;
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** The next packet, or null at the end of the buffer. */
  next(): Pkt | null {
    if (this.offset >= this.buf.length) return null;
    if (this.offset + 4 > this.buf.length) throw new Error('truncated pkt-line header');
    const hex = this.buf.toString('ascii', this.offset, this.offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`malformed pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.offset += 4;
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.offset += 4;
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.offset += 4;
      return { kind: 'data', payload: Buffer.alloc(0) };
    }
    if (length < 4 || this.offset + length > this.buf.length) throw new Error('pkt-line overruns the body');
    const payload = this.buf.subarray(this.offset + 4, this.offset + length);
    this.offset += length;
    return { kind: 'data', payload };
  }

  /** The unread remainder (a receive-pack body carries its packfile after the command flush). */
  rest(): Buffer {
    return this.buf.subarray(this.offset);
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODES: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, string>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Inflate the zlib stream starting at `offset`, finding its exact end: Node's inflateSync accepts
 * trailing bytes, so the consumed length is the smallest prefix that inflates to `expectedSize`.
 */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  const attempt = (length: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + length));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  let hi = Math.min(buf.length - offset, Math.max(128, expectedSize + 64));
  let data = attempt(hi);
  while (data === null) {
    if (offset + hi >= buf.length) throw new Error('pack entry is truncated');
    hi = Math.min(buf.length - offset, hi * 2);
    data = attempt(hi);
  }
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (attempt(mid) !== null) hi = mid;
    else lo = mid;
  }
  const out = attempt(hi);
  if (out === null) throw new Error('pack entry does not inflate');
  return { data: out, nextOffset: offset + hi };
}

/** Apply a delta (the copy/insert instruction stream) to its base object's payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta');
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface RawPackEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseSha?: string;
}

/**
 * Parse a packfile and store every object it carries (deltas resolved against the pack itself or,
 * for a thin pack, the objects already in the store). Returns the stored objects' shas. Throws on
 * any malformation, including a trailer checksum mismatch.
 */
export function ingestPack(pack: Buffer): string[] {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');

  const entries: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeCode === 6) {
      let b = pack[offset]!;
      offset += 1;
      let negative = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset]!;
        offset += 1;
        negative = ((negative + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - negative;
    } else if (typeCode === 7) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateAt(pack, offset, size);
    offset = inflated.nextOffset;
    const entry: RawPackEntry = { offset: start, typeCode, size, data: inflated.data, baseOffset, baseSha };
    entries.push(entry);
    byOffset.set(start, entry);
  }

  // Non-delta entries indexed by the sha they will hash to, for ref-delta base lookup.
  const plainBySha = new Map<string, RawPackEntry>();
  for (const entry of entries) {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      plainBySha.set(hashObject(CODE_TYPES[entry.typeCode]! as never, entry.data), entry);
    }
  }

  const resolved = new Map<number, { type: string; data: Buffer; sha: string }>();
  const resolve = (entry: RawPackEntry, depth: number): { type: string; data: Buffer; sha: string } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (depth > 64) throw new Error('delta chain is too deep');
    let result: { type: string; data: Buffer; sha: string };
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const type = CODE_TYPES[entry.typeCode]!;
      result = { type, data: entry.data, sha: writeObject(type as never, entry.data) };
    } else if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: { type: string; data: Buffer } | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry, depth + 1);
      } else {
        const inPack = plainBySha.get(entry.baseSha!);
        if (inPack !== undefined) base = resolve(inPack, depth + 1);
        else {
          const stored = readObject(entry.baseSha!);
          if (stored === undefined) throw new Error('ref-delta base is not available');
          base = { type: stored.type, data: stored.data };
        }
      }
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data, sha: writeObject(base.type as never, data) };
    } else {
      throw new Error(`pack entry type ${entry.typeCode} is not supported`);
    }
    resolved.set(entry.offset, result);
    return result;
  };

  const shas: string[] = [];
  for (const entry of entries) shas.push(resolve(entry, 0).sha);
  return shas;
}

/** Build a packfile holding the given objects whole (no deltas), with a correct trailer. */
export function buildPack(shas: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of shas) {
    const obj = readObject(sha);
    if (obj === undefined) throw new Error(`cannot pack missing object ${sha}`);
    const typeCode = TYPE_CODES[obj.type]!;
    let size = obj.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size === 0) {
      headBytes.push(first);
    } else {
      headBytes.push(first | 0x80);
      while (size > 0) {
        const b = size & 0x7f;
        size >>= 7;
        headBytes.push(size > 0 ? b | 0x80 : b);
      }
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- advertisements

/** The refs a repository advertises, sorted, with HEAD first in the returned list. */
function advertisedRefs(repo: RepoRec): Array<{ name: string; sha: string }> {
  const refs = [...repo.refs.entries()].map(([name, sha]) => ({ name, sha }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled target of a ref that names an annotated tag, or null. */
function peeledOf(sha: string): string | null {
  const obj = readObject(sha);
  if (obj === undefined || obj.type !== 'tag') return null;
  const tag = parseTag(obj.data);
  return tag === null ? null : tag.object;
}

export interface HttpResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function textResult(status: number, contentType: string, body: Buffer): HttpResult {
  return { status, contentType, body };
}

/** GET /info/refs for either service. */
export function advertise(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): HttpResult {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
    return textResult(200, contentType, Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]));
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_SHA} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headSha !== undefined) {
      parts.push(pktLine(`${headSha} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pktLine(first ? `${ref.sha} ${ref.name}\0${caps}\n` : `${ref.sha} ${ref.name}\n`));
      first = false;
      const peeled = peeledOf(ref.sha);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return textResult(200, contentType, Buffer.concat(parts));
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** One ls-refs answer line set for the repository, honoring ref-prefix filtering server-side. */
export function lsRefs(repo: RepoRec, args: LsRefsArgs): HttpResult {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      lines.push(args.symrefs ? `${headSha} HEAD symref-target:${headTarget}` : `${headSha} HEAD`);
    } else if (args.unborn) {
      lines.push(args.symrefs ? `unborn HEAD symref-target:${headTarget}` : 'unborn HEAD');
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOf(ref.sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  return textResult(200, 'application/x-git-upload-pack-result', body);
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

interface FetchPlan {
  /** Object shas to pack, in send order. */
  objects: string[];
  shallow: string[];
  unshallow: string[];
  /** Haves that are ancestors of (or equal to) some want: the common commits to ACK. */
  common: string[];
}

/** Every tree and blob sha under a commit's tree (the commit's full file closure). */
function treeClosureOf(commitSha: string, into: Set<string>): void {
  const commit = readCommit(commitSha);
  if (commit === null) return;
  const walk = (treeSha: string): void => {
    if (into.has(treeSha)) return;
    const entries = readTree(treeSha);
    if (entries === null) return;
    into.add(treeSha);
    for (const entry of entries) {
      if (entry.mode === '40000') walk(entry.sha);
      else into.add(entry.sha);
    }
  };
  walk(commit.tree);
}

/** Plan which objects a fetch sends, and the shallow bookkeeping that goes with them. */
function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const wantCommits = new Set<string>();
  const extraRoots: string[] = [];
  for (const want of request.wants) {
    const obj = readObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit') wantCommits.add(want);
    else if (obj.type === 'tag') {
      extraRoots.push(want);
      const peeled = peelToCommit(want);
      if (peeled !== null) wantCommits.add(peeled);
    } else {
      extraRoots.push(want);
    }
  }

  // What the client already holds: closures of its haves, never descending past its shallow
  // boundary (a boundary commit is held, its parents are not).
  const boundary = new Set(request.clientShallow);
  const haveCommits = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of request.haves) {
      const peeled = peelToCommit(have) ?? (readCommit(have) !== null ? have : null);
      if (peeled !== null && !haveCommits.has(peeled)) {
        haveCommits.add(peeled);
        queue.push(peeled);
      }
    }
    while (queue.length > 0) {
      const sha = queue.pop()!;
      if (boundary.has(sha)) continue;
      const commit = readCommit(sha);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!haveCommits.has(parent)) {
          haveCommits.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  for (const not of request.deepenNot) {
    const peeled = peelToCommit(not) ?? not;
    for (const sha of commitDistances(peeled).keys()) haveCommits.add(sha);
  }

  // Distances from the wants (shortest path over the union of all want histories). A depth fetch
  // only ever reasons `depth` generations out, so the walk stops there — a depth-1 clone of a
  // 200-commit repository must not pay for the whole history.
  const dist = new Map<string, number>();
  const distLimit = request.depth !== null ? request.depth : Number.POSITIVE_INFINITY;
  for (const want of wantCommits) {
    for (const [sha, d] of commitDistancesUpTo(want, distLimit)) {
      const known = dist.get(sha);
      if (known === undefined || d < known) dist.set(sha, d);
    }
  }

  const sendCommits = new Set<string>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const depthLimited = request.depth !== null || request.deepenSince !== null;

  if (request.depth !== null) {
    // `deepen N` is an absolute depth from the wants: everything nearer than N generations,
    // minus what the client already holds. This covers fresh shallow clones, deepens of an
    // existing shallow clone, and shallow fetches of a moved tip uniformly.
    for (const [sha, d] of dist) {
      if (d < request.depth && !haveCommits.has(sha)) sendCommits.add(sha);
    }
  } else if (request.deepenSince !== null) {
    const since = request.deepenSince;
    for (const sha of dist.keys()) {
      const commit = readCommit(sha);
      if (commit === null) continue;
      const epoch = Number(/ (\d+) [+-]\d{4}$/.exec(commit.committer)?.[1] ?? 0);
      if (epoch >= since && !haveCommits.has(sha)) sendCommits.add(sha);
    }
  } else {
    // A full fetch: everything the client lacks, but never the history below its shallow
    // boundary (that stays un-fetched by definition of the boundary).
    const belowBoundary = new Set<string>();
    for (const edge of boundary) {
      for (const sha of commitDistances(edge).keys()) if (sha !== edge) belowBoundary.add(sha);
    }
    for (const sha of dist.keys()) {
      if (!haveCommits.has(sha) && !belowBoundary.has(sha)) sendCommits.add(sha);
    }
  }

  if (depthLimited) {
    // The client's resulting history: what it held, its boundary, and what it is being sent.
    // The new boundary is the set of held commits whose parents stay outside it.
    const resulting = new Set<string>([...haveCommits, ...sendCommits]);
    for (const edge of boundary) if (dist.has(edge)) resulting.add(edge);
    const finalBoundary = new Set<string>();
    for (const sha of resulting) {
      const commit = readCommit(sha);
      if (commit === null) continue;
      if (commit.parents.some((parent) => !resulting.has(parent) && readCommit(parent) !== null)) finalBoundary.add(sha);
    }
    for (const sha of sendCommits) if (finalBoundary.has(sha)) shallow.add(sha);
    for (const edge of boundary) {
      if (resulting.has(edge) && !finalBoundary.has(edge)) unshallow.add(edge);
    }
  }

  // Object set: the send commits, their trees and blobs, minus everything the client already has.
  const excluded = new Set<string>();
  for (const sha of haveCommits) treeClosureOf(sha, excluded);

  const objects: string[] = [];
  const seen = new Set<string>();
  const pushObj = (sha: string): void => {
    if (seen.has(sha) || excluded.has(sha)) return;
    if (readObject(sha) === undefined) return;
    seen.add(sha);
    objects.push(sha);
  };
  const orderedCommits = [...sendCommits].sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0));
  for (const sha of orderedCommits) pushObj(sha);
  for (const root of extraRoots) {
    pushObj(root);
    const obj = readObject(root);
    if (obj !== undefined && obj.type === 'tree') {
      const closure = new Set<string>();
      const walk = (treeSha: string): void => {
        if (closure.has(treeSha)) return;
        const entries = readTree(treeSha);
        if (entries === null) return;
        closure.add(treeSha);
        for (const entry of entries) {
          if (entry.mode === '40000') walk(entry.sha);
          else closure.add(entry.sha);
        }
      };
      walk(root);
      for (const sha of closure) pushObj(sha);
    }
  }
  const treesAndBlobs = new Set<string>();
  for (const sha of sendCommits) treeClosureOf(sha, treesAndBlobs);
  for (const sha of treesAndBlobs) pushObj(sha);

  const common = request.haves.filter((have) => {
    const peeled = peelToCommit(have) ?? have;
    return dist.has(peeled);
  });

  return { objects, shallow: [...shallow], unshallow: [...unshallow], common };
}

/** Wrap pack bytes in sideband-64k pkt-lines (band 1), as the fetch answer's packfile section. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

/** A protocol v2 fetch answer. */
function fetchV2(repo: RepoRec, request: FetchRequest): HttpResult {
  const plan = planFetch(repo, request);
  const sections: Buffer[][] = [];
  if (!request.done) {
    const acks: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.common.length > 0) for (const sha of plan.common) acks.push(pktLine(`ACK ${sha}\n`));
    else acks.push(pktLine('NAK\n'));
    sections.push(acks);
    const body = Buffer.concat([...sections.flat(), PKT_FLUSH]);
    return textResult(200, 'application/x-git-upload-pack-result', body);
  }
  if (request.haves.length > 0) {
    const acks: Buffer[] = [pktLine('acknowledgments\n')];
    if (plan.common.length > 0) for (const sha of plan.common) acks.push(pktLine(`ACK ${sha}\n`));
    else acks.push(pktLine('NAK\n'));
    sections.push(acks);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const info: Buffer[] = [pktLine('shallow-info\n')];
    for (const sha of plan.shallow) info.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) info.push(pktLine(`unshallow ${sha}\n`));
    sections.push(info);
  }
  const pack = buildPack(plan.objects);
  sections.push([pktLine('packfile\n'), ...sidebandPackets(pack)]);
  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push(PKT_DELIM);
    parts.push(...section);
  });
  parts.push(PKT_FLUSH);
  return textResult(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** A protocol v0 fetch answer (the fallback for clients that do not speak v2). */
function fetchV0(repo: RepoRec, request: FetchRequest, caps: ReadonlySet<string>): HttpResult {
  const plan = planFetch(repo, request);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.common.length > 0) parts.push(pktLine(`ACK ${plan.common[plan.common.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  if (caps.has('side-band-64k')) {
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pack);
  }
  return textResult(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** Parse a v2 command request (ls-refs or fetch) out of a POST body. Throws on malformed framing. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const reader = new PktReader(body);
  let command = '';
  const args: string[] = [];
  let inArgs = false;
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind === 'delim') {
      inArgs = true;
      continue;
    }
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // capability lines (agent=, object-format=) are accepted and ignored
    } else {
      args.push(line);
    }
  }
  if (command === '') throw new Error('v2 request has no command');
  return { command, args };
}

/** Parse a v0 upload-pack request body. Throws on malformed framing. */
function parseV0FetchRequest(body: Buffer): { request: FetchRequest; caps: ReadonlySet<string> } {
  const reader = new PktReader(body);
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  const caps = new Set<string>();
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') caps.add(cap);
      line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') request.done = true;
  }
  return { request, caps };
}

/** POST /git-upload-pack. Throws on malformed framing (the caller answers 400). */
export function uploadPack(repo: RepoRec, body: Buffer, protocolV2: boolean): HttpResult {
  if (protocolV2) {
    const { command, args } = parseV2Request(body);
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const arg of args) {
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return lsRefs(repo, lsArgs);
    }
    if (command === 'fetch') {
      const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) request.clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7));
        else if (arg.startsWith('deepen-since ')) request.deepenSince = Number(arg.slice(13));
        else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
        else if (arg === 'done') request.done = true;
        // thin-pack / no-progress / ofs-delta / filter: accepted; the pack is always self-contained
      }
      return fetchV2(repo, request);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  const { request, caps } = parseV0FetchRequest(body);
  return fetchV0(repo, request, caps);
}

// ---------------------------------------------------------------- receive-pack (v0)

interface RefUpdate {
  readonly oldSha: string;
  readonly newSha: string;
  readonly ref: string;
}

/** Whether moving `ref` from old to new is allowed: creation, deletion, or a fast-forward. */
function updateAllowed(repo: RepoRec, update: RefUpdate): boolean {
  if (update.newSha === update.oldSha) return true;
  if (update.oldSha === ZERO_SHA) return true; // creation
  if (update.newSha === ZERO_SHA) return true; // deletion
  const current = repo.refs.get(update.ref);
  if (current !== update.oldSha) return false;
  if (update.ref.startsWith('refs/tags/')) return true; // tags may be re-pointed
  const newCommit = peelToCommit(update.newSha);
  const oldCommit = peelToCommit(update.oldSha);
  if (newCommit === null || oldCommit === null) return false;
  return isAncestor(oldCommit, newCommit);
}

/** POST /git-receive-pack. Throws on malformed framing (the caller answers 400). */
export function receivePack(repo: RepoRec, body: Buffer): HttpResult {
  const reader = new PktReader(body);
  const updates: RefUpdate[] = [];
  const caps = new Set<string>();
  for (let pkt = reader.next(); pkt !== null; pkt = reader.next()) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      for (const cap of line.slice(nul + 1).split(' ')) if (cap !== '') caps.add(cap);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !/^[0-9a-f]{40}$/.test(parts[0]!) || !/^[0-9a-f]{40}$/.test(parts[1]!)) {
      throw new Error('malformed receive-pack command');
    }
    updates.push({ oldSha: parts[0]!, newSha: parts[1]!, ref: parts[2]! });
  }
  const packBytes = reader.rest();

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      ingestPack(packBytes);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const update of updates) {
    if (unpackError !== null) {
      results.push({ ref: update.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (!update.ref.startsWith('refs/heads/') && !update.ref.startsWith('refs/tags/')) {
      results.push({ ref: update.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    if (!updateAllowed(repo, update)) {
      results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (update.newSha === ZERO_SHA) repo.refs.delete(update.ref);
    else repo.refs.set(update.ref, update.newSha);
    results.push({ ref: update.ref, ok: true });
  }

  if (!caps.has('report-status')) {
    return textResult(200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
  }
  const reportLines: string[] = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'error'}\n`);
  }
  const inner = Buffer.concat(reportLines.map((line) => pktLine(line)));
  if (caps.has('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, Math.min(inner.length, offset + CHUNK))])));
    }
    packets.push(PKT_FLUSH);
    return textResult(200, 'application/x-git-receive-pack-result', Buffer.concat(packets));
  }
  return textResult(200, 'application/x-git-receive-pack-result', Buffer.concat([inner, PKT_FLUSH]));
}
