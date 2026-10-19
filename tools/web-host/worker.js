// shared.numaworth.com: the Numa Shared web app under /app, and the backend's public pages under
// the branded address.
//
// - /app and below: the web app (an Expo web export, served as a single-page app).
// - GET pages (home, privacy, support, invite pages, Apple's app-site-association): fetched from the
//   backend and served here, so the address stays shared.numaworth.com.
// - Anything else (sign-in, invite checks, card sync, an invite page's "View invite" form): sent
//   straight to the backend with a 307, so its rate limits see each person's own IP rather than
//   this Worker's.
const BACKEND = 'https://adept-camel-457.convex.site';
const PAGES = [/^\/$/, /^\/assets\//, /^\/privacy$/, /^\/support$/, /^\/join\/[^/]+$/, /^\/\.well-known\/apple-app-site-association$/];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
    if (url.pathname.startsWith('/app/')) {
      const inner = new URL(request.url);
      inner.pathname = url.pathname.slice('/app'.length);
      return env.ASSETS.fetch(new Request(inner, request));
    }
    const target = `${BACKEND}${url.pathname}${url.search}`;
    if ((request.method === 'GET' || request.method === 'HEAD') && PAGES.some((p) => p.test(url.pathname))) {
      const upstream = await fetch(target, { method: request.method, headers: { Accept: request.headers.get('Accept') ?? '*/*' }, redirect: 'manual' });
      const headers = new Headers(upstream.headers);
      headers.delete('set-cookie');
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    return Response.redirect(target, 307);
  },
};
