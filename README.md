# forge-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sinker234/forge-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sinker234/forge-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge written in TypeScript: one Node 22
process serves git smart HTTP, REST v3, GraphQL v4, and MCP from its own in-memory store —
no UI, no database, no git binary, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

## Surfaces

| Surface | Where |
| --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` — upload-pack protocol v2 (advertisement, ls-refs, fetch with shallow/deepen), receive-pack v0 (push with fast-forward enforcement and report-status) |
| REST v3 | `/api/v3` — repositories, branches, commits, contents, labels, issues, comments, pull requests with squash/merge merges |
| GraphQL v4 | `/api/graphql` — viewer, repository, issue/pull-request connections, `node()`, the mutations, and `__type` introspection |
| MCP | `/mcp` — JSON-RPC 2.0 (2026-07-28 `server/discover` plus the legacy initialize handshake) with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |

Packfiles are read and written by hand (ofs/ref deltas resolved in-process), objects live in a
SHA-1 content-addressed store, and every timestamp comes from a logical clock so runs are
deterministic.

## Harness contract

The harness contract (see `main.ts`): bind an ephemeral port, POST
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then poll `$MAKEFUN_ENV_URL/done` and exit 0 when
the suite is finished. Requests carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; repositories
belong to the token's login.

## Layout

- `main.ts` — the entry ↔ env lifecycle.
- `app.ts` — HTTP routing, auth, and the JSON wire discipline.
- `store.ts` — the in-memory data model and the git object store.
- `git.ts` — pkt-lines, packfiles, and the smart-HTTP protocol.
- `rest.ts` — the REST v3 resources.
- `graphql.ts` — a small GraphQL parser/executor for the v4 documents.
- `mcp.ts` — the MCP endpoint and its six tools.

MIT licensed (see `LICENSE`).

<sub>Entered on [make.fun](https://make.fun/?ref=c5a4h2ax&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>