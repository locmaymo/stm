import { handle, type Env } from './broker.js';

interface WorkerEnv extends Env {
  /** The static site, for addresses that are neither a file nor the broker's. */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * The Worker entry point: only the default export, see `broker.ts`.
 *
 * Files are served before this runs. What reaches it is `/api/*` and any
 * address that matched no file, and the second kind goes back to the static
 * site so it gets the site's own 404 page rather than the broker's JSON.
 */
export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> => new URL(request.url).pathname.startsWith('/api/')
    ? handle(request, env, fetch)
    : env.ASSETS.fetch(request),
};
