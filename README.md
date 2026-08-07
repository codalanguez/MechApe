# 🐒 MechApe

A local, private LLM studio on its own [llama.cpp](https://github.com/ggml-org/llama.cpp) backend — projects, Claude-style skills, and live file knowledge. No separate Ollama install and nothing to fetch on first launch: the `llama-server` runtime ships inside the installer, SHA256-verified at build time, and runs your models — plain `.gguf` files you pull straight from Hugging Face — directly. Local by default: out of the box, nothing ever leaves your machine except a model you asked for. When your hardware can't carry the model you need, an **optional** [OpenRouter](https://openrouter.ai) key adds remote models — per chat, clearly badged, never implicit.

**Website:** [codalanguez.com/mechape](https://codalanguez.com/mechape/) · more experiments in [The Lab](https://codalanguez.com/lab/)

![Chat with a project, skill, and live token count](docs/screenshots/chat.png)

<table>
  <tr>
    <td width="50%"><img alt="Projects page" src="docs/screenshots/projects.png"></td>
    <td width="50%"><img alt="Model settings with size and usage recommendation" src="docs/screenshots/model-settings.png"></td>
  </tr>
  <tr>
    <td align="center"><em>Projects overview</em></td>
    <td align="center"><em>Model settings — size, specs & usage recommendation</em></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Skills manager" src="docs/screenshots/skills.png"></td>
    <td width="50%" valign="top">
      <br>
      <strong>What you're looking at</strong>
      <ul>
        <li>Claude-format <strong>skills</strong> as per-project toggles or <code>/</code> per message</li>
        <li>A live <strong>token / context</strong> readout in the composer</li>
        <li>Per-project <strong>model settings</strong> with a size &amp; use-case recommendation</li>
        <li>Seven switchable themes — four dark, three light (shown: <strong>Cyber Deco</strong>, the default) — in Preferences → Theme</li>
      </ul>
    </td>
  </tr>
</table>

## Quick start

```powershell
git clone https://github.com/codalanguez/MechApe.git
cd MechApe
npm install        # first time only
npm start          # then open http://localhost:8113
npm test           # unit tests for the OpenRouter + llama.cpp adapter boundaries
```

On Windows you can also just double-click **`Start MechApe.cmd`** to open the app.

Requires **Node.js 18+**. `npm start` runs headless — it's the desktop app that ships and manages the llama.cpp backend for you (see below); in a plain repo checkout, start the two `llama-server` instances yourself before chatting (or run `npm run runtime` once to fetch the same verified builds the installer bundles, into `electron/runtime/`):

```powershell
# chat instance — swap the model whenever you switch models in the UI
llama-server -m path\to\model.gguf --host 127.0.0.1 --port 8114 -ngl 999
# embed instance — for large-attachment retrieval; only needed once
llama-server -m path\to\embed-model.gguf --host 127.0.0.1 --port 8115 --embedding --pooling mean
```

Grab a `llama-server` build from the [llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases), and `.gguf` model files from any Hugging Face GGUF repo (e.g. [bartowski](https://huggingface.co/bartowski) or [unsloth](https://huggingface.co/unsloth)). Works the same way on macOS and Linux — swap the `powershell` block above for your shell.

## Desktop app

MechApe can also run as a native desktop application (like the ComfyUI desktop app) instead of in a browser tab. An [Electron](https://www.electronjs.org) shell boots the bundled `llama-server` runtime and the app server on free ports, and shows the UI in its own window with a splash screen.

```powershell
npm install        # first time only — pulls in Electron
npm run desktop    # launches the desktop app
```

Or double-click **`Start MechApe Desktop.cmd`** (installs dependencies on first run).

**Preferences** — the ⚙ gear in the sidebar footer opens a panel with three storage locations, each user-changeable via a native folder picker (or resettable to its default):

- **Projects & chats folder** — where conversations and project settings are saved. Changing it restarts the server and reloads the UI; existing chats stay in the old folder (move the JSON files manually if you want them along).
- **Skills folder** — where `SKILL.md` folders are scanned from. Point it at `~\.claude\skills` to use your Claude Code skills as-is.
- **Models folder** — where downloaded `.gguf` files live, plain files you can see and move yourself (default: beside the projects folder). Changing it restarts the server and reloads the UI.

Each location's env var (`MECHAPE_DATA_DIR`, `MECHAPE_SKILLS_DIR`, `MECHAPE_MODELS_DIR`) always wins over the saved preference and shows as read-only in the panel.

**Data & backup** (also in Preferences, and works in plain browser mode too — not desktop-only) — **Back up now…** zips your projects & chats to a folder you pick; cached retrieval embeddings aren't included since they rebuild automatically. **Erase everything…** clears every project, chat, and cached embedding in place — skills and these preferences are untouched — and is gated behind typing the exact confirmation phrase, so it can't happen by a stray click. A live line above the buttons shows your project count and data-folder path; the desktop app adds an **Open data folder** shortcut next to it.

### Build a standalone installer

To produce an installer you can hand to another machine — no Node required on the target:

```powershell
npm run dist       # Windows: MechApe Setup <version>.exe · macOS: MechApe-<version>[-arm64].dmg / .zip · Linux: MechApe-<version>.AppImage
```

`electron-builder` picks the target platform from the host you build on. On Windows it produces a standard NSIS setup: install-location picker, Start-menu entry, desktop shortcut, uninstaller, installed per-user (no admin needed). On macOS it produces a `.dmg` (drag-to-Applications) and a `.zip` for **both Intel (x64) and Apple Silicon (arm64)** in one run — electron-builder cross-packages the arm64 build even from an x64 host, no separate Mac needed. On Linux it produces a single-file `.AppImage` (x64) — no install step, just `chmod +x` and run; a `.deb` isn't built from a macOS host (the bundled packager needs GNU `ar`, which macOS doesn't ship — build `.deb` from an actual Linux machine if you need one). The target machine needs nothing preinstalled — the `llama-server` runtime is packaged inside the installer (run `npm run runtime` first, or just use `npm run dist`, which does it for you). Only the server binary and its shared libraries ship — the ~21 other CLI tools in a llama.cpp release are dropped, mostly to avoid putting that many unsigned executables on someone's disk.

Unsigned macOS builds (the default here, no Apple Developer ID on hand) trigger Gatekeeper on first launch — right-click the app → **Open**, or allow it via **System Settings → Privacy & Security → Open Anyway**. After that first launch it opens normally.

When running as an installed app, project data and skills live under the OS's per-user app-data folder — `%APPDATA%\MechApe` on Windows, `~/Library/Application Support/MechApe` on macOS, `~/.config/MechApe` on Linux (`data/projects` and `skills` inside it) — so updates and uninstalls never touch your chats; the bundled sample skills are copied there on first run. A repo checkout (`npm start` / `npm run desktop`) keeps everything repo-local as before. `MECHAPE_DATA_DIR` / `MECHAPE_SKILLS_DIR` env vars override either way.

The build config lives in `package.json` under `"build"`; icon assets are in `electron/build/` (`icon.ico` for Windows, `icon.icns` for macOS, a `icons/` folder of PNGs for Linux — all generated from `icon-source.png`). The desktop shell lives entirely in `electron/` and reuses the server unchanged — `npm start` still runs it headless in a browser.

**Building on Windows needs Developer Mode on.** electron-builder downloads a `winCodeSign` bundle that contains macOS symlinks, and creating symlinks on Windows requires either an elevated shell or Developer Mode. Without it the build dies partway through with `Cannot create symbolic link : A required privilege is not held by the client`, which is not obviously about symlink permissions when you first read it. Turn it on at **Settings → System → For developers → Developer Mode**, or run the build from an Administrator terminal.

**Code signing** — point electron-builder at a PFX and it signs the app, uninstaller, and installer (SHA-256 + RFC-3161 timestamp):

```powershell
$env:CSC_LINK = "$HOME\.mechape-signing\mechape-codesign.pfx"
$env:CSC_KEY_PASSWORD = Get-Content "$HOME\.mechape-signing\pfx-password.txt"
npm run dist
```

A self-signed certificate (as generated here) makes signatures verify on machines that trust it, but other people's PCs still see "unknown publisher" and SmartScreen still warns — only a CA-issued certificate fixes that.

**Released builds are signed in CI instead.** `.github/workflows/release.yml` builds on a version tag and signs through [SignPath Foundation][signpath], in two passes: every binary inside the unpacked app (which is what makes the bundled `llama-server.exe` signed *on disk after install*, the file scanners actually object to), then the installer built from those signed files. SignPath pulls the artifact from the workflow run itself and verifies its origin, so a locally built installer can't be signed with that certificate by design. Setup, the application process, and how to verify a signature are in **[docs/SIGNING.md](docs/SIGNING.md)**. Until the application is approved the workflow still builds and publishes — just unsigned, and labelled as such.

[signpath]: https://signpath.org/

## Features

### Projects (like Claude Projects)
Each project bundles:
- **Instructions** — a system prompt applied to every chat in the project
- **Knowledge** — files and folders attached from your machine
- **Skills** — always-on skills for the project
- **Chats** — as many conversations as you like, each remembering its model

Everything is stored as plain JSON under `data/projects/` — easy to back up, easy to inspect, never leaves your disk.

### Search
**⌕ Search** in the rail (or **Ctrl+K**) searches project names, chat titles, and every message's content at once — a debounced query against a local endpoint, no index to maintain. Results are grouped by what matched, with a match-centered snippet for message hits; clicking one opens the right project and chat and scrolls straight to (and briefly highlights) that exact message.

### Skills (Claude skill format)
Drop a folder into `skills/`, containing a `SKILL.md` with YAML frontmatter:

```
skills/
  my-skill/
    SKILL.md
```

```markdown
---
name: my-skill
description: One line describing when to use this skill.
---

Instructions the model follows when the skill is loaded…
```

Or create one in-app: **✦ Skills → + New skill** scaffolds the folder and a starter `SKILL.md` from a built-in template (`lib/skill-template.md`) — then edit the file to write the instructions. Also available from the desktop menu (**MechApe → Skills → New Skill…**).

Existing skills can be brought in with **⇪ Import skill…** — pick a skill folder, a `SKILL.md`, or a packaged **`.skill` file** (a zip of the skill folder; plain `.zip` works too) and it's copied/extracted into your skills directory with size and path-safety checks. Importing one whose name already matches an installed skill doesn't just fail — you're offered **Replace existing** or **Import as new name** on the spot.

Prefer not to write it yourself? **✦ Create with model** has one of your installed local models draft the instructions from your name + description brief. The model picker recommends the best installed candidate for the job (solid instruct families at GPU-friendly sizes; reasoning models rank lower). Review the generated `SKILL.md` before relying on it.

Click any skill's name to open its detail view — **Edit…** rewrites its description and instructions in place (same file, no need to touch it on disk), **Delete skill…** removes the folder entirely and drops it from every project that had it toggled on, asking first since it can't be undone.

Two ways to use a skill:
1. **Project toggle** — switch it on in the project panel; it loads into every message.
2. **Slash invoke** — type `/` in the composer and pick a skill; it loads for that message only (and stays in the conversation history from then on).

Existing Claude Code skills work as-is — point MechApe at them:

```powershell
$env:MECHAPE_SKILLS_DIR = "$HOME\.claude\skills"; npm start
```

### File & directory knowledge
Attach any file or folder via the built-in browser — **one at a time or several at once**: toggle (+) as many files and folders as you want, even across different folders as you browse, then attach them all in one go. A file's *name* opens a preview instead (see below); the toggle is what selects it. Contents are **re-read from disk on every message**, so your latest edits are always what the model sees. Directories are walked recursively (skipping `node_modules`, `.git`, build output, binaries) with size budgets so you don't blow out the context window.

Attach at **two levels**:
- **Project knowledge** (the inspector's Knowledge panel) — shared by every chat in the project.
- **Chat knowledge** (the 📎 in the chat header) — scoped to just that one chat. Great for a quick chat where you want to drop in a few files without setting up a project; shown as chips above the composer and counted in the token meter.

### Preview & save files
Click any file's name in the browser (📎, or Knowledge → Attach) to **preview** it before attaching — markdown renders like a chat reply, other text shows as-is, and binary files are refused rather than dumped as garbage. Right-click any message → **Save as file…** writes it to disk: pick a folder through the same browser, type a name (MechApe suggests one from the first line), and it's saved as real markdown — the original source, not a flattened copy, so headings, code fences, and links all survive. An existing file is never silently overwritten; you're asked first. Both are fenced by the same `MECHAPE_FS_ROOTS` allowlist as attachments — a save can't land, and a preview can't read, outside it.

### Large attachments: retrieval instead of overflow

Attach something big — a whole manuscript, a codebase — and MechApe embeds it **on-device** (via its own embed `llama-server` instance, running a small GGUF model such as `nomic-embed-text-v1.5`) and injects only the passages relevant to your question, instead of dumping the entire file into every prompt. Small attachments (< 64 KB) are still included whole; anything larger is searched. Indexing starts **in the background the moment you attach** (with an "indexing %" badge), so the first message doesn't wait on it. The index is cached on disk by file signature — so a file is embedded once and reused until it changes — and it's removed when you detach the attachment or delete the project. Entirely offline — and if no embedding model is installed, MechApe offers to pull the recommended one on first run, or simply falls back to including the file as before. Set `MECHAPE_RETRIEVAL=off` to always include attachments whole and write no index at all.

#### Benchmarks

> The figures below were measured before the [move from Ollama to a self-managed llama.cpp backend](#local-backend-llamacpp) and still say "Ollama" in the machine line — the retrieval mechanics they demonstrate (chunk/embed/rank, index caching, prefill-time savings) are byte-for-byte unchanged by that move, but the numbers themselves are stale. Re-run `npm run bench` against the new backend to refresh them.

<!-- BENCH:START (auto-generated by `npm run bench` — do not edit by hand) -->
Measured end-to-end against a live Ollama on a sample laptop — **11th Gen Intel Core i9-11900H · 16 threads · 64 GB RAM · NVIDIA GeForce RTX 3070 Laptop GPU · 8192 MiB**, Ollama 0.32.3, embed `nomic-embed-text`, chat `qwen2.5:7b`. Timings come from Ollama's own `prompt_eval_duration`.

**Retrieval by file size** — chunk + embed once, then rank per question:

| Attachment | Chunks | Index build (one-time) | Warm query | Prompt vs full dump | Fact buried at 92% depth |
|---|--:|--:|--:|--:|:--|
| 128 KB (~33k tok) | 154 | 3.6 s | 77 ms | **−88%** | ✓ found |
| 512 KB (~131k tok) | 768 | 8.0 s | 127 ms | **−88%** | ✓ found |
| 2 MB (~524k tok) | 3,219 | 32.5 s | 118 ms | **−88%** | ✓ found |

The old behavior caps a file at 120 KB, so on the 2.0 MB file it only ever saw the first ~6% — and would miss a fact sitting at 92% depth. Retrieval indexes the whole file and found it every time, injecting ~4k tokens instead of ~31k.

**Time to first token** — `qwen2.5:7b`, 32k context:

| Prompt | Tokens | Prefill |
|---|--:|--:|
| Retrieved passages | 3,654 | **1.9 s** |
| Full dump (120 KB cap) | 26,713 | 17.9 s |

Retrieval reaches the first token **~9.5× sooner**. And a full manuscript (500k+ tokens) is far over a 32k window and can't be sent at all — retrieval is what makes it fit.

**Long chats stay open** — biggest attachment; retrieval holds the system prompt flat while history grows:

| Turns | System tok | History tok | Total | of 32k context |
|--:|--:|--:|--:|--:|
| 5 | 3,741 | 529 | 4,270 | 13% |
| 20 | 3,741 | 2,118 | 5,859 | 18% |
| 60 | 3,741 | 6,358 | 10,099 | 31% |

The system prompt stays constant as the conversation grows. With the old dump it would pin the system at ~31k tokens, so a long chat overflows the 32k window and older messages get trimmed.

> **Caveats.** The *first* index of a huge file scales with size (~32.5 s for the 2.0 MB file; one-time, cached until it changes). The index stores the chunked source **text** in plaintext under the data dir — gitignored, removed when you detach the attachment, and size-capped; `MECHAPE_RETRIEVAL=off` avoids it. Vectors are a sibling raw-binary Float32 file, not JSON-encoded text; a full index pair (text + vectors) currently runs ~5–6× the source (12.8 MB for the 2.0 MB doc). Warm-SSD read caching saves only sub-millisecond per message; the cache that matters is the index.

<sub>Auto-generated by `npm run bench` · last measured 2026-07-24.</sub>
<!-- BENCH:END -->

### Local backend (llama.cpp)
MechApe runs models itself — no separate daemon, no registry. Two loopback-only `llama-server` instances (chat + embed), each holding one model file at a time:
- **You own the binary, and it ships in the box.** The Vulkan and CPU builds of a specific, pinned `llama.cpp` release are fetched at *build* time (`npm run runtime`), SHA256-verified against the digest GitHub's own release API reports for that exact asset, and packaged inside the installer. So there's nothing to download on first launch and nothing is fetched-then-executed at runtime — which matters beyond convenience: an application that downloads an executable into a user-writable folder and runs it is behaviourally a malware dropper, and antivirus engines treat it as one. (Observed the hard way: Avast quarantined `llama-server.exe`, then Electron itself, while leaving the other 21 executables in the same folder alone.) Only the opt-in CUDA build is still downloaded, because it and its separate runtime come to ~640 MB.
- **It picks the right build for your hardware.** On Windows, MechApe probes the bundled Vulkan build (which enumerates every vendor's GPU) and then chooses: an **NVIDIA** card gets **CUDA → Vulkan → CPU**, anything else gets **Vulkan → CPU**. CUDA leads on NVIDIA because Vulkan's throughput there measured badly — on the laptop RTX 3070 this was developed against, full Vulkan offload generated *slower than CPU-only* (1.9 vs 15.3 tok/s). CUDA can't be bundled (its build plus its separately-packaged runtime come to ~640 MB), so choosing it costs a one-time download; AMD and Intel are never sent on that errand, since CUDA can't see their cards. Untick **Preferences → GPU acceleration** to stay on the bundled Vulkan build and download nothing. macOS uses the universal build with Metal compiled in; Linux is CPU-only in the pinned release for now.
- **And the right *GPU*, not just the right build.** On a laptop the integrated GPU usually enumerates first — and reports more memory than the discrete card, since it shares system RAM:
  ```
  Vulkan0: Intel(R) UHD Graphics            (32618 MiB, 48085 MiB free)
  Vulkan1: NVIDIA GeForce RTX 3070 Laptop   ( 8018 MiB,  7250 MiB free)
  ```
  Taking device 0 (llama.cpp's own default) or "the one with the most memory" both land on the *slow* one, so MechApe classifies by name and pins the discrete card explicitly. It re-checks on every launch, so plugging in an eGPU or updating a driver is picked up rather than cached. The probe is also deliberately biased toward keeping a GPU build: only a definite "this build sees no GPU" demotes it, never output the probe couldn't parse.
- **If a model won't load on the GPU, it retries on CPU** instead of failing the chat — most often when the weights plus the KV cache for your chosen context length don't fit in VRAM. That's session-only, so restarting gives the GPU another go rather than condemning you to CPU forever after one bad moment. Either way the status pill names what you're actually running on (**local models · CUDA**, **· Vulkan**, **· CPU**), because a silent downgrade would just feel like unexplained slowness.
- **You own the weights.** Models are plain `.gguf` files in your models folder, pulled straight from a Hugging Face repo (`owner/repo` or `owner/repo:QUANT` — e.g. `bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M`) via **Manage models**. No blob store, no opaque registry — see and move the files yourself.
- **Switching models respawns the chat instance** (kill, relaunch on the new file, wait for health) — transparent, a second or two, same place a context-length change also takes effect (context length is a `llama-server` launch flag, not a per-request option).
- Model picker per chat, streaming responses, stop button
- **↻ Retry** on the conversation's last reply — re-runs your last prompt (with the same invoked skills) under whatever model is currently selected, so you can switch models and compare takes; available after errors and Stop too
- **Edit & resend** any of *your own* past messages, not just the last one — right-click → **Edit & resend…** turns it into an inline textarea; saving discards it and everything after it (its own reply is expected — that's the point) and resends the edited text. Discarding more than that asks first
- **Copy or save a whole conversation as Markdown** — right-click a chat in the rail for **Copy as Markdown** (clipboard) or **Save as file…** (through the same folder-pick + filename flow as a per-message save). It's the real stored source, not a flattened render, so headings/code/links come out intact
- Health indicator in the sidebar
- Killed cleanly on quit — unlike the old Ollama integration (a shared system daemon, deliberately left running), the llama-server processes are MechApe's own and don't linger after the app closes

### Themes

Seven presets in **Preferences → Theme**, applied instantly and remembered (no restart, no flash on boot):

- **Dark** — Cyber Deco (default), Speakeasy Noir, Gothic Library, Midnight
- **Light** — Parchment, Daylight, Porcelain

The whole UI runs on CSS variables (every accent, glow, and surface derives from the theme's tokens), and all seven are contrast-checked to WCAG AA. Custom colors, fonts, a system-follow toggle, and density controls are on the [roadmap](ROADMAP.md).

### Optional: remote models (OpenRouter)

If your machine can't run the model your work needs, add an [OpenRouter](https://openrouter.ai) API key in **Preferences → Remote models** and the model picker grows an "OpenRouter — remote" group next to your local models. Browse the full catalog (☁ next to the picker) with context lengths and per-token prices, ★ the ones you want, and pick them per chat like any local model.

The trust model is explicit, not fine print:

- **Nothing goes remote unless you pick a remote model for a chat.** Local chats are untouched, and a fresh install has no key and makes no remote calls at all.
- **Privacy routing by default** — remote requests are restricted to providers that **don't log or train on prompts** (`data_collection: deny`); widen it in Preferences if you want more provider choice.
- Chats using a remote model send that chat's messages, project instructions, and attachments to openrouter.ai and the model's provider — a **☁ remote** badge sits beside the picker whenever that's the case.
- **Costs are visible**: every remote reply shows its exact $ cost and token counts, the chat header totals the conversation's spend, and Preferences shows what your key has used. (That readout means opening Preferences or the ☁ model browser with a key saved checks your balance with OpenRouter — key metadata only, never chat content, cached for a minute.)
- **Reasoning models work properly** — R1-class models stream their thinking into a collapsible block instead of appearing frozen; it's saved with the message.
- The browse dialog has a **"free only"** filter (the `:free` variants cost nothing, rate-limited), and a per-project `or_route` option routes to the cheapest (`floor`) or fastest (`nitro`) provider. On Claude/Gemini models the system prompt is **cache-marked** automatically — cache *writes* cost slightly more, but every following message in a session reads the instructions+attachments back at a deep discount, which is exactly MechApe's resend pattern.
- Retrieval embeddings stay **local-only**: large attachments are indexed on-device via MechApe's own embed instance even when the chat model is remote.
- The API key is stored OS-encrypted (DPAPI via Electron `safeStorage`), is only handed to the local server process, and never reaches the browser UI.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8113` | Web UI port |
| `MECHAPE_LLAMACPP_CHAT_URL` | `http://127.0.0.1:8114` | Chat `llama-server` instance address (always loopback — a non-loopback value is ignored). In headless `npm start`, point this at an instance you started yourself; the desktop app sets it automatically. |
| `MECHAPE_LLAMACPP_EMBED_URL` | `http://127.0.0.1:8115` | Embed `llama-server` instance address (same loopback rule). |
| `MECHAPE_LLAMACPP_BIN` | *(unset)* | Path to a `llama-server` executable. Set automatically by the desktop app once it's downloaded and verified one — leave unset in headless mode; auto-spawn/respawn only activates when this is set. |
| `MECHAPE_MODELS_DIR` | *(beside data dir)* | Where downloaded `.gguf` files live |
| `MECHAPE_SKILLS_DIR` | `./skills` | Where to scan for skills |
| `MECHAPE_FS_ROOTS` | *(unset)* | Semicolon-separated list of directories the file browser and attachments are restricted to, e.g. `C:\projects;D:\writing`. When unset, the **desktop app fences to your home folder** by default (manage it in Preferences → File access); a repo checkout (`npm start`) is whole-disk unless you set this. |
| `MECHAPE_RETRIEVAL` | `on` | Set to `off` to always include attachments whole (no embedding/retrieval) |
| `MECHAPE_EMBED_MODEL` | *(auto-detect)* | Force a specific installed `.gguf` embedding model by filename; otherwise the first installed embed model is used |
| `MECHAPE_EMBED_DIR` | *(beside data dir)* | Where the on-disk embedding indexes are stored |
| `MECHAPE_OPENROUTER_KEY` | *(unset)* | OpenRouter API key enabling optional remote models. In the desktop app, set it in Preferences → Remote models instead (stored OS-encrypted); the env var overrides that. Unset = fully local. |
| `MECHAPE_OR_DATA_COLLECTION` | `deny` | Remote privacy routing: `deny` restricts remote chats to providers that don't log/train on prompts; `allow` widens provider choice. Toggle in Preferences → Remote models. |

## Security

MechApe is a single-user local app, hardened accordingly:

- **Loopback only, everywhere** — not just the web server: both `llama-server` instances are always launched with `--host 127.0.0.1`, hardcoded, never derived from an env value that could point them wider.
- **Verified before it ever runs** — the downloaded `llama-server` binary is checked against a SHA256 digest fetched from GitHub's own release API for that exact, pinned asset (a second, independent HTTPS request) before extraction; a mismatch is refused, not warned about.
- **Model downloads are pinned and sanitized** — pulling a model is one HTTPS request to a hardcoded `huggingface.co` host; the resolved filename is validated (`.gguf` suffix required, no path separators or `..`) before it ever touches the filesystem, and a failed/aborted download is written to a temp file and never renamed into place, so a partial pull can't masquerade as an installed model.
- **No orphaned processes** — the chat and embed instances are MechApe's own, tracked by PID across the process boundary (a parent-initiated kill on Windows doesn't let a child clean up after itself — see `electron/server.js`) and force-killed on quit or restart.
- **Loopback only** — the server binds `127.0.0.1`; it is never reachable from the network.
- **DNS-rebinding protection** — requests with a `Host` header other than `localhost`/`127.0.0.1` are rejected, so a malicious website that points its own domain at your loopback address gets a 403.
- **CSRF protection** — cross-origin requests (any `Origin` other than the app's own) are rejected.
- **Content Security Policy** — scripts run from the app's own origin only; no eval, no inline scripts, no third-party script sources. Plus `nosniff`, `no-referrer`, and a locked-down `Permissions-Policy`.
- **Filesystem scoping** — the desktop app fences browsing, attachment reads, file preview, and "Save as file…" to your **home folder by default** (widen it in Preferences → File access: add folders or allow the whole disk). `MECHAPE_FS_ROOTS` overrides it; the check runs on every read and write, and resolves realpath so a symlink/junction can't escape the allowlist. A saved filename is validated as a single path segment (no `\`, `/`, or `..`) server-side regardless of what the client sends, and previews sniff for binary content and refuse to render it rather than sending raw bytes to the browser.
- **Input validation** — project/skill ids are strictly validated (no path traversal), all model output is HTML-escaped before rendering, and errors return generic JSON with no stack traces.
- **Untrusted attachments** — attached files and retrieved passages are wrapped as clearly-marked *untrusted reference data*, with an explicit instruction to the model to treat them as content and never obey instructions found inside them; content that reads like an injection (e.g. "ignore previous instructions", forged `System:`/`Assistant:` turns) is flagged in the prompt's attachment notes.
- **Remote backend guarded** — with no OpenRouter key configured, the server refuses remote-model requests outright (nothing is ever sent with an empty key, even for a stale chat that still names a remote model); the key is OS-encrypted at rest, handed only to the local server process, never exposed to the browser UI, and provider streams are size-capped and translated at one boundary.
- **On-disk retrieval cache** — when a large attachment is searched (see [retrieval](#large-attachments-retrieval-instead-of-overflow)), its embedding index is written under `EMBED_DIR` (default beside your data dir; `%APPDATA%\MechApe\embeddings` for the installed app). That index contains the chunked source **text in plaintext**, like your chats — so it's gitignored, deleted when you detach the attachment or delete the project, and size-capped (least-recently-used eviction). `MECHAPE_RETRIEVAL=off` disables it entirely, and directory junctions inside an attached folder can't escape `MECHAPE_FS_ROOTS`.

Your chats and project data stay on your disk. UI fonts are bundled locally (no Google Fonts requests), so out of the box the **only** outbound connections are ones you explicitly caused: downloading `llama-server` itself (once, verified) and pulling a model you asked for (from Hugging Face). [Remote models via OpenRouter](#optional-remote-models-openrouter) are the one other exception, and only ever affect chats where you explicitly picked a remote model — and say so with a badge.

The desktop shell adds its own hardening: sandboxed renderer with context isolation, a navigation guard (the window can only ever display the app — external links open in your real browser), all web permission requests (camera, mic, location…) denied, and preferences IPC that only accepts calls from the app's own pages.

## Roadmap

MechApe's plans live in **[ROADMAP.md](ROADMAP.md)** — grouped by the promise each item serves: keeping it **local-first**, **honest**, and **yours**. The guiding rule for everything there: nothing ever *requires* an account, a cloud service, or sending your data off the machine — anything remote is opt-in, per chat, and labeled.

A few of what's next: branching an alternate take without losing the original, theming (custom colors, fonts, a system-follow toggle), and completion notifications. (Search across chats & projects, backup & wipe controls, local retrieval over big attachments, and optional remote models via OpenRouter have already shipped.) See the [full roadmap →](ROADMAP.md)

## Layout

```
server.js               entry point: middleware, routers, listen
lib/
  config.js             env + constants (ports, paths, context budgets)
  security.js           Host/Origin validation, CSP, fs allowlist
  store.js              project JSON persistence
  skills.js             SKILL.md discovery + frontmatter parsing
  attachments.js        reading knowledge from disk (cached by size+mtime)
  knowledge.js          per-attachment dump-vs-retrieve orchestration
  retrieval.js          on-device embeddings + persisted index + top-K search
  prompt.js             system prompt assembly
  llamacpp.js           llama.cpp HTTP client + process supervision (spawn/respawn) + HF model pulls
  gguf.js                bounds-checked GGUF header reader (model metadata, no server round-trip)
  sse.js                 shared OpenAI-style SSE → NDJSON translator (llamacpp + openrouter)
  openrouter.js          optional remote backend (OpenRouter)
  stream.js             NDJSON tee helper (chat + pull share it)
  tokens.js             rough token estimate
  options.js            generation-option sanitizer (Ollama-shaped, backend-agnostic)
  log.js                error logging to a rotating file
routes/
  projects.js           projects / chats / attachments CRUD
  skills.js             skill listing endpoints
  fs.js                 file-browser listings, file preview, write-to-disk
  search.js             search across project names, chat titles, messages
  models.js              health, models, streaming chat
public/
  index.html            single-page UI shell
  style.css             the seven themes (CSS-variable presets)
  js/                   ES modules, one per feature:
    main.js             wiring + startup
    state.js            shared client state
    api.js              JSON fetch client
    util.js             DOM helpers ($, esc, toast)
    markdown.js         safe markdown renderer
    status.js           health indicator + model list
    skills.js           skill catalog, toggles + "/" invocation
    skill-create.js     adding skills: template, model-written, import
    search.js           search across projects/chats/messages, jump-to-result
    model-settings.js   per-project generation options (context, temperature, advanced)
    views.js            main-area view switching (welcome / projects / chat)
    modal.js            shared open/close behavior for backdrop modals
    ctxmenu.js          right-click menus (chats, projects, messages, skills)
    projects.js         projects page, lifecycle + inspector
    attachments.js      project & chat knowledge: attach, detach, index status
    filebrowser.js      the generic "pick a file/folder from this machine" modal
    filepreview.js      read-only preview of a file on disk
    savefile.js         "Save as file…": write chat content to disk
    chat.js             messages, streaming, stop
    context-meter.js    live token/context estimate in the composer
    model-manager.js    pull / delete / disk usage for local (.gguf) models
    model-info.js       selected-model size, specs + usage recommendation
    model-bootstrap.js  first-run offers to pull a chat model + the retrieval embed model
    prefs.js            preferences panel (storage folders; desktop app only)
skills/                 your skills (3 samples included)
data/projects/          project + chat storage (JSON, gitignored)
electron/               desktop shell, one module per concern
  main.js               entry point: window + app lifecycle
  runtime.js            shared state (window, server process, port)
  settings.js           settings.json + storage-location resolution
  dialogs.js            native-dialog helpers
  llamacpp.js           download + SHA256-verify the llama-server binary
  server.js             fork/wait/restart of the Express server + llama-server PID tracking
  menu.js               app menu with live Projects & Skills submenus
  prefs-ipc.js          preferences IPC (validated senders)
  preload.js            contextBridge exposed to the web UI
  loading.html          themed splash shown while the server boots
  build/                icon assets + installer resources
```

Each module carries a header comment explaining its responsibility.

## License

MIT — see [LICENSE](LICENSE). Fork it, skin it, teach it new tricks; just keep the copyright notice attached.

