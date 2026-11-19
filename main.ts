// main.ts — the entrypoint, and the only file that owns the process lifecycle.
// The forge itself (git smart HTTP, REST v3, GraphQL and MCP over one store)
// is built by createApp() in app.ts; this file binds its port, tells the suite
// where the forge can be reached, and stays alive until the suite says it is
// finished, then exits 0.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

/** Pause between two polls of the suite, and between two register attempts. */
const POLL_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The suite's base URL with any trailing slashes removed, or '' when
 * MAKEFUN_ENV_URL is not set (a local run with nobody to report to).
 */
function suiteBaseUrl(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/**
 * POST {"port": port} to the suite's /register until it accepts. The suite
 * records the address the request came from and dials it back on this port,
 * so the forge must already be listening before the first attempt. A failed
 * attempt only means the suite is still coming up: wait, then try again.
 */
async function registerPort(base: string, port: number): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await reply.text();
      if (reply.ok) return;
    } catch {
      // Not up yet, or the connection dropped: fall through and retry.
    }
    await sleep(POLL_DELAY_MS);
  }
}

/** Ask the suite once whether it has finished driving the forge. */
async function suiteIsDone(base: string): Promise<boolean> {
  const reply = await fetch(`${base}/done`);
  if (!reply.ok) {
    // Drain the body so the connection is released, then treat the answer
    // as "not done": a bad poll is retried like any other.
    await reply.text().catch(() => '');
    return false;
  }
  const body: unknown = await reply.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return false;
  return (body as { done?: unknown }).done === true;
}

/**
 * Long-poll /done until the suite answers {"done": true}. A poll that fails
 * or answers something unreadable is never a reason to give up: the forge
 * keeps serving and asks again after a short pause.
 */
async function waitUntilDone(base: string): Promise<void> {
  for (;;) {
    try {
      if (await suiteIsDone(base)) return;
    } catch {
      // A dropped poll changes nothing; keep waiting.
    }
    await sleep(POLL_DELAY_MS);
  }
}

async function run(): Promise<void> {
  const server: Server = createApp();

  // Port 0 lets the kernel pick an ephemeral port, so the forge never lands
  // on 8080, where the suite itself listens.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }

  const base = suiteBaseUrl();
  if (base === '') {
    // Nobody to register with: serve until the process is stopped.
    await new Promise<void>(() => {});
    return;
  }

  await registerPort(base, address.port);
  await waitUntilDone(base);

  server.close();
  server.closeAllConnections();
}

run().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
