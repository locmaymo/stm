// Loaded into every page of the app's WebViews before the page's own scripts.
// It does nothing except in a SillyTavern served on this phone: there it tells
// the app when SillyTavern is up and when a character has finished a reply, so
// the app can show it in a chat bubble, and it switches to the chat a bubble
// is opened for. STMApp is the channel the app gives these pages; see
// ChatBridge.java.
(() => {
  'use strict';
  if (typeof STMApp === 'undefined' || window.__stmChatBridge) return;
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  window.__stmChatBridge = true;

  /** How many of the last messages go with a reply, for the notification. */
  const HISTORY = 12;
  const MAX_TEXT = 4000;
  const MAX_AVATAR_BYTES = 1024 * 1024;
  const avatars = new Map();

  function context() {
    const tavern = globalThis.SillyTavern;
    return tavern && typeof tavern.getContext === 'function' ? tavern.getContext() : null;
  }

  function chatId(ctx) {
    return String(ctx.getCurrentChatId?.() ?? '');
  }

  /** The words as the reader sees them: after SillyTavern's formatting and regex scripts, without the markup. */
  function wordsOf(index, message) {
    const shown = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
    const words = shown ? shown.innerText : String(message.mes ?? '');
    return words.trim().slice(0, MAX_TEXT);
  }

  async function avatar(file) {
    if (!file) return '';
    if (avatars.has(file)) return avatars.get(file);
    try {
      const response = await fetch(`/thumbnail?type=avatar&file=${encodeURIComponent(file)}`, { credentials: 'same-origin' });
      if (!response.ok) return '';
      const blob = await response.blob();
      if (blob.size > MAX_AVATAR_BYTES) return '';
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      avatars.set(file, url);
      return url;
    } catch {
      return '';
    }
  }

  async function report(index) {
    const ctx = context();
    const message = ctx?.chat?.[index];
    if (!message || message.is_user || message.is_system) return;
    const words = wordsOf(index, message);
    if (!words) return;
    const group = ctx.groupId ? (ctx.groups ?? []).find((item) => item.id === ctx.groupId) : null;
    const character = !group && ctx.characterId !== undefined ? ctx.characters?.[ctx.characterId] : null;
    const key = group ? `g:${group.id}` : character ? `c:${character.avatar}` : '';
    if (!key) return;
    const speaker = group
      ? message.original_avatar || (ctx.characters ?? []).find((item) => item.name === message.name)?.avatar
      : character.avatar;
    const history = [];
    for (let i = ctx.chat.length - 1; i >= 0 && history.length < HISTORY; i--) {
      const item = ctx.chat[i];
      if (!item || item.is_system) continue;
      const text = wordsOf(i, item);
      if (text) history.unshift({ user: Boolean(item.is_user), name: String(item.name ?? ''), text });
    }
    STMApp.postMessage(JSON.stringify({
      type: 'reply',
      key,
      chat: chatId(ctx),
      title: String(group ? group.name : character.name),
      group: Boolean(group),
      name: String(message.name ?? ''),
      text: words,
      avatar: await avatar(speaker),
      history,
    }));
  }

  function generating() {
    return document.body?.dataset.generating === 'true';
  }

  /**
   * Show one conversation: `key` is `c:` and a character's avatar, or `g:` and
   * a group; `chat` is the chat file. Why not, or '' once it is on screen. A
   * reply being written is not interrupted to do it.
   */
  async function open(key, chat) {
    let ctx = context();
    if (!ctx) return 'unavailable';
    const group = key.startsWith('g:') ? key.slice(2) : null;
    const avatar = key.startsWith('c:') ? key.slice(2) : null;
    const here = group ? ctx.groupId === group : !ctx.groupId && ctx.characters?.[ctx.characterId]?.avatar === avatar;
    if (here && (!chat || chatId(ctx) === chat)) return '';
    if (generating()) return 'busy';
    if (group) {
      if (ctx.groupId !== group) {
        // Not on the context SillyTavern gives extensions; the module is the same one the page runs.
        const groups = await import('/scripts/group-chats.js');
        await groups.openGroupById(group);
      }
      ctx = context();
      if (chat && chatId(ctx) !== chat) await ctx.openGroupChat(group, chat);
    } else {
      const index = (ctx.characters ?? []).findIndex((item) => item.avatar === avatar);
      if (index < 0) return 'missing';
      if (!here) await ctx.selectCharacterById(index, { switchMenu: false });
      ctx = context();
      if (chat && chatId(ctx) !== chat) await ctx.openCharacterChat(chat);
    }
    return '';
  }

  /**
   * To the newest message, as a messenger opens a conversation. The page has
   * just been moved into a window of another size, so it is done again once
   * that window has laid it out.
   */
  function toNewest() {
    const scroll = () => {
      const chat = document.getElementById('chat');
      if (chat) chat.scrollTop = chat.scrollHeight;
    };
    for (const wait of [0, 150, 500]) setTimeout(scroll, wait);
  }

  STMApp.addEventListener('message', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || data.type !== 'open') return;
    open(String(data.key ?? ''), String(data.chat ?? ''))
      .catch(() => 'failed')
      .then((problem) => {
        toNewest();
        STMApp.postMessage(JSON.stringify({ type: 'opened', id: String(data.id ?? ''), problem }));
      });
  });

  function hook() {
    const ctx = context();
    const rendered = ctx?.eventTypes?.CHARACTER_MESSAGE_RENDERED;
    if (!ctx?.eventSource || !rendered) return false;
    ctx.eventSource.on(rendered, (index) => { void report(Number(index)); });
    // Characters and chats are loaded by then. SillyTavern calls a listener
    // added after the event at once, so it is heard however late this is.
    const ready = ctx.eventTypes.APP_READY;
    if (ready) ctx.eventSource.on(ready, () => STMApp.postMessage(JSON.stringify({ type: 'ready' })));
    else STMApp.postMessage(JSON.stringify({ type: 'ready' }));
    return true;
  }

  // SillyTavern sets its global while its modules load, a while after this runs.
  let tries = 0;
  const timer = setInterval(() => { if (hook() || ++tries >= 120) clearInterval(timer); }, 1000);
})();
