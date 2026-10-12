import type { PageState, ReplyReport } from './replies.js';
import type { NotificationLocale } from './notifications.js';

/**
 * Reply notifications, from SillyTavern's side of the door.
 *
 * The door adds one script to every SillyTavern page it serves. The script
 * tells the manager when the page is looked at and when it is left, and when
 * a character finished a reply while nobody was looking; it subscribes the
 * browser to pushes on this origin, which is the one an iPhone added to its
 * Home Screen; and it opens the chat a notification was about when that is
 * pressed. See replies.ts for what is told when.
 *
 * Both scripts are plain ES5-ish JavaScript with no template literals so they
 * can sit inside this file's own template strings, like the tools window's.
 */

export const NOTIFY_SCRIPT_PATH = '/__stm/notify.js';
export const NOTIFY_WORKER_PATH = '/__stm/notify-sw.js';
export const NOTIFY_PREFIX = '/__stm/notify/';

/** What the door asks of the manager for this. */
export interface GatewayReplies {
  presence(page: string, state: PageState): void;
  reply(report: ReplyReport): Promise<void>;
  publicKey(): Promise<string>;
  subscribed(endpoint: string): Promise<boolean>;
  /** Whether any browser at all is subscribed here, so a page knows whether to keep saying where it is. */
  anyone(): Promise<boolean>;
  subscribe(input: { readonly endpoint: string; readonly p256dh: string; readonly auth: string; readonly locale: NotificationLocale }): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
  /** Every device was put out of the door: none of them is told anything any more. */
  revoked(): void;
}

/** The tag that loads the script, put just before `</head>`. */
export const NOTIFY_TAG = `<script src="${NOTIFY_SCRIPT_PATH}" defer></script>`;

/**
 * The page with the script in it, or null when it is not a page to put it in.
 *
 * Only a whole document has a `</head>`; the fragments SillyTavern fetches as
 * templates do not, and are left as they came.
 */
export function withNotifyScript(html: string): string | null {
  const at = html.search(/<\/head\s*>/iu);
  if (at === -1 || html.includes(NOTIFY_SCRIPT_PATH)) return null;
  return `${html.slice(0, at)}${NOTIFY_TAG}${html.slice(at)}`;
}

/*
 * The page script.
 *
 * It says nothing inside the Android app, which tells replies its own way
 * (chat_bridge.js), and keeps a heartbeat going only while somebody is
 * subscribed: through a fixed link every request counts against the owner's
 * daily allowance of Worker requests.
 */
export const NOTIFY_SCRIPT = `(function(){
'use strict';
if(window.__stmNotify||typeof window.STMApp!=='undefined')return;
window.__stmNotify=true;
var PAGE=(Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,24);
var BEAT=60000,MAX_TEXT=1000,anyone=false,beat=0;
function call(method,path,body,keep){return fetch(path,{method:method,credentials:'same-origin',keepalive:!!keep,headers:{'content-type':'application/json','x-stm-tools':'1'},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(b){b.__ok=r.ok;return b})})}
function shown(){return document.visibilityState==='visible'}
function say(state){return call('POST','/__stm/notify/presence',{page:PAGE,state:state},true).then(function(b){if(b&&typeof b.anyone==='boolean')anyone=b.anyone;return b},function(){return null})}
function tick(){clearTimeout(beat);var s=shown()?'visible':'hidden';say(s).then(function(){if(anyone&&shown())beat=setTimeout(tick,BEAT)})}
document.addEventListener('visibilitychange',tick);
addEventListener('pagehide',function(e){clearTimeout(beat);say(e.persisted?'hidden':'gone')});
addEventListener('pageshow',function(e){if(e.persisted)tick()});
function context(){var t=window.SillyTavern;return t&&typeof t.getContext==='function'?t.getContext():null}
function chatId(ctx){try{return String(ctx.getCurrentChatId&&ctx.getCurrentChatId()||'')}catch(e){return''}}
function wordsOf(index,message){var shownText=document.querySelector('#chat .mes[mesid="'+index+'"] .mes_text');var w=shownText?shownText.innerText:String(message.mes||'');return w.trim().slice(0,MAX_TEXT)}
function report(index){if(!anyone||shown())return;var ctx=context();var m=ctx&&ctx.chat&&ctx.chat[index];if(!m||m.is_user||m.is_system)return;var group=ctx.groupId?(ctx.groups||[]).filter(function(g){return g.id===ctx.groupId})[0]:null;var character=!group&&ctx.characterId!==undefined&&ctx.characters?ctx.characters[ctx.characterId]:null;if(!group&&!character)return;var speaker=group?(m.original_avatar||((ctx.characters||[]).filter(function(c){return c.name===m.name})[0]||{}).avatar||''):character.avatar;
call('POST','/__stm/notify/reply',{page:PAGE,title:String(group?group.name:character.name),name:String(m.name||''),group:!!group,text:wordsOf(index,m),avatar:String(speaker||''),key:group?'g:'+group.id:'c:'+character.avatar,chat:chatId(ctx)},true).catch(function(){})}
function busy(){return document.body&&document.body.dataset.generating==='true'}
function openChat(key,chat){var ctx=context();if(!ctx||!key)return Promise.resolve();var group=key.indexOf('g:')===0?key.slice(2):null,avatar=key.indexOf('c:')===0?key.slice(2):null;var here=group?ctx.groupId===group:!ctx.groupId&&ctx.characters&&ctx.characters[ctx.characterId]&&ctx.characters[ctx.characterId].avatar===avatar;if(here&&(!chat||chatId(ctx)===chat))return Promise.resolve();if(busy())return Promise.resolve();
if(group){return(ctx.groupId!==group?import('/scripts/group-chats.js').then(function(g){return g.openGroupById(group)}):Promise.resolve()).then(function(){var c=context();if(chat&&chatId(c)!==chat)return c.openGroupChat(group,chat)})}
var index=(ctx.characters||[]).map(function(c){return c.avatar}).indexOf(avatar);if(index<0)return Promise.resolve();return(here?Promise.resolve():ctx.selectCharacterById(index,{switchMenu:false})).then(function(){var c=context();if(chat&&chatId(c)!==chat)return c.openCharacterChat(chat)})}
function openFrom(hash){var m=/stm-open=([^&]*)(?:&chat=([^&]*))?/.exec(hash||'');if(!m)return false;var key=decodeURIComponent(m[1]||''),chat=decodeURIComponent(m[2]||'');openChat(key,chat).catch(function(){});return true}
function hook(){var ctx=context();var ev=ctx&&ctx.eventTypes;if(!ctx||!ctx.eventSource||!ev||!ev.CHARACTER_MESSAGE_RENDERED)return false;ctx.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED,function(i){report(Number(i))});
var ready=function(){if(openFrom(location.hash))try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}};if(ev.APP_READY)ctx.eventSource.on(ev.APP_READY,ready);else ready();return true}
var tries=0,timer=setInterval(function(){if(hook()||++tries>=120)clearInterval(timer)},1000);
if('serviceWorker' in navigator){navigator.serviceWorker.addEventListener('message',function(e){var d=e.data||{};if(d.type==='stm-open')openFrom(d.hash)});try{navigator.serviceWorker.startMessages()}catch(e){}}
tick();
var SW='${NOTIFY_WORKER_PATH}';
function keyBytes(s){var p=(s+'===='.slice((s.length%4)||4)).replace(/-/g,'+').replace(/_/g,'/');var b=atob(p),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function standalone(){return navigator.standalone===true||(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)}
function appleMobile(){var a=navigator.userAgent;return/iPhone|iPad|iPod/i.test(a)||(/Macintosh/i.test(a)&&navigator.maxTouchPoints>1)}
function support(){if(appleMobile()&&!standalone())return'needs-home-screen';if(!window.isSecureContext)return'needs-https';if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return'unsupported';if(Notification.permission==='denied')return'blocked';return'ready'}
function registration(){return navigator.serviceWorker.getRegistration('/').then(function(r){return r&&r.active&&r.active.scriptURL.indexOf(SW)!==-1?r:navigator.serviceWorker.register(SW,{scope:'/'}).then(function(){return navigator.serviceWorker.ready})})}
function current(){var s=support();if(s!=='ready'&&s!=='blocked')return Promise.resolve(null);return navigator.serviceWorker.getRegistration('/').then(function(r){return r?r.pushManager.getSubscription():null}).then(function(sub){if(!sub)return null;return call('GET','/__stm/notify/push?endpoint='+encodeURIComponent(sub.endpoint)).then(function(b){return b.__ok&&b.subscribed?sub:null})})}
function locale(){var l=(document.documentElement.lang||navigator.language||'').toLowerCase();return l.indexOf('vi')===0?'vi':'en'}
function enable(){var s=support();if(s!=='ready')return Promise.resolve(s);return Notification.requestPermission().then(function(p){if(p==='denied')return'blocked';if(p!=='granted')return'failed';return call('GET','/__stm/notify/push').then(function(b){if(!b.__ok||!b.publicKey)return'failed';return registration().then(function(r){return r.pushManager.getSubscription().then(function(old){return old?old.unsubscribe().catch(function(){}):null}).then(function(){return r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(b.publicKey)})})}).then(function(sub){return call('POST','/__stm/notify/push',{subscription:sub.toJSON(),locale:locale()})}).then(function(saved){if(!saved.__ok)return'failed';anyone=true;tick();return'on'})})}).catch(function(){return'failed'})}
function disable(){return current().then(function(sub){if(!sub)return'off';return call('DELETE','/__stm/notify/push',{endpoint:sub.endpoint}).then(function(){return sub.unsubscribe().catch(function(){})}).then(function(){return'off'})}).catch(function(){return'failed'})}
function status(){var s=support();if(s!=='ready')return Promise.resolve(s);return current().then(function(sub){return sub?'on':'off'}).catch(function(){return'off'})}
window.STMNotify={status:status,enable:enable,disable:disable};
})();`;

/*
 * The service worker on SillyTavern's origin. It shows a push and opens what
 * it was about, and does nothing else: no fetch handler, so it never stands
 * between SillyTavern and its own requests.
 */
export const NOTIFY_WORKER = `self.addEventListener('install',function(){self.skipWaiting()});
self.addEventListener('activate',function(event){event.waitUntil(self.clients.claim())});
self.addEventListener('push',function(event){var m={};try{m=event.data?event.data.json():{}}catch(e){m={title:event.data?event.data.text():''}}
event.waitUntil(self.registration.showNotification(m.title||'SillyTavern',{body:m.body||'',tag:m.tag||undefined,renotify:!!m.tag,icon:m.icon||'/img/apple-icon-192x192.png',badge:'/img/apple-icon-72x72.png',data:{url:m.url||'/'}}))});
self.addEventListener('notificationclick',function(event){event.notification.close();var target=new URL((event.notification.data&&event.notification.data.url)||'/',self.location.origin);
event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(windows){var top=null;for(var i=0;i<windows.length;i++){var c=windows[i];if(new URL(c.url).origin!==self.location.origin)continue;c.postMessage({type:'stm-open',hash:target.hash});if(!top&&c.frameType!=='nested')top=c}
if(top&&'focus' in top)return top.focus();return self.clients.openWindow?self.clients.openWindow(target.href):undefined}))});`;
