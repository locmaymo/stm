/**
 * The Worker that stands in front of a Quick Tunnel and forwards to it.
 *
 * A Quick Tunnel's address is random and changes every time cloudflared
 * starts, which makes it useless as the address somebody keeps: a bookmark
 * from yesterday is a dead hostname today, and the one they were sent by a
 * friend answers `DNS_PROBE_FINISHED_NXDOMAIN` because the name no longer
 * exists in DNS at all. A Worker on the account's own `workers.dev` subdomain
 * has a name that does not move. It is deployed once and redeployed with the
 * new origin whenever the tunnel changes, so the address people hold on to
 * stays the same while the thing behind it comes and goes.
 *
 * What it does is deliberately nothing more than forwarding. Every request
 * arrives at the tunnel with the method, headers and body it was made with,
 * and every answer comes back untouched - so the access gateway behind it sets
 * its own cookies, serves its own sign-in and streams its own responses exactly
 * as it would to a browser that had the tunnel address.
 *
 * `ORIGIN` is the tunnel address, and is empty when there is no tunnel: the
 * Worker then says so rather than forwarding into nothing, because a reader who
 * opens their own address wants to know the tunnel is off, not to read a
 * Cloudflare error page about a hostname they have never heard of.
 *
 * The same page answers a tunnel that has gone away without anybody saying so -
 * a manager stopped, a machine asleep, a container reset. The address it was
 * pointed at is then a name Cloudflare cannot reach, and forwarding to it put
 * Cloudflare's own 530 through this Worker: a wall of error codes about a
 * hostname the reader has never seen, for the ordinary fact that the machine
 * at the other end is off.
 *
 * The one thing it adds to a request is `X-Forwarded-Host`. The console checks
 * that a request that carries an `Origin` came from an address it answers on,
 * and through here those two never match on their own: the browser's origin is
 * this Worker, and `Host` by the time it arrives is the tunnel's random
 * hostname. Without the header the console refuses its own sign-in form with
 * `origin_rejected` - the address opens, shows the page, and cannot be signed
 * in to, which is exactly as useless as not opening at all.
 *
 * Bump `PROXY_WORKER_VERSION` whenever the source changes; a manager that finds
 * an older version deployed replaces it.
 */
export const PROXY_WORKER_VERSION = 5;

/**
 * The two names, and what each one is in front of.
 *
 * Fixed rather than generated, because the whole point is an address that can
 * be remembered and written down. They become
 * `https://stm.<subdomain>.workers.dev` and
 * `https://sillytavern.<subdomain>.workers.dev`.
 */
export const PROXY_SCRIPT_NAMES = {
  manager: 'stm',
  sillyTavern: 'sillytavern',
} as const;

export type ProxyWorkerTarget = keyof typeof PROXY_SCRIPT_NAMES;

export const PROXY_WORKER_TARGETS: readonly ProxyWorkerTarget[] = ['manager', 'sillyTavern'];

/** The path the manager asks a deployed script about itself on. */
export const PROXY_VERSION_PATH = '/__stm-proxy/version';

export const PROXY_WORKER_COMPATIBILITY_DATE = '2026-09-01';

export const PROXY_WORKER_SOURCE = `const VERSION = ${PROXY_WORKER_VERSION};
const VERSION_PATH = ${JSON.stringify(PROXY_VERSION_PATH)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Asked by the manager, to find out what is deployed here and what it is
    // pointed at. Answered before anything is forwarded, so it works even
    // while the tunnel behind this is down.
    if (url.pathname === VERSION_PATH) {
      return json({ version: VERSION, target: env.TARGET || null, origin: env.ORIGIN || null });
    }
    const origin = typeof env.ORIGIN === 'string' ? env.ORIGIN.trim() : '';
    if (!origin) return offline(env, request);
    let upstream;
    try { upstream = new URL(origin); } catch { return offline(env, request); }
    // The path, the query and everything else about the request are the
    // reader's; only where it is sent changes.
    const target = new URL(url.pathname + url.search, upstream.origin);
    try {
      /*
       * The original request, at a different address.
       *
       * Built from \`request\` rather than copied field by field, because that
       * is what carries a WebSocket upgrade through - and the console shows
       * SillyTavern in a frame that streams. \`redirect: 'manual'\` keeps a
       * redirect the origin issues as an answer for the browser to follow
       * through this Worker, instead of following it here and returning the
       * result of a different address.
       */
      const forwarded = new Request(target, request);
      // Kept so the answer below can be recognised as the tunnel being gone
      // rather than as the thing behind it having an opinion.
      const tunnelled = upstream.hostname.endsWith('.trycloudflare.com');
      // What the browser actually typed, which nothing downstream can work out
      // for itself once Host has become the tunnel's. Left alone on an upgrade:
      // a WebSocket handshake is the one request the runtime is particular
      // about, nothing behind this checks the origin of one, and carrying the
      // socket matters more than labelling it.
      if (!request.headers.get('upgrade')) {
        forwarded.headers.set('x-forwarded-host', url.host);
        forwarded.headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
      }
      const answer = await fetch(forwarded, { redirect: 'manual' });
      /*
       * Cloudflare could not reach the tunnel, which by now is not there.
       *
       * A Quick Tunnel's hostname stays in DNS behind Cloudflare after
       * cloudflared exits, so this does not fail as a name that cannot be
       * resolved: it comes back as an answer, 530, and this Worker passed it
       * on. Somebody opening the address they were given got a Cloudflare
       * error page naming a random hostname, rather than being told that the
       * machine is off.
       */
      if (answer.status === 530 && tunnelled) return offline(env, request);
      return answer;
    } catch (error) {
      // The name has gone from DNS too, which is the same fact arriving as a
      // failure instead of as an answer.
      if (upstream.hostname.endsWith('.trycloudflare.com')) return offline(env, request);
      return json({ error: 'origin_unreachable', message: String(error && error.message || error).slice(0, 200) }, 502);
    }
  },
};

/**
 * The tunnel is off, or was never there - or is on its way.
 *
 * A calm page rather than an error, because this is the expected state of a
 * machine that is switched off: the address is right and there is nothing
 * behind it yet. It says so first, then what to check on the machine, and then
 * waits with the reader: it asks again on its own, less often the longer it
 * has waited and not at all while the tab is hidden, and opens the real page
 * the moment the address answers with something that is not this.
 *
 * In the reader's language - Vietnamese where the browser asks for it, English
 * otherwise - with a switch between the two that is remembered in the browser.
 */
function offline(env, request) {
  const manager = env.TARGET === 'manager';
  const texts = manager ? {
    vi: {
      title: 'STM chưa sẵn sàng',
      check: 'Hãy kiểm tra:',
      s1: 'Máy tính đang chạy SillyTavern Manager đã bật và vẫn kết nối mạng.',
      s2: 'Trong Thiết lập của SillyTavern Manager, kiểm tra “Mở stm ra internet” đã bật chưa.',
      note: 'Trang này sẽ tự mở STM ngay khi sẵn sàng, không cần tải lại.',
      wait: 'Đang chờ liên kết STM của bạn',
    },
    en: {
      title: 'STM isn’t ready yet',
      check: 'Things to check:',
      s1: 'The computer running SillyTavern Manager is on and connected.',
      s2: 'In SillyTavern Manager’s settings, check that “Open stm to the internet” is switched on.',
      note: 'This page opens STM by itself as soon as it’s ready. No need to reload.',
      wait: 'Waiting for your STM link',
    },
  } : {
    vi: {
      title: 'SillyTavern chưa sẵn sàng',
      check: 'Hãy kiểm tra:',
      s1: 'Máy tính đang chạy SillyTavern Manager đã bật, và SillyTavern đang chạy.',
      s2: 'Trong SillyTavern Manager, kiểm tra Link truy cập SillyTavern đã bật chưa.',
      note: 'Trang này sẽ tự mở SillyTavern ngay khi sẵn sàng, không cần tải lại.',
      wait: 'Đang chờ liên kết SillyTavern của bạn',
    },
    en: {
      title: 'SillyTavern isn’t ready yet',
      check: 'Things to check:',
      s1: 'The computer running SillyTavern Manager is on, and SillyTavern is running.',
      s2: 'In SillyTavern Manager, check that the SillyTavern access link is switched on.',
      note: 'This page opens SillyTavern by itself as soon as it’s ready. No need to reload.',
      wait: 'Waiting for your SillyTavern link',
    },
  };
  const lang = ((request && request.headers.get('accept-language')) || '').trim().toLowerCase().startsWith('vi') ? 'vi' : 'en';
  const t = texts[lang];
  const line = (id, tag, cls) => '<' + tag + ' id="' + id + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + t[id] + '</' + tag + '>';
  return new Response(
    '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + '<title>' + t.title + '</title>'
    + '<style>'
    + ':root{color-scheme:light dark;--base:#e7defe;--wall:linear-gradient(140deg,#cdb9ff 0%,#ffc7e3 42%,#ffd9b0 62%,#b5dcff 100%);--ink:#141026;--muted:#4f4a66;--glass:rgba(255,255,255,.58);--edge:rgba(255,255,255,.75);--chip:rgba(20,16,38,.06);--accent:#6d4aff;--blob:.95}'
    + '@media (prefers-color-scheme:dark){:root{--base:#0a0914;--wall:linear-gradient(140deg,#1b1240 0%,#2a0f33 45%,#10213d 100%);--ink:#f3f1ff;--muted:#b9b3d6;--glass:rgba(22,19,40,.52);--edge:rgba(255,255,255,.12);--chip:rgba(255,255,255,.08);--accent:#a996ff;--blob:.8}}'
    + '*{box-sizing:border-box}html,body{height:100%}'
    + 'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;overflow:hidden;background:var(--base) var(--wall) fixed;color:var(--ink);'
    + 'font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}'
    // The wallpaper: large colour fields that drift, turn and change shape,
    // blurred together the way a desktop background is.
    + '.bg{position:fixed;inset:-20%;filter:blur(90px) saturate(160%);opacity:var(--blob);pointer-events:none}'
    + '.bg i{position:absolute;display:block;width:55vmax;height:55vmax;border-radius:42% 58% 63% 37%/45% 40% 60% 55%;mix-blend-mode:normal}'
    + '.b1{background:#ff5fa8;top:-10%;left:-8%;animation:w1 38s ease-in-out infinite}'
    + '.b2{background:#7a54ff;top:0;right:-12%;animation:w2 44s ease-in-out infinite}'
    + '.b3{background:#2f8fff;bottom:-18%;left:6%;animation:w3 41s ease-in-out infinite}'
    + '.b4{background:#1fd1e6;bottom:-8%;right:-6%;width:44vmax;height:44vmax;animation:w4 47s ease-in-out infinite}'
    + '.b5{background:#ffa24d;top:32%;left:30%;width:40vmax;height:40vmax;animation:w5 35s ease-in-out infinite}'
    + '@keyframes w1{0%,100%{transform:translate(0,0) rotate(0) scale(1)}25%{transform:translate(45vw,20vh) rotate(60deg) scale(1.2)}50%{transform:translate(30vw,65vh) rotate(140deg) scale(.9)}75%{transform:translate(-5vw,40vh) rotate(220deg) scale(1.1)}}'
    + '@keyframes w2{0%,100%{transform:translate(0,0) rotate(0) scale(1)}25%{transform:translate(-40vw,35vh) rotate(-70deg) scale(.85)}50%{transform:translate(-65vw,5vh) rotate(-150deg) scale(1.15)}75%{transform:translate(-20vw,55vh) rotate(-230deg) scale(1)}}'
    + '@keyframes w3{0%,100%{transform:translate(0,0) rotate(0) scale(1)}25%{transform:translate(50vw,-30vh) rotate(80deg) scale(1.1)}50%{transform:translate(15vw,-65vh) rotate(160deg) scale(.9)}75%{transform:translate(-10vw,-25vh) rotate(250deg) scale(1.2)}}'
    + '@keyframes w4{0%,100%{transform:translate(0,0) rotate(0) scale(1)}25%{transform:translate(-55vw,-20vh) rotate(-60deg) scale(1.2)}50%{transform:translate(-25vw,-60vh) rotate(-140deg) scale(1)}75%{transform:translate(5vw,-35vh) rotate(-220deg) scale(.85)}}'
    + '@keyframes w5{0%,100%{transform:translate(0,0) rotate(0) scale(1)}25%{transform:translate(-35vw,-30vh) rotate(90deg) scale(.8)}50%{transform:translate(30vw,-20vh) rotate(180deg) scale(1.2)}75%{transform:translate(20vw,30vh) rotate(270deg) scale(.95)}}'
    + '.grain{position:fixed;inset:0;pointer-events:none;opacity:.05;background-image:radial-gradient(rgba(0,0,0,.6) 1px,transparent 1px);background-size:3px 3px}'
    // The card: frosted glass over the wallpaper.
    + '.card{position:relative;width:min(100%,30rem);padding:30px 28px 24px;border-radius:26px;background:var(--glass);border:1px solid var(--edge);'
    + '-webkit-backdrop-filter:blur(30px) saturate(170%);backdrop-filter:blur(30px) saturate(170%);box-shadow:0 30px 80px -30px rgba(30,15,80,.45)}'
    + 'h1{margin:0 0 16px;font-size:1.55rem;line-height:1.25;font-weight:650;letter-spacing:-.01em}'
    + '.check{margin:0 0 10px;font-weight:600;font-size:.95rem}'
    + 'ol{margin:0 0 18px;padding:0;list-style:none;counter-reset:s;display:grid;gap:10px}'
    + 'ol li{counter-increment:s;display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;font-size:.95rem}'
    + 'ol li:before{content:counter(s);display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--chip);font-weight:650;font-size:.85rem;color:var(--accent)}'
    + '.note{margin:0 0 20px;font-size:.9rem;color:var(--muted)}'
    + '.row{display:flex;justify-content:center}'
    + '.wait{display:inline-flex;align-items:center;gap:10px;padding:8px 14px;border-radius:999px;background:var(--chip);font-size:.88rem;color:var(--muted)}'
    + '.dots{display:inline-flex;gap:4px}.dots i{width:6px;height:6px;border-radius:50%;background:var(--accent);animation:blink 1.2s ease-in-out infinite}'
    + '.dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}'
    + '@keyframes blink{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}'
    + 'button{font:inherit;cursor:pointer}'
    + '.lang{position:fixed;top:max(14px,env(safe-area-inset-top));right:14px;display:flex;padding:3px;border-radius:999px;background:var(--glass);border:1px solid var(--edge);'
    + '-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}'
    + '.lang button{min-width:40px;padding:5px 10px;border:0;border-radius:999px;background:transparent;color:var(--muted);font-size:.8rem;font-weight:650}'
    + '.lang button[aria-pressed=true]{background:var(--ink);color:var(--base)}'
    + '@media (prefers-reduced-motion:reduce){.bg i,.dots i{animation:none}}'
    + '</style></head><body>'
    + '<div class="bg" aria-hidden="true"><i class="b1"></i><i class="b2"></i><i class="b3"></i><i class="b4"></i><i class="b5"></i></div><div class="grain" aria-hidden="true"></div>'
    + '<div class="lang" role="group" aria-label="Language"><button type="button" data-lang="vi" aria-pressed="' + (lang === 'vi') + '">VI</button><button type="button" data-lang="en" aria-pressed="' + (lang === 'en') + '">EN</button></div>'
    + '<main class="card">'
    + line('title', 'h1') + line('check', 'p', 'check')
    + '<ol><li id="s1">' + t.s1 + '</li><li id="s2">' + t.s2 + '</li></ol>'
    + line('note', 'p', 'note')
    + '<div class="row"><span class="wait" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="wait">' + t.wait + '</span></span></div></main>'
    + '<script>(function(){var T=' + JSON.stringify(texts) + ',KEY="stm-wait-lang",lang="' + lang + '",n=0,timer=0;'
    + 'try{var saved=localStorage.getItem(KEY);if(T[saved])lang=saved}catch(e){}'
    + 'function apply(l){lang=l;var t=T[l];document.documentElement.lang=l;document.title=t.title;'
    + '["title","check","s1","s2","note","wait"].forEach(function(id){document.getElementById(id).textContent=t[id]});'
    + 'Array.prototype.forEach.call(document.querySelectorAll("[data-lang]"),function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-lang")===l))})}'
    + 'apply(lang);'
    + 'document.querySelector(".lang").addEventListener("click",function(e){var b=e.target.closest("[data-lang]");if(!b)return;apply(b.getAttribute("data-lang"));try{localStorage.setItem(KEY,lang)}catch(e){}});'
    + 'function delay(){return n<24?5000:n<56?15000:60000}'
    + 'function ask(){timer=0;if(document.hidden)return;n+=1;'
    + 'fetch(location.href,{cache:"no-store",credentials:"same-origin"}).then(function(r){'
    + 'if(!r.headers.get("x-stm-offline")){location.reload();return}next()}).catch(next)}'
    + 'function next(){if(!timer&&!document.hidden)timer=setTimeout(ask,delay())}'
    + 'document.addEventListener("visibilitychange",function(){if(!document.hidden)next()});next()})()</script>'
    + '</body></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-stm-offline': '1' } },
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
`;
