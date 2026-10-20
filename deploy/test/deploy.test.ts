import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deploy = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${deploy}${path}`, 'utf8');

const templates = ['templates/eventindex.env', 'templates/eventindex-admin', 'templates/nginx-http.conf', 'templates/nginx-tls.conf', 'templates/litestream.yml',
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

test('every unit that runs strfry allows the open files strfry.conf asks for', () => {
  // strfry raises its own limit to nofiles on every command, not only the
  // relay, and stops if the unit's hard limit is lower (systemd's default is 524288).
  const nofiles = Number(/^\s*nofiles = (\d+)$/m.exec(readFileSync(`${repo}relay/strfry.conf`, 'utf8'))![1]);
  const units = readdirSync(`${deploy}templates/systemd`).filter((unit) => {
    const exec = /^ExecStart=(\S+)/m.exec(read(`templates/systemd/${unit}`))?.[1] ?? '';
    const script = exec.startsWith('${APP_DIR}/deploy/') ? read(exec.slice('${APP_DIR}/deploy/'.length)) : '';
    return /\/usr\/local\/bin\/strfry\b/.test(`${exec}\n${script}`);
  });
  assert.deepEqual(units.sort(), ['eventindex-relay-export.service', 'strfry.service']);
  for (const unit of units) {
    const limit = /^LimitNOFILE=(\d+)$/m.exec(read(`templates/systemd/${unit}`))?.[1];
    assert.ok(Number(limit) >= nofiles, `${unit}: LimitNOFILE=${limit ?? '(systemd default)'} is below strfry's nofiles = ${nofiles}`);
  }
});

test('rclone writes to the bucket without checking or creating it', () => {
  // A key scoped to one bucket may not create buckets; rclone tries to before
  // its first write unless told not to, and the write then fails with 403.
  const remotes = scripts.filter((path) => /RCLONE_CONFIG_BUCKET_TYPE=s3/.test(read(path)));
  assert.deepEqual(remotes.sort(), ['relay-export.sh', 'restore.sh']);
  for (const path of remotes) assert.match(read(path), /RCLONE_CONFIG_BUCKET_NO_CHECK_BUCKET=true/, path);
});

test('the API cannot read the secrets, and the indexer has time to finish its poll on stop', () => {
  const api = read('templates/systemd/eventindex-api.service');
  assert.match(api, /^InaccessiblePaths=\$\{ETC\}$/m);
  assert.doesNotMatch(api, /^ReadOnlyPaths=\$\{ETC\}$/m);
  assert.match(read('templates/systemd/eventindex-indexer.service'), /^TimeoutStopSec=\d+$/m);
});

test('the main domain is served by the API, with a static page while it is down', () => {
  const main = read('templates/nginx-tls.conf').split('server {').find((block) => block.includes('server_name ${DOMAIN};'))!;
  assert.match(main, /location \/ \{[^}]*proxy_pass http:\/\/127\.0\.0\.1:\$\{API_PORT\};[^}]*proxy_set_header X-Real-IP \$remote_addr;[^}]*error_page 502 503 504 \/offline\.html;/s);
  assert.match(main, /location = \/offline\.html \{\s*internal;\s*\}/);
  assert.match(read('steps/services.sh'), /site\/offline\.html/);
  const page = read('site/offline.html');
  assert.doesNotMatch(page, /<script|<img|https?:\/\/[^"]*\.(js|css)/i);
});

test('the admin command runs as the service user with the services\' settings', () => {
  const admin = read('templates/eventindex-admin');
  assert.match(admin, /^\. \$\{ETC\}\/eventindex\.env$/m);
  assert.match(admin, /runuser -u \$\{SERVICE_USER\} -- \/usr\/local\/bin\/node .*indexer\/src\/admin\.ts "\$@"$/m);
  assert.equal(spawnSync('sh', ['-n', `${deploy}templates/eventindex-admin`]).status, 0);
});

test('nginx logs no visitor address: every server block uses a format without one', () => {
  const http = read('templates/nginx-http.conf');
  const formats = [...http.matchAll(/log_format\s+eventindex\s+([^;]+);/g)];
  assert.equal(formats.length, 1, 'one eventindex log format, in the port-80 file nginx always loads');
  assert.doesNotMatch(formats[0]![1]!, /remote_addr|remote_user|x_forwarded_for|x_real_ip|realip|http_referer/);
  for (const path of ['templates/nginx-http.conf', 'templates/nginx-tls.conf']) {
    const blocks = read(path).split(/^server \{/m).slice(1);
    assert.ok(blocks.length > 0, path);
    for (const block of blocks) assert.match(block, /^\s*access_log \/var\/log\/nginx\/access\.log eventindex;$/m, `${path}: ${block.slice(0, 80)}`);
    assert.doesNotMatch(read(path), /access_log(?![^;]*\beventindex;)[^;]*;/, `${path}: an access_log with another format`);
  }
});

test('strfry runs the write policy from the checked-out code, with the allowlist the indexer writes', () => {
  const conf = readFileSync(`${repo}relay/strfry.conf`, 'utf8');
  const appDir = /^APP_DIR=(.+)$/m.exec(read('lib.sh'))![1]!;
  assert.equal(/^\s*plugin = "([^"]*)"$/m.exec(conf)![1], `${appDir}/relay/write-policy`);
  assert.equal(spawnSync('git', ['-C', repo, 'ls-files', '-s', 'relay/write-policy'], { encoding: 'utf8' }).stdout.split(' ')[0], '100755', 'the plugin is executable in git');
  const unit = read('templates/systemd/strfry.service');
  assert.match(unit, /^Environment=EVENTINDEX_RELAY_ALLOWLIST=\$\{DATA_DIR\}\/relay-allowlist\.json$/m);
  assert.match(unit, /^Environment=EVENTINDEX_RELAY_URL=ws:\/\/127\.0\.0\.1:\$\{RELAY_PORT\}$/m);
  assert.match(read('templates/eventindex.env'), /^EVENTINDEX_RELAY_ALLOWLIST=\$\{DATA_DIR\}\/relay-allowlist\.json$/m);
  const services = read('steps/services.sh');
  assert.match(services, /install -m 644 "\$APP_DIR\/relay\/strfry\.conf" \/etc\/strfry\.conf/);
  assert.match(services, /systemctl restart strfry\.service/);
});

test('the index relay takes events of 512 KB, so its own limit is never the tightest', () => {
  const conf = readFileSync(`${repo}relay/strfry.conf`, 'utf8');
  const value = (name: string) => Number(new RegExp(`^\\s*${name} = (\\d+)$`, 'm').exec(conf)![1]);
  assert.equal(value('maxEventSize'), 524288);
  assert.ok(value('maxWebsocketPayloadSize') > value('maxEventSize'), 'a frame holds the largest event and its envelope');
  assert.ok(value('maxNumTags') >= 2000);
});

test('the signer secret is made on any setup when missing, and nothing in deploy/ speaks of calendar keys', () => {
  const secrets = read('steps/secrets.sh');
  const signer = /signer="\$ETC\/signer\.secret"\nif \[ ! -s "\$signer" \]; then\n([\s\S]*?)\nfi/.exec(secrets);
  assert.ok(signer, 'secrets.sh makes signer.secret');
  assert.doesNotMatch(signer[1]!, /mode|first|die/, 'on any setup, without condition');
  assert.match(signer[1]!, /openssl rand -hex 32 >"\$signer"/);
  const files = (dir: string): string[] => readdirSync(`${deploy}${dir}`, { withFileTypes: true })
    .flatMap((f) => (f.isDirectory() ? (f.name === 'test' ? [] : files(`${dir}${f.name}/`)) : [`${dir}${f.name}`]));
  for (const path of files('')) assert.doesNotMatch(read(path), /calendar[- _]?keys?|CALENDAR_KEY/i, path);
});
