/**
 * test-desktop-settings.js — the desktop shell's OpenRouter key states.
 *
 * Run under Electron, not node: safeStorage is what these tests are about.
 *
 *     npm run test:desktop
 *
 * (That is also why this one is not part of `npm test` — it needs an
 * Electron app instance, where the rest of the suite is plain node.)
 *
 * The state worth testing is 'unreadable': a saved key whose ciphertext this
 * install cannot open. It happens for real — the rename migration in
 * electron/main.js copies settings.json from the previous app's %APPDATA%
 * folder, and safeStorage on Windows encrypts with an AES key that lives in
 * that folder's "Local State" file, which does not come along. Reading that
 * as "no key configured" is what made an upgraded install come up silently
 * local, with remote models missing and nothing anywhere saying why.
 *
 * Everything runs against a throwaway userData dir, so a developer's real
 * settings are never touched.
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-settings-test-'));
app.setPath('userData', tmp);

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`);
  if (!cond) failures++;
};

const settingsFile = path.join(tmp, 'settings.json');
const write = (o) => fs.writeFileSync(settingsFile, JSON.stringify(o, null, 2));
const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

app.whenReady().then(() => {
  const s = require('../electron/settings');

  if (!safeStorage.isEncryptionAvailable()) {
    console.log('OS encryption unavailable — these tests cannot say anything. Skipping.');
    return app.exit(0);
  }

  /* ---- a key encrypted by some other install ---- */
  write({ openrouterKey: Buffer.from(`v10${'x'.repeat(80)}`).toString('base64'), dataDir: tmp });
  check("an undecryptable blob reports 'unreadable'", s.openrouterKeyState() === 'unreadable');
  check('...and is never mistaken for a configured key', s.openrouterConfigured() === false);
  check('the audit clears it, and says it did', s.auditOpenRouterKey() === true);
  check('...the dead blob is gone', read().openrouterKey === undefined);
  check('...the loss is remembered, so Preferences can explain it', s.openrouterKeyLost() === true);
  check('...a second audit finds nothing left to do', s.auditOpenRouterKey() === false);
  check('...and nothing else in settings was disturbed', read().dataDir === tmp);

  /* ---- a key saved by this install ---- */
  s.setOpenRouterKey('sk-or-v1-test-key');
  check("a key saved here reports 'settings'", s.openrouterKeyState() === 'settings');
  check('...and counts as configured', s.openrouterConfigured() === true);
  check('...and retires the lost-key notice', s.openrouterKeyLost() === false);
  check('...the audit leaves a good key alone', s.auditOpenRouterKey() === false && read().openrouterKey !== undefined);
  check('...and it never lands in the file as plaintext', !fs.readFileSync(settingsFile, 'utf8').includes('sk-or-v1-test-key'));

  /* ---- no key: the fully-local default ---- */
  s.setOpenRouterKey('');
  check("no key at all reports 'none'", s.openrouterKeyState() === 'none');
  check('...and the audit is a no-op', s.auditOpenRouterKey() === false);

  /* ---- the env override ---- */
  s.setOpenRouterKey('sk-or-v1-saved-key');
  process.env.MECHAPE_OPENROUTER_KEY = 'sk-or-v1-from-env';
  check("MECHAPE_OPENROUTER_KEY reports 'env'", s.openrouterKeyState() === 'env');
  check('...and puts the saved key at no risk', s.auditOpenRouterKey() === false && read().openrouterKey !== undefined);
  delete process.env.MECHAPE_OPENROUTER_KEY;

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} desktop settings test(s) FAILED` : '\nall desktop settings tests passed');
  app.exit(failures ? 1 : 0);
}).catch((e) => {
  console.error(e);
  app.exit(1);
});
