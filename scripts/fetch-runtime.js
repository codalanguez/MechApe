/**
 * fetch-runtime.js — put the llama.cpp runtime *inside* the installer.
 *
 * Runs at build time (from `npm run dist`) and leaves verified, unpacked
 * builds under electron/runtime/, which electron-builder then ships as
 * extraResources.
 *
 * Why bundle rather than download on first run — the way this used to work:
 * a running application that fetches an executable into a user-writable
 * folder and launches it is, behaviourally, indistinguishable from a
 * malware dropper. Antivirus engines watch for exactly that, and llama.cpp's
 * server is a prime target on its own merits: a small, unsigned executable
 * that opens a listening socket. On the machine this was developed on, Avast
 * quarantined llama-server.exe (and eventually Electron itself), leaving the
 * other 21 executables in the same folder untouched. Shipping the binary in
 * a signed installer removes the dropper pattern entirely, lets the binary
 * be signed alongside the app, and makes first launch instant.
 *
 * CUDA is deliberately NOT bundled: its build plus its separately-packaged
 * runtime come to ~640 MB, which is not a reasonable installer. It stays an
 * opt-in download for people who want the last increment of NVIDIA speed —
 * and that is exactly the case where warning about antivirus is honest.
 *
 *   node scripts/fetch-runtime.js          # fetch anything missing
 *   node scripts/fetch-runtime.js --force  # re-fetch even if present
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RELEASE_TAG = 'b10290';   // keep in sync with electron/llamacpp.js
const REPO = 'ggml-org/llama.cpp';
const OUT_ROOT = path.join(__dirname, '..', 'electron', 'runtime', RELEASE_TAG);
const FORCE = process.argv.includes('--force');

/* Only the builds small enough to ship. Vulkan accelerates NVIDIA, AMD and
 * Intel from one 34 MB archive and carries the CPU backends too; the CPU
 * build is the floor for machines with no usable Vulkan driver at all. */
const BUNDLED = {
  win32: [
    { variant: 'vulkan', asset: `llama-${RELEASE_TAG}-bin-win-vulkan-x64.zip` },
    { variant: 'cpu', asset: `llama-${RELEASE_TAG}-bin-win-cpu-x64.zip` },
  ],
  darwin: [
    { variant: 'metal', asset: `llama-${RELEASE_TAG}-bin-macos-arm64.tar.gz`, arch: 'arm64' },
    { variant: 'metal', asset: `llama-${RELEASE_TAG}-bin-macos-x64.tar.gz`, arch: 'x64' },
  ],
  linux: [
    { variant: 'cpu', asset: `llama-${RELEASE_TAG}-bin-ubuntu-x64.tar.gz` },
  ],
};

const tarBin = () => {
  if (process.platform === 'win32') {
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys32)) return sys32;
  }
  return 'tar';
};

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

async function assetMeta(assetName) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`, {
    headers: { 'User-Agent': 'MechApe-build', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`GitHub release lookup failed (${r.status})`);
  const asset = ((await r.json()).assets || []).find(a => a.name === assetName);
  if (!asset) throw new Error(`asset "${assetName}" not found in ${RELEASE_TAG}`);
  if (!asset.digest || !asset.digest.startsWith('sha256:')) {
    throw new Error(`asset "${assetName}" has no sha256 digest to verify against`);
  }
  return { url: asset.browser_download_url, sha256: asset.digest.slice(7) };
}

const sha256 = (file) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject)
    .on('end', () => resolve(h.digest('hex')));
});

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const ws = fs.createWriteStream(dest);
  const reader = r.body.getReader();
  let done = 0, lastPct = -1;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    done += value.byteLength;
    await new Promise((res, rej) => ws.write(Buffer.from(value), e => (e ? rej(e) : res())));
    const pct = total ? Math.floor((done / total) * 100 / 10) * 10 : -1;
    if (pct !== lastPct && pct >= 0) { process.stdout.write(`    ${pct}%\r`); lastPct = pct; }
  }
  await new Promise((res, rej) => ws.end(e => (e ? rej(e) : res())));
}

/* Same Zip-Slip guard the runtime installer applies — a build step is still
 * a place where an archive shouldn't get to write outside its directory. */
function assertSafeEntries(entries) {
  for (const raw of entries) {
    const name = raw.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`archive entry "${raw}" escapes the extraction directory`);
    }
  }
}

async function fetchVariant({ variant, asset, arch }) {
  const dir = path.join(OUT_ROOT, arch ? `${variant}-${arch}` : variant);
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (!FORCE && fs.existsSync(path.join(dir, exe))) {
    console.log(`  ${path.basename(dir)}: already present`);
    return;
  }

  console.log(`  ${path.basename(dir)}: fetching ${asset}`);
  const meta = await assetMeta(asset);
  const tmp = path.join(OUT_ROOT, `.${asset}`);
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  await download(meta.url, tmp);

  const actual = await sha256(tmp);
  if (actual !== meta.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${asset} failed SHA256 verification (expected ${meta.sha256}, got ${actual})`);
  }
  console.log(`    sha256 ok`);

  const staging = `${dir}.unpacking`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  assertSafeEntries((await run(tarBin(), ['-tf', tmp])).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  await run(tarBin(), ['-xf', tmp, '-C', staging]);
  fs.rmSync(tmp, { force: true });

  if (!fs.existsSync(path.join(staging, exe))) {
    throw new Error(`${asset} did not contain ${exe}`);
  }
  trimToServer(staging, exe);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  console.log(`    unpacked -> ${path.relative(process.cwd(), dir)}`);
}

/**
 * Keep llama-server and its libraries; drop the rest of the CLI suite.
 *
 * A llama.cpp release ships ~22 executables (llama-cli, llama-bench,
 * llama-quantize, llama-tts …). MechApe spawns exactly one of them. Shipping
 * the other 21 costs installer size, makes electron-builder attempt a code
 * signature on each, and — the part that actually matters after this
 * project's run-in with Avast — puts twenty-one more unsigned executables on
 * the user's disk for a scanner to take an interest in. The shared libraries
 * stay: llama-server loads the ggml backends at runtime.
 */
function trimToServer(dir, keepExe) {
  const doomed = [];
  const base = keepExe.replace(/\.exe$/i, '');            // "llama-server"

  for (const name of fs.readdirSync(dir)) {
    const lower = name.toLowerCase();

    // every front-end executable except the server
    const isExe = process.platform === 'win32'
      ? lower.endsWith('.exe')
      : !path.extname(name) && name.startsWith('llama-');
    if (isExe && lower !== keepExe.toLowerCase()) { doomed.push(name); continue; }

    /* Each CLI tool has a private "<tool>-impl" library beside it, dead
     * weight once its executable is gone. Only these paired ones go —
     * llama-common, llama.dll, mtmd and every ggml-* backend are shared and
     * load-bearing for the server. */
    if (lower.endsWith('-impl.dll') && !lower.startsWith(`${base.toLowerCase()}-impl`)) doomed.push(name);
  }

  let freed = 0;
  for (const name of doomed) {
    const p = path.join(dir, name);
    try { freed += fs.statSync(p).size; fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
  if (doomed.length) console.log(`    trimmed ${doomed.length} unused files (${(freed / 1048576).toFixed(0)} MB)`);
}

(async () => {
  const wanted = BUNDLED[process.platform] || BUNDLED.linux;
  console.log(`Bundling llama.cpp ${RELEASE_TAG} for ${process.platform}:`);
  for (const entry of wanted) await fetchVariant(entry);
  console.log('Runtime ready to ship.');
})().catch((e) => {
  console.error(`\nfetch-runtime failed: ${e.message}`);
  process.exit(1);
});
