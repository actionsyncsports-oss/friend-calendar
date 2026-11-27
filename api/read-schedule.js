// Reads a photo of a (possibly handwritten) work schedule and returns the
// signed-in person's shifts as JSON, for the "Work hours -> Photo" screen.
//
// - Needs ANTHROPIC_API_KEY set in the Vercel project's environment. Without
//   it this answers 503 "not_configured" and the app falls back to typing
//   shifts in by hand.
// - Only callable by a signed-in Friend Calendar user: the caller's Supabase
//   access token is checked against Supabase before anything is spent.
// - The photo is forwarded to the model and discarded -- never stored or logged.
const SUPABASE_URL = 'https://wtbgmzxnkraghdghdhjd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_a02VCZ_JkJnfBwULZvfziA_aGQPXUR_';
const MODEL = process.env.SCHEDULE_MODEL || 'claude-sonnet-5-5';
const MAX_B64 = 3_800_000;          // ~2.8 MB of image; the page shrinks photos well below this
const DAILY_LIMIT = 20;             // per person, per warm server instance (best-effort brake, not a ledger)

const _used = new Map();            // userId -> { day, n }
function overLimit(uid) {
  const day = new Date().toISOString().slice(0, 10);
  const u = _used.get(uid);
  if (!u || u.day !== day) { _used.set(uid, { day, n: 1 }); return false; }
  u.n += 1;
  return u.n > DAILY_LIMIT;
}

function buildPrompt(name, today) {
  return [
    'This is a photo of a work schedule, possibly handwritten. Today is ' + today + '.',
    name ? 'Find the shifts for the person named "' + name + '" (the row or column with that name; match nicknames and partial names sensibly). If the schedule clearly belongs to one person only, use all of it.'
         : 'If the schedule clearly belongs to one person, use all of it; otherwise return nothing and explain in "unsure".',
    'Return ONLY a JSON object, no other text, in exactly this shape:',
    '{"shifts":[{"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM"}],"unsure":""}',
    'Rules:',
    '- 24-hour times. One entry per continuous stretch of work: a split shift (e.g. 11-3 and 5-10 on one day) is TWO entries with the same date.',
    '- Turn weekday names and day numbers into real dates. Use the dates printed on the schedule if there are any; if it only shows weekdays, use the coming occurrence on or after today. Dates must not be in the past unless the schedule clearly shows past dates.',
    '- If am/pm is not written, assume restaurant/shop hours (e.g. "5-11" is 17:00-23:00, "11-3" is 11:00-15:00) and mention it in "unsure".',
    '- "close" or "cl" -> end "23:59"; "open" -> start "09:00" unless something else is clear; mention either in "unsure".',
    '- A shift that runs past midnight ends at "23:59" on its start date (do not carry it onto the next day); mention it in "unsure".',
    '- Skip days marked off, OFF, vacation, or blank.',
    '- "unsure" is a short plain sentence about anything hard to read or assumed (smudged digits, guessed years, guessed am/pm), or empty if all was clear. Never invent shifts you cannot see.'
  ].join('\n');
}

function clean(shifts) {
  const out = [];
  (Array.isArray(shifts) ? shifts : []).forEach((s) => {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) return;
    const a = /^(\d{1,2}):(\d{2})$/.exec(String(s.start)), b = /^(\d{1,2}):(\d{2})$/.exec(String(s.end));
    if (!a || !b) return;
    const st = +a[1] + a[2] / 60, en = +b[1] + b[2] / 60;
    if (st < 0 || st > 24 || en <= 0 || en > 24 || en <= st) return;
    out.push({ date: s.date, start: String(s.start), end: String(s.end) });
  });
  return out.slice(0, 120);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'not_configured' });

  // Who is asking? Ask Supabase to vouch for the bearer token.
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'signin' });
  let user;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) return res.status(401).json({ error: 'signin' });
    user = await r.json();
  } catch (e) { return res.status(502).json({ error: 'auth_unreachable' }); }
  if (!user || !user.id) return res.status(401).json({ error: 'signin' });
  if (overLimit(user.id)) return res.status(429).json({ error: 'limit' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const image = String(body.image || '');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(body.mediaType) ? body.mediaType : 'image/jpeg';
  if (!image || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) return res.status(400).json({ error: 'image' });
  const name = String(body.name || '').replace(/[^\p{L}\p{N} .'’-]/gu, '').slice(0, 40);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today)) ? body.today : new Date().toISOString().slice(0, 10);

  let reply;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2500,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: buildPrompt(name, today) }
        ] }]
      })
    });
    if (!r.ok) return res.status(502).json({ error: 'model', status: r.status });
    reply = await r.json();
  } catch (e) { return res.status(502).json({ error: 'model_unreachable' }); }

  const text = (reply.content || []).map((c) => c.text || '').join('');
  const m = /\{[\s\S]*\}/.exec(text);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch (e) { parsed = null; }
  if (!parsed) return res.status(502).json({ error: 'unreadable' });
  return res.status(200).json({ shifts: clean(parsed.shifts), unsure: String(parsed.unsure || '').slice(0, 300) });
};
