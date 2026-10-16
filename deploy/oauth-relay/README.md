# The project site, the OAuth relay and the Google token broker

This directory is the Wrangler project that publishes `stm.locmaymo.top`. The
pages themselves live in [`apps/site`](../../apps/site) and are built into
`apps/site/dist`, which is what Wrangler uploads. Nothing here is committed
output: run the build first.

The site carries the landing page, the documentation and the legal documents,
plus the OAuth relay and the Google token broker described below.

## Cloudflare OAuth relay

The static page Cloudflare returns the browser to after **Connect Cloudflare**. It
reads which manager started the sign-in from the OAuth `state` and sends the
`code` and `state` back to that manager's `/oauth/cloudflare/callback`.

Cloudflare only redirects to an address registered on the OAuth client, matched
exactly, while a manager can be open on any port or host: this machine, the LAN, a
tunnel, a hosted workspace. So one address is registered, this page, and it forwards.

It forwards on its own only to loopback, private-network and `.local` hosts. Any
other address - tunnels and hosting platforms included, since anyone can get a name
there - is shown with a **Continue** button, so the page cannot be used as a silent
redirect to another site. The page names no provider and carries a footer linking
to the project and this repository: a page that forwards sign-in codes to public
addresses, or that shows a third party's name on a domain that is not theirs, is
what browsers' phishing checks look for.
The authorization code is useless without the PKCE verifier, which never leaves the
manager.

## Google token broker

Google's web OAuth clients want the client secret at the code exchange and at
every refresh, and the secret cannot ship with the manager: this repository is
public, and anything in the npm package or the APK can be read back out. So the
Worker has one script, [`src/broker.ts`](src/broker.ts), that holds it:

| Route | The manager sends | The broker adds |
| --- | --- | --- |
| `POST /api/google/token` | `{ code, code_verifier }` | client ID, secret, the fixed `redirect_uri` |
| `POST /api/google/refresh` | `{ refresh_token }` | client ID, secret |

It forwards to Google's token endpoint and nowhere else, keeps nothing, logs no
bodies, answers no CORS preflight, and wants a JSON body, so a page on another
site cannot use it from a visitor's browser. Backups never pass through it:
the manager talks to Google Drive directly with the access token.

Only `/api/*` runs the script first (`run_worker_first`); files are served
without it, and any other address is handed back to the site.

The secret is a **Worker secret**, never a file. Set it once, after the first
deploy that includes the script (Cloudflare refuses secrets on a Worker that is
only static assets):

- in the dashboard: **Workers & Pages → stm-oauth-relay → Settings → Variables
  and Secrets → Add**, type **Secret**, name `GOOGLE_CLIENT_SECRET`; or
- from this directory: `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

Secrets survive deploys. Until it is set, both routes answer
`503 broker_not_configured`.

If the secret ever leaks: add a second secret on the Google client, put the new
one here, then disable the old one. Users' refresh tokens keep working, so
nobody needs a new release. To stop new sign-ins during abuse while existing
users keep refreshing, set `GOOGLE_SIGNIN_PAUSED` to `"1"` in `wrangler.jsonc`
and deploy. A per-address rate limit (`GOOGLE_LIMITER`) is in the same file.

`npm run verify` runs `scripts/secret-gate.mjs`, which fails on anything shaped
like a Google client secret, access token or refresh token in a tracked file,
and on a tracked `client_secret_*.json`.

## Deploy

The project's copy runs as the Worker `stm-oauth-relay` with static assets on
`stm.locmaymo.top`.

It deploys itself. [`.github/workflows/site.yml`](../../.github/workflows/site.yml)
runs on every push to `main` that touches `apps/site`, `packages/legal` or this
directory, builds the pages and uploads them. The relay page is part of how the
manager signs in to Cloudflare, so a change to it that sits undeployed is a
sign-in behaving differently from the code that ships with it.

It needs two repository secrets:

| Secret | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with **Workers Scripts: Edit** on the account below — the *Edit Cloudflare Workers* template gives it. Create it under **My Profile → API Tokens**, not as an account-wide key. |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from the Cloudflare dashboard sidebar. Paste it with no trailing newline. |

The workflow asks Cloudflare whether those two reach this account's Workers
before it builds anything to upload. Cloudflare answers a wrong account ID and a
token without the permission with the same `7003 ... perhaps your object
identifier is invalid`, which names neither; the check says which.

Wrangler is a dev dependency of this directory, pinned and locked in its own
`package.json`, and the workflow runs that one. It is not left to
`cloudflare/wrangler-action` to choose: the version it picked was 3.90, which
cannot deploy a Worker that is only static assets and asked for an entry point
this site does not have.

It lives here rather than at the repository root because it pulls in
`workerd`, the Workers runtime, whose install script knows only macOS, Linux
and Windows and fails outright on Android. The manager itself runs on Termux,
and a root `npm ci` there would die on a dependency only a deploy ever needs.
Installing the manager no longer installs Wrangler at all; deploying the site
installs it in this directory.

By hand, when you want to deploy without a push:

```bash
npm run site:build
cd deploy/oauth-relay
npm ci
npx wrangler login
npx wrangler deploy
```

Change the `routes` pattern in `wrangler.jsonc` to deploy it on another domain.
`/oauth/cloudflare/callback` is served from
`apps/site/public/oauth/cloudflare/callback.html` without a redirect, so the
registered URI is answered exactly as registered.

## Registering an OAuth client

Needed only by the project's maintainer, or by someone running their own client.

1. In the Cloudflare dashboard, **Manage Account → OAuth clients → Create client**.
2. **Token authentication method:** `none` (a public client with PKCE; there is no
   secret to ship). **Grant types:** `authorization_code`, `refresh_token`.
   **Response type:** `code`.
3. **Redirect URLs:** `https://<your domain>/oauth/cloudflare/callback`. Add
   `http://localhost:7860/oauth/cloudflare/callback` for development if you like.
4. **Scopes:**

   | Permission | Scope ID | Required |
   | --- | --- | --- |
   | Workers R2 Storage Read / Edit | `workers-r2.read`, `workers-r2.write` | yes |
   | Workers R2 Storage Bucket Item Read / Edit | `workers-r2-bucket-item.read`, `workers-r2-bucket-item.write` | yes |
   | Workers Scripts Edit | `workers-scripts.write` | optional: the fast Worker data path |
   | Account Analytics Read | `account-analytics.read` | optional: usage figures |

   Cloudflare does not offer API token permissions to OAuth clients, which is why
   data goes through a Worker rather than through minted S3 keys.
5. A new client is **private**: only members of your account can authorize it. To
   let anyone use it, add a logo and a client URL, verify the client URL's domain
   with the `TXT` record Cloudflare gives you, and change the visibility to public.
   That change cannot be undone.
6. Point the manager at the client with `STM_CLOUDFLARE_OAUTH_CLIENT_ID` and
   `STM_CLOUDFLARE_OAUTH_REDIRECT_URI` (see `.env.example`), and deploy this relay on
   the redirect's domain.

A scope ID a client does not have is refused with `invalid_scope` before the sign-in
page even loads, which is a quick way to check a registration:

```bash
curl -s -o /dev/null -w "%{redirect_url}\n" "https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<URL-ENCODED REDIRECT>&state=abcdefghijklmnop&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=workers-r2.read"
```
