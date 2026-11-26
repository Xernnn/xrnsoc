/* npm run release, offline: the signed .crx that scripts/crx.mjs writes, read
 * back (CRX3 header, signature, the zip inside with update_url in its
 * manifest), the update manifest, and what stops scripts/release.mjs before
 * it signs or sends anything: no config, no key (never made without
 * --new-key), a branch other than main. Run with `npm test`. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawnSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let failures = 0;
let checks = 0;
function ok(label, condition, detail) {
  checks++;
  if (condition) console.log('  ✓ ' + label);
  else {
    failures++;
    console.log('  ✗ ' + label + (detail ? '  — ' + detail : ''));
  }
}

/* Every entry of a zip: { name: bytes }. */
function unzip(buf) {
  const out = {};
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0, n = buf.readUInt16LE(end + 10); i < n; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    at += 46 + nameLen + extra;
  }
  return out;
}

/* Protobuf fields, all length-delimited here: [[number, bytes]]. */
function fields(buf) {
  const out = [];
  for (let at = 0; at < buf.length;) {
    let key = 0, shift = 0, b;
    do { b = buf[at++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    let len = 0; shift = 0;
    do { b = buf[at++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out.push([key >> 3, buf.subarray(at, at + len)]);
    at += len;
  }
  return out;
}

(async () => {
  const crx = await import(path.join(root, 'scripts/crx.mjs'));
  const guard = await import(path.join(root, 'scripts/release-guard.mjs'));

  console.log('\nthe .crx');
  {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const files = crx.withUpdateUrl(crx.packageFiles(root), 'https://server.example/ext/update/xrnsoc.xml');
    const file = crx.crx3(crx.zip(files), privateKey);
    ok('starts Cr24, format 3', file.toString('latin1', 0, 4) === 'Cr24' && file.readUInt32LE(4) === 3);
    const headerLen = file.readUInt32LE(8);
    const header = fields(file.subarray(12, 12 + headerLen));
    const archive = file.subarray(12 + headerLen);
    const proof = fields(header.find(([n]) => n === 2)[1]);
    const publicKey = proof.find(([n]) => n === 1)[1];
    const signature = proof.find(([n]) => n === 2)[1];
    const signedData = header.find(([n]) => n === 10000)[1];
    const len = Buffer.alloc(4);
    len.writeUInt32LE(signedData.length);
    const verify = crypto.createVerify('sha256');
    verify.update(Buffer.concat([crx.CRX3_SIGNED_PREFIX, len, signedData, archive]));
    const key = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    ok('its signature checks out against the key it carries', verify.verify(key, signature));
    const id = [...crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('hex')]
      .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    ok('its ID is the one the key makes', id === crx.extensionId(privateKey), id);
    const entries = unzip(archive);
    const manifest = JSON.parse(entries['manifest.json']);
    ok('the manifest inside names the update manifest', manifest.update_url === 'https://server.example/ext/update/xrnsoc.xml', manifest.update_url);
    const shipped = Object.keys(entries);
    ok('it holds the worker, the content scripts, the popup, the icons and the font',
      ['src/background/service-worker.js', 'src/content/engine.js', 'src/popup/popup.html', 'icons/icon128.png'].every(f => shipped.includes(f)) &&
      shipped.some(f => f.startsWith('fonts/')), shipped.slice(0, 8).join(', '));
    ok('and nothing else: no tests, scripts or docs', !shipped.some(f => /^(test|scripts|docs|node_modules)\//.test(f)));
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    ok('the repo\'s manifest keeps no update_url', !('update_url' in onDisk));
    const xml = crx.updateManifest({ id, version: '2.3.0', codebase: 'https://server.example/ext/update/xrnsoc-2.3.0.crx', crx: file });
    ok('the update manifest names the ID, the version, the file and its hash',
      guard.appIdOf(xml) === id && xml.includes("version='2.3.0'") && xml.includes('xrnsoc-2.3.0.crx') &&
      xml.includes(crypto.createHash('sha256').update(file).digest('hex')));
  }

  console.log('\nwhat stops a release');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xrnsoc-release-'));
    const env = { ...process.env, XRNSOC_CONFIG: home, XRNSOC_DIST: path.join(home, 'dist') };
    const run = (...args) => spawnSync('node', [path.join(root, 'scripts/release.mjs'), '--force', ...args], { env, encoding: 'utf8' });
    let r = run();
    ok('no release.json: it stops and says what to write', r.status === 1 && /release\.json/.test(r.stderr), r.stderr);
    fs.mkdirSync(path.join(home, 'xrnsoc'));
    fs.writeFileSync(path.join(home, 'xrnsoc', 'release.json'), JSON.stringify({ server: 'https://server.example/ext', ssh: 'nowhere', dir: '../x' }));
    r = run();
    ok('a data folder that climbs out is refused', r.status === 1 && /"dir"/.test(r.stderr), r.stderr);
    fs.writeFileSync(path.join(home, 'xrnsoc', 'release.json'), JSON.stringify({ server: 'https://server.example/ext', ssh: 'nowhere', dir: 'some-sync/data' }));
    r = run();
    ok('no signing key: it stops, and makes none', r.status === 1 && /Restore it from the key backup/.test(r.stderr) &&
      !fs.existsSync(path.join(home, 'xrnsoc', 'xrnsoc.pem')), r.stderr);
    fs.rmSync(home, { recursive: true, force: true });

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'xrnsoc-guard-'));
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { stdio: 'pipe' });
    git('init', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(repo, 'a'), 'a');
    git('add', 'a');
    git('commit', '-qm', 'a');
    ok('a branch other than main is refused', guard.treeRefusals(repo).some(m => /not main/.test(m)), guard.treeRefusals(repo).join());
    git('checkout', '-qb', 'main');
    fs.writeFileSync(path.join(repo, 'b'), 'b');
    ok('so is a file not committed', guard.treeRefusals(repo).some(m => /not committed/.test(m)));
    fs.rmSync(path.join(repo, 'b'));
    ok('main with everything committed goes', guard.treeRefusals(repo).length === 0, guard.treeRefusals(repo).join());
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : checks + ' checks passed'));
  process.exit(failures ? 1 : 0);
})();
