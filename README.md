# forge-entry — a GitHub-compatible git forge

A standalone, single-process git forge for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). One Node 22 process serves
four surfaces from its own in-memory store — no UI, no database, no git binary, no outside
service:

| Surface | Where |
| --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` — upload-pack protocol v2 (advertisement, ls-refs, fetch with shallow/deepen), receive-pack v0 (push with fast-forward enforcement and report-status) |
| REST v3 | `/api/v3` — repositories, branches, commits, contents, labels, issues, comments, pull requests with squash/merge merges |
| GraphQL v4 | `/api/graphql` — viewer, repository, issue/pull-request connections, `node()`, the mutations, and `__type` introspection |
| MCP | `/mcp` — JSON-RPC 2.0 (2026-07-28 `server/discover` plus the legacy initialize handshake) with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |

Packfiles are read and written by hand (ofs/ref deltas resolved in-process), objects live in a
SHA-1 content-addressed store, and every timestamp comes from a logical clock so runs are
deterministic.

## Run it

```sh
node --experimental-strip-types main.ts
```

The harness contract (see `main.ts`, kept from the kit starter): bind an ephemeral port, POST
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, then poll `$MAKEFUN_ENV_URL/done` and exit 0 when
the suite is finished. Requests carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; repositories
belong to the token's login.

## Layout

- `main.ts` — the entry ↔ env lifecycle (from the kit starter, unchanged).
- `app.ts` — HTTP routing, auth, and the JSON wire discipline.
- `store.ts` — the in-memory data model and the git object store.
- `git.ts` — pkt-lines, packfiles, and the smart-HTTP protocol.
- `rest.ts` — the REST v3 resources.
- `graphql.ts` — a small GraphQL parser/executor for the v4 documents.
- `mcp.ts` — the MCP endpoint and its six tools.

MIT licensed (see `LICENSE`).
