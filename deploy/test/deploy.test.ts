import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${deploy}${path}`, 'utf8');

const templates = ['templates/eventindex.env', 'templates/nginx-http.conf', 'templates/nginx-tls.conf', 'templates/litestream.yml',
  ...readdirSync(`${deploy}templates/systemd`).map((f) => `templates/systemd/${f}`)];
const scripts = ['lib.sh', 'setup.sh', 'restore.sh', 'relay-export.sh', 'upgrade.sh', ...readdirSync(`${deploy}steps`).map((f) => `steps/${f}`)];

function config(): Record<string, string> {
  return Object.fromEntries(read('config.example.env').split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

const templateVars = [...read('lib.sh').matchAll(/^TEMPLATE_VARS='([^']*)'/gm)][0]![1]!.match(/[A-Z_]+/g)!;
const libVars = ['SERVICE_USER', 'APP_DIR', 'DATA_DIR', 'RELAY_DB_DIR', 'SITE_DIR', 'ACME_DIR', 'ETC'];
// Left for Litestream to expand from the bucket keys at start.
const runtimeVars = ['BUCKET_ACCESS_KEY_ID', 'BUCKET_SECRET_ACCESS_KEY'];

test('every template variable is rendered, and every rendered variable is configured', () => {
  const settings = config();
  for (const path of templates) {
    for (const [, name] of read(path).matchAll(/\$\{([A-Z_]+)\}/g)) {
      assert.ok(templateVars.includes(name!) || runtimeVars.includes(name!), `${path} uses \${${name}} that is not rendered`);
    }
  }
  for (const name of templateVars) {
    assert.ok(libVars.includes(name) || name in settings, `\${${name}} is neither in lib.sh nor in config.example.env`);
  }
});

test('rendering keeps nginx\'s own variables and leaves only the bucket keys unexpanded', { skip: spawnSync('envsubst', ['--version']).status !== 0 && 'envsubst is not installed' }, () => {
  const env = { PATH: process.env['PATH'] ?? '', ...config(), SERVICE_USER: 'eventindex', APP_DIR: '/opt/eventindex/app', DATA_DIR: '/var/lib/eventindex', RELAY_DB_DIR: '/var/lib/strfry/db', SITE_DIR: '/var/www/eventindex', ACME_DIR: '/var/www/letsencrypt', ETC: '/etc/eventindex' };
  const list = templateVars.map((v) => `\${${v}}`).join(' ');
  for (const path of templates) {
    const out = spawnSync('envsubst', [list], { input: read(path), env, encoding: 'utf8' }).stdout;
    const left = [...out.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
    assert.deepEqual(left.filter((v) => !runtimeVars.includes(v!)), [], path);
    if (path.includes('nginx')) assert.ok(out.includes('$host') && !out.includes('${DOMAIN}'), path);
  }
});

test('every script parses and stops on the first error', () => {
  for (const path of scripts) {
    const check = spawnSync('bash', ['-n', `${deploy}${path}`], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${path}: ${check.stderr}`);
  }
  assert.match(read('lib.sh'), /^set -euo pipefail$/m);
  for (const path of ['setup.sh', 'restore.sh', 'relay-export.sh', 'upgrade.sh']) {
    assert.match(read(path), /^#!\/usr\/bin\/env bash\n/, path);
    assert.match(read(path), /^\. "\$\(dirname "\$0"\)\/lib\.sh"$/m, path);
  }
});

test('the example configuration holds no secret and no address', () => {
  const text = read('config.example.env');
  assert.doesNotMatch(text, /nsec1|ncryptsec1|SECRET_ACCESS_KEY=|ACCESS_KEY_ID=/);
  const addresses = (text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? []).filter((ip) => ip !== '127.0.0.1');
  assert.deepEqual(addresses, []);
  for (const [name, value] of Object.entries(config())) {
    if (/SHA256|COMMIT/.test(name)) assert.match(value, /^[0-9a-f]{40,64}$/, name);
  }
});

test('the relay is proxied as a WebSocket with the client address', () => {
  const relay = read('templates/nginx-tls.conf').split('server {').find((block) => block.includes('server_name ${RELAY_HOST};'))!;
  for (const line of ['proxy_http_version 1.1;', 'proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection $connection_upgrade;', 'proxy_set_header X-Real-IP $remote_addr;']) {
    assert.ok(relay.includes(line), line);
  }
});

test('strfry listens where nginx proxies, keeps its data where the setup makes it, and reads the real-IP header', () => {
  const conf = readFileSync(`${repo}relay/strfry.conf`, 'utf8');
  assert.match(conf, /^\s*db = "\/var\/lib\/strfry\/db\/"$/m);
  assert.match(read('lib.sh'), /^RELAY_DB_DIR=\/var\/lib\/strfry\/db$/m);
  assert.equal(/^\s*port = (\d+)$/m.exec(conf)![1], config()['RELAY_PORT']);
  assert.match(conf, /realIpHeader = "x-real-ip"/);
});

test('every service runs as the service user, sandboxed', () => {
  for (const unit of ['strfry.service', 'eventindex-indexer.service', 'eventindex-api.service', 'eventindex-relay-export.service']) {
    const text = read(`templates/systemd/${unit}`);
    assert.match(text, /^User=\$\{SERVICE_USER\}$/m, unit);
    assert.match(text, /^ProtectSystem=strict$/m, unit);
    assert.match(text, /^NoNewPrivileges=yes$/m, unit);
  }
});
