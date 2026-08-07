/**
 * accel.js — which llama.cpp build to run, and what it's actually running on.
 *
 * Shared by electron/llamacpp.js (which probes candidate builds at boot and
 * downloads the winner) and lib/llamacpp.js (which reports the live
 * accelerator through /api/health). Pure functions only — no Electron, no
 * filesystem, no network — so the parsing below is unit-testable, which
 * matters more here than usual: a wrong verdict from parseDevices silently
 * changes which build every user runs.
 */

/* Build variants, in the order they're tried. Each maps to release asset(s)
 * (see electron/llamacpp.js's assetsFor). The last entry is the always-works
 * fallback and is accepted without probing.
 *
 * On Windows the order depends on what hardware is actually present, because
 * the two builds are not close substitutes:
 *
 *  - **CUDA** is what an NVIDIA card should be running. Measured on a laptop
 *    RTX 3070, Vulkan full-offload turned in *worse* generation throughput
 *    than CPU-only (1.9 vs 15.3 tok/s) with wild run-to-run variance, so
 *    treating Vulkan as good-enough for NVIDIA was a mistake. Its cost is
 *    real though: llama.cpp's CUDA build is 250 MB *plus* a separately
 *    packaged 391 MB runtime, too big to ship in an installer, so choosing
 *    it means a download.
 *  - **Vulkan** ships inside the app and covers AMD and Intel, where CUDA is
 *    useless. Offering CUDA to those machines would burn 640 MB to arrive at
 *    a build that can't see their GPU.
 *
 * Hence `hasNvidia`: CUDA leads only where it can actually run. `cudaOptOut`
 * is the escape hatch for an NVIDIA owner who would rather keep the bundled
 * build than spend the download.
 *
 * macOS ships one universal build with Metal compiled in; Linux has only a
 * CPU build in the pinned release. Neither has anything to choose. */
function variantChain(platform = process.platform, { hasNvidia = false, cudaOptOut = false } = {}) {
  if (platform === 'win32') {
    return (hasNvidia && !cudaOptOut) ? ['cuda', 'vulkan', 'cpu'] : ['vulkan', 'cpu'];
  }
  if (platform === 'darwin') return ['metal'];
  return ['cpu'];
}

/* Vulkan enumerates every vendor's GPU, and the bundled Vulkan build is
 * already probed at boot — so it doubles as the hardware detector that
 * decides whether CUDA is worth fetching, at no extra cost. */
const isNvidia = (name) => /\bnvidia|geforce|rtx|gtx|quadro|tesla\b/i.test(name || '');
const anyNvidia = (gpus) => (gpus || []).some(g => isNvidia(g.name));

/** Human label for the status pill / logs. */
function accelLabel(variant) {
  return { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal', cpu: 'CPU' }[variant] || 'CPU';
}

/* GPU device lines from `llama-server --list-devices` look like:
 *
 *   Available devices:
 *     CUDA0: NVIDIA GeForce RTX 4060 Ti (15944 MiB, 14143 MiB free)
 *     Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)
 *
 * The trailing digit is what distinguishes a real GPU device from a plain
 * "CPU" line (which some builds also list) — so a CPU-only machine running
 * the CUDA build prints the header with no matching lines beneath it, which
 * is exactly the case this exists to detect. */
const GPU_LINE = /^\s*(CUDA|Vulkan|ROCm|HIP|SYCL|Metal|CANN|OpenCL|MUSA)(\d+)\s*:\s*(\S.*?)\s*$/i;
const DEVICES_HEADER = /available devices/i;

/**
 * Parse `--list-devices` output.
 *
 * Returns `{ recognized, gpus }`. **`recognized` is the important field**:
 * it says whether we actually understood the output, NOT whether a GPU was
 * found. Callers must treat `recognized: false` as "no verdict — keep the
 * current build", never as "no GPU". A future llama.cpp that reformats this
 * output, or a build that errors before printing, would otherwise silently
 * demote every user to the CPU build and halve their speed for no reason.
 * Only `recognized: true` with an empty `gpus` is a real "this build sees no
 * GPU here" verdict.
 */
function parseDevices(output) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/);
  if (!lines.some(l => DEVICES_HEADER.test(l))) return { recognized: false, gpus: [] };

  /* Scan every line, not just the ones under the header, and don't stop at a
   * blank line. Both of those would be tidier, and both bias toward finding
   * FEWER GPUs — the harmful direction here, since an empty result demotes
   * the user to the CPU build. A stray log line that happens to match this
   * fairly specific `Backend<n>: <name>` shape at worst keeps a GPU build
   * that was already working. */
  const gpus = [];
  for (const line of lines) {
    const m = GPU_LINE.exec(line);
    if (!m) continue;
    const rest = m[3];
    // "... (8018 MiB, 7250 MiB free)" — trailing size info, when present
    const mem = /\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/i.exec(rest);
    gpus.push({
      backend: m[1],
      index: Number(m[2]),
      id: `${m[1]}${m[2]}`,                                  // exactly what --device expects
      name: (mem ? rest.slice(0, mem.index) : rest).trim(),
      totalMiB: mem ? Number(mem[1]) : null,
      freeMiB: mem ? Number(mem[2]) : null,
    });
  }
  return { recognized: true, gpus };
}

/* Integrated GPUs share system RAM, so they can *report* far more memory
 * than a much faster discrete card — a real example from a laptop this was
 * developed against:
 *
 *   Vulkan0: Intel(R) UHD Graphics            (32618 MiB, 48085 MiB free)
 *   Vulkan1: NVIDIA GeForce RTX 3070 Laptop   ( 8018 MiB,  7250 MiB free)
 *
 * Picking by reported memory would choose the iGPU, and so would taking
 * device 0 (llama.cpp's own default) — both land on the slow one. Hence
 * classifying by name instead. */
const DISCRETE_HINT = /\b(nvidia|geforce|rtx|gtx|quadro|tesla|radeon (rx|pro)|arc [ab]\d|instinct)\b/i;
const INTEGRATED_HINT = /\b(uhd graphics|hd graphics|iris|vega \d+ graphics|radeon\(tm\) graphics|integrated|llvmpipe|softwarerasterizer|swiftshader)\b/i;

/** 2 = discrete, 1 = unknown, 0 = integrated/software. */
function deviceRank(name) {
  if (INTEGRATED_HINT.test(name)) return 0;
  if (DISCRETE_HINT.test(name)) return 2;
  return 1;
}

/**
 * Choose which enumerated GPU to offload to, or null if there's nothing to
 * choose. Prefers a discrete card, then the one with the most real VRAM
 * within the same class. Returns the device object; callers pass its `id`
 * (e.g. "Vulkan1") to llama-server's `--device`.
 */
function pickDevice(gpus) {
  if (!gpus || !gpus.length) return null;
  return [...gpus].sort((a, b) =>
    deviceRank(b.name) - deviceRank(a.name) || (b.totalMiB || 0) - (a.totalMiB || 0) || a.index - b.index,
  )[0];
}

module.exports = { variantChain, accelLabel, parseDevices, pickDevice, deviceRank, isNvidia, anyNvidia };
