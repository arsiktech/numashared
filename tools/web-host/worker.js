// shared.numaworth.com: the Numa Shared web app under /app, and the backend's public pages under
// the branded address.
//
// - /app and below: the web app (an Expo web export, served as a single-page app).
// - GET pages (home, privacy, support, invite pages, Apple's app-site-association): fetched from the
//   backend and served here, so the address stays shared.numaworth.com.
// - Any other GET a person could open: a small "page not found" with a way back.
// - Anything else (sign-in, invite checks, card sync, an invite page's "View invite" form): sent
//   straight to the backend with a 307, so its rate limits see each person's own IP rather than
//   this Worker's.
const BACKEND = 'https://adept-camel-457.convex.site';
// Read by apps and scripts, never by a person in a browser: these go to the backend like a POST.
const API = [/^\/auth\//, /^\/app-config$/, /^\/card-sync\//];
const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Page not found · Numa Shared</title><style>body{margin:0;font:17px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fbfaf6;color:#1e2420}
main{max-width:34rem;margin:0 auto;padding:18vh 22px 48px}h1{font-size:2rem;line-height:1.15;margin:0 0 .6rem}p{color:#595d56;margin:0 0 1.4rem}
a{display:inline-block;padding:12px 0;margin-right:1.4rem;color:#1e2420;font-weight:650}
@media (prefers-color-scheme:dark){body{background:#121512;color:#eef0e6}p{color:#adb1a6}a{color:#eef0e6}}</style></head>
<body><main><h1>This page doesn’t exist</h1><p>The link may be old or mistyped.</p><a href="/">Numa Shared home</a><a href="/app/">Open the app</a></main></body></html>`;
const PAGES = [/^\/$/, /^\/assets\//, /^\/privacy$/, /^\/support$/, /^\/terms$/, /^\/join\/[^/]+$/, /^\/\.well-known\/apple-app-site-association$/];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
    if (url.pathname.startsWith('/app/')) {
      const inner = new URL(request.url);
      inner.pathname = url.pathname.slice('/app'.length);
      const res = await env.ASSETS.fetch(new Request(inner, request));
      // Bundles and fonts carry a content hash in their names, so a return visit needn't fetch them.
      if (res.ok && /^\/(_expo\/static|assets)\//.test(inner.pathname)) {
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    // "/privacy/" is the same page as "/privacy".
    const bare = url.pathname.replace(/\/+$/, '');
    if (bare && bare !== url.pathname && PAGES.some((p) => p.test(bare))) return Response.redirect(`${url.origin}${bare}${url.search}`, 301);
    const target = `${BACKEND}${url.pathname}${url.search}`;
    if ((request.method === 'GET' || request.method === 'HEAD') && PAGES.some((p) => p.test(url.pathname))) {
      const upstream = await fetch(target, { method: request.method, headers: { Accept: request.headers.get('Accept') ?? '*/*' }, redirect: 'manual' });
      const headers = new Headers(upstream.headers);
      headers.delete('set-cookie');
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && !API.some((p) => p.test(url.pathname))) {
      return new Response(request.method === 'HEAD' ? null : NOT_FOUND, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return Response.redirect(target, 307);
  },
};
