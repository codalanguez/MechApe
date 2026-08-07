/**
 * llamacpp.js — download, verify, and locate the llama-server binary.
 *
 * On the desktop app's first run (or after a release-tag bump), downloads
 * the platform-appropriate llama.cpp release asset from GitHub, verifies its
 * SHA256 against the digest GitHub's own release API reports for that exact
 * asset — a second, independent HTTPS fetch, not a hash hand-copied into
 * source where a single mistyped character would silently defeat the check
 * — extracts it, and remembers the resolved binary path. On Windows it walks
 * CUDA → Vulkan → CPU, asking each build what GPU devices it can actually
 * see (`--list-devices`) and keeping the first that finds one; builds are
 * downloaded lazily, so the common case still fetches exactly one archive.
 *
 * Everything after "here is a verified binary" is lib/llamacpp.js's job: it
 * spawns and supervises the actual chat/embed processes once handed this
 * path via the MECHAPE_LLAMACPP_BIN env var.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { streamToFile } = require('../lib/download');
const { variantChain, accelLabel, parseDevices, pickDevice, anyNvidia } = require('../lib/accel');
const runtime = require('./runtime');
const { loadSettings, saveSettings } = require('./settings');

// Sanity cap for the llama-server release archive — the current Windows CUDA
// build is ~240 MB; this leaves generous headroom for the CUDA runtime
// growing in a future release without being an effectively-unbounded download.
const MAX_LLAMACPP_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

// A specific, known-good release — bumped deliberately, never resolved as
// "latest" at runtime (that would silently trust whatever GitHub serves for
// a moving tag today, a supply-chain footgun for a binary we then execute).
const RELEASE_TAG = 'b10290';
const REPO = 'ggml-org/llama.cpp';

const CUDA_SERIES = '12.4';

/**
 * The release asset(s) a variant needs, extracted together into one folder.
 *
 * Usually one archive — except CUDA, which needs two: llama.cpp's CUDA build
 * does NOT bundle the CUDA runtime, and ships it as a separate `cudart-*`
 * archive. Miss it and `ggml-cuda.dll` silently fails to load, so the build
 * launches fine and reports "Available devices: (none)" on a machine with a
 * perfectly good NVIDIA card. (Observed exactly that on an RTX 3070 before
 * this was fixed.) Note the cudart asset carries no release tag in its name.
 */
function assetsFor(variant) {
  if (process.platform === 'win32') {
    if (variant === 'cuda') {
      return [
        `llama-${RELEASE_TAG}-bin-win-cuda-${CUDA_SERIES}-x64.zip`,
        `cudart-llama-bin-win-cuda-${CUDA_SERIES}-x64.zip`,
      ];
    }
    if (variant === 'vulkan') return [`llama-${RELEASE_TAG}-bin-win-vulkan-x64.zip`];
    return [`llama-${RELEASE_TAG}-bin-win-cpu-x64.zip`];
  }
  if (process.platform === 'darwin') {
    return [process.arch === 'arm64'
      ? `llama-${RELEASE_TAG}-bin-macos-arm64.tar.gz`   // Metal is compiled in
      : `llama-${RELEASE_TAG}-bin-macos-x64.tar.gz`];
  }
  return [`llama-${RELEASE_TAG}-bin-ubuntu-x64.tar.gz`]; // Linux: CPU build only in this release
}

/* A variant is only "installed" if it's actually runnable. For CUDA that
 * means the runtime DLLs too — a folder holding just the build looks
 * complete to findBinary but can't use the GPU, which is precisely the
 * broken state this guards against reusing on a later launch. */
function variantComplete(variant, dir) {
  if (!findBinary(dir)) return false;
  if (variant !== 'cuda') return true;
  try {
    return fs.readdirSync(dir).some(f => /^cudart64_.*\.dll$/i.test(f));
  } catch { return false; }
}

const exeName = () => (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const runtimeRoot = () => path.join(app.getPath('userData'), 'runtime', 'llamacpp', RELEASE_TAG);

async function fetchAssetMeta(assetName) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`, {
    headers: { 'User-Agent': 'MechApe', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`GitHub release lookup failed (${r.status})`);
  const rel = await r.json();
  const asset = (rel.assets || []).find(a => a.name === assetName);
  if (!asset) throw new Error(`asset "${assetName}" not found in release ${RELEASE_TAG}`);
  if (!asset.digest || !asset.digest.startsWith('sha256:')) throw new Error('release asset has no sha256 digest to verify against — refusing to trust it blindly');
  return { url: asset.browser_download_url, sha256: asset.digest.slice('sha256:'.length) };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => hash.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

async function downloadFile(url, dest, onProgress) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  await streamToFile(r.body, dest, { total, maxBytes: MAX_LLAMACPP_DOWNLOAD_BYTES, onProgress });
}

/* ---- extraction ----
 *
 * Both archive shapes (Windows .zip, macOS/Linux .tar.gz) go through `tar`,
 * which ships on Windows 10 1803+, macOS, and Linux, and whose libarchive
 * backend reads zip as happily as tar.
 *
 * This deliberately does NOT use adm-zip, which the rest of the app uses for
 * skill archives. adm-zip reads the whole archive into memory and hands back
 * each entry as a Buffer — fine for a few KB of markdown, catastrophic here:
 * the Windows CUDA build is a 250 MB archive containing a single 537 MB DLL,
 * so extracting it that way allocates most of a gigabyte and blocks the
 * thread doing it. Done on Electron's main thread, that freezes the whole
 * app (observed: the splash goes "Not Responding" and the extraction dies
 * part-way). Spawning `tar` streams entry-by-entry to disk in another
 * process, so the UI stays responsive and memory stays flat. */

/* Resolve tar explicitly rather than trusting PATH. Windows ships bsdtar
 * (libarchive) at System32\tar.exe, which reads zip — but a machine with Git
 * for Windows, MSYS, or Cygwin installed can easily have *GNU* tar earlier on
 * PATH, and GNU tar both refuses zip and misreads "C:\..." as a remote
 * host:path spec ("Cannot connect to C:"). Verified the hard way: bare `tar`
 * in a Git Bash shell on this project's own dev machine is GNU tar 1.35. */
function tarBin() {
  if (process.platform === 'win32') {
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys32)) return sys32;
  }
  return 'tar';
}

/** Entry paths inside an archive, without extracting anything. */
function listArchiveEntries(archivePath) {
  return new Promise((resolve, reject) => {
    execFile(tarBin(), ['-tf', archivePath], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(`could not read the archive (${err.message})`));
      resolve(stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    });
  });
}

/* Reject absolute paths, drive letters, and any "..' segment before we let
 * tar write anything — the same Zip-Slip guard lib/skills.js applies to
 * imported skills. The archive is already SHA256-verified against a pinned
 * GitHub release, so this is defense-in-depth, but checking names is cheap
 * and every extraction in this codebase should clear the same bar. */
function assertSafeEntries(entries) {
  for (const raw of entries) {
    const name = raw.replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
      throw new Error(`archive entry "${raw}" escapes the extraction directory — refusing to extract`);
    }
  }
}

function extractArchive(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    execFile(tarBin(), ['-xf', archivePath, '-C', destDir], { timeout: 900000, windowsHide: true },
      (err) => (err ? reject(new Error(`extracting the llama.cpp build failed (${err.message})`)) : resolve()));
  });
}

/* Release archives don't all nest the binary the same way — walk the
 * extracted tree rather than assume a fixed layout. Bounded depth-first
 * search over a small, just-extracted directory, not untrusted input. */
function findBinary(dir) {
  const target = exeName();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const p = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.toLowerCase() === target) return p;
    }
  }
  return null;
}

/**
 * Ask a candidate build what devices it can actually see.
 *
 * `--list-devices` initializes the GPU backend and enumerates real devices,
 * then exits — so unlike a `--help` launch check (which only proves the
 * executable's DLLs resolve), this distinguishes "the CUDA build starts fine
 * but there's no NVIDIA GPU here" from "there is one." That distinction is
 * the whole point: the former used to sail through the old check and only
 * surface at the first real model load, as a crash mid-chat.
 *
 * llama.cpp writes the device list to stdout but its log lines to stderr, so
 * both are searched. A non-zero exit that still produced parseable output
 * counts as launched — some builds exit non-zero after printing.
 */
function probeDevices(binPath) {
  return new Promise((resolve) => {
    // generous timeout: creating a first CUDA context on a cold driver can
    // take several seconds, and a false "didn't launch" would demote a
    // perfectly good GPU build
    execFile(binPath, ['--list-devices'], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}\n${stderr || ''}`;
      if (err && !out.trim()) return resolve({ launched: false, recognized: false, gpus: [] });
      resolve({ launched: true, ...parseDevices(out) });
    });
  });
}

/** Download one asset (or reuse an intact prior download) and return its
 * verified local path. Never returns a path that hasn't matched its digest. */
async function fetchVerified(assetName, report) {
  const meta = await fetchAssetMeta(assetName);
  const tmpArchive = path.join(app.getPath('temp'), `mechape-${assetName}`);

  /* A previous run may have downloaded this already and then failed (or been
   * killed) during extraction. Re-hashing a local file is far cheaper than
   * re-fetching a quarter-gigabyte, so an intact archive is reused and only
   * a corrupt/partial one is discarded and pulled again. */
  if (fs.existsSync(tmpArchive)) {
    report({ status: 'checking the download already on disk' });
    if ((await sha256File(tmpArchive)) === meta.sha256) return tmpArchive;
    try { fs.unlinkSync(tmpArchive); } catch { /* best effort */ }
  }

  report({ status: 'downloading', completed: 0, total: 0 });
  await downloadFile(meta.url, tmpArchive, (completed, total) => report({ status: 'downloading', completed, total }));
  report({ status: 'verifying the download' });
  if ((await sha256File(tmpArchive)) !== meta.sha256) {
    try { fs.unlinkSync(tmpArchive); } catch { /* best effort */ }
    throw new Error('a downloaded llama.cpp archive failed SHA256 verification against the GitHub release — refusing to run it');
  }
  return tmpArchive;
}

/**
 * Install a variant: fetch every archive it needs, verify them all, then
 * unpack them together into one clean folder.
 *
 * Everything is verified before anything is extracted, so a failure on the
 * second archive can't leave a half-installed folder that later looks
 * complete — the same reason destDir is wiped first rather than merged into.
 */
async function installVariant(variant, destDir, onProgress) {
  const report = (status) => { if (onProgress) onProgress(status); };
  const archives = [];
  for (const assetName of assetsFor(variant)) archives.push(await fetchVerified(assetName, report));

  /* Unpack into a staging folder and move it into place only once it's
   * complete, so `destDir` is either absent or whole — never half-unpacked.
   * Quitting the app mid-extraction is entirely normal (it's a minutes-long
   * first run) and used to leave a folder holding most of a build: enough
   * for findBinary to call it installed, not enough to actually run. */
  const staging = destDir + '.installing';
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* nothing to clear */ }

  report({ status: 'unpacking' });
  for (const archive of archives) {
    assertSafeEntries(await listArchiveEntries(archive));
    await extractArchive(archive, staging);
  }

  const bin = findBinary(staging);
  if (!bin) throw new Error('extracted archive did not contain llama-server');
  if (!variantComplete(variant, staging)) throw new Error(`the ${variant} build unpacked without its runtime libraries`);
  if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* best effort */ } }

  try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* nothing to replace */ }
  fs.renameSync(staging, destDir);

  /* Re-check after the move. An antivirus watching this folder can delete or
   * block the executable moments after it lands — seen in the wild with
   * Avast, which let 54 of a build's 55 files through and silently removed
   * llama-server.exe alone, *after* the checks above had passed. Without
   * this the install reports success, the variant gets remembered, and the
   * only symptom is a backend that is permanently "unreachable" for no
   * stated reason. */
  const installed = findBinary(destDir);
  if (!installed) {
    throw Object.assign(
      new Error(
        'llama-server.exe disappeared right after it was unpacked — this is antivirus, not a bad download. '
        + 'A small unsigned executable that opens a listening socket trips backdoor heuristics, and llama.cpp\'s '
        + 'server binary is a known false positive (observed with Avast, which quarantined it while leaving all '
        + '21 other executables in the same folder alone). Add an exception for MechApe\'s runtime folder in your '
        + 'antivirus, then try again.',
      ),
      { blockedByScanner: true },
    );
  }
  for (const archive of archives) { try { fs.unlinkSync(archive); } catch { /* best effort */ } }
  return installed;
}

/**
 * A build shipped inside the app, if this variant is one of them.
 *
 * Bundled builds are the whole point of scripts/fetch-runtime.js: they arrive
 * through a signed installer instead of being downloaded by a running process
 * and executed, which is the pattern antivirus engines (rightly) treat as a
 * dropper. Nothing to download, nothing to verify at runtime — it was already
 * verified at build time — and first launch is instant.
 *
 * Only the small builds ship this way (Vulkan and CPU on Windows, Metal on
 * macOS). CUDA is ~640 MB with its separate runtime, so it stays an opt-in
 * download and is the one path that can still trip a scanner.
 */
function bundledBinary(variant) {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'runtime', RELEASE_TAG)]
    : [path.join(runtime.APP_ROOT, 'electron', 'runtime', RELEASE_TAG)];
  // macOS ships one build per architecture, named accordingly
  const names = variant === 'metal' ? [`metal-${process.arch}`, 'metal'] : [variant];
  for (const root of roots) {
    for (const name of names) {
      const dir = path.join(root, name);
      if (fs.existsSync(dir) && variantComplete(variant, dir)) {
        const bin = findBinary(dir);
        if (bin) return bin;
      }
    }
  }
  return null;
}

/** Resolve one variant: shipped copy first, then a previous download, then
 * (only if neither exists) fetch it. */
async function resolveVariant(variant, onProgress) {
  const bundled = bundledBinary(variant);
  if (bundled) return bundled;
  const existing = installedBinary(variant);
  if (existing) return existing;
  return installVariant(variant, path.join(runtimeRoot(), variant), onProgress);
}

let resolved = null; // {bin, variant} — cached for this process's lifetime

/** The already-installed binary for `variant`, or null if it isn't on disk
 * (or is there but incomplete — see variantComplete). */
function installedBinary(variant) {
  const dir = path.join(runtimeRoot(), variant);
  if (!fs.existsSync(dir) || !variantComplete(variant, dir)) return null;
  return findBinary(dir);
}

/**
 * Resolve which llama.cpp build to run, downloading + SHA256-verifying on
 * first use. Returns `{bin, variant}`.
 *
 * Walks lib/accel.js's variant chain (Windows: CUDA → Vulkan → CPU), asking
 * each candidate what devices it can see and taking the first that reports a
 * real GPU. Downloads are lazy — the ~34 MB Vulkan build is only fetched if
 * the CUDA one reports no NVIDIA device, and the CPU build only if neither
 * GPU build finds anything — so the common case still downloads exactly one
 * archive. The winner is remembered so later launches skip straight to it.
 *
 * Deliberately biased toward keeping a GPU build: a candidate is only
 * rejected on a *positive* "no devices" verdict (or an outright failure to
 * launch). Output we can't parse is treated as "no verdict, keep it" — see
 * parseDevices. Getting that backwards would quietly put working GPU
 * machines on the CPU build, which is a far worse failure than the one this
 * is guarding against, and an invisible one.
 */
/**
 * Ask a build what it can see, and decide whether to keep it.
 *
 * `usable: false` means "this build found nothing to accelerate with, move
 * on". Unparseable output is deliberately usable — see parseDevices. The
 * chosen `device` is what stops llama.cpp defaulting to device 0, which on a
 * laptop is typically the integrated GPU rather than the discrete card.
 */
async function probeAndPick(bin) {
  const probe = await probeDevices(bin);
  if (!probe.launched) return { usable: false, device: null };
  if (probe.recognized && probe.gpus.length === 0) return { usable: false, device: null };
  return { usable: true, device: pickDevice(probe.gpus) };
}

/**
 * Is there an NVIDIA card here?
 *
 * Answered with the *bundled* Vulkan build, which enumerates every vendor's
 * GPU and is already on disk — so this costs one sub-second probe and no
 * download, and it runs before we decide whether the 640 MB CUDA fetch is
 * justified. An unreadable or missing probe returns false, which keeps the
 * app on the build it already has rather than speculatively downloading.
 */
async function detectNvidia() {
  const bin = bundledBinary('vulkan') || installedBinary('vulkan');
  if (!bin) return false;
  const probe = await probeDevices(bin);
  return probe.recognized ? anyNvidia(probe.gpus) : false;
}

async function ensureLlamaCppBinary(onProgress) {
  if (resolved && fs.existsSync(resolved.bin)) return resolved;

  const settings = loadSettings();
  const hasNvidia = process.platform === 'win32' ? await detectNvidia() : false;
  const chain = variantChain(process.platform, { hasNvidia, cudaOptOut: Boolean(settings.cudaOptOut) });
  if (hasNvidia && !settings.cudaOptOut) {
    console.log('[mechape] NVIDIA GPU detected — preferring the CUDA build');
  }
  const cpuFallback = chain[chain.length - 1];

  /* Variants this machine has already been *shown* not to support — a probe
   * that positively reported no devices. Remembering them is what stops a
   * GPU-less machine re-downloading a build every launch just to be told the
   * same thing.
   *
   * Only probe verdicts land here, never install failures: a download that
   * timed out or an extraction interrupted by quitting the app says nothing
   * about the hardware, and must be retried rather than written off. */
  const rejected = Array.isArray(settings.llamacppRejected) ? settings.llamacppRejected : [];

  /* The remembered build is only good enough if nothing *better* is still
   * worth trying — otherwise opting into CUDA after having fallen back to
   * Vulkan would take this fast path forever and appear to do nothing.
   *
   * Re-probe it rather than trusting a stored device: under a second, and it
   * means plugging in an eGPU, updating a driver, or a card dying is picked
   * up next launch instead of offloading to something no longer there. */
  const remembered = settings.llamacppVariant;
  const rank = chain.indexOf(remembered);
  const nothingBetterLeft = rank >= 0 && chain.slice(0, rank).every(v => rejected.includes(v));
  if (nothingBetterLeft) {
    const bin = installedBinary(remembered);
    if (bin) {
      const { usable, device } = remembered === cpuFallback
        ? { usable: true, device: null }
        : await probeAndPick(bin);
      if (usable) { resolved = { bin, variant: remembered, device }; return resolved; }
      // it stopped working — fall through and walk the chain again
    }
  }

  let lastErr = null;
  const nowRejected = [...rejected];
  for (let i = 0; i < chain.length; i++) {
    const variant = chain[i];
    const isFallback = i === chain.length - 1; // last link: accept without probing

    let bin;
    try {
      if (onProgress) onProgress({ status: `preparing the ${accelLabel(variant)} build` });
      bin = await resolveVariant(variant, onProgress);
    } catch (e) {
      lastErr = e;
      // Silence here is how a blocked CUDA install turned into an
      // unexplained "backend unreachable" — say why, on the console the
      // developer is already watching.
      console.warn(`[mechape] the ${accelLabel(variant)} build is unavailable: ${e.message}`);
      // A scanner deleting the binary will do it again on every retry, so
      // don't re-download hundreds of MB each launch to prove it. Anything
      // else (a timeout, an interrupted unpack) stays retryable.
      if (e.blockedByScanner && !nowRejected.includes(variant)) nowRejected.push(variant);
      continue;
    }

    let device = null;
    if (!isFallback) {
      const picked = await probeAndPick(bin);
      if (!picked.usable) {
        console.warn(`[mechape] the ${accelLabel(variant)} build found no usable GPU on this machine — trying the next one`);
        if (!nowRejected.includes(variant)) nowRejected.push(variant);
        continue;
      }
      device = picked.device;
    }

    // a variant that works now clears any stale rejection of it
    saveSettings({
      llamacppVariant: variant,
      llamacppRejected: nowRejected.filter(v => v !== variant).length ? nowRejected.filter(v => v !== variant) : undefined,
    });
    console.log(`[mechape] using the ${accelLabel(variant)} build${device ? ` on ${device.name}` : ''}`);
    resolved = { bin, variant, device };
    return resolved;
  }

  // every variant, including the CPU fallback, failed to install
  saveSettings({ llamacppRejected: nowRejected.length ? nowRejected : undefined });
  throw lastErr || new Error('no usable llama.cpp build could be resolved');
}

module.exports = { ensureLlamaCppBinary, RELEASE_TAG };
