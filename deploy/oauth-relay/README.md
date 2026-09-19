# The project site and the Cloudflare OAuth relay

This directory is the Wrangler project that publishes `stm.locmaymo.top`. The
pages themselves live in [`apps/site`](../../apps/site) and are built into
`apps/site/dist`, which is what Wrangler uploads. Nothing here is committed
output: run the build first.

The site carries the landing page, the documentation and the legal documents,
plus the OAuth relay described below.

## Cloudflare OAuth relay

The static page Cloudflare returns the browser to after **Connect Cloudflare**. It
reads which manager started the sign-in from the OAuth `state` and sends the
`code` and `state` back to that manager's `/oauth/cloudflare/callback`.

Cloudflare only redirects to an address registered on the OAuth client, matched
exactly, while a manager can be open on any port or host: this machine, the LAN, a
tunnel, ModelScope. So one address is registered, this page, and it forwards.

It forwards on its own only to loopback, private-network, `.local`,
`*.trycloudflare.com` and ModelScope hosts. Any other address is shown with a
**Continue** button, so the page cannot be used as a silent redirect to another site.
The authorization code is useless without the PKCE verifier, which never leaves the
manager.

## Deploy

The project's copy runs as the Worker `stm-oauth-relay` with static assets on
`stm.locmaymo.top`.

It deploys itself. [`.github/workflows/site.yml`](../../.github/workflows/site.yml)
runs on every push to `main` that touches `apps/site`, `packages/legal` or this
directory, builds the pages and uploads them. The relay page is part of how the
manager signs in to Cloudflare, so a change to it that sits undeployed is a
sign-in behaving differently from the code that ships with it.

It needs two repository secrets, on an environment named `site`:

| Secret | What it is |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with **Workers Scripts: Edit**. Create it under **My Profile → API Tokens**, not as an account-wide key. |
| `CLOUDFLARE_ACCOUNT_ID` | The account ID from the Cloudflare dashboard sidebar. |

By hand, when you want to deploy without a push:

```bash
npm run site:build
npx wrangler login
cd deploy/oauth-relay
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
