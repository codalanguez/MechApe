/**
 * state.js — single shared client state.
 *
 * One mutable object imported by every module: the loaded project, active
 * chat id, model/skill catalogs, pending slash-invoked skills, and streaming
 * status. Keeping it in one plain object (rather than scattered globals)
 * makes the data flow between modules explicit and easy to inspect from
 * devtools.
 */
export const state = {
  projects: [],          // project summaries for the sidebar
  project: null,         // full loaded project (chats, attachments, skills)
  chatId: null,          // active chat id within state.project
  models: [],            // available local (.gguf) models
  skills: [],            // available skills (id, name, description)
  invokedSkills: [],     // skill ids invoked via "/" for the next message
  streaming: false,      // a reply is currently streaming
  abort: null,           // AbortController for the in-flight stream
  streamChatId: null,    // which chat that stream belongs to (it may not be the open one)
  streamBubble: null,    // its live bubble, so openChat can re-attach it on return
  fbDir: null,           // file browser's current directory
  baseTokens: null,      // est. tokens of the fixed request part (system + history)
  systemTokens: 0,       // est. tokens of the system prompt alone (the overflow floor)
  contextLimit: 4096,    // num_ctx the meter compares against
};
