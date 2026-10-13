import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_EXTENSION, CHATS_DIR, GROUP_CHATS_DIR } from '../../../packages/chats/src/index.js';
import type { ChatKind } from '../../../packages/contracts/src/index.js';

/**
 * Open a search hit inside SillyTavern.
 *
 * The console asks the manager for a short-lived token naming the chat and
 * the message, and opens SillyTavern through the door at `/?stm_open=<token>`:
 * a chat's name never sits in an address, a history or a log. The door puts a
 * small script into SillyTavern's page, which reads the token, asks the door
 * what it stands for, and opens the chat the way a reader would - select the
 * character or the group, open the chat, scroll to the message and light it
 * up. Where this SillyTavern cannot be asked to, it says which character and
 * chat to open instead.
 *
 * The script is plain ES5-ish JavaScript with no template literals so it can
 * sit inside this file's own template string, like the door's other scripts.
 */

export const OPEN_SCRIPT_PATH = '/__stm/open.js';
export const OPEN_PREFIX = '/__stm/open/';
export const OPEN_TAG = `<script src="${OPEN_SCRIPT_PATH}" defer></script>`;
/** The query parameter the console puts the token in. */
export const OPEN_PARAMETER = 'stm_open';

/** How long a token is good for: long enough for a tab and a sign-in, not for a bookmark. */
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 64;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

/** A message to open. */
export interface ChatOpenTarget {
  readonly kind: ChatKind;
  /** For a character chat, its folder: the card's file name without `.png`. */
  readonly character: string | null;
  /** For a group chat, its group. */
  readonly group: string | null;
  readonly chat: string;
  readonly index: number;
  /** What the console calls the character or group, for a note when it cannot be opened. */
  readonly title: string | null;
}

/** What the door asks of the manager for this. */
export interface GatewayChatOpener {
  /** What a token stands for, or null when it is unknown or out of time. */
  target(token: string): ChatOpenTarget | null;
}

/** Tokens handed to the console, each for one message, kept in memory only. */
export class ChatOpenTokens implements GatewayChatOpener {
  private readonly tokens = new Map<string, { readonly target: ChatOpenTarget; readonly expires: number }>();

  public constructor(private readonly now: () => number = Date.now) {}

  public issue(target: ChatOpenTarget): string {
    this.prune();
    while (this.tokens.size >= MAX_TOKENS) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
    }
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, { target, expires: this.now() + TOKEN_TTL_MS });
    return token;
  }

  public target(token: string): ChatOpenTarget | null {
    if (!TOKEN_PATTERN.test(token)) return null;
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expires <= this.now()) { this.tokens.delete(token); return null; }
    return entry.target;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(token);
  }
}

/** A name that is one path segment and nothing more. */
function plainName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\/\0]/u.test(value) && value !== '.' && value !== '..';
}

/** A request body as a message to open, or a reason it is not one. */
export function parseOpenRequest(body: unknown): { target: ChatOpenTarget } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'The body must be an object' };
  const value = body as Record<string, unknown>;
  if (value.kind !== 'character' && value.kind !== 'group') return { error: 'kind must be character or group' };
  if (!plainName(value.chat)) return { error: 'chat must be a chat name' };
  if (typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0) return { error: 'index must be a message number' };
  if (value.kind === 'character' && !plainName(value.character)) return { error: 'character must be a chat folder' };
  if (value.kind === 'group' && !plainName(value.group)) return { error: 'group must be a group id' };
  return {
    target: {
      kind: value.kind,
      character: value.kind === 'character' ? value.character as string : null,
      group: value.kind === 'group' ? value.group as string : null,
      chat: value.chat,
      index: value.index,
      title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 200) : null,
    },
  };
}

/** Whether the chat a target names is a file in this user directory. */
export async function chatExists(userRoot: string, target: ChatOpenTarget): Promise<boolean> {
  const file = `${target.chat}${CHAT_EXTENSION}`;
  const path = target.kind === 'character' ? join(userRoot, CHATS_DIR, target.character ?? '', file) : join(userRoot, GROUP_CHATS_DIR, file);
  return (await stat(path).catch(() => null))?.isFile() === true;
}

/** What the script is told about a token: what to open, keyed the way SillyTavern's own lists are. */
export function openAnswer(target: ChatOpenTarget): { kind: ChatKind; avatar: string | null; group: string | null; chat: string; index: number; title: string | null } {
  return {
    kind: target.kind,
    // SillyTavern names a character's chat folder after its card, `.png` taken off.
    avatar: target.kind === 'character' ? `${target.character}.png` : null,
    group: target.group,
    chat: target.chat,
    index: target.index,
    title: target.title,
  };
}

const TEXT = {
  en: {
    expired: 'That link to a chat has expired. Open it again from the console.',
    busy: 'SillyTavern is writing a reply. Open the chat again once it is done.',
    missing: 'Could not find {name} in this SillyTavern. The chat is "{chat}", message #{index}.',
    manual: 'Open {name} and the chat "{chat}"; the message is #{index}.',
    group: 'the group',
  },
  vi: {
    expired: 'Liên kết tới chat này đã hết hạn. Hãy mở lại từ bảng điều khiển.',
    busy: 'SillyTavern đang viết câu trả lời. Mở lại chat khi nó viết xong.',
    missing: 'Không thấy {name} trong SillyTavern này. Chat là "{chat}", tin nhắn #{index}.',
    manual: 'Hãy mở {name} và chat "{chat}"; tin nhắn là #{index}.',
    group: 'nhóm',
  },
};

const OPEN_STYLE = '.stm-o{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:100000;max-width:min(92vw,440px);padding:10px 14px;border-radius:10px;background:#1f2937;color:#f9fafb;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}'
  + '@keyframes stm-o-flash{0%,100%{box-shadow:none}20%,60%{box-shadow:0 0 0 3px rgba(250,204,21,.9)}}'
  + '.stm-o-flash{animation:stm-o-flash 2.4s ease-in-out;border-radius:8px}';

export const OPEN_SCRIPT = `(function(){
'use strict';
if(window.__stmOpen)return;
window.__stmOpen=true;
var params;try{params=new URLSearchParams(location.search)}catch(e){return}
var token=params.get('${OPEN_PARAMETER}');if(!token)return;
params.delete('${OPEN_PARAMETER}');
try{var rest=params.toString();history.replaceState(history.state,'',location.pathname+(rest?'?'+rest:'')+location.hash)}catch(e){}
var TEXT=${JSON.stringify(TEXT)},STYLE=${JSON.stringify(OPEN_STYLE)};
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}
var T=TEXT[(load('language')||document.documentElement.lang||navigator.language||'').toLowerCase().indexOf('vi')===0?'vi':'en'];
function fill(s,v){return s.replace(/\\{(\\w+)\\}/g,function(m,k){return v[k]===undefined?m:String(v[k])})}
function note(text){if(!document.getElementById('stm-o-style')){var st=document.createElement('style');st.id='stm-o-style';st.textContent=STYLE;document.head.appendChild(st)}var old=document.querySelector('.stm-o');if(old)old.parentNode.removeChild(old);var c=document.createElement('div');c.className='stm-o';c.setAttribute('role','status');c.textContent=text;document.body.appendChild(c);setTimeout(function(){if(c.parentNode)c.parentNode.removeChild(c)},9000)}
function context(){var t=window.SillyTavern;return t&&typeof t.getContext==='function'?t.getContext():null}
function chatId(ctx){try{return String(ctx.getCurrentChatId&&ctx.getCurrentChatId()||'')}catch(e){return''}}
function busy(){return document.body&&document.body.dataset.generating==='true'}
function wait(ms){return new Promise(function(r){setTimeout(r,ms)})}
/* A message older than the ones SillyTavern shows is brought in the way its
   own "show more" does, then scrolled to and lit up. */
function light(index){var el=document.querySelector('#chat .mes[mesid="'+index+'"]');if(!el)return false;el.scrollIntoView({block:'center'});if(!el.classList.contains('stm-o-flash'))el.classList.add('stm-o-flash');return true}
/* SillyTavern draws a chat in steps and scrolls to its end as it goes, so the
   message is looked for once the chat has stopped changing, and again a moment
   later in case a picture loading moved it. */
function settle(chat){var last='',same=0,tries=0;return new Promise(function(done){(function look(){var c=context();var list=document.querySelectorAll('#chat .mes');var sig=chatId(c)+'|'+list.length+'|'+(list.length?list[list.length-1].getAttribute('mesid'):'');if(chatId(c)===chat&&list.length>0&&sig===last)same++;else{same=0;last=sig}if(same>=3||++tries>=75){done();return}setTimeout(look,200)})()})}
function reveal(index,tries){if(light(index)){setTimeout(function(){light(index)},800);return Promise.resolve(true)}
if(tries>=60)return Promise.resolve(false);var first=document.querySelector('#chat .mes');var firstId=first?Number(first.getAttribute('mesid')):NaN;
if(!isNaN(firstId)&&firstId>index){return import('/script.js').then(function(m){if(m&&typeof m.showMoreMessages==='function')return m.showMoreMessages(firstId-index+1);var more=document.getElementById('show_more_messages');if(more)more.click()}).catch(function(){var more=document.getElementById('show_more_messages');if(more)more.click()}).then(function(){return wait(300)}).then(function(){return reveal(index,tries+1)})}
return wait(250).then(function(){return reveal(index,tries+1)})}
function open(target){var ctx=context();var name=target.title||(target.kind==='group'?T.group:String(target.avatar||'').replace(/\\.png$/i,''));var words={name:name,chat:target.chat,index:target.index};
if(!ctx){note(fill(T.manual,words));return}
if(busy()){note(T.busy);return}
var step;
if(target.kind==='group'){if(typeof ctx.openGroupChat!=='function'){note(fill(T.manual,words));return}
var known=(ctx.groups||[]).some(function(g){return g.id===target.group});if(!known){note(fill(T.missing,words));return}
step=(ctx.groupId!==target.group?import('/scripts/group-chats.js').then(function(g){return g.openGroupById(target.group)}):Promise.resolve()).then(function(){var c=context();if(chatId(c)!==target.chat)return c.openGroupChat(target.group,target.chat)})}
else{if(typeof ctx.selectCharacterById!=='function'||typeof ctx.openCharacterChat!=='function'){note(fill(T.manual,words));return}
var at=(ctx.characters||[]).map(function(c){return c.avatar}).indexOf(target.avatar);if(at<0){note(fill(T.missing,words));return}
var here=!ctx.groupId&&String(ctx.characterId)===String(at);
step=(here?Promise.resolve():ctx.selectCharacterById(at,{switchMenu:false})).then(function(){var c=context();if(chatId(c)!==target.chat)return c.openCharacterChat(target.chat)})}
step.then(function(){return settle(target.chat)}).then(function(){return reveal(target.index,0)}).then(function(found){if(!found)note(fill(T.manual,words))}).catch(function(){note(fill(T.manual,words))})}
function ready(go){var tries=0;var timer=setInterval(function(){var ctx=context();var ev=ctx&&ctx.eventTypes;if(ctx&&ctx.eventSource&&ev&&ev.APP_READY){clearInterval(timer);var done=false;ctx.eventSource.on(ev.APP_READY,function(){if(!done){done=true;go()}});return}
if(++tries>=120){clearInterval(timer);if(ctx)go();else note(T.expired)}},500)}
fetch('${OPEN_PREFIX}'+encodeURIComponent(token),{credentials:'same-origin',headers:{'x-stm-tools':'1'}}).then(function(r){return r.ok?r.json():null}).then(function(target){if(!target||!target.chat){note(T.expired);return}ready(function(){open(target)})}).catch(function(){note(T.expired)});
})();`;
