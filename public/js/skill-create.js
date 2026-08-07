/**
 * skill-create.js — the three ways of adding a skill.
 *
 * Drives the create form inside the skills modal:
 *   - blank scaffold from the built-in template,
 *   - instructions written by a local model (name + description = the brief),
 *   - import of an existing skill folder via the file browser.
 * Model choice is ranked: proven instruct families at GPU-friendly sizes
 * first; reasoning models (their <think> output pollutes files), embedders,
 * and cloud models rank low or are excluded.
 */
import { $, esc, toast } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { openBrowser } from './filebrowser.js';
import { loadSkills, renderSkillToggles } from './skills.js';

function rankModelsForWriting(models) {
  return models
    .filter(m => !/embed/i.test(m.name))
    .map(m => {
      let score = 0;
      if (/qwen|llama3|mistral|gemma|phi/i.test(m.name)) score += 3;
      if (m.size >= 1.5e9 && m.size <= 10e9) score += 2;
      if (m.size > 15e9) score -= 2;
      if (/r1|reason|think|magistral/i.test(m.name)) score -= 2;
      if (/cloud/i.test(m.name)) score -= 3;
      return { model: m, score };
    })
    .sort((a, b) => b.score - a.score || b.model.size - a.model.size)
    .map(r => r.model);
}

function fillModelSelect() {
  const sel = $('#ns-model');
  const ranked = rankModelsForWriting(state.models);
  if (!ranked.length) {
    sel.innerHTML = '<option value="">no models installed — pull one from Manage models</option>';
    return;
  }
  sel.innerHTML = ranked.map((m, i) =>
    `<option value="${esc(m.name)}">${i === 0 ? '★ ' : ''}${esc(m.name)}${i === 0 ? ' (recommended)' : ''}</option>`
  ).join('');
}

export function showSkillCreateForm() {
  fillModelSelect();
  hideImportConflict(); // the two forms share the modal footer's space; only one at a time
  $('#skill-create').hidden = false;
  $('#ns-name').focus();
}

/** After any successful add: close the form, refresh the catalog, announce. */
async function skillAdded(message) {
  $('#ns-name').value = '';
  $('#ns-desc').value = '';
  $('#skill-create').hidden = true;
  await loadSkills();
  renderSkillToggles();
  toast(message);
}

/* Shared submit path: `generate` decides template scaffold vs. model-written
 * instructions. */
async function submitNewSkill(generate) {
  const name = $('#ns-name').value.trim();
  const description = $('#ns-desc').value.trim();
  if (!name) { toast('Give the skill a name', true); return; }
  if (generate && !description) { toast('Describe what the skill should do — that is the model’s brief', true); return; }
  const model = $('#ns-model').value;
  if (generate && !model) { toast('No model available — pull one first from Manage models', true); return; }

  const genBtn = $('#btn-generate-skill');
  const buttons = document.querySelectorAll('#skill-create button');
  buttons.forEach(b => { b.disabled = true; });
  if (generate) genBtn.textContent = 'Generating…';
  try {
    const created = generate
      ? await api('/api/skills/generate', { method: 'POST', body: { name, description, model } })
      : await api('/api/skills', { method: 'POST', body: { name, description } });
    await skillAdded(generate
      ? `Skill /${created.id} written by ${model} — review its SKILL.md before relying on it`
      : `Skill /${created.id} created from the template — edit its SKILL.md to write the instructions`);
  } catch (e) { toast(e.message, true); }
  finally {
    buttons.forEach(b => { b.disabled = false; });
    genBtn.textContent = '✦ Create with model';
  }
}

let conflictPath = null; // the source path awaiting a replace/rename decision

function hideImportConflict() {
  conflictPath = null;
  $('#skill-import-conflict').hidden = true;
  $('#sic-newid').value = '';
}

function showImportConflict(path, id) {
  conflictPath = path;
  $('#skill-create').hidden = true; // the two forms share the modal footer's space; only one at a time
  $('#sic-message').textContent = `A skill named "${id}" already exists — replace it with this one, or import it under a different name?`;
  $('#sic-newid').value = `${id}-2`;
  $('#btn-sic-rename').disabled = false;
  $('#skill-import-conflict').hidden = false;
}

async function attemptImport(path, opts = {}) {
  try {
    const s = await api('/api/skills/import', { method: 'POST', body: { path, ...opts } });
    hideImportConflict();
    await skillAdded(s.already ? `Skill /${s.id} is already in your skills folder`
      : opts.force ? `Skill /${s.id} replaced` : `Skill /${s.id} imported`);
  } catch (e) {
    const m = e.message.match(/^skill "([^"]+)" already exists$/);
    if (m && !opts.force && !opts.asId) showImportConflict(path, m[1]);
    else toast(e.message, true);
  }
}

export function importSkillFlow() {
  openBrowser({
    title: 'Import a skill folder or .skill file',
    verb: 'import',
    dirLabel: 'Import this folder',
    onPick: (p) => attemptImport(p),
  });
}

/** Bind the modal's create-form controls (called once from main.js). */
export function initSkillCreate() {
  $('#btn-new-skill').addEventListener('click', showSkillCreateForm);
  $('#btn-import-skill').addEventListener('click', importSkillFlow);
  $('#btn-cancel-skill').addEventListener('click', () => { $('#skill-create').hidden = true; });
  $('#btn-create-skill').addEventListener('click', () => submitNewSkill(false));
  $('#btn-generate-skill').addEventListener('click', () => submitNewSkill(true));
  const onEnter = (e) => { if (e.key === 'Enter') submitNewSkill(true); };
  $('#ns-name').addEventListener('keydown', onEnter);
  $('#ns-desc').addEventListener('keydown', onEnter);

  $('#btn-sic-replace').addEventListener('click', () => attemptImport(conflictPath, { force: true }));
  $('#btn-sic-rename').addEventListener('click', () => attemptImport(conflictPath, { asId: $('#sic-newid').value.trim() }));
  $('#btn-sic-cancel').addEventListener('click', hideImportConflict);
  $('#sic-newid').addEventListener('input', () => { $('#btn-sic-rename').disabled = !$('#sic-newid').value.trim(); });
  $('#sic-newid').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#btn-sic-rename').disabled) $('#btn-sic-rename').click(); });
}
