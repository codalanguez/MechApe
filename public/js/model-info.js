/**
 * model-info.js — an info box for the selected model.
 *
 * Shows size, parameter count, quantization, and trained context length
 * (fetched from /api/models/info) plus a plain-language usage recommendation
 * derived from the model's size, name, and capabilities — including a heads-up
 * when a model is large enough to load slowly on a modest machine.
 */
import { $, fmtBytes, fmtCtx, fmtPerM } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { orFavorites, isRemoteModel, OR_PREFIX } from './openrouter.js';

const fmtCtxLabel = (n) => n ? `${fmtCtx(n)} context` : '';

/** Single source of truth for what a model is, from its name + capabilities. */
function detectTraits(name, caps) {
  const n = name.toLowerCase();
  return {
    embed: /embed/.test(n),
    vision: caps.includes('vision') || /llava|vision|-vl\b|moondream|minicpm-v|bakllava/.test(n),
    code: /cod(e|er)|starcoder|deepseek-coder|qwen[\w.-]*coder|codestral/.test(n),
    reasoning: caps.includes('thinking') || /\br1\b|reason|magistral|qwq|deepseek-r1/.test(n),
    creative: /writer|story|novel|prose|roleplay|\brp\b|mytho|nemo|fusion|character|author/.test(n),
    tools: caps.includes('tools'),
  };
}

/** Task strengths, from the detected traits. */
function usesFor(t) {
  if (t.embed) return ['embeddings & search (not chat)'];
  const uses = [t.creative ? 'creative writing' : 'general chat & writing'];
  if (t.code) uses.push('coding');
  if (t.reasoning) uses.push('reasoning & math');
  if (t.vision) uses.push('reading images');
  if (t.tools) uses.push('tool use / agents');
  return uses;
}

/** A one-sentence usage recommendation from size and traits. */
function recommend(size, t) {
  if (t.embed) return 'Embedding model — produces vectors, not chat replies. Not usable as a chat model here.';

  const gb = (size || 0) / 1e9;
  let base;
  if (gb === 0) base = 'Size unknown.';
  else if (gb < 2) base = 'Small and fast — great for quick tasks and low-resource machines; may struggle with hard reasoning.';
  else if (gb < 6) base = 'A balanced all-rounder — good quality and speed on most machines.';
  else if (gb < 15) base = 'Higher quality, but wants a capable GPU (≈12 GB+ VRAM) to stay responsive.';
  else base = 'Large — top quality but slow without a strong GPU (≈24 GB+ VRAM); expect longer load times.';

  const tags = [];
  if (t.vision) tags.push('accepts images');
  if (t.tools) tags.push('supports tool calls');
  if (t.reasoning) tags.push('a reasoning model — thinks step by step, so slower and more verbose');
  if (t.code) tags.push('tuned for code');
  return tags.length ? `${base} Also ${tags.join(', ')}.` : base;
}

/** Remote (OpenRouter) models: specs come from the catalog/favorites, and the
 * recommendation is honest about where the text goes. */
function updateRemoteInfo(name) {
  const id = name.slice(OR_PREFIX.length);
  const m = (state.orCatalog || []).find(x => x.id === id)
    || orFavorites().find(x => x.id === id)
    || { id };
  const perM = (p) => fmtPerM(p, null);
  $('#mi-name').textContent = m.name || id;
  $('#mi-specs').textContent = [
    fmtCtxLabel(m.contextLength),
    perM(m.promptPrice) ? `${perM(m.promptPrice)} in / ${perM(m.completionPrice)} out per M tokens` : '',
  ].filter(Boolean).join(' · ') || 'remote model';
  const traits = detectTraits(id, []);
  $('#mi-uses').textContent = `Good for: ${usesFor(traits).join(' · ')}`;
  $('#mi-rec').textContent = 'Runs on OpenRouter’s servers — this chat’s messages and attachments leave your machine, billed per token.';
}

/** Populate the info box for `name` (hidden when there's no model). */
export async function updateModelInfo(name) {
  const box = $('#model-info');
  if (!name) { box.hidden = true; return; }
  box.hidden = false;
  if (isRemoteModel(name)) return updateRemoteInfo(name);
  const size = (state.models.find(m => m.name === name) || {}).size || 0;

  $('#mi-name').textContent = name;
  $('#mi-specs').textContent = fmtBytes(size);
  $('#mi-rec').textContent = 'Loading…';

  let caps = [];
  try {
    const info = await api(`/api/models/info?name=${encodeURIComponent(name)}`);
    caps = info.capabilities || [];
    $('#mi-specs').textContent = [info.parameterSize, info.quantization, fmtBytes(size), fmtCtxLabel(info.contextLength)]
      .filter(Boolean).join(' · ');
  } catch { /* local backend offline — fall back to size + name heuristics */ }
  const traits = detectTraits(name, caps);
  $('#mi-uses').textContent = `Good for: ${usesFor(traits).join(' · ')}`;
  $('#mi-rec').textContent = recommend(size, traits);
}
