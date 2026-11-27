// Delivers a phone notification (Web Push). Called ONLY by the database (a trigger), never by the app:
// the database looks up who should be told and which phones they've allowed, then posts the list here.
//
// Needs these set in the Vercel project's environment variables:
//   VAPID_PRIVATE_KEY   the private key that identifies Friend Calendar to the phone makers' push services
//   PUSH_SECRET         a shared secret; the database sends it, anyone else is refused
// (The matching public key is worked out from the private key, so there is nothing to keep in step by hand.)
// Without them it answers 503 and nothing is sent (the app still works; you just don't get phone notifications).
//
// GET shows a harmless status page (true/false only, never any value) so setup can be checked from a phone.
const crypto = require('crypto');

// The public key built into the app (index.html). The private key must be the matching one.
const APP_PUBLIC_KEY = 'BCQ7GIIsaELDIFc0QUaSjIaX5kV3-ZEiz5XbHO0KNT9rDkpjjis6Nb1iGl7AYivCs7EV_mU1L5DCwsfc9VPVrzQ';

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// The public key that belongs to a private key (both base64url), or '' if the private key isn't a valid one.
function publicFor(priv) {
  try {
    const raw = Buffer.from(String(priv).trim(), 'base64url');
    if (raw.length !== 32) return '';   // a real private key is exactly 32 bytes
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(raw);
    return ecdh.getPublicKey('base64url');
  } catch (e) { return ''; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const priv = String(process.env.VAPID_PRIVATE_KEY || '').trim(), secret = process.env.PUSH_SECRET;
  const pub = publicFor(priv);

  if (req.method === 'GET') {
    return res.status(200).json({
      privateKeyValid: !!pub,
      keyMatchesApp: !!pub && pub === APP_PUBLIC_KEY,
      pushSecretSet: !!secret,
      ready: !!pub && pub === APP_PUBLIC_KEY && !!secret
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  if (!pub || !secret) return res.status(503).json({ error: 'not_configured' });
  if (!same(req.headers['x-push-secret'], secret)) return res.status(401).json({ error: 'forbidden' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const subs = (Array.isArray(body.subs) ? body.subs : []).filter(function (s) {
    return s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
      && typeof s.p256dh === 'string' && typeof s.auth === 'string';
  }).slice(0, 200);
  if (!subs.length) return res.status(200).json({ sent: 0, failed: 0, gone: [] });

  const clip = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
  const payload = JSON.stringify({
    title: clip(body.title, 80) || 'Friend Calendar',
    body: clip(body.body, 160),
    url: /^\/(?![\/\\])/.test(String(body.url || '')) ? clip(body.url, 200) : '/',   // same-site paths only ("//host" and "/\host" are not)
    tag: clip(body.tag, 60) || undefined
  });

  const webpush = require('web-push');
  webpush.setVapidDetails('https://friend-calendar-five.vercel.app', pub, priv);   // a URL contact, so no personal email is sent anywhere
  let sent = 0, failed = 0; const gone = [];
  await Promise.all(subs.map(async function (s) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'normal' });
      sent++;
    } catch (e) {
      failed++;
      if (e && (e.statusCode === 404 || e.statusCode === 410)) gone.push(s.endpoint);   // the phone removed it; safe to forget
    }
  }));
  return res.status(200).json({ sent, failed, gone });
};
