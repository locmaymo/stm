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
 * It also asks. A switch nobody finds is a switch nobody turns on, so the
 * first time a character replies on a device that could be told, a card asks
 * whether it should be - or, on an iPhone outside the Home Screen, says what
 * to do first. The same switches stay in SillyTavern's wand menu afterwards.
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
  /** Whether this browser is shown what was said; null when it is not subscribed. */
  preview(endpoint: string): Promise<boolean | null>;
  /** False when that browser is not subscribed. */
  setPreview(endpoint: string, preview: boolean): Promise<boolean>;
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

interface NotifyText {
  readonly askTitle: string;
  readonly askTitleAny: string;
  readonly askBody: string;
  readonly turnOn: string;
  readonly notNow: string;
  readonly homeTitle: string;
  readonly homeBody: string;
  readonly gotIt: string;
  readonly on: string;
  readonly blocked: string;
  readonly failed: string;
  readonly needsHttps: string;
  readonly unsupported: string;
  readonly menu: string;
  readonly notify: string;
  readonly preview: string;
  readonly previewNote: string;
  readonly close: string;
}

const TEXT: Readonly<Record<NotificationLocale, NotifyText>> = {
  en: {
    askTitle: 'Get a notification when {name} replies?',
    askTitleAny: 'Get a notification when a character replies?',
    askBody: 'Switch to another app or lock the screen while a reply is being written, and this device tells you when it arrives.',
    turnOn: 'Turn on',
    notNow: 'Not now',
    homeTitle: 'Reply notifications on iPhone and iPad',
    homeBody: 'Add SillyTavern to your Home Screen first: tap Share, then Add to Home Screen, and open it from there. It will ask again then.',
    gotIt: 'Got it',
    on: 'Done. This device will tell you when a character replies.',
    blocked: 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.',
    failed: 'Notifications could not be turned on. Try again in a moment.',
    needsHttps: 'Open SillyTavern with its https link to get notifications on this device.',
    unsupported: 'This browser cannot show notifications from SillyTavern.',
    menu: 'Reply notifications',
    notify: 'Tell me on this device when a character replies',
    preview: 'Show what they said',
    previewNote: 'It is shown on the lock screen. Off, the notification only says who replied.',
    close: 'Close',
  },
  vi: {
    askTitle: 'Nhận thông báo khi {name} trả lời?',
    askTitleAny: 'Nhận thông báo khi nhân vật trả lời?',
    askBody: 'Chuyển sang app khác hoặc khoá màn hình trong lúc câu trả lời đang được viết, thiết bị này sẽ báo khi nó đến.',
    turnOn: 'Bật',
    notNow: 'Để sau',
    homeTitle: 'Thông báo trả lời trên iPhone và iPad',
    homeBody: 'Hãy thêm SillyTavern vào Màn hình chính trước: bấm Chia sẻ, chọn Thêm vào MH chính, rồi mở SillyTavern từ đó. Khi ấy nó sẽ hỏi lại.',
    gotIt: 'Đã hiểu',
    on: 'Xong. Thiết bị này sẽ báo khi nhân vật trả lời.',
    blocked: 'Thông báo đang bị chặn cho trang này. Hãy cho phép trong cài đặt trình duyệt hoặc hệ thống rồi thử lại.',
    failed: 'Không bật được thông báo. Hãy thử lại sau ít phút.',
    needsHttps: 'Hãy mở SillyTavern bằng link https để nhận thông báo trên thiết bị này.',
    unsupported: 'Trình duyệt này không hiện được thông báo từ SillyTavern.',
    menu: 'Thông báo trả lời',
    notify: 'Báo trên thiết bị này khi nhân vật trả lời',
    preview: 'Hiện nội dung tin nhắn',
    previewNote: 'Nội dung hiện cả trên màn hình khoá. Tắt đi thì thông báo chỉ nói ai đã trả lời.',
    close: 'Đóng',
  },
};

/** The card's look, in SillyTavern's own theme colours where it has them. */
const NOTIFY_STYLE = '.stm-n{position:fixed;left:50%;top:calc(52px + env(safe-area-inset-top));transform:translateX(-50%);z-index:100000;box-sizing:border-box;width:min(26rem,calc(100vw - 24px));padding:14px 16px;border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.18));border-radius:14px;background:var(--SmartThemeBlurTintColor,rgba(23,23,26,.96));color:var(--SmartThemeBodyColor,#dcdcd2);box-shadow:0 14px 36px rgba(0,0,0,.45);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);font:inherit;font-size:15px;line-height:1.45;text-align:left}'
  + '.stm-n h3{margin:0 0 4px;font-size:1.05em;font-weight:600;color:inherit}.stm-n p{margin:0;opacity:.85}.stm-n .stm-n-row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:12px}'
  + '.stm-n button{min-height:36px;padding:6px 14px;border:1px solid var(--SmartThemeBorderColor,rgba(255,255,255,.18));border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}.stm-n button.stm-n-go{border-color:transparent;background:var(--SmartThemeQuoteColor,#e18a24);color:#fff;font-weight:600}.stm-n button:disabled{opacity:.5;cursor:default}'
  + '.stm-n label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;cursor:pointer}.stm-n label input{flex:none;width:20px;height:20px;margin:0;accent-color:var(--SmartThemeQuoteColor,#e18a24)}.stm-n label[data-off]{opacity:.5;cursor:default}.stm-n small{display:block;margin-top:4px;opacity:.7;font-size:.85em}.stm-n .stm-n-note{margin-top:10px}';

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
var TEXT=${JSON.stringify(TEXT)},STYLE=${JSON.stringify(NOTIFY_STYLE)};
var PAGE=(Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,24);
var BEAT=60000,MAX_TEXT=1000,ASKED='stm-notify-asked',ASK_AGAIN=14*24*3600*1000,anyone=false,beat=0,waiting=false,asking=false;
function store(k,v){try{if(v===null)localStorage.removeItem(k);else localStorage.setItem(k,v)}catch(e){}}
function load(k){try{return localStorage.getItem(k)}catch(e){return null}}
function locale(){var l=(load('language')||document.documentElement.lang||navigator.language||'').toLowerCase();return l.indexOf('vi')===0?'vi':'en'}
var T=TEXT[locale()];
function call(method,path,body,keep){return fetch(path,{method:method,credentials:'same-origin',keepalive:!!keep,headers:{'content-type':'application/json','x-stm-tools':'1'},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{}}).then(function(b){b.__ok=r.ok;return b})})}
function shown(){return document.visibilityState==='visible'}
function say(state){return call('POST','/__stm/notify/presence',{page:PAGE,state:state},true).then(function(b){if(b&&typeof b.anyone==='boolean')anyone=b.anyone;return b},function(){return null})}
function tick(){clearTimeout(beat);var s=shown()?'visible':'hidden';say(s).then(function(){if(anyone&&shown())beat=setTimeout(tick,BEAT)})}
document.addEventListener('visibilitychange',tick);
addEventListener('pagehide',function(e){clearTimeout(beat);say(e.persisted?'hidden':'gone')});
addEventListener('pageshow',function(e){if(e.persisted)tick()});
function context(){var t=window.SillyTavern;return t&&typeof t.getContext==='function'?t.getContext():null}
function chatId(ctx){try{return String(ctx.getCurrentChatId&&ctx.getCurrentChatId()||'')}catch(e){return''}}
function wordsOf(index,message){var el=document.querySelector('#chat .mes[mesid="'+index+'"] .mes_text');var w=el?el.innerText:String(message.mes||'');return w.trim().slice(0,MAX_TEXT)}
function speakerOf(ctx,m){var group=ctx.groupId?(ctx.groups||[]).filter(function(g){return g.id===ctx.groupId})[0]:null;var character=!group&&ctx.characterId!==undefined&&ctx.characters?ctx.characters[ctx.characterId]:null;if(!group&&!character)return null;
var avatar=group?(m.original_avatar||((ctx.characters||[]).filter(function(c){return c.name===m.name})[0]||{}).avatar||''):character.avatar;return{group:group,character:character,avatar:String(avatar||''),title:String(group?group.name:character.name),key:group?'g:'+group.id:'c:'+character.avatar}}
/* A character's reply, as SillyTavern finished showing it: told when nobody
   looks, and the moment to ask when somebody does. */
function rendered(index){if(!waiting)return;var ctx=context();var m=ctx&&ctx.chat&&ctx.chat[index];if(!m||m.is_user||m.is_system||index!==ctx.chat.length-1)return;waiting=false;var who=speakerOf(ctx,m);if(!who)return;
if(shown()){ask(String(m.name||who.title));return}
if(!anyone)return;
call('POST','/__stm/notify/reply',{page:PAGE,title:who.title,name:String(m.name||''),group:!!who.group,text:wordsOf(index,m),avatar:who.avatar,key:who.key,chat:chatId(ctx)},true).catch(function(){})}
function busy(){return document.body&&document.body.dataset.generating==='true'}
function openChat(key,chat){var ctx=context();if(!ctx||!key)return Promise.resolve();var group=key.indexOf('g:')===0?key.slice(2):null,avatar=key.indexOf('c:')===0?key.slice(2):null;var here=group?ctx.groupId===group:!ctx.groupId&&ctx.characters&&ctx.characters[ctx.characterId]&&ctx.characters[ctx.characterId].avatar===avatar;if(here&&(!chat||chatId(ctx)===chat))return Promise.resolve();if(busy())return Promise.resolve();
if(group){return(ctx.groupId!==group?import('/scripts/group-chats.js').then(function(g){return g.openGroupById(group)}):Promise.resolve()).then(function(){var c=context();if(chat&&chatId(c)!==chat)return c.openGroupChat(group,chat)})}
var index=(ctx.characters||[]).map(function(c){return c.avatar}).indexOf(avatar);if(index<0)return Promise.resolve();return(here?Promise.resolve():ctx.selectCharacterById(index,{switchMenu:false})).then(function(){var c=context();if(chat&&chatId(c)!==chat)return c.openCharacterChat(chat)})}
function openFrom(hash){var m=/stm-open=([^&]*)(?:&chat=([^&]*))?/.exec(hash||'');if(!m)return false;var key=decodeURIComponent(m[1]||''),chat=decodeURIComponent(m[2]||'');openChat(key,chat).catch(function(){});return true}
function hook(){var ctx=context();var ev=ctx&&ctx.eventTypes;if(!ctx||!ctx.eventSource||!ev||!ev.CHARACTER_MESSAGE_RENDERED)return false;
if(ev.GENERATION_STARTED)ctx.eventSource.on(ev.GENERATION_STARTED,function(type,options,dryRun){if(!dryRun&&!(options&&options.quiet_prompt))waiting=true});else waiting=true;
if(ev.CHAT_CHANGED)ctx.eventSource.on(ev.CHAT_CHANGED,function(){waiting=false});
ctx.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED,function(i){rendered(Number(i))});
var ready=function(){if(openFrom(location.hash))try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}addMenu()};if(ev.APP_READY)ctx.eventSource.on(ev.APP_READY,ready);else ready();return true}
var tries=0,timer=setInterval(function(){if(hook()||++tries>=120)clearInterval(timer)},1000);
if('serviceWorker' in navigator){navigator.serviceWorker.addEventListener('message',function(e){var d=e.data||{};if(d.type==='stm-open')openFrom(d.hash)});try{navigator.serviceWorker.startMessages()}catch(e){}}
tick();
var SW='${NOTIFY_WORKER_PATH}';
function keyBytes(s){var p=(s+'===='.slice((s.length%4)||4)).replace(/-/g,'+').replace(/_/g,'/');var b=atob(p),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function standalone(){return navigator.standalone===true||(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)}
function appleMobile(){var a=navigator.userAgent;return/iPhone|iPad|iPod/i.test(a)||(/Macintosh/i.test(a)&&navigator.maxTouchPoints>1)}
/* A frame inside another site - the console's own view of SillyTavern - can
   neither ask for permission nor keep a subscription of its own. */
function framedElsewhere(){if(window.top===window)return false;try{return window.top.location.origin!==location.origin}catch(e){return true}}
function support(){if(framedElsewhere())return'framed';if(appleMobile()&&!standalone())return'needs-home-screen';if(!window.isSecureContext)return'needs-https';if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return'unsupported';if(Notification.permission==='denied')return'blocked';return'ready'}
function registration(){return navigator.serviceWorker.getRegistration('/').then(function(r){return r&&r.active&&r.active.scriptURL.indexOf(SW)!==-1?r:navigator.serviceWorker.register(SW,{scope:'/'}).then(function(){return navigator.serviceWorker.ready})})}
function current(){var s=support();if(s!=='ready'&&s!=='blocked')return Promise.resolve(null);return navigator.serviceWorker.getRegistration('/').then(function(r){return r?r.pushManager.getSubscription():null}).then(function(sub){if(!sub)return null;return call('GET','/__stm/notify/push?endpoint='+encodeURIComponent(sub.endpoint)).then(function(b){return b.__ok&&b.subscribed?{sub:sub,preview:b.preview!==false}:null})})}
function enable(){var s=support();if(s!=='ready')return Promise.resolve(s);return Notification.requestPermission().then(function(p){if(p==='denied')return'blocked';if(p!=='granted')return'failed';return call('GET','/__stm/notify/push').then(function(b){if(!b.__ok||!b.publicKey)return'failed';return registration().then(function(r){return r.pushManager.getSubscription().then(function(old){return old?old.unsubscribe().catch(function(){}):null}).then(function(){return r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(b.publicKey)})})}).then(function(sub){return call('POST','/__stm/notify/push',{subscription:sub.toJSON(),locale:locale()})}).then(function(saved){if(!saved.__ok)return'failed';anyone=true;tick();return'on'})})}).catch(function(){return'failed'})}
function disable(){return current().then(function(found){if(!found)return'off';return call('DELETE','/__stm/notify/push',{endpoint:found.sub.endpoint}).then(function(){return found.sub.unsubscribe().catch(function(){})}).then(function(){return'off'})}).catch(function(){return'failed'})}
function setPreview(on){return current().then(function(found){if(!found)return false;return call('PUT','/__stm/notify/push',{endpoint:found.sub.endpoint,preview:!!on}).then(function(b){return!!b.__ok})}).catch(function(){return false})}
function status(){var s=support();if(s!=='ready')return Promise.resolve(s);return current().then(function(found){return found?'on':'off'}).catch(function(){return'off'})}
/* The card: one at a time, at the top where it covers neither the chat nor
   the box being typed in. */
var open=null;
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
function card(title,body){if(!document.getElementById('stm-n-style')){var st=el('style');st.id='stm-n-style';st.textContent=STYLE;document.head.appendChild(st)}close();var c=el('div','stm-n');c.setAttribute('role','dialog');c.setAttribute('aria-label',title);c.appendChild(el('h3','',title));if(body)c.appendChild(el('p','',body));document.body.appendChild(c);open=c;return c}
function close(){if(open&&open.parentNode)open.parentNode.removeChild(open);open=null}
function buttons(c,list){var row=el('div','stm-n-row');list.forEach(function(b){var x=el('button',b.go?'stm-n-go':'',b.label);x.type='button';x.addEventListener('click',function(){b.act(x)});row.appendChild(x)});c.appendChild(row);return row}
function toast(text){var c=card(text,'');setTimeout(function(){if(open===c)close()},5000)}
function reason(s){return s==='needs-home-screen'?T.homeBody:s==='needs-https'?T.needsHttps:s==='blocked'?T.blocked:s==='unsupported'?T.unsupported:''}
function turnOn(button){button.disabled=true;enable().then(function(r){toast(r==='on'?T.on:r==='blocked'?T.blocked:T.failed)})}
/* Asked once, the first time a character replies while somebody looks; again
   a fortnight after "not now", and never once it is on. */
function ask(name){if(asking||open)return;var last=Number(load(ASKED)||0);if(last&&Date.now()-last<ASK_AGAIN)return;asking=true;status().then(function(s){asking=false;if(s!=='off'&&s!=='needs-home-screen')return;var snooze=function(){store(ASKED,String(Date.now()));close()};
if(s==='needs-home-screen'){buttons(card(T.homeTitle,T.homeBody),[{label:T.gotIt,go:true,act:snooze}]);return}
buttons(card(name?T.askTitle.replace('{name}',name):T.askTitleAny,T.askBody),[{label:T.notNow,act:snooze},{label:T.turnOn,go:true,act:function(b){store(ASKED,String(Date.now()));turnOn(b)}}])},function(){asking=false})}
/* The switches, for afterwards: on this device or not, and what it shows. */
function settings(){status().then(function(s){var c=card(T.menu,'');if(s!=='on'&&s!=='off'){if(s!=='framed')c.appendChild(el('p','stm-n-note',reason(s)));buttons(c,[{label:T.close,act:close}]);return}
var notify=el('label'),box=el('input');box.type='checkbox';box.checked=s==='on';notify.appendChild(el('span','',T.notify));notify.appendChild(box);c.appendChild(notify);
var preview=el('label'),pbox=el('input'),words=el('span','',T.preview);pbox.type='checkbox';words.appendChild(el('small','',T.previewNote));preview.appendChild(words);preview.appendChild(pbox);c.appendChild(preview);
function sync(on){pbox.disabled=!on;if(on)preview.removeAttribute('data-off');else preview.setAttribute('data-off','')}
sync(s==='on');pbox.checked=true;if(s==='on')current().then(function(f){if(f)pbox.checked=f.preview});
box.addEventListener('change',function(){box.disabled=true;(box.checked?enable():disable()).then(function(r){box.disabled=false;if(box.checked&&r!=='on'){box.checked=false;var n=c.querySelector('.stm-n-note')||c.insertBefore(el('p','stm-n-note'),c.lastChild);n.textContent=r==='blocked'?T.blocked:T.failed}sync(box.checked);if(box.checked)pbox.checked=true})});
pbox.addEventListener('change',function(){pbox.disabled=true;setPreview(pbox.checked).then(function(ok){pbox.disabled=false;if(!ok)pbox.checked=!pbox.checked})});
buttons(c,[{label:T.close,act:close}])})}
/* An entry in SillyTavern's wand menu, where its own extensions put theirs.
   A version without that menu simply has none. */
function addMenu(){if(framedElsewhere()||document.getElementById('stm_notify_wand_container'))return;var menu=document.getElementById('extensionsMenu');if(!menu){if(++menuTries<30)setTimeout(addMenu,1000);return}
var box=el('div','extension_container');box.id='stm_notify_wand_container';var item=el('div','list-group-item flex-container flexGap5');item.id='stm_notify_menu';item.title=T.menu;item.appendChild(el('div','fa-solid fa-bell extensionsMenuExtensionButton'));item.appendChild(el('span','',T.menu));item.addEventListener('click',function(){settings()});box.appendChild(item);menu.appendChild(box)}
var menuTries=0;
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&open)close()});
window.STMNotify={status:status,enable:enable,disable:disable,settings:settings};
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
