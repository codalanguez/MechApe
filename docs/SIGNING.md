# Code signing

MechApe's Windows releases are signed by [SignPath Foundation][foundation],
which provides free code-signing certificates to open-source projects.

## Why this is not optional

MechApe ships `llama-server.exe` and its GPU backend DLLs inside the
installer. That binary is small, unsigned by upstream, and opens a listening
socket — which is, behaviourally, indistinguishable from what a malware
dropper does. Heuristic scanners are built to notice exactly that shape.

This is not hypothetical. During development, Avast quarantined
`llama-server.exe` on the build machine, then `electron.exe`, then the app's
own executable, while leaving the other twenty-one executables in the same
folder untouched. Adding an exclusion did not clear it, because the block was
cached in the running service rather than in the chest.

Two changes address it, and only together:

1. **Bundling the runtime in the installer** (`scripts/fetch-runtime.js`)
   removes the download-then-execute pattern entirely. Done.
2. **Signing every binary**, which is what this document covers. A valid
   Authenticode signature gives the file an identity that reputation systems
   and SmartScreen can accumulate trust against.

Signing only the installer is not enough. The file that gets quarantined is
`llama-server.exe` *after* installation, so it has to carry its own
signature. `.github/workflows/release.yml` therefore signs in two passes: the
unpacked application first, then the installer built from those signed files.

## Applying to SignPath Foundation

Apply at <https://signpath.org/apply>. What they check, and where MechApe
stands:

| Requirement | Status |
| --- | --- |
| OSI-approved license | MIT |
| Public source repository | `github.com/codalanguez/MechApe` |
| Build runs in a trusted CI, from public source | GitHub Actions, `release.yml` |
| No commercial distribution of the signed binary | Free and open source |
| A real, useful project rather than a placeholder | Judgement call; link the README and the site |

Review is manual and takes a while — plan on weeks, not days. Nothing below
can be configured until the application is approved.

**The origin verification is the part worth understanding.** SignPath does not
accept an uploaded file. It reaches back into the workflow run through the
GitHub API and pulls the artifact itself, then checks that the run came from
the repository, branch, and workflow registered with the project. That is why
the build has to happen in CI, and why a locally built installer can never be
signed with this certificate — by design.

## Configuring the SignPath project

Once approved, in the SignPath web UI:

1. Create a project. Note its **slug** — that is `SIGNPATH_PROJECT_SLUG`.
2. Add a **trusted build system** for GitHub Actions and link the repository.
3. Create two **artifact configurations**, named exactly as the workflow
   expects:

   - `unpacked-app` — a zip whose PE files all get signed
   - `installer` — a single PE file

4. Create a **signing policy** (typically `release-signing`) and grant the
   GitHub Actions build system permission to submit against it. Its slug is
   `SIGNPATH_SIGNING_POLICY_SLUG`.
5. Generate an **API token** for CI submission.

The artifact configuration is XML written in SignPath's own schema. For the
unpacked app it needs to recurse the zip and Authenticode-sign every `.exe`
and `.dll`; for the installer it is a single `pe-file` entry. The shape is
roughly:

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <for-each filter="**/*.exe;**/*.dll">
      <pe-file>
        <authenticode-sign />
      </pe-file>
    </for-each>
  </zip-file>
</artifact-configuration>
```

> Treat that as a starting point, not a copy-paste. The schema is versioned and
> SignPath's own artifact-configuration reference is authoritative — check it
> against their docs before saving. The editor validates as you type, and a
> misconfigured filter fails loudly at submission time rather than silently
> shipping unsigned files.

## Configuring GitHub

The workflow reads one secret and three variables. In
**Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `SIGNPATH_API_TOKEN` | The CI API token |
| Variable | `SIGNPATH_ORGANIZATION_ID` | Organization GUID from the SignPath UI |
| Variable | `SIGNPATH_PROJECT_SLUG` | The project slug |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | e.g. `release-signing` |

Only the token is a secret; the other three are identifiers, not credentials,
and keeping them as variables makes failed runs far easier to read.

## Cutting a release

```bash
npm version minor        # or patch/major — updates package.json and tags
git push --follow-tags
```

The tag triggers the workflow, which refuses to proceed if the tag and
`package.json` version disagree. It then runs the tests, fetches and
SHA256-verifies the llama.cpp runtime, builds, signs both passes, and opens a
**draft** release with the installer and a `SHA256SUMS.txt`.

The release is left as a draft on purpose: install it on a real machine and
launch it once before publishing.

## Before approval comes through

The workflow does not fail without the secret. It detects that signing is
unconfigured, skips both passes, emits a warning, and publishes an unsigned
installer with the draft release notes saying so plainly. Releases stay
possible while the application is pending — they just carry the SmartScreen
warning until they don't.

## Verifying a signature

```powershell
Get-AuthenticodeSignature 'MechApe Setup 1.11.2.exe' | Format-List Status, SignerCertificate
```

`Status` must be `Valid`. The workflow already asserts this for
`llama-server.exe` inside the unpacked app and fails the build if it is not,
so a green run means the binary that caused the original problem is genuinely
signed — not merely that SignPath returned a file.

Note that a fresh certificate carries no SmartScreen reputation yet. Early
downloads may still see a warning; it fades as install volume accumulates
against the consistent signing identity. That is expected and is not a
misconfiguration.

[foundation]: https://signpath.org/
