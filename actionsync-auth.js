/* ============================================================
   ActionSync — shared auth module
   ------------------------------------------------------------
   ONE source of truth for "is someone signed in, and who are they".

   Every page previously loaded Supabase on its own setTimeout, built its
   own client, and never checked whether the stored session still matched a
   real profile. That produced three separate symptoms:

     - code running before the client existed saw "no session"
     - a deleted profile left a live session, so the next signup skipped
       the password step and logged straight into the dead account
     - each page invented its own redirect rules

   This module replaces all of that. Usage:

     await AS.auth.ready();            // client + session resolved
     const user = AS.auth.user();      // auth user or null
     const prof = AS.auth.profile();   // profiles row or null

   ready() is safe to call from anywhere, any number of times — the work
   happens once and every caller awaits the same promise.
   ============================================================ */

window.AS = window.AS || {};

(function () {
  'use strict';

  var SUPABASE_URL = 'https://wtbgmzxnkraghdghdhjd.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_a02VCZ_JkJnfBwULZvfziA_aGQPXUR_';
  var SDK_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0';

  var _client = null;
  var _user = null;
  var _profile = null;
  var _ready = null;
  var _listeners = [];

  // ---- SDK loading -------------------------------------------------
  function loadSdk() {
    return new Promise(function (resolve, reject) {
      if (typeof supabase !== 'undefined' && supabase.createClient) return resolve();
      var existing = document.querySelector('script[data-as-supabase]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('SDK failed')); });
        return;
      }
      var s = document.createElement('script');
      s.src = SDK_SRC;
      s.setAttribute('data-as-supabase', '1');
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Supabase SDK failed to load')); };
      document.head.appendChild(s);
    });
  }

  // ---- Session validation -----------------------------------------
  // A session whose profiles row no longer exists is ORPHANED: the account
  // was deleted, or the profile write failed during signup. Keeping it
  // signed in is what made a fresh signup skip the password step. We sign
  // out so the next attempt starts genuinely clean.
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // A query error or thrown exception here is NOT proof the profile is
  // missing — it's usually a cold connection (first load on a new device,
  // a mobile network still settling) racing the query. Treating that the
  // same as "no row" signed a real account out or, worse, sent a caller's
  // needsProfile check straight to onboarding for someone who already has
  // a complete profile. So this retries a genuine error a couple of times
  // before giving up — only an actual empty result (query succeeded, zero
  // rows) is treated as confirmed-missing, immediately, no retry.
  function queryProfile(user, attempt) {
    return _client
      .from('profiles').select('id, name, display_name, first_name, last_name')
      .eq('id', user.id).maybeSingle()
      .then(function (res) {
        if (res.error) {
          if (attempt < 2) return sleep(400).then(function () { return queryProfile(user, attempt + 1); });
          console.warn('[auth] profile check failed after retries (kept session):', res.error.message);
          return { confirmed: false, data: null };
        }
        return { confirmed: true, data: res.data };
      })
      .catch(function (e) {
        if (attempt < 2) return sleep(400).then(function () { return queryProfile(user, attempt + 1); });
        console.warn('[auth] profile check threw after retries (kept session):', e && e.message);
        return { confirmed: false, data: null };
      });
  }

  function validate(user) {
    if (!user) return Promise.resolve(null);
    return queryProfile(user, 0).then(function (result) {
      if (!result.confirmed) return null;   // inconclusive — keep the session, assume they have one
      if (!result.data) {
        console.warn('[auth] orphaned session (no profile row) — signing out');
        return _client.auth.signOut().then(function () {
          _user = null;
          clearDeviceIdentity();
          return null;
        });
      }
      return result.data;
    });
  }

  function clearDeviceIdentity() {
    // Identity only. Content (areas, logs, photos) is deliberately left
    // alone so signing out doesn't destroy someone's work.
    ['actionsync_sb_session', 'actionsync_my_profile', 'actionsync_identity']
      .forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  }

  // ---- Init --------------------------------------------------------
  function init() {
    if (_ready) return _ready;
    _ready = loadSdk()
      .then(function () {
        _client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        window._sb = _client;   // back-compat: existing pages read window._sb
        window._sbReady = true;

        _client.auth.onAuthStateChange(function (event, session) {
          _user = session ? session.user : null;
          window._meId = _user ? _user.id : null;
          _listeners.forEach(function (fn) { try { fn(_user); } catch (e) {} });
        });

        return _client.auth.getSession();
      })
      .then(function (res) {
        _user = (res && res.data && res.data.session) ? res.data.session.user : null;
        window._meId = _user ? _user.id : null;
        return validate(_user);
      })
      .then(function (prof) {
        _profile = prof;
        return { user: _user, profile: _profile };
      })
      .catch(function (e) {
        console.warn('[auth] init failed:', e && e.message);
        return { user: null, profile: null };
      });
    return _ready;
  }

  // ---- Public API --------------------------------------------------
  AS.auth = {
    ready: init,
    client: function () { return _client; },
    user: function () { return _user; },
    profile: function () { return _profile; },
    isSignedIn: function () { return !!_user; },

    onChange: function (fn) { if (typeof fn === 'function') _listeners.push(fn); },

    signIn: function (email, password) {
      return init().then(function () {
        return _client.auth.signInWithPassword({
          email: String(email || '').trim(),
          password: String(password || '')
        });
      }).then(function (res) {
        if (res.error) return { ok: false, error: res.error.message };
        _user = res.data.user;
        window._meId = _user ? _user.id : null;
        return validate(_user).then(function (prof) {
          _profile = prof;
          // Signed in but no profile row: let the caller send them to
          // onboarding to finish, rather than into a half-built account.
          return { ok: true, user: _user, profile: prof, needsProfile: !prof };
        });
      });
    },

    // Creates the auth user AND the profile row. If the profile write
    // fails the caller is told, so we never leave an auth user with no
    // profile (the exact state that caused the orphaned-session bug).
    signUp: function (email, password, profileFields) {
      return init().then(function () {
        return _client.auth.signUp({
          email: String(email || '').trim(),
          password: String(password || ''),
          options: { data: profileFields || {} }
        });
      }).then(function (res) {
        if (res.error) return { ok: false, error: res.error.message };
        var user = res.data.user;
        if (!user) return { ok: false, error: 'No user returned' };
        _user = user;
        window._meId = user.id;

        var row = Object.assign({ id: user.id, updated_at: new Date().toISOString() },
                                profileFields || {});
        row.created_at = row.created_at || new Date().toISOString();

        return _client.from('profiles').upsert(row, { onConflict: 'id' })
          .then(function (pr) {
            if (pr.error) {
              return { ok: true, user: user, profileError: pr.error.message,
                       needsConfirm: !res.data.session };
            }
            _profile = row;
            return { ok: true, user: user, needsConfirm: !res.data.session };
          });
      });
    },

    signOut: function () {
      return init().then(function () {
        return _client.auth.signOut();
      }).then(function () {
        _user = null; _profile = null; window._meId = null;
        clearDeviceIdentity();
        return { ok: true };
      }).catch(function (e) {
        return { ok: false, error: e && e.message };
      });
    },

    // Diagnostic: reports exactly why sharing is or isn't working.
    check: function () {
      return init().then(function () {
        var out = [];
        function line(label, ok, detail) {
          out.push((ok === true ? '\u2713 ' : ok === false ? '\u2717 ' : '\u2013 ') +
                   label + (detail ? ' \u2014 ' + detail : ''));
        }
        line('Supabase client', !!_client, _client ? 'ready' : 'not created');
        line('Signed in', !!_user, _user ? _user.id : 'no session');
        line('Profile row', !!_profile, _profile ? 'exists' : 'missing (orphaned session)');
        if (!_user) { console.log(out.join('\n')); return out; }

        var tables = [
          ['events', 'meetups'], ['field_logs', 'field logs'],
          ['profile_photos', 'photos'], ['sessions', 'sessions/crumbs'],
          ['areas', 'areas'], ['event_signups', 'meetup signups']
        ];
        return tables.reduce(function (chain, t) {
          return chain.then(function () {
            return _client.from(t[0]).select('*', { count: 'exact', head: true })
              .then(function (r) {
                if (r.error) {
                  var m = (r.error.message || '').toLowerCase();
                  if (m.indexOf('does not exist') >= 0 || r.error.code === '42P01')
                    line(t[1], false, 'TABLE MISSING (' + t[0] + ')');
                  else if (m.indexOf('permission') >= 0 || m.indexOf('policy') >= 0 || r.error.code === '42501')
                    line(t[1], false, 'RLS BLOCKING ' + t[0]);
                  else line(t[1], false, t[0] + ': ' + r.error.message);
                } else {
                  line(t[1], true, (typeof r.count === 'number' ? r.count : '?') + ' row(s) readable');
                }
              });
          });
        }, Promise.resolve()).then(function () {
          console.log('%c[ActionSync sharing check]', 'font-weight:bold;font-size:13px');
          console.log(out.join('\n'));
          return out;
        });
      });
    }
  };

  // Back-compat for existing pages that call checkSharing()
  window.checkSharing = function () { return AS.auth.check(); };

  // Start immediately — pages await AS.auth.ready() rather than racing it.
  init();
})();
