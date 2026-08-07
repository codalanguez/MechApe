/**
 * menu.js — the application menu, including live Projects & Skills submenus.
 *
 * The MechApe menu mirrors app data: its Projects and Skills submenus are
 * built from the server's own API, so the menu is rebuilt whenever the window
 * regains focus (wired in main.js) and after boot or a server restart.
 * Item clicks are forwarded to the web UI over the 'menu:action' IPC channel
 * (received in public/js/main.js via the preload bridge).
 */
const { Menu, shell } = require('electron');
const runtime = require('./runtime');
const { effectiveStorage, logDir } = require('./settings');

const MENU_LIST_LIMIT = 25; // native menus get unwieldy past this

/** GET a JSON endpoint from our own server; null on any failure. */
async function apiGet(pathname) {
  try {
    const r = await fetch(`http://127.0.0.1:${runtime.serverPort}${pathname}`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Tell the web UI to perform a menu-chosen action (open project, etc.). */
function sendToUI(type, id) {
  runtime.win?.webContents.send('menu:action', { type, id });
}

function projectsSubmenu(projects) {
  const items = projects.slice(0, MENU_LIST_LIMIT).map(p => ({
    label: p.name,
    sublabel: `${p.chatCount} chat${p.chatCount === 1 ? '' : 's'}`,
    click: () => sendToUI('open-project', p.id),
  }));
  return [
    { label: 'New Project', click: () => sendToUI('new-project') },
    { type: 'separator' },
    ...(items.length ? items : [{ label: 'No projects yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Open Projects Folder', click: () => shell.openPath(effectiveStorage().dataDir) },
  ];
}

function skillsSubmenu(skills) {
  const items = skills.slice(0, MENU_LIST_LIMIT).map(s => ({
    label: `/${s.id}`,
    sublabel: (s.description || '').slice(0, 60),
    click: () => sendToUI('pick-skill', s.id),
  }));
  return [
    { label: 'New Skill…', click: () => sendToUI('new-skill') },
    { label: 'Import Skill…', click: () => sendToUI('import-skill') },
    { type: 'separator' },
    ...(items.length ? items : [{ label: 'No skills found', enabled: false }]),
    { type: 'separator' },
    { label: 'Open Skills Folder', click: () => shell.openPath(effectiveStorage().skillsDir) },
    { label: 'Refresh', click: () => buildMenu() },
  ];
}

async function buildMenu() {
  let projects = [];
  let skills = [];
  if (runtime.serverProc) {
    projects = (await apiGet('/api/projects')) || [];
    skills = ((await apiGet('/api/skills')) || {}).skills || [];
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'MechApe',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://localhost:${runtime.serverPort}`),
        },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () => sendToUI('preferences'),
        },
        {
          label: 'Manage Models…',
          click: () => sendToUI('manage-models'),
        },
        {
          label: 'Open Models Folder',
          click: () => shell.openPath(effectiveStorage().modelsDir),
        },
        { type: 'separator' },
        { label: 'Projects', submenu: projectsSubmenu(projects) },
        { label: 'Skills', submenu: skillsSubmenu(skills) },
        { type: 'separator' },
        { label: 'Open Logs Folder', click: () => shell.openPath(logDir()) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Help & FAQ', click: () => sendToUI('help') },
        { label: 'About MechApe', click: () => sendToUI('about') },
        { type: 'separator' },
        { label: 'GitHub Repository', click: () => shell.openExternal('https://github.com/codalanguez/MechApe') },
        { label: 'Read the README', click: () => shell.openExternal('https://github.com/codalanguez/MechApe#readme') },
      ],
    },
  ]));
}

module.exports = { buildMenu };
