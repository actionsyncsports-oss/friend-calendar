// Personalizes the link-preview card (iMessage, WhatsApp, etc.) for an
// invite shared from "My QR" / "Add by link", which carries ?from=<name>.
// A link-preview crawler never runs JS, so index.html's static <title>/
// og:* tags are all it ever sees -- the only way to make those reflect
// WHO shared the link is to rewrite them here, before the response
// leaves Vercel's edge. No ?from= (the bare app URL, or ?add= with no
// name attached): index.html is served untouched.
export const config = { matcher: '/' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const from = (url.searchParams.get('from') || '').trim().slice(0, 40);
  if (!from) return;

  const res = await fetch(new URL('/index.html', request.url));
  let html = await res.text();

  const name = esc(from);
  const title = name + ' is inviting you to see their availability';
  const desc = 'Friend Calendar — see when your friends are free, and plan something together.';

  html = html
    .replace(/<title>.*?<\/title>/, '<title>' + title + '</title>')
    .replace(/<meta property="og:title" content=".*?"\/>/, '<meta property="og:title" content="' + title + '"/>')
    .replace(/<meta property="og:description" content=".*?"\/>/, '<meta property="og:description" content="' + desc + '"/>')
    .replace(/<meta name="description" content=".*?"\/>/, '<meta name="description" content="' + desc + '"/>');

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
