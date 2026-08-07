/**
 * main.js — entry point: event wiring and startup.
 *
 * Imports every feature module, binds all buttons/keyboard handlers exactly
 * once (grouped by area below), then boots: check the local backend's
 * health, load models and skills, and land on the projects page. Also
 * schedules the recurring health poll (15s).
 */
import { $, autoGrow } from './util.js';
import { state } from './state.js';
import { checkHealth, loadModels, updateRemoteBadge } from './status.js';
import { initOpenRouter, refreshOrStatus } from './openrouter.js';
import { loadSkills, updateSkillPopup, pickSkill, renderSkillToggles, handleSkillPopupKey, initSkillDetailActions } from './skills.js';
import { initSkillCreate, showSkillCreateForm, importSkillFlow } from './skill-create.js';
import { createProject, openProject, saveProjectMeta, deleteProject, showProjectsPage, quickChat } from './projects.js';
import { browseTo, closeBrowser, pickCurrentDir, commitSelection } from './filebrowser.js';
import { attachToProject, attachToChat } from './attachments.js';
import { newChat, send, clearChat } from './chat.js';
import { initOverflowDialog } from './overflow.js';
import { initModal } from './modal.js';
import { initPrefs } from './prefs.js';
import { initContextMenus } from './ctxmenu.js';
import { initModelSettings } from './model-settings.js';
import { initModelManager, openModelManager } from './model-manager.js';
import { updateMeter } from './context-meter.js';
import { checkModels } from './model-bootstrap.js';
import { initHelpAbout } from './about.js';
import { initConfirm } from './confirm.js';
import { initFilePreview } from './filepreview.js';
import { initSaveFile } from './savefile.js';
import { initSearch, openSearch } from './search.js';

function wireNavigation() {
  $('#btn-new-project').addEventListener('click', createProject);
  $('#btn-welcome-project').addEventListener('click', createProject);
  $('#btn-projects-page').addEventListener('click', showProjectsPage);
  $('#chat-project-name').addEventListener('click', showProjectsPage);
  $('#btn-quick-chat').addEventListener('click', quickChat);
  $('#btn-welcome-quick').addEventListener('click', quickChat);
  $('#btn-new-chat').addEventListener('click', newChat);
  $('#btn-clear-chat').addEventListener('click', () => clearChat());
  $('#btn-search').addEventListener('click', openSearch);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      if (document.querySelector('.modal-backdrop:not([hidden]):not(#search-backdrop)')) return; // another modal is already up
      e.preventDefault();
      openSearch();
    }
  });
}

/** Skills modal, opened from the inspector, the rail, or the desktop menu. */
function wireSkillsModal() {
  const modal = initModal('#skills-backdrop', '#btn-close-skills');
  const open = () => { renderSkillToggles(); modal.open(); };
  $('#btn-open-skills').addEventListener('click', open);
  $('#btn-skills-page').addEventListener('click', open);
  initModal('#skill-detail-backdrop', '#btn-close-skill-detail'); // detail view (opened from a skill name)
  initSkillDetailActions();
  initSkillCreate();
  return open;
}

/** Actions arriving from the desktop shell's menu bar (preload bridge). */
function wireDesktopMenu(openSkillsModal, openModels) {
  if (!window.mechape?.onMenuAction) return;
  window.mechape.onMenuAction(({ type, id }) => {
    if (type === 'new-project') createProject();
    else if (type === 'open-project') openProject(id);
    else if (type === 'pick-skill') pickSkill(id);
    else if (type === 'new-skill') { openSkillsModal(); showSkillCreateForm(); }
    else if (type === 'import-skill') { openSkillsModal(); importSkillFlow(); }
    else if (type === 'manage-models') openModels();
    else if (type === 'preferences') $('#btn-prefs').click();
    else if (type === 'help') $('#btn-help').click();
    else if (type === 'about') $('#btn-about').click();
  });
}

function wireModelSettings() {
  const settings = initModal('#model-settings-backdrop', '#btn-close-model-settings');
  initModelSettings(settings.open);
  initModal('#model-manager-backdrop', '#btn-close-model-manager');
  initModelManager();
  $('#btn-open-model-manager').addEventListener('click', openModelManager);
  initOpenRouter();
  // keep the "☁ remote" chip honest whenever the model choice changes
  $('#model-select').addEventListener('change', updateRemoteBadge);
  return openModelManager;
}

function wireInspector() {
  // the project panel opens from a right-edge pull-tab; closing reveals the tab
  const openPanel = () => { $('#inspector').hidden = false; $('#inspector-tab').hidden = true; };
  const closePanel = () => { $('#inspector').hidden = true; $('#inspector-tab').hidden = false; };
  $('#inspector-tab').addEventListener('click', openPanel);
  $('#btn-close-inspector').addEventListener('click', closePanel);
  $('#proj-name').addEventListener('change', saveProjectMeta);
  $('#proj-instructions').addEventListener('change', saveProjectMeta);
  $('#btn-delete-project').addEventListener('click', deleteProject);
}

function wireFileBrowser() {
  // the plain "Attach from this machine" entry point: project-level Knowledge
  $('#btn-browse').addEventListener('click', attachToProject);
  $('#btn-close-browser').addEventListener('click', closeBrowser);
  $('#btn-fb-drives').addEventListener('click', () => browseTo('__drives__'));
  $('#btn-attach-dir').addEventListener('click', pickCurrentDir);
  $('#btn-fb-attach-selected').addEventListener('click', commitSelection);
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeBrowser(); });
  initFilePreview(); // file rows in the browser preview on click
  initSaveFile();
  initSearch();
}

function wireComposer() {
  $('#btn-attach-chat').addEventListener('click', attachToChat);
  $('#btn-send').addEventListener('click', () => send()); // no event arg — it would be read as bypassOverflow
  $('#btn-stop').addEventListener('click', () => state.abort && state.abort.abort());

  const input = $('#input');
  input.addEventListener('input', () => { autoGrow(input); updateSkillPopup(); updateMeter(); });
  input.addEventListener('keydown', (e) => {
    if (handleSkillPopupKey(e)) return; // "/" popup owns Tab/Enter/arrows/Esc while open
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
}

async function init() {
  initConfirm();
  initPrefs();
  initContextMenus();
  wireNavigation();
  wireDesktopMenu(wireSkillsModal(), wireModelSettings());
  wireInspector();
  wireFileBrowser();
  wireComposer();
  initHelpAbout();
  initOverflowDialog(send, newChat);

  // orStatus first: loadModels needs to know whether remote favorites belong
  // in the picker
  await Promise.all([checkHealth(), refreshOrStatus().then(loadModels), loadSkills()]);
  await showProjectsPage(); // land on the all-projects page (welcome if none)
  checkModels(); // first-run: offer a chat model and the retrieval embed model if missing
  setInterval(checkHealth, 15000);
}

init();
