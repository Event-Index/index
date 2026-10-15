import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('../../', import.meta.url).pathname;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

test('main.ts serves on its port without any key, and stops cleanly on SIGTERM', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'api-main-'));
  const port = await freePort();
  try {
    const env = { ...process.env, EVENTINDEX_DATA_DIR: dataDir, EVENTINDEX_API_PORT: String(port), EVENTINDEX_INDEX_KEY_FILE: '/nonexistent/key', EVENTINDEX_CALENDAR_SECRET_FILE: '/nonexistent/secret' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'api/src/main.ts'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (chunk) => { out += chunk; });
    child.stderr!.on('data', (chunk) => { out += chunk; });
    for (let i = 0; i < 200 && !/api listening/.test(out); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, new RegExp(`api listening on 127.0.0.1:${port}`));
    const stats = await (await fetch(`http://127.0.0.1:${port}/api/1.0/stats`)).json() as { calendars: number };
    assert.equal(stats.calendars, 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, out);
    assert.match(out, /stopped/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
