'use strict';
/*
  Atmosphere: Ecordiatlas's offline observation app (spec: Ecordia Atmosphere, 21 Nov 2026).
    Prepare (online)  the observer chooses who they will observe (their planned observations are ticked).
    Cache             Atmosphere downloads each person's rubric, name and role, encrypted on the device.
    Observe (offline) the observer completes the rubric; the draft is saved on the device as they go (IndexedDB).
    Submit (online)   the observation is sealed for Ecordiatlas and sent, now or by background sync later.
    Clear             once Ecordiatlas has it, the device deletes its copy.
  Before it is submitted a draft can only be changed here, on this device. Once submitted, Ecordiatlas owns it: only the
  staff member's manager can change it (or the observer, if the manager allows it). Downloads and drafts stay on the
  device for up to 14 days; a draft still here then is sent to Ecordiatlas unfinished and the manager is emailed.
  Storage and encryption: store.js. Server (in Ecordiatlas): Api/AtmosphereController.cs, Api/AtmosphereSite.cs,
  Services/StaffRubricService.Atmosphere.cs. Ecordiatlas's address comes from this site's /config.json (Atlas:Url).
*/
(() => {
  const A = window.Atmosphere;
  const LOCK_AFTER_MS = 5 * 60 * 1000;   // locked again after 5 minutes away
  const MIN_PASSCODE = 6;
  const MAX_PHOTOS = 20;
  const TYPES = { planned: 'Planned', unannounced: 'Unannounced', peer: 'Peer', 'learning-walk': 'Learning walk' };
  const PHOTO_MAX_SIDE = 2000, PHOTO_QUALITY = 0.85;   // the photo upload rule (as Ecordiatlas and the Ecordia app)

  let ATLAS = '';   // Ecordiatlas's address, from /config.json (Atlas:Url in appsettings)
  const S = {
    online: navigator.onLine,
    signedIn: false,      // the Ecordiatlas sign-in answered just now
    user: null,           // { userId, email, name, tenantId, tenantName, ecordiaUrl } (+ the wrapped keys, in store.js)
    key: null,            // the data key while unlocked (memory only)
    hiddenAt: 0,
    start: null,          // the Prepare screen's data
    urls: []              // photo blob: addresses to let go of when the screen changes
  };

  // ------------------------------------------------------------------ small helpers
  const $main = () => document.getElementById('main');
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = c => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
    children.forEach(add);
    return el;
  }
  /** replaceChildren without the empty slots (null would show as the word null). */
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false));
  let fieldN = 0;
  function field(label, control, hint) {
    const id = control.id || (control.id = 'f' + (++fieldN));
    const hintEl = hint ? h('p', { class: 'hint', id: id + '-hint' }, hint) : null;
    if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
    return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintEl);
  }
  let toastTimer = null;
  // Confirmations fade (they repeat what the screen shows); errors stay until closed, so there is time to read them
  // (WCAG 2.2.1), with a Close button and Escape.
  function toast(text, error) {
    const t = document.getElementById('toast');
    t.className = 'toast' + (error ? ' error' : '');
    t.setAttribute('role', error ? 'alert' : 'status');
    clearTimeout(toastTimer);
    if (error) {
      const close = h('button', { type: 'button', class: 'small', onclick: () => { t.hidden = true; } }, 'Close', h('span', { class: 'sr-only' }, ' error message'));
      t.replaceChildren(h('span', {}, text), close);
    } else {
      t.textContent = text;
      toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
    }
    t.hidden = false;
  }
  document.addEventListener('keydown', e => { const t = document.getElementById('toast'); if (e.key === 'Escape' && t && !t.hidden && t.classList.contains('error')) t.hidden = true; });
  const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmtDate = s => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const fmtTime = s => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const fmtWhen = s => `${new Date(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${fmtTime(s)}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  // Ecordiatlas signs the person in (if needed) and sends them back here (its /sso/atmosphere, to Atmosphere:Url).
  const signInUrl = () => ATLAS + '/sso/atmosphere';
  const atlasLink = path => `${ATLAS}${path}${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(S.user?.tenantId || '')}`;

  class ApiError extends Error {
    constructor(status, body) { super(body?.title || `Ecordiatlas answered ${status}.`); this.status = status; this.body = body; }
  }
  class NoSignal extends Error { constructor() { super('No signal. Try again when you\'re back online.'); this.noSignal = true; } }

  async function api(method, url, body, opts = {}) {
    const headers = { 'X-ILR-Client': 'atmosphere', Accept: 'application/json' };
    if (S.user?.tenantId && !opts.noTenant) headers['X-Tenant-Id'] = S.user.tenantId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(ATLAS + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include', mode: 'cors', cache: 'no-store' }); }
    catch { setOnline(false); throw new NoSignal(); }
    // (a gateway or proxy answering for a server it can't reach: no signal to Ecordiatlas either)
    if (res.status >= 502 && res.status <= 504) { setOnline(false); throw new NoSignal(); }
    setOnline(true);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.status === 401 || data?.code === 'mfa_setup_required') S.signedIn = false;
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  /** Runs a button's work, saying what went wrong in plain words. */
  const guard = fn => async (...args) => {
    try { return await fn(...args); }
    catch (e) {
      console.error(e);
      if (e.status === 401) toast('Your Ecordiatlas sign-in has ended. Sign in again (your work is kept on this device).', true);
      else toast(e.message || String(e), true);
    }
  };

  // Redrawing the screen already showing (after Remove, Send now, the signal coming back) keeps the user on the same
  // card, not back at the top (Peter, 21 Nov 2026: every button keeps the user looking at the same card).
  // placeToKeep before the redraw, restorePlace after show(). Cards are matched by their heading; the button by its
  // words and its place among buttons with the same words.
  const words = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const cardName = card => words(card.querySelector('h2, h3')).replace(/\d+/g, '#');
  let lastPressed = null;
  document.addEventListener('click', e => { lastPressed = e.target.closest?.('button') || lastPressed; }, true);
  function placeToKeep() {
    const main = $main();
    const focused = main.contains(document.activeElement) ? document.activeElement : null;
    const active = focused?.matches('button, a') ? focused : lastPressed && main.contains(lastPressed) ? lastPressed : null;
    let card = active?.closest('.card');
    if (!card) card = [...main.querySelectorAll('.card')].find(c => c.getBoundingClientRect().bottom > 0);
    const same = card && active ? [...card.querySelectorAll('button, a')].filter(b => words(b) === words(active)) : [];
    return { y: window.scrollY, card: card ? cardName(card) : null, top: card?.getBoundingClientRect().top, button: active ? words(active) : null, nth: same.indexOf(active) };
  }
  function restorePlace(keep) {
    if (!keep) return;
    const card = keep.card && [...$main().querySelectorAll('.card')].find(c => cardName(c) === keep.card);
    if (!card) { window.scrollTo(0, keep.y); return; }
    window.scrollBy(0, card.getBoundingClientRect().top - keep.top);
    const same = keep.button ? [...card.querySelectorAll('button, a')].filter(b => words(b) === keep.button && !b.disabled) : [];
    const target = same[Math.min(Math.max(keep.nth, 0), same.length - 1)] || card.querySelector('h2, h3');
    if (target) { if (!same.length) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }

  function show(...children) {
    for (const u of S.urls.splice(0)) URL.revokeObjectURL(u);
    const main = $main();
    main.replaceChildren(...children.flat().filter(Boolean));
    window.scrollTo(0, 0);
    const heading = main.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    // Each screen names itself in the tab title (WCAG 2.4.2).
    const name = heading?.textContent.trim();
    document.title = name && name !== 'Atmosphere' ? `${name} - Atmosphere` : 'Atmosphere';
    drawNav();
  }

  // ------------------------------------------------------------------ signal and sending
  function setOnline(on) {
    S.online = on;
    const el = document.getElementById('signal');
    el.replaceChildren(on ? h('span', { class: 'pill ok' }, 'Online') : h('span', { class: 'pill warn' }, 'No signal'));
  }

  async function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'atmosphere:sent') afterSend(e.data.result); });
      // Checks for drafts reaching 14 days and anything waiting, about twice a day where the browser allows it.
      if (reg.periodicSync) {
        try {
          const p = await navigator.permissions?.query({ name: 'periodic-background-sync' });
          if (!p || p.state === 'granted') await reg.periodicSync.register('atmosphere-check', { minInterval: 12 * 60 * 60 * 1000 });
        } catch { /* not allowed: checked whenever Atmosphere is opened */ }
      }
    } catch (e) { console.warn('Atmosphere offline files not set up', e); }
  }

  /** Background sync sends what is waiting when the signal comes back, even if Atmosphere is closed (not on iPhone or iPad). */
  async function askBackgroundSend() {
    try { const reg = await navigator.serviceWorker?.ready; await reg?.sync?.register('atmosphere-send'); } catch { /* sent when Atmosphere is next opened */ }
  }

  let sending = false;
  async function sendNow(quiet) {
    if (sending || !navigator.onLine) return null;
    sending = true;
    try {
      await A.expire();
      const result = await A.sendOutbox();
      afterSend(result, quiet);
      if (result.noSignal) askBackgroundSend();
      return result;
    } finally { sending = false; }
  }

  function afterSend(result, quiet) {
    if (!result) return;
    if (result.sent.length) {
      const unfinished = result.sent.filter(s => s.unfinished).length;
      toast(`${plural(result.sent.length, 'observation')} sent to Ecordiatlas${unfinished ? ` (${unfinished} unfinished, after 14 days)` : ''}. ${result.sent.length === 1 ? 'It has' : 'They have'} been removed from this device.`);
    } else if (result.needSignIn && !quiet) toast('Sign in to Ecordiatlas to send what is waiting. It stays on this device until then.', true);
    else if (result.refused.length && !quiet) toast('Ecordiatlas couldn\'t accept an observation. See "Waiting to send".', true);
    if (result.needSignIn) S.signedIn = false;
    if (result.noSignal) setOnline(false);   // (Ecordiatlas couldn't be reached, whatever the phone says)
    else if (result.sent.length) setOnline(true);
    if (S.key && S.screen === 'home') home();
  }

  // ------------------------------------------------------------------ the header's links
  function drawNav() {
    const nav = document.getElementById('nav');
    nav.replaceChildren(...[
      S.user && S.signedIn ? h('a', { href: atlasLink('/app/staff/rubrics') }, 'Ecordiatlas') : null,
      S.user?.ecordiaUrl ? h('a', { href: S.user.ecordiaUrl }, 'Ecordia') : null,
      S.key ? h('button', { class: 'small', type: 'button', onclick: () => lockNow() }, 'Lock') : null].filter(Boolean));
  }

  // ------------------------------------------------------------------ start-up
  async function boot() {
    setOnline(navigator.onLine);
    window.addEventListener('online', async () => { setOnline(true); await checkSignIn(); if (S.key) { await sendNow(true); if (S.screen === 'home') home(); } });
    window.addEventListener('offline', () => setOnline(false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { S.hiddenAt = Date.now(); return; }
      if (S.key && S.hiddenAt && Date.now() - S.hiddenAt > LOCK_AFTER_MS) lockNow('Atmosphere locked itself while you were away.');
      else if (S.key) sendNow(true);
    });
    registerWorker();
    // While Atmosphere is open and unlocked, anything waiting is tried again every minute (phones don't always say when
    // the signal is back, and Ecordiatlas may have been the one out of reach).
    setInterval(() => { if (S.key && navigator.onLine && !document.hidden) sendNow(true); }, 60000);
    // Where Ecordiatlas is: from this site's /config.json (the service worker's copy when there is no signal).
    try { const c = await (await fetch('/config.json')).json(); ATLAS = String(c.AtlasUrl || c.atlasUrl || '').replace(/\/+$/, ''); }
    catch { ATLAS = await A.atlasUrl(); }
    if (ATLAS) await A.saveAtlasUrl(ATLAS);
    await A.expire().catch(() => null);

    const params = new URLSearchParams(location.search);
    const wantTenant = params.get('tenant');
    const recoverAsked = params.get('recover') === '1';
    if (params.toString()) history.replaceState(null, '', '/');

    let me = null, signedOut = false;
    try { me = await api('GET', '/api/v1/me', undefined, { noTenant: true }); }
    catch (e) { if (e.status === 401 || e.status === 403) signedOut = true; }

    if (me?.UserId) {
      S.signedIn = true;
      const tenants = me.Tenants || [];
      if (!tenants.length) return show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere'), h('p', {}, 'Your Ecordiatlas account isn\'t in an organisation yet, so there is nothing to observe.')));
      const remembered = (() => { try { return localStorage.getItem('atm.tenant.' + me.UserId); } catch { return null; } })();
      const pick = tenants.find(t => t.Id === wantTenant) || tenants.find(t => t.Id === remembered) || (tenants.length === 1 ? tenants[0] : null);
      if (!pick) return chooseOrganisation(me, tenants);
      await useAccount(me, pick);
    } else if (signedOut) {
      const last = await A.lastUser();
      if (!last?.recovery) { location.href = signInUrl(); return; }
      S.user = last;   // keep working offline; sign in to send
    } else {
      const last = await A.lastUser();
      if (!last?.recovery) return show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere needs a signal the first time'),
        h('p', {}, 'Open Atmosphere once with a signal and sign in with your Ecordiatlas account. After that it works with no signal.')));
      S.user = last;
    }
    if (S.signedIn && (recoverAsked || recoveryPending())) return finishRecovery();
    lockScreen();
  }

  function chooseOrganisation(me, tenants) {
    show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Which organisation?'),
      h('p', {}, 'Choose the organisation whose staff you are observing.'),
      h('ul', { class: 'atm-list' }, tenants.map(t => h('li', {}, h('button', { class: 'atm-big', type: 'button', onclick: guard(async () => { await useAccount(me, t); lockScreen(); }) }, t.Name))))));
  }

  async function useAccount(me, tenant) {
    try { localStorage.setItem('atm.tenant.' + me.UserId, tenant.Id); } catch { /* blocked */ }
    const saved = await A.getUser(me.UserId) || {};
    S.user = { userId: me.UserId, email: me.Actor, name: saved.name || me.Actor, tenantId: tenant.Id, tenantName: tenant.Name,
      ecordiaUrl: me.FromEcordiaApp && me.EmbedOrigins?.[0] ? me.EmbedOrigins[0] : saved.ecordiaUrl || null };
    await A.saveProfile(S.user);
    await A.setLastUser(me.UserId);
    try { await A.saveServerKey(await api('GET', '/api/v1/atmosphere/key')); }
    catch (e) { if (e.status === 403) S.noAddOn = e.message; }
  }

  /** Back online: is the Ecordiatlas sign-in still there (and the same person)? */
  async function checkSignIn() {
    try {
      const me = await api('GET', '/api/v1/me', undefined, { noTenant: true });
      S.signedIn = me?.UserId === S.user?.userId;
      if (S.signedIn && !(await A.serverKey())) await A.saveServerKey(await api('GET', '/api/v1/atmosphere/key'));
    } catch { S.signedIn = false; }
    drawNav();
  }

  // ------------------------------------------------------------------ passcode: set up, unlock, recover
  function lockNow(message) {
    S.key = null;
    S.screen = 'lock';
    lockScreen(message);
  }

  async function lockScreen(message) {
    started = true;
    S.screen = 'lock';
    const u = await A.getUser(S.user.userId);
    if (!u?.recovery) return setUpScreen();
    const input = h('input', { type: 'password', autocomplete: 'current-password', required: true, minlength: MIN_PASSCODE });
    const error = h('p', { class: 'field-msg error', role: 'alert' });
    const unlock = guard(async ev => {
      ev?.preventDefault();
      error.textContent = '';
      if (!input.value) { error.textContent = 'Enter your passcode.'; input.focus(); return; }
      try { S.key = await A.unlock(S.user.userId, input.value); }
      catch (e) { error.textContent = e.message; input.value = ''; input.focus(); return; }
      home();
      sendNow(true);
    });
    show(h('form', { class: 'card atm-lock', onsubmit: unlock },
      h('h1', {}, 'Unlock Atmosphere'),
      message ? h('p', { class: 'notice-line' }, message) : null,
      h('p', {}, `${u.email || u.name}${u.tenantName ? ` · ${u.tenantName}` : ''}`),
      !u.byPasscode ? h('p', { class: 'notice-line' }, 'Too many wrong passcodes. Unlock with your Ecordiatlas sign-in instead.') : field('Passcode', input),
      error,
      h('div', { class: 'toolbar' },
        u.byPasscode ? h('button', { class: 'primary atm-big', type: 'submit' }, 'Unlock') : null,
        h('button', { type: 'button', onclick: guard(startRecovery) }, 'Forgotten your passcode?')),
      !S.signedIn && S.online ? h('p', { class: 'hint' }, 'You\'re signed out of Ecordiatlas. You can still work here; ', h('a', { href: signInUrl() }, 'sign in'), ' to send.') : null));
    if (u.byPasscode) input.focus();
  }

  function passcodeFields(withOld) {
    const old = withOld ? h('input', { type: 'password', autocomplete: 'current-password' }) : null;
    const one = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSCODE });
    const two = h('input', { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSCODE });
    const error = h('p', { class: 'field-msg error', role: 'alert' });
    const check = () => {
      error.textContent = '';
      if (one.value.length < MIN_PASSCODE) { error.textContent = `Use at least ${MIN_PASSCODE} digits or characters.`; one.focus(); return null; }
      if (/^(\d)\1+$/.test(one.value) || '0123456789012'.includes(one.value) || '9876543210987'.includes(one.value)) { error.textContent = 'Choose something harder to guess than a repeated or running number.'; one.focus(); return null; }
      if (one.value !== two.value) { error.textContent = 'The two passcodes don\'t match.'; two.focus(); return null; }
      return one.value;
    };
    return { old, error, check, els: [old ? field('Current passcode', old) : null, field('New passcode', one, `At least ${MIN_PASSCODE} digits or characters. You'll need it each time you open Atmosphere.`), field('The new passcode again', two), error] };
  }

  async function setUpScreen() {
    S.screen = 'setup';
    if (!S.online || !S.signedIn) return show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere needs a signal to set up'),
      h('p', {}, 'Open Atmosphere with a signal and sign in with your Ecordiatlas account. After that it works with no signal.'),
      S.online ? h('a', { class: 'btn primary', href: signInUrl() }, 'Sign in') : null));
    if (S.noAddOn) return show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere'), h('p', {}, S.noAddOn)));
    const f = passcodeFields(false);
    const go = guard(async ev => {
      ev.preventDefault();
      const pass = f.check();
      if (!pass) return;
      S.key = await A.setUpUser(S.user, pass, await A.serverKey());
      toast('Atmosphere is ready on this device.');
      home();
    });
    show(h('form', { class: 'card atm-lock', onsubmit: go },
      h('h1', {}, 'Choose a passcode'),
      h('p', {}, 'Atmosphere keeps the rubrics and your observations on this device, encrypted, so you can work with no signal. The passcode unlocks them.'),
      h('p', { class: 'hint' }, 'If you forget it, you can unlock with your Ecordiatlas sign-in when you have a signal.'),
      f.els, h('button', { class: 'primary atm-big', type: 'submit' }, 'Set up Atmosphere')));
  }

  const RECOVERY_KEY = 'atm.recovery';
  function recoveryPending() {
    try { const p = JSON.parse(localStorage.getItem(RECOVERY_KEY) || 'null'); return !!p && p.userId === S.user?.userId && Date.now() - p.at < 30 * 60 * 1000; }
    catch { return false; }
  }

  async function startRecovery() {
    if (!navigator.onLine) throw new Error('This needs a signal: you\'ll be asked to sign in to Ecordiatlas again.');
    if (!confirm('To unlock without your passcode, you\'ll be signed out of Ecordiatlas and asked to sign in again. Your observations stay on this device.')) return;
    const r = await api('POST', '/api/v1/atmosphere/recovery', { DeviceId: await A.deviceId() }, { noTenant: true });
    try { localStorage.setItem(RECOVERY_KEY, JSON.stringify({ userId: S.user.userId, at: Date.now() })); } catch { /* blocked */ }
    if (S.user.ecordiaUrl) {
      show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Sign in again'),
        h('p', {}, 'Open Atmosphere again from the Ecordia app (that signs you in), or sign in to Ecordiatlas here.'),
        h('div', { class: 'toolbar' }, h('a', { class: 'btn primary', href: S.user.ecordiaUrl }, 'Open the Ecordia app'), h('a', { class: 'btn', href: ATLAS + r.SignInUrl }, 'Sign in to Ecordiatlas'))));
    } else location.href = ATLAS + r.SignInUrl;
  }

  async function finishRecovery() {
    const u = await A.getUser(S.user.userId);
    try { localStorage.removeItem(RECOVERY_KEY); } catch { /* blocked */ }
    if (!u?.recovery) return lockScreen();
    let raw;
    try { raw = (await api('POST', '/api/v1/atmosphere/recovery-key', { DeviceId: await A.deviceId(), Sealed: u.recovery }, { noTenant: true })).Key; }
    catch (e) { return lockScreen(e.message); }
    const f = passcodeFields(false);
    S.screen = 'setup';
    show(h('form', { class: 'card atm-lock', onsubmit: guard(async ev => {
      ev.preventDefault();
      const pass = f.check();
      if (!pass) return;
      S.key = await A.setPasscodeFromRecovery(S.user.userId, raw, pass);
      raw = null;
      toast('Unlocked. Use your new passcode from now on.');
      home();
      sendNow(true);
    }) }, h('h1', {}, 'Choose a new passcode'), h('p', {}, 'You\'ve signed in again, so your observations can be unlocked. Choose a new passcode for this device.'),
      f.els, h('button', { class: 'primary atm-big', type: 'submit' }, 'Unlock')));
  }

  // ------------------------------------------------------------------ home: today's observations
  async function home() {
    const keep = S.screen === 'home' ? placeToKeep() : null;   // drawn again: stay on the same card
    S.screen = 'home';
    const userId = S.user.userId;
    let [packs, drafts, outbox, sent] = await Promise.all([A.packs(S.key, userId), A.drafts(S.key, userId), A.outbox(userId), A.sent(userId)]);
    if (S.screen !== 'home') return;
    const draftById = Object.fromEntries(drafts.map(d => [d.id, d]));
    const label = d => d?.draft ? (d.draft.visit ? visitTitle(d.draft) : `${d.draft.staffName}`) : 'An observation';
    const sub = d => d?.draft ? (d.draft.visit ? `Visit check · ${fmtDate(d.draft.visitedOn)}` : `${d.draft.rubricName} · ${fmtDate(d.draft.observedOn)}`) : '';
    const visitPack = packs.find(p => p.item.Visit);
    packs = packs.filter(p => !p.item.Visit);

    const waiting = outbox.map(o => {
      const d = draftById[o.id];
      const status = o.status === 'refused' ? h('span', { class: 'pill error' }, 'Not accepted')
        : !S.online ? h('span', { class: 'pill warn' }, 'Waiting for a signal')
        : !S.signedIn ? h('span', { class: 'pill warn' }, 'Sign in to send')
        : h('span', { class: 'pill warn' }, 'Sending…');
      return h('li', {},
        h('div', { class: 'who' }, h('strong', {}, label(d)), h('span', { class: 'muted' }, [sub(d), o.kind === 'unfinished' ? ' · unfinished, after 14 days' : ''].join(''))),
        status,
        o.status === 'refused' ? h('div', { class: 'errors' }, h('p', {}, o.error), o.errors?.length > 1 ? h('ul', {}, o.errors.map(e => h('li', {}, e))) : null,
          h('div', { class: 'atm-actions' },
            o.kind === 'submit' && d?.draft ? h('button', { type: 'button', class: 'small', onclick: guard(async () => { await A.backToDraft(o.id); (d.draft.visit ? visitScreen : observe)(o.id); }) }, 'Back to the draft') : null,
            h('button', { type: 'button', class: 'small danger', onclick: guard(async () => {
              if (!confirm('Remove this observation from this device? It hasn\'t reached Ecordiatlas, so it will be lost.')) return;
              await A.removeDraft(o.id);
              home();
            }) }, 'Remove from this device'))) : null);
    });

    const inProgress = drafts.filter(d => d.state === 'draft').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(d => h('li', {},
      h('div', { class: 'who' }, h('strong', {}, label(d)), h('span', { class: 'muted' }, `${sub(d)} · kept here until ${fmtDate(d.keepUntil)}`)),
      d.draft ? h('button', { type: 'button', class: 'primary', onclick: () => (d.draft.visit ? visitScreen : observe)(d.id) }, 'Continue', h('span', { class: 'sr-only' }, ` ${label(d)}`)) : h('span', { class: 'muted' }, 'Can\'t be opened with this passcode')));

    const ready = packs.sort((a, b) => (a.item.PlannedStart || '').localeCompare(b.item.PlannedStart || '') || a.item.StaffName.localeCompare(b.item.StaffName)).map(p => h('li', {},
      h('div', { class: 'who' }, h('strong', {}, p.item.StaffName),
        h('span', { class: 'muted' }, `${p.item.Role} · ${p.item.RubricName} (version ${p.item.Grid.Version})${p.item.PlannedStart ? ` · ${fmtWhen(p.item.PlannedStart)}` : ''}`)),
      h('button', { type: 'button', class: 'primary', onclick: guard(() => startObservation(p)) }, 'Start', h('span', { class: 'sr-only' }, ` observing ${p.item.StaffName}`)),
      h('button', { type: 'button', class: 'small', onclick: guard(async () => { await A.removePack(p.id); home(); }) }, 'Remove', h('span', { class: 'sr-only' }, ` ${p.item.StaffName}`))));

    const recent = sent.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 10).map(s => h('li', {},
      h('div', { class: 'who' }, h('strong', {}, s.unfinished ? 'Sent unfinished' : 'Sent'), h('span', { class: 'muted' }, fmtWhen(s.sentAt))),
      S.online ? h('a', { href: atlasLink(s.link || `/app/staff/rubrics/records/${s.recordId}`) }, 'Open in Ecordiatlas') : null));

    const canPrepare = S.online && S.signedIn;
    show(
      h('h1', {}, 'Today\'s observations'),
      !S.signedIn && S.online ? h('p', { class: 'notice-line' }, 'You\'re signed out of Ecordiatlas. You can keep observing; ', h('a', { href: signInUrl() }, 'sign in'), ' to download rubrics and send observations.') : null,
      h('div', { class: 'card' },
        h('button', { type: 'button', class: 'primary atm-big', disabled: !canPrepare, onclick: () => prepare() }, 'Choose who to observe'),
        !S.online ? h('p', { class: 'hint' }, 'Choosing and downloading needs a signal. What is already on this device works without one.') : null),
      waiting.length ? h('section', { class: 'card', 'aria-labelledby': 'h-waiting' }, h('h2', { id: 'h-waiting' }, 'Waiting to send'),
        h('ul', { class: 'atm-list' }, waiting),
        S.online && S.signedIn && outbox.some(o => o.status !== 'refused') ? h('button', { type: 'button', onclick: guard(() => sendNow(false)) }, 'Send now') : null) : null,
      inProgress.length ? h('section', { class: 'card', 'aria-labelledby': 'h-progress' }, h('h2', { id: 'h-progress' }, 'In progress'), h('ul', { class: 'atm-list' }, inProgress),
        h('p', { class: 'hint' }, `Only you can see these, on this device. A draft not submitted within ${A.KEEP_DAYS} days is sent to Ecordiatlas unfinished, and the staff member's manager is told.`)) : null,
      h('section', { class: 'card', 'aria-labelledby': 'h-visits' }, h('h2', { id: 'h-visits' }, 'Visit checks'),
        h('p', { class: 'hint' }, 'Check a workplace, or audit a subcontractor, with no signal. Download your employers first while you have one.'),
        visitPack ? h('p', { class: 'muted' }, `${plural(visitPack.item.Employers.length, 'employer')}${visitPack.item.Subcontractors.length ? `, ${plural(visitPack.item.Subcontractors.length, 'subcontractor')}` : ''} on this device, downloaded ${fmtWhen(visitPack.packedAt)}.`) : null,
        h('div', { class: 'atm-actions' },
          h('button', { type: 'button', disabled: !canPrepare, onclick: guard(downloadVisits) }, visitPack ? 'Download again' : 'Download employers'),
          visitPack ? h('button', { type: 'button', class: 'primary', onclick: guard(() => startVisit('workplace', visitPack.item)) }, 'Start a workplace visit') : null,
          visitPack?.item.Subcontractors.length ? h('button', { type: 'button', class: 'primary', onclick: guard(() => startVisit('subcontractor', visitPack.item)) }, 'Start a subcontractor audit') : null)),
      h('section', { class: 'card', 'aria-labelledby': 'h-ready' }, h('h2', { id: 'h-ready' }, 'Ready to observe'),
        ready.length ? h('ul', { class: 'atm-list' }, ready) : h('p', { class: 'muted' }, 'Nobody yet. Choose who you will observe while you have a signal.')),
      recent.length ? h('section', { class: 'card', 'aria-labelledby': 'h-sent' }, h('h2', { id: 'h-sent' }, 'Sent to Ecordiatlas'), h('ul', { class: 'atm-list' }, recent),
        h('p', { class: 'hint' }, 'Ecordiatlas has these now: only the staff member\'s manager can change them there.')) : null,
      h('section', { class: 'card', 'aria-labelledby': 'h-device' }, h('h2', { id: 'h-device' }, 'This device'),
        h('p', { class: 'hint' }, `Everything here is encrypted and kept for up to ${A.KEEP_DAYS} days. Atmosphere locks itself after 5 minutes away.`),
        h('div', { class: 'atm-actions' },
          h('button', { type: 'button', onclick: () => changePasscodeScreen() }, 'Change passcode'),
          h('button', { type: 'button', class: 'danger', onclick: guard(() => forgetDevice(outbox.length + inProgress.length)) }, 'Remove everything from this device'))));
    restorePlace(keep);
  }

  async function forgetDevice(unsent) {
    const warn = unsent ? `${plural(unsent, 'observation')} on this device ${unsent === 1 ? 'hasn\'t' : 'haven\'t'} reached Ecordiatlas and will be lost. ` : '';
    if (!confirm(`${warn}Remove all your Atmosphere data from this device? This can't be undone.`)) return;
    await A.forget(S.user.userId);
    S.key = null;
    toast('Your Atmosphere data has been removed from this device.');
    setUpScreen();
  }

  function changePasscodeScreen() {
    S.screen = 'passcode';
    const f = passcodeFields(true);
    show(h('form', { class: 'card atm-lock', onsubmit: guard(async ev => {
      ev.preventDefault();
      const pass = f.check();
      if (!pass) return;
      try { await A.changePasscode(S.user.userId, f.old.value, pass); }
      catch (e) { f.error.textContent = e.message; f.old.focus(); return; }
      toast('Passcode changed.');
      home();
    }) }, h('h1', {}, 'Change passcode'), f.els,
      h('div', { class: 'toolbar' }, h('button', { class: 'primary', type: 'submit' }, 'Change passcode'), h('button', { type: 'button', onclick: () => home() }, 'Cancel'))));
  }

  // ------------------------------------------------------------------ prepare: choose who to observe, and download
  async function prepare() {
    S.screen = 'prepare';
    show(h('h1', {}, 'Choose who to observe'), h('p', { class: 'muted' }, 'Loading…'));
    let st;
    try { st = S.start = await api('GET', '/api/v1/atmosphere/start'); }
    catch (e) { toast(e.message, true); return home(); }
    S.user = { ...S.user, name: st.ObserverName };
    await A.saveProfile(S.user);
    const coversRole = (r, p) => r.Roles.includes('any') || (p.IsAssessor && r.Roles.includes('assessor')) || (p.IsIv && r.Roles.includes('iv'));
    const people = Object.fromEntries(st.People.map(p => [p.Id, p]));
    const rubrics = Object.fromEntries(st.Rubrics.map(r => [r.Id, r]));
    const chosen = [];   // { box, select (or fixed rubric), staffId, observation }
    const today = todayLocal();

    const planned = st.Planned.filter(o => people[o.StaffId] && rubrics[o.RubricId]).map(o => {
      const box = h('input', { type: 'checkbox', checked: o.StartLocal.slice(0, 10) === today });
      chosen.push({ box, staffId: o.StaffId, rubricId: () => o.RubricId, observation: o });
      return h('li', {}, h('label', { class: 'pick' }, box, h('span', {}, h('strong', {}, people[o.StaffId].Name),
        h('span', { class: 'muted' }, ` ${fmtWhen(o.StartLocal)} · ${rubrics[o.RubricId].Name} · ${TYPES[o.Type] || o.Type}${o.Location ? ` · ${o.Location}` : ''}`))));
    });

    const search = h('input', { type: 'search', placeholder: 'e.g. Sam or assessor' });
    const rows = st.People.map(p => {
      const options = st.Rubrics.filter(r => coversRole(r, p));
      const box = h('input', { type: 'checkbox', disabled: !options.length });
      const select = h('select', { disabled: !options.length },
        options.length ? options.map(r => h('option', { value: r.Id }, `${r.Name} (version ${r.Version})`)) : h('option', {}, 'No rubric for this role'));
      select.addEventListener('change', () => { if (options.length) box.checked = true; });
      chosen.push({ box, staffId: p.Id, rubricId: () => select.value, observation: null });
      const li = h('li', { dataset: { find: `${p.Name} ${p.Role} ${p.JobTitle || ''}`.toLowerCase() } },
        h('label', { class: 'pick' }, box, h('span', {}, h('strong', {}, p.Name), h('span', { class: 'muted' }, ` ${p.Role}${p.JobTitle && p.JobTitle !== p.Role ? ` · ${p.JobTitle}` : ''}`))),
        field(['Rubric', h('span', { class: 'sr-only' }, ` for ${p.Name}`)], select));   // a visible label (WCAG 3.3.2)
      return li;
    });
    // How many the search leaves, said to screen readers too (WCAG 4.1.3).
    const found = h('p', { class: 'hint', role: 'status' });
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      rows.forEach(li => { li.hidden = !!q && !li.dataset.find.includes(q); });
      found.textContent = q ? plural(rows.filter(li => !li.hidden).length, 'person', 'people') + ' found.' : '';
    });

    const download = guard(async () => {
      const items = chosen.filter(c => c.box.checked).map(c => ({ StaffId: c.staffId, RubricId: c.rubricId(), ObservationId: c.observation?.Id || null, _o: c.observation }));
      if (!items.length) { toast('Tick at least one person.', true); return; }
      const pack = await api('POST', '/api/v1/atmosphere/pack', { Items: items.map(({ _o, ...i }) => i) });
      for (const it of pack.Items) {
        const o = items.find(i => i.StaffId === it.StaffId && i.RubricId === it.RubricId && (i.ObservationId || null) === (it.ObservationId || null))?._o;
        await A.savePack(S.key, S.user, { ...it, PlannedStart: o?.StartLocal || null, Location: o?.Location || null }, pack.PackedUtc);
      }
      toast(`${plural(pack.Items.length, 'rubric')} downloaded. You can observe with no signal now; ${pack.Items.length === 1 ? 'it stays' : 'they stay'} on this device for up to ${A.KEEP_DAYS} days.`);
      home();
    });

    show(h('h1', {}, 'Choose who to observe'),
      h('p', { class: 'muted' }, 'Atmosphere downloads the rubric, name and role for each person you tick, so you can observe them with no signal.'),
      planned.length ? h('section', { class: 'card', 'aria-labelledby': 'h-planned' }, h('h2', { id: 'h-planned' }, 'Your planned observations'),
        h('ul', { class: 'atm-list atm-choose' }, planned)) : null,
      h('section', { class: 'card', 'aria-labelledby': 'h-people' }, h('h2', { id: 'h-people' }, planned.length ? 'Anyone else' : 'People you can observe'),
        st.Rubrics.length ? null : h('p', { class: 'notice-line' }, 'There are no published rubrics yet. Ask your quality lead to publish one in Ecordiatlas.'),
        st.People.length > 8 ? h('div', { class: 'atm-search' }, field('Search by name or role', search), found) : null,
        st.People.length ? h('ul', { class: 'atm-list atm-choose' }, rows) : h('p', { class: 'muted' }, 'There is nobody you can observe.')),
      h('div', { class: 'atm-save' }, h('div', {},
        h('button', { type: 'button', class: 'primary', onclick: download }, 'Download'),
        h('button', { type: 'button', onclick: () => home() }, 'Cancel'))));
  }

  // ------------------------------------------------------------------ observe: complete the rubric on the device
  async function startObservation(p) {
    const it = p.item;
    const grid = it.Grid;
    const choices = {};
    for (const c of grid.Sections.flatMap(s => s.Criteria)) choices[c.Id] = { level: null, notSeen: false, comment: '' };
    const d = {
      id: A.uuid(), staffId: it.StaffId, staffName: it.StaffName, role: it.Role, rubricId: it.RubricId, rubricName: it.RubricName, purposeName: it.PurposeName,
      grid, observationId: it.ObservationId || null, type: it.Type || 'planned', observedOn: todayLocal(), courseKey: '', summary: '', choices, actions: [], photos: [],
      startedAt: new Date().toISOString()
    };
    await A.saveDraft(S.key, S.user, d);
    await A.removePack(p.id);
    observe(d.id);
  }

  /** The overall result as levels are chosen (Ecordiatlas works it out again when it arrives): as rubrics.js does. */
  function resultOf(g, choices) {
    const levels = g.Levels;
    const levelById = Object.fromEntries(levels.map(l => [l.Id, l]));
    const criteria = g.Sections.flatMap(s => s.Criteria);
    const chosen = Object.entries(choices).filter(([, c]) => c.level || c.notSeen);
    const scored = chosen.filter(([, c]) => c.level && levelById[c.level]).map(([cid, c]) => ({ c: criteria.find(x => x.Id === cid), l: levelById[c.level] }));
    const ls = l => l.Score ?? (levels.indexOf(l) + 1);
    let score = null, band = null;
    if (g.Graded && scored.length) {
      if (g.ResultMethod === 'average') score = scored.reduce((t, x) => t + ls(x.l), 0) / scored.length;
      if (g.ResultMethod === 'weighted') { const w = scored.reduce((t, x) => t + (x.c.Weighting || 1), 0); score = scored.reduce((t, x) => t + (x.c.Weighting || 1) * ls(x.l), 0) / w; }
      const lowest = scored.reduce((m, x) => levels.indexOf(x.l) < levels.indexOf(m.l) ? x : m).l;
      if (g.ResultMethod === 'lowest') score = ls(lowest);
      band = g.Bands.length ? [...g.Bands].sort((a, b) => b.From - a.From).find(b => score >= b.From)?.Label : g.ResultMethod === 'lowest' ? lowest.Label : null;
    }
    const lowestHit = g.Triggers.LowestLevel && scored.some(x => x.l === levels[0]);
    const belowBand = g.Triggers.BelowBand && score != null && score < (g.Bands.find(b => b.Label === g.Triggers.BelowBand)?.From ?? -Infinity);
    return { score, band, missing: criteria.length - chosen.length, lowestHit, belowBand, lowestLabel: levels[0]?.Label };
  }

  /** What Ecordiatlas will ask for before sharing (StaffRubricService.ShareCoreAsync): checked here first. */
  function problemsOf(d) {
    const out = [];
    for (const c of d.grid.Sections.flatMap(s => s.Criteria)) {
      const ch = d.choices[c.Id] || {};
      if (!ch.level && !ch.notSeen) out.push({ id: c.Id, text: `Choose a level for "${c.Title}".` });
      else if (c.CommentRequired && !ch.notSeen && !(ch.comment || '').trim()) out.push({ id: c.Id, text: `"${c.Title}" needs a comment.` });
      if (c.EvidenceRequired && !ch.notSeen && !d.photos.some(p => p.criterionId === c.Id)) out.push({ id: c.Id, text: `"${c.Title}" needs evidence: take a photo for it.` });
    }
    if (d.observedOn > todayLocal()) out.push({ id: 'date', text: 'The date can\'t be in the future.' });
    for (const a of d.actions) if (a.text.trim() && !a.dueDate) out.push({ id: 'actions', text: 'Give each action a due date.' });
    return out;
  }

  async function observe(id) {
    S.screen = 'observe';
    const row = await A.draft(S.key, id);
    if (!row?.draft) { toast('That observation isn\'t on this device any more.', true); return home(); }
    if (row.state !== 'draft') { toast('That observation has been submitted, so it can\'t be changed here.', true); return home(); }
    const d = row.draft;
    const key = S.key;   // (a save still due when Atmosphere locks goes through)
    const g = d.grid;
    const levels = g.Levels;
    let timer = null, saving = Promise.resolve();
    const saveState = h('span', { class: 'save-state', role: 'status' }, `Saved on this device ${fmtTime(row.updatedAt)}, encrypted.`);
    const save = () => {
      clearTimeout(timer);
      saving = saving.then(async () => {
        try { await A.saveDraft(key, S.user, d); saveState.textContent = `Saved on this device ${fmtTime(d.updatedAt)}, encrypted.`; }
        catch (e) { saveState.textContent = `Not saved: ${e.message}`; }
      });
      return saving;
    };
    const changed = () => { saveState.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(save, 500); drawResult(); };
    // Saved before the page goes away or Atmosphere locks.
    const flush = () => { if (timer) save(); };
    document.addEventListener('visibilitychange', flush, { once: true });

    const resultBox = h('div', { class: 'rubric-result', 'aria-live': 'polite' });
    const drawResult = () => {
      const r = resultOf(g, d.choices);
      const next = [h('h2', {}, 'Overall result'),
        g.Graded ? h('p', { class: 'result-line' }, r.band ? h('strong', {}, r.band) : h('span', { class: 'muted' }, 'No band yet'), r.score != null ? ` · score ${Math.round(r.score * 100) / 100}` : '')
          : h('p', {}, 'Not graded: a level and comments for each criterion.'),
        r.missing ? h('p', { class: 'hint' }, `${r.missing} criteri${r.missing === 1 ? 'on' : 'a'} still to do.`) : h('p', { class: 'hint' }, 'Every criterion has a level.'),
        r.lowestHit || r.belowBand ? h('p', { class: 'notice-line' }, h('span', { class: 'pill warn' }, 'Action needed'), ' ',
          [r.lowestHit ? `a criterion is at the lowest level (${r.lowestLabel})` : null, r.belowBand ? `the result is below ${g.Triggers.BelowBand}` : null].filter(Boolean).join(' and '),
          ': agree at least one action below.') : null].filter(Boolean);
      // A live region: only replaced when the result changes, so typing a comment doesn't read the result out again.
      if (next.map(n => n.textContent).join('|') !== [...resultBox.children].map(n => n.textContent).join('|')) fill(resultBox, next);
    };

    // Photos: shrunk and stripped of their location (as every upload), then encrypted on the device.
    const photoList = criterionId => {
      const ul = h('ul', { class: 'atm-photos', dataset: { photos: criterionId || 'record' } });
      for (const p of d.photos.filter(x => (x.criterionId || null) === (criterionId || null))) {
        const img = h('img', { alt: p.name });
        A.photoUrl(p).then(u => { if (u) { S.urls.push(u); img.src = u; } });
        ul.append(h('li', {}, img, h('button', { type: 'button', class: 'small', onclick: guard(async () => {
          d.photos = d.photos.filter(x => x.id !== p.id);
          await A.removePhoto(p.id);
          await save();
          ul.replaceWith(photoList(criterionId));
        }) }, 'Remove', h('span', { class: 'sr-only' }, ` ${p.name}`))));
      }
      return ul;
    };
    const photoButtons = (criterionId, title) => {
      const picker = (attrs, text) => {
        const input = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', ...attrs });
        input.addEventListener('change', guard(async () => {
          const file = input.files[0];
          input.value = '';
          if (!file) return;
          if (d.photos.length >= MAX_PHOTOS) throw new Error(`Up to ${MAX_PHOTOS} photos can go with an observation.`);
          const small = await compressPhoto(file);
          const saved = await A.savePhoto(S.user, d.id, small);
          d.photos.push({ ...saved, criterionId: criterionId || null, name: `photo-${d.photos.length + 1}.jpg`, at: new Date().toISOString() });
          await save();
          $main().querySelector(`[data-photos="${criterionId || 'record'}"]`)?.replaceWith(photoList(criterionId));
          toast('Photo kept on this device, encrypted.');
        }));
        return h('label', { class: 'btn small file-button' }, input, text);
      };
      return h('div', { class: 'atm-actions' },
        picker({ capture: 'environment' }, ['Take a photo', h('span', { class: 'sr-only' }, title ? ` for ${title}` : ' for the whole observation')]),
        picker({}, ['Choose a photo', h('span', { class: 'sr-only' }, title ? ` for ${title}` : ' for the whole observation')]));
    };

    let radioN = 0;
    const criterionBlock = c => {
      const name = 'crit' + (++radioN);
      const pick = h('div', { class: `level-cells cols-${levels.length + (g.AllowNotSeen ? 1 : 0)}` });
      const cell = (checked, colour, inside, onPick) => {
        const input = h('input', { type: 'radio', name, checked, class: 'sr-radio' });
        input.addEventListener('change', onPick);
        return h('label', { class: `level-cell lvl-${colour}${checked ? ' chosen' : ''}` }, input, inside);
      };
      levels.forEach((l, i) => pick.append(cell(d.choices[c.Id].level === l.Id, l.Colour,
        [h('span', { class: 'level-name' }, l.Label, l.Score != null && g.Graded ? h('span', { class: 'muted' }, ` (${l.Score})`) : null),
          c.Descriptors[i] ? h('span', { class: 'level-desc' }, c.Descriptors[i]) : null],
        () => { d.choices[c.Id] = { ...d.choices[c.Id], level: l.Id, notSeen: false }; changed(); })));
      if (g.AllowNotSeen) pick.append(cell(!!d.choices[c.Id].notSeen, 'grey', [h('span', { class: 'level-name' }, 'Not seen'), h('span', { class: 'level-desc muted' }, 'Left out of the result')],
        () => { d.choices[c.Id] = { ...d.choices[c.Id], level: null, notSeen: true }; changed(); }));
      pick.addEventListener('change', () => pick.querySelectorAll('.level-cell').forEach(x => x.classList.toggle('chosen', x.querySelector('input').checked)));
      const comment = h('textarea', { maxlength: 2000, class: 'short-text' }, d.choices[c.Id].comment || '');
      comment.addEventListener('input', () => { d.choices[c.Id].comment = comment.value; changed(); });
      return h('fieldset', { class: 'criterion', id: 'c-' + c.Id },
        h('legend', {}, c.Title, c.Weighting && g.ResultMethod === 'weighted' ? h('span', { class: 'muted' }, ` (weighting ${c.Weighting})`) : null),
        c.Guidance ? h('p', { class: 'hint' }, c.Guidance) : null,
        c.CommentRequired || c.EvidenceRequired ? h('p', { class: 'hint' }, [c.CommentRequired ? 'A comment is needed.' : null, c.EvidenceRequired ? 'Evidence is needed: take a photo.' : null].filter(Boolean).join(' ')) : null,
        pick,
        field('Comment', comment, 'To dictate, tap the microphone on your keyboard.'),
        photoList(c.Id), photoButtons(c.Id, c.Title));
    };

    const date = h('input', { type: 'date', value: d.observedOn, max: todayLocal(), id: 'c-date' });
    date.addEventListener('change', () => { d.observedOn = date.value; changed(); });
    const type = h('select', {}, Object.entries(TYPES).map(([k, v]) => h('option', { value: k, selected: k === d.type }, v)));
    type.addEventListener('change', () => { d.type = type.value; changed(); });
    const course = h('input', { maxlength: 20, value: d.courseKey || '', placeholder: 'e.g. std:123 or aim:60012345', spellcheck: 'false', autocapitalize: 'off' });
    course.addEventListener('input', () => { d.courseKey = course.value.trim(); changed(); });
    const summary = h('textarea', { maxlength: 4000, class: 'short-text' }, d.summary || '');
    summary.addEventListener('input', () => { d.summary = summary.value; changed(); });

    const actionsBox = h('div', { id: 'c-actions' });
    const drawActions = () => fill(actionsBox, ...d.actions.map((a, i) => {
      const text = h('textarea', { maxlength: 1000 }, a.text);
      text.addEventListener('input', () => { a.text = text.value; changed(); });
      const due = h('input', { type: 'date', value: a.dueDate, min: todayLocal() });
      due.addEventListener('change', () => { a.dueDate = due.value; changed(); });
      return h('div', { class: 'atm-action-row' }, field(`Action ${i + 1}`, text), field(`Action ${i + 1} due by`, due), h('button', { type: 'button', class: 'small', onclick: () => { d.actions.splice(i, 1); drawActions(); changed(); } }, 'Remove', h('span', { class: 'sr-only' }, ` action ${i + 1}`)));
    }));
    drawActions();

    const problemsBox = h('div', { tabindex: '-1' });
    const submit = guard(async () => {
      await save();
      const problems = problemsOf(d);
      if (problems.length) {
        fill(problemsBox, h('div', { class: 'card', role: 'alert' }, h('h2', {}, 'Before you submit'),
          h('ul', { class: 'atm-problems' }, problems.map(p => h('li', {}, h('a', { href: '#c-' + p.id, onclick: ev => {
            ev.preventDefault();
            const el = document.getElementById('c-' + p.id);
            el?.scrollIntoView({ block: 'center' });
            el?.querySelector('input, textarea, select')?.focus({ preventScroll: true });
          } }, p.text))))));
        problemsBox.scrollIntoView({ block: 'start' });
        problemsBox.focus({ preventScroll: true });
        return;
      }
      fill(problemsBox);
      if (!confirm(`Submit this observation of ${d.staffName}? It goes to Ecordiatlas and is shared with them. After that it can't be changed here: only their manager can change it in Ecordiatlas.`)) return;
      await A.submit(S.user, d);
      askBackgroundSend();
      toast(navigator.onLine ? 'Submitted. Sending to Ecordiatlas…' : 'Submitted. It will be sent to Ecordiatlas when you have a signal.');
      await home();
      sendNow(false);
    });
    const remove = guard(async () => {
      if (!confirm('Delete this draft from this device? It hasn\'t been sent, so it will be lost.')) return;
      clearTimeout(timer);
      await A.removeDraft(d.id);
      toast('Draft deleted.');
      home();
    });

    show(
      h('p', {}, h('a', { href: '/', onclick: ev => { ev.preventDefault(); flush(); home(); } }, '← Today\'s observations')),
      h('h1', {}, `${d.rubricName}: ${d.staffName}`),
      h('div', { class: 'card' },
        h('dl', { class: 'facts' }, h('dt', {}, 'About'), h('dd', {}, `${d.staffName} · ${d.role}`), h('dt', {}, 'Rubric'), h('dd', {}, `${d.rubricName} (version ${g.Version})`),
          h('dt', {}, 'Kept here until'), h('dd', {}, fmtDate(row.keepUntil))),
        h('div', { class: 'fields' }, field('Date', date), field('Type', type), field('Course or standard (optional)', course)),
        h('p', { class: 'hint' }, 'A draft: only you can see it, on this device, until you submit it.')),
      problemsBox,
      h('div', { class: 'card' }, resultBox),
      g.Sections.map(sec => h('section', { class: 'card rubric-section' }, h('h2', {}, sec.Title), sec.Criteria.map(criterionBlock))),
      h('div', { class: 'card' }, h('h2', {}, 'Overall comments'), field('Overall comments', summary),
        h('h3', {}, 'Photos for the whole observation'), photoList(null), photoButtons(null, null)),
      h('div', { class: 'card' }, h('h2', {}, 'Actions'),
        h('p', { class: 'hint' }, 'Development steps agreed with the staff member. They go into their development plan in Ecordiatlas.'),
        actionsBox,
        h('button', { type: 'button', onclick: () => { const due = new Date(Date.now() + 28 * 86400000); d.actions.push({ text: '', dueDate: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` }); drawActions(); actionsBox.querySelector('.atm-action-row:last-child textarea')?.focus(); changed(); } }, 'Add an action')),
      h('div', { class: 'card' }, h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete this draft')),
      h('div', { class: 'atm-save' }, h('div', {}, saveState, h('button', { type: 'button', class: 'primary', onclick: submit }, 'Submit to Ecordiatlas'))));
    drawResult();
  }

  // ------------------------------------------------------------------ visit checks (safeguarding at work, in Ecordiatlas: SafeguardingWorkService)
  const ANSWERS = [['', '–'], ['yes', 'Yes'], ['no', 'No'], ['na', 'Not relevant']];
  const visitTitle = d => d.type === 'subcontractor' ? `Audit: ${d.subName || 'subcontractor not chosen'}` : `Visit: ${d.empName || 'employer not chosen'}`;

  async function downloadVisits() {
    const pack = await api('GET', '/api/v1/atmosphere/visit-pack');
    if (!(await A.serverKey())) await A.saveServerKey(await api('GET', '/api/v1/atmosphere/visit-key'));
    await A.saveVisitPack(S.key, S.user, pack, new Date().toISOString());
    toast(`Downloaded ${plural(pack.Employers.length, 'employer')}${pack.Subcontractors.length ? ` and ${plural(pack.Subcontractors.length, 'subcontractor')}` : ''}.`);
    home();
  }

  async function startVisit(type, pack) {
    const d = {
      id: A.uuid(), visit: true, type, pack, empId: '', empName: '', learnerId: '', subId: '', subName: '', visitedOn: todayLocal(), checks: {},
      notes: '', findings: '', actions: '', actionsDueOn: '', learnersSpokenTo: '', photos: [], startedAt: new Date().toISOString()
    };
    await A.saveDraft(S.key, S.user, d);
    visitScreen(d.id);
  }

  async function visitScreen(id) {
    S.screen = 'visit';
    const row = await A.draft(S.key, id);
    if (!row?.draft) { toast('That visit isn\'t on this device any more.', true); return home(); }
    if (row.state !== 'draft') { toast('That visit has been submitted, so it can\'t be changed here.', true); return home(); }
    const d = row.draft, key = S.key, pack = d.pack, workplace = d.type === 'workplace';
    let timer = null, saving = Promise.resolve();
    const saveState = h('span', { class: 'save-state', role: 'status' }, `Saved on this device ${fmtTime(row.updatedAt)}, encrypted.`);
    const save = () => {
      clearTimeout(timer);
      saving = saving.then(async () => {
        try { await A.saveDraft(key, S.user, d); saveState.textContent = `Saved on this device ${fmtTime(d.updatedAt)}, encrypted.`; }
        catch (e) { saveState.textContent = `Not saved: ${e.message}`; }
      });
      return saving;
    };
    const changed = () => { saveState.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(save, 500); };
    const flush = () => { if (timer) save(); };
    document.addEventListener('visibilitychange', flush, { once: true });
    const bind = (el, prop, after) => { el.addEventListener('input', () => { d[prop] = el.value; after?.(); changed(); }); return el; };

    const date = bind(h('input', { type: 'date', value: d.visitedOn, max: todayLocal() }), 'visitedOn');
    const learnerSel = h('select', {});
    const drawLearners = () => {
      const emp = pack.Employers.find(e => String(e.EmpId) === String(d.empId));
      fill(learnerSel, h('option', { value: '' }, 'Not one apprentice in particular'), (emp?.Learners || []).map(l => h('option', { value: l.Key, selected: l.Key === d.learnerId }, l.Label)));
    };
    const who = workplace
      ? bind(h('select', {}, h('option', { value: '' }, 'Choose…'), pack.Employers.map(e => h('option', { value: e.EmpId, selected: String(e.EmpId) === String(d.empId) }, e.Name))), 'empId', () => {
          d.empName = pack.Employers.find(e => String(e.EmpId) === String(d.empId))?.Name || ''; d.learnerId = ''; drawLearners();
        })
      : bind(h('select', {}, h('option', { value: '' }, 'Choose…'), pack.Subcontractors.map(s => h('option', { value: s.Key, selected: s.Key === d.subId }, s.Label))), 'subId', () => {
          d.subName = pack.Subcontractors.find(s => s.Key === d.subId)?.Label || '';
        });
    bind(learnerSel, 'learnerId');
    drawLearners();
    const list = workplace ? pack.Workplace : pack.Subcontractor;
    const checks = list.map(o => {
      const sel = h('select', { 'aria-label': o.Label }, ANSWERS.map(([k, t]) => h('option', { value: k, selected: (d.checks[o.Key] || '') === k }, t)));
      sel.addEventListener('change', () => { d.checks[o.Key] = sel.value; changed(); });
      return h('li', { class: 'atm-check' }, h('span', {}, o.Label), sel);
    });
    const text = (prop, rows) => bind(h('textarea', { rows, maxlength: prop === 'notes' ? 2000 : 4000 }, d[prop] || ''), prop);
    const problems = h('div', { role: 'alert' });
    const submit = guard(async () => {
      const missing = [];
      if (workplace && !d.empId) missing.push('Choose the employer.');
      if (!workplace && !d.subId) missing.push('Choose the subcontractor.');
      if (!d.visitedOn) missing.push('Enter the date of the visit.');
      if (!Object.values(d.checks).some(Boolean)) missing.push('Answer at least one check.');
      if (missing.length) { fill(problems, h('div', { class: 'errors' }, h('ul', {}, missing.map(m => h('li', {}, m))))); problems.scrollIntoView({ block: 'nearest' }); return; }
      fill(problems);
      await save();
      if (!confirm(`Submit this ${workplace ? 'workplace visit' : 'audit'}? It goes to Ecordiatlas and can't be changed here after that.`)) return;
      await A.submit(S.user, d);
      askBackgroundSend();
      toast(navigator.onLine ? 'Submitted. Sending to Ecordiatlas…' : 'Submitted. It will be sent to Ecordiatlas when you have a signal.');
      await home();
      sendNow(false);
    });
    const remove = guard(async () => {
      if (!confirm('Delete this visit from this device? It hasn\'t been sent, so it will be lost.')) return;
      clearTimeout(timer);
      await A.removeDraft(d.id);
      toast('Visit deleted.');
      home();
    });
    show(
      h('p', {}, h('a', { href: '/', onclick: ev => { ev.preventDefault(); flush(); home(); } }, '← Today\'s observations')),
      h('h1', {}, workplace ? 'Workplace visit' : 'Subcontractor audit'),
      h('div', { class: 'card' },
        h('div', { class: 'fields' }, field(workplace ? 'Employer' : 'Subcontractor', who), workplace ? field('Apprentice', learnerSel) : null, field('Date of the visit', date),
          workplace ? null : field('Learners spoken to', bind(h('input', { type: 'number', min: 0, max: 999, value: d.learnersSpokenTo ?? '' }), 'learnersSpokenTo'))),
        h('p', { class: 'hint' }, `A draft: only you can see it, on this device, until you submit it. Kept here until ${fmtDate(row.keepUntil)}.`)),
      problems,
      h('section', { class: 'card' }, h('h2', {}, 'Checks'), h('ul', { class: 'atm-list atm-checks' }, checks),
        workplace ? h('p', { class: 'hint' }, 'If you see or hear anything worrying, raise a safeguarding concern in Ecordiatlas as well, today. If someone is in immediate danger, call 999.') : null),
      workplace
        ? h('section', { class: 'card' }, h('h2', {}, 'Notes'), field('What you saw and agreed', text('notes', 4)))
        : h('section', { class: 'card' }, h('h2', {}, 'Findings and actions'), field('Findings', text('findings', 4)), field('Actions agreed', text('actions', 3)),
            field('Actions due by', bind(h('input', { type: 'date', value: d.actionsDueOn || '' }), 'actionsDueOn'))),
      h('div', { class: 'card' }, h('button', { type: 'button', class: 'danger', onclick: remove }, 'Delete this visit')),
      h('div', { class: 'atm-save' }, h('div', {}, saveState, h('button', { type: 'button', class: 'primary', onclick: submit }, 'Submit to Ecordiatlas'))));
  }

  // ------------------------------------------------------------------ photos: the same rule as every upload
  async function compressPhoto(file) {
    if (typeof createImageBitmap !== 'function') throw new Error('This browser can\'t prepare photos. Try another browser.');
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw new Error('That photo couldn\'t be opened. Try taking it again.'); }
    try {
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale)), hgt = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, hgt);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, hgt);
      // Always re-encoded: the original may carry where it was taken.
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
      if (!blob) throw new Error('That photo couldn\'t be prepared.');
      return blob;
    } finally { bitmap.close?.(); }
  }

  // If the device's storage doesn't answer (another Atmosphere tab is holding it), say so rather than wait for ever.
  let started = false;
  setTimeout(() => { if (!started && $main().textContent.includes('Opening Atmosphere')) show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere is still opening'),
    h('p', {}, 'Close Atmosphere in your other tabs or windows, then try again.'), h('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, 'Try again'))); }, 15000);
  document.addEventListener('DOMContentLoaded', () => boot().catch(e => {
    console.error(e);
    show(h('div', { class: 'card atm-lock' }, h('h1', {}, 'Atmosphere couldn\'t start'), h('p', {}, e.message || String(e))));
  }));
})();
