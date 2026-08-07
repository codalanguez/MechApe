/**
 * ctxmenu.js — right-click context menus.
 *
 * One themed menu element, positioned at the cursor and dismissed by any
 * click, Escape, scroll, or resize. initContextMenus() wires the app's
 * zones through delegated listeners (they survive re-renders):
 *   chat rail item  → open / rename / delete
 *   project card    → open / delete
 *   chat message    → copy selection / whole message
 *   skill row       → copy the /command
 * Right-clicks inside inputs and textareas are left alone so the native
 * editing menu (provided by the desktop shell) can appear.
 */
import { copyText, toast } from './util.js';
import { openChat, renameChat, deleteChat, clearChat, currentChat, beginEditMessage, copyConversationMarkdown, saveConversationAsFile } from './chat.js';
import { openProject, deleteProjectById } from './projects.js';
import { openSkillDetail } from './skills.js';
import { saveAsFile } from './savefile.js';

let menu = null;

function hideMenu() {
  if (menu) { menu.remove(); menu = null; }
}

/** items: [{ label, action, danger? }] — falsy entries are skipped,
 *  the string 'sep' inserts a divider. */
export function showContextMenu(x, y, items) {
  hideMenu();
  menu = document.createElement('div');
  menu.id = 'ctx-menu';
  for (const item of items.filter(Boolean)) {
    if (item === 'sep') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' }));
      continue;
    }
    const el = document.createElement('button');
    el.className = 'ctx-item' + (item.danger ? ' danger' : '');
    el.textContent = item.label;
    el.addEventListener('click', () => { hideMenu(); item.action(); });
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

function menuFor(target) {
  const chatLi = target.closest('#chat-list li[data-id]');
  if (chatLi) {
    const cid = chatLi.dataset.id;
    return [
      { label: 'Open chat', action: () => openChat(cid) },
      { label: 'Rename chat…', action: () => renameChat(cid) },
      { label: 'Clear messages', action: () => clearChat(cid) },
      'sep',
      { label: 'Copy as Markdown', action: () => copyConversationMarkdown(cid) },
      { label: 'Save as file…', action: () => saveConversationAsFile(cid) },
      'sep',
      { label: 'Delete chat', danger: true, action: () => deleteChat(cid) },
    ];
  }

  const card = target.closest('.proj-card[data-id]');
  if (card) {
    const pid = card.dataset.id;
    return [
      { label: 'Open project', action: () => openProject(pid) },
      'sep',
      { label: 'Delete project…', danger: true, action: () => deleteProjectById(pid) },
    ];
  }

  const msg = target.closest('#messages .msg');
  if (msg) {
    const idx = Number(msg.dataset.idx);
    const stored = currentChat()?.messages[idx];
    const selection = String(getSelection() || '').trim();
    const body = msg.querySelector('.msg-body');
    // the real markdown source, keyed by render position — falls back to the
    // rendered text for a message not yet indexed (e.g. still streaming).
    // Matters because rendered headings are CSS-uppercased and markdown
    // syntax (**bold**, code fences, links) doesn't survive an innerText read.
    const raw = stored?.content ?? body.innerText.trim();
    return [
      selection && { label: 'Copy selection', action: () => { copyText(selection); toast('Copied'); } },
      { label: 'Copy message', action: () => { copyText(body.innerText.trim()); toast('Message copied'); } },
      stored?.role === 'user' && { label: 'Edit & resend…', action: () => beginEditMessage(idx) },
      { label: 'Save as file…', action: () => saveAsFile(raw) },
    ];
  }

  const skillLi = target.closest('#skill-list li[data-skill]');
  if (skillLi) {
    const sid = skillLi.dataset.skill;
    return [
      { label: 'Show details', action: () => openSkillDetail(sid) },
      { label: `Copy /${sid}`, action: () => { copyText('/' + sid); toast(`/${sid} copied`); } },
    ];
  }

  return null;
}

export function initContextMenus() {
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return; // native editing menu
    const items = menuFor(e.target);
    if (!items) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, items);
  });
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
  addEventListener('resize', hideMenu);
  addEventListener('scroll', hideMenu, true);
}
