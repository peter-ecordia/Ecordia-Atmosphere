'use strict';
/*
  Atmosphere's storage on the device and its encryption. Loaded by the page (atmosphere.js) and by the service worker
  (sw.js), which sends what is waiting in the background, to Ecordiatlas's API (its address is in meta "atlas"). Spec: Ecordia Atmosphere.

  IndexedDB "ecordia-atmosphere":
    meta     device id, the server's public key, and per user: name, organisation, and their data key wrapped two ways
             (by their passcode, and sealed to the server for when the passcode is forgotten).
    packs    the rubrics downloaded for the people to observe (name, role, the whole grid): encrypted with the data key.
    drafts   observations in progress: encrypted with the data key, plus a copy sealed to the server (escrow) so a draft
             still here after 14 days can be sent unfinished without the passcode.
    photos   each photo, encrypted with its own key (kept inside the encrypted draft and the sealed copies).
    outbox   what is waiting to be sent: sealed to the server, so it can't be read on the device and the service worker
             can send it with no passcode. Deleted (with its draft and photos) once Ecordiatlas has answered.
    sent     record ids sent recently (no names), for links to Ecordiatlas. Kept 14 days.

  Encryption: AES-256-GCM (WebCrypto). The data key never leaves the device unwrapped; it is in memory only while
  Atmosphere is unlocked. Passcode: PBKDF2-SHA-256, 600,000 rounds. Sealing to the server: a fresh AES key per item,
  wrapped with the server's RSA-OAEP (SHA-256) key (Services/AtmosphereService.cs).
*/
(function (root) {
  const DB_NAME = 'ecordia-atmosphere', DB_VERSION = 1;
  const KEEP_DAYS = 14;
  const DAY = 86400000;
  const PBKDF2_ROUNDS = 600000;
  const SEND_LOCK = 'atmosphere-send';
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ------------------------------------------------------------------ IndexedDB
  let dbPromise = null;
  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('meta', { keyPath: 'key' });
        for (const name of ['packs', 'drafts', 'photos', 'outbox']) d.createObjectStore(name, { keyPath: 'id' }).createIndex('userId', 'userId');
        d.createObjectStore('sent', { keyPath: 'recordId' }).createIndex('userId', 'userId');
      };
      r.onsuccess = () => {
        const d = r.result;
        // Another tab or a newer version needs the database (an upgrade, or "Remove everything"): let go of it, never block it.
        d.onversionchange = () => { d.close(); dbPromise = null; };
        resolve(d);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Close Atmosphere in your other tabs, then try again.'));
    });
    return dbPromise;
  }
  const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  async function tx(stores, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      let out;
      Promise.resolve(fn(...[].concat(stores).map(s => t.objectStore(s)))).then(v => { out = v; }, e => { try { t.abort(); } catch { /* already done */ } reject(e); });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Not saved on the device.'));
    });
  }
  const get = (store, key) => tx(store, 'readonly', s => done(s.get(key)));
  const put = (store, value) => tx(store, 'readwrite', s => done(s.put(value)));
  const del = (store, key) => tx(store, 'readwrite', s => done(s.delete(key)));
  const all = store => tx(store, 'readonly', s => done(s.getAll()));
  const forUser = (store, userId) => tx(store, 'readonly', s => done(s.index('userId').getAll(userId)));

  // ------------------------------------------------------------------ bytes
  const b64 = buf => { const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const json = v => enc.encode(JSON.stringify(v));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // ------------------------------------------------------------------ device and server key
  async function deviceId() {
    const m = await get('meta', 'device');
    if (m) return m.id;
    const id = uuid();
    await put('meta', { key: 'device', id });
    return id;
  }
  /** Ecordiatlas's address (from /config.json), kept for the service worker. */
  const atlasUrl = async () => (await get('meta', 'atlas'))?.value || '';
  const saveAtlasUrl = value => put('meta', { key: 'atlas', value });
  const serverKey = async () => (await get('meta', 'serverKey'))?.value || null;
  const saveServerKey = value => put('meta', { key: 'serverKey', value });

  /** Seals bytes to the server (only Ecordiatlas can open it): { V, Kid, Key, Iv, Data }. */
  async function seal(bytes, pub) {
    if (!pub) throw new Error('Atmosphere needs a signal once to get Ecordiatlas\'s key.');
    const rsa = await crypto.subtle.importKey('spki', unb64(pub.PublicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('atmosphere:' + pub.Kid) }, key, bytes);
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, await crypto.subtle.exportKey('raw', key));
    return { V: 1, Kid: pub.Kid, Key: b64(wrapped), Iv: b64(iv), Data: b64(data) };
  }

  // ------------------------------------------------------------------ users, passcode and the data key
  const userKey = userId => 'user:' + userId;
  const getUser = userId => get('meta', userKey(userId));
  const saveUser = u => put('meta', { ...u, key: userKey(u.userId) });
  /** Name and organisation only: never touches the wrapped keys (so a copy held by the page can't put back an old passcode). */
  const PROFILE = ['userId', 'email', 'name', 'tenantId', 'tenantName', 'ecordiaUrl'];
  async function saveProfile(u) {
    const existing = await getUser(u.userId) || {};
    const profile = Object.fromEntries(PROFILE.filter(k => k in u).map(k => [k, u[k]]));
    await saveUser({ ...existing, ...profile });
  }
  const lastUser = async () => { const m = await get('meta', 'lastUser'); return m ? getUser(m.userId) : null; };
  const setLastUser = userId => put('meta', { key: 'lastUser', userId });

  async function passKey(passcode, salt, rounds) {
    const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: rounds, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }
  async function wrapWithPasscode(raw, passcode) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const extractable = await crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
    const data = await crypto.subtle.wrapKey('raw', extractable, await passKey(passcode, salt, PBKDF2_ROUNDS), { name: 'AES-GCM', iv });
    return { salt: b64(salt), iv: b64(iv), data: b64(data), rounds: PBKDF2_ROUNDS };
  }
  const importDataKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  /** First use on this device: a new data key, wrapped by the passcode and sealed to the server for recovery. */
  async function setUpUser(u, passcode, pub) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const device = await deviceId();
    const recovery = await seal(json({ V: 1, Purpose: 'recovery', UserId: u.userId, DeviceId: device, Key: b64(raw) }), pub);
    const existing = await getUser(u.userId) || {};
    await saveUser({ ...existing, userId: u.userId, byPasscode: await wrapWithPasscode(raw, passcode), recovery, failed: 0, setUpAt: new Date().toISOString() });
    const key = await importDataKey(raw);
    raw.fill(0);
    return key;
  }

  const MAX_TRIES = 10;
  /** The data key, or an error saying how many tries are left (after 10, only "Forgotten your passcode?" opens it). */
  async function unlock(userId, passcode) {
    const u = await getUser(userId);
    if (!u?.byPasscode) throw new Error('Too many wrong passcodes. Choose "Forgotten your passcode?" to unlock with your Ecordiatlas sign-in.');
    const w = u.byPasscode;
    try {
      const kek = await passKey(passcode, unb64(w.salt), w.rounds);
      const key = await crypto.subtle.unwrapKey('raw', unb64(w.data), kek, { name: 'AES-GCM', iv: unb64(w.iv) }, 'AES-GCM', false, ['encrypt', 'decrypt']);
      if (u.failed) await saveUser({ ...u, failed: 0 });
      return key;
    } catch {
      const failed = (u.failed || 0) + 1;
      if (failed >= MAX_TRIES) {
        await saveUser({ ...u, byPasscode: null, failed });
        throw new Error('That passcode isn\'t right, and that was the last try. Choose "Forgotten your passcode?" to unlock with your Ecordiatlas sign-in.');
      }
      await saveUser({ ...u, failed });
      throw new Error(`That passcode isn't right. ${MAX_TRIES - failed} ${MAX_TRIES - failed === 1 ? 'try' : 'tries'} left.`);
    }
  }

  /** After recovery: the data key from the server, wrapped by a new passcode. */
  async function setPasscodeFromRecovery(userId, rawB64, passcode) {
    const u = await getUser(userId);
    const raw = unb64(rawB64);
    await saveUser({ ...u, byPasscode: await wrapWithPasscode(raw, passcode), failed: 0 });
    const key = await importDataKey(raw);
    raw.fill(0);
    return key;
  }

  async function changePasscode(userId, oldPasscode, newPasscode) {
    const u = await getUser(userId);
    const w = u.byPasscode;
    const kek = await passKey(oldPasscode, unb64(w.salt), w.rounds);
    let extractable;
    try { extractable = await crypto.subtle.unwrapKey('raw', unb64(w.data), kek, { name: 'AES-GCM', iv: unb64(w.iv) }, 'AES-GCM', true, ['encrypt', 'decrypt']); }
    catch { throw new Error('Your current passcode isn\'t right.'); }
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', extractable));
    await saveUser({ ...u, byPasscode: await wrapWithPasscode(raw, newPasscode), failed: 0 });
    raw.fill(0);
  }

  // ------------------------------------------------------------------ encrypted values
  async function lock(key, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, json(value)) };
  }
  async function open(key, box) {
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.data)));
  }

  // ------------------------------------------------------------------ packs (rubrics downloaded for the people to observe)
  async function savePack(key, user, item, packedAt) {
    const id = `${user.userId}|${item.StaffId}|${item.RubricId}|${item.ObservationId || ''}`;
    const keepUntil = new Date(new Date(packedAt).getTime() + KEEP_DAYS * DAY).toISOString();
    await put('packs', { id, userId: user.userId, tenantId: user.tenantId, packedAt, keepUntil, box: await lock(key, item) });
  }
  async function packs(key, userId) {
    const rows = await forUser('packs', userId);
    const out = [];
    for (const r of rows) {
      try { out.push({ id: r.id, tenantId: r.tenantId, packedAt: r.packedAt, keepUntil: r.keepUntil, item: await open(key, r.box) }); }
      catch { /* another key (set up again): left until it expires */ }
    }
    return out;
  }
  const removePack = id => del('packs', id);

  // ------------------------------------------------------------------ drafts and photos
  /** What Ecordiatlas receives (AtmosphereObservation): kind "submit" or "unfinished". */
  function observation(d, kind, user) {
    return {
      V: 1, Kind: kind, Id: d.id, UserId: user.userId, TenantId: user.tenantId, StaffId: d.staffId, RubricId: d.rubricId, VersionId: d.grid.Id,
      ObservationId: d.observationId || null, ObservedOn: d.observedOn || d.startedAt.slice(0, 10), Type: d.type, CourseKey: d.courseKey || null, Summary: d.summary || null,
      Scores: Object.entries(d.choices).filter(([, c]) => c.level || c.notSeen || c.comment)
        .map(([CriterionId, c]) => ({ CriterionId, LevelId: c.level || null, NotSeen: !!c.notSeen && !c.level, Comment: c.comment || null })),
      Actions: d.actions.filter(a => a.text.trim() && a.dueDate).map(a => ({ Text: a.text.trim(), DueDate: a.dueDate })),
      Photos: d.photos.map(p => ({ CriterionId: p.criterionId || null, Name: p.name, Key: p.key, Iv: p.iv })),
      StartedUtc: d.startedAt
    };
  }

  /**
   * What Ecordiatlas receives for a visit check (AtmosphereVisit, safeguarding at work): Purpose "visit", Type
   * "workplace" or "subcontractor". It travels through the same outbox and endpoint as observations.
   */
  function visit(d, kind, user) {
    return {
      V: 1, Purpose: 'visit', Kind: kind, Type: d.type, Id: d.id, UserId: user.userId, TenantId: user.tenantId, EmpId: d.empId ? Number(d.empId) : null,
      LearnerId: d.learnerId || null, SubTenantId: d.subId || null, VisitedOn: d.visitedOn,
      Checks: Object.entries(d.checks).filter(([, a]) => a).map(([Key, Answer]) => ({ Key, Answer, Note: null })),
      Notes: d.notes || null, Findings: d.findings || null, Actions: d.actions || null, ActionsDueOn: d.actionsDueOn || null,
      LearnersSpokenTo: d.learnersSpokenTo === '' || d.learnersSpokenTo == null ? null : Number(d.learnersSpokenTo)
    };
  }
  const payload = (d, kind, user) => (d.visit ? visit(d, kind, user) : observation(d, kind, user));

  /** The visit checklists, employers and subcontractors, encrypted like the rubric packs (one per person). */
  async function saveVisitPack(key, user, item, packedAt) {
    const keepUntil = new Date(new Date(packedAt).getTime() + KEEP_DAYS * DAY).toISOString();
    await put('packs', { id: `${user.userId}|visits`, userId: user.userId, tenantId: user.tenantId, packedAt, keepUntil, box: await lock(key, { ...item, Visit: true }) });
  }

  /** Saves a draft: encrypted for the device, and sealed to the server in case it is still here in 14 days. */
  async function saveDraft(key, user, d) {
    const pub = await serverKey();
    const existing = await get('drafts', d.id);
    const escrow = await seal(json(payload(d, 'unfinished', user)), pub);
    d.updatedAt = new Date().toISOString();
    await put('drafts', {
      id: d.id, userId: user.userId, tenantId: user.tenantId, createdAt: existing?.createdAt || d.startedAt, updatedAt: d.updatedAt,
      keepUntil: existing?.keepUntil || new Date(new Date(d.startedAt).getTime() + KEEP_DAYS * DAY).toISOString(),
      state: existing?.state === 'sending' ? 'sending' : 'draft', escrow, photoIds: d.photos.map(p => p.id), box: await lock(key, d)
    });
  }
  async function drafts(key, userId) {
    const rows = await forUser('drafts', userId);
    const out = [];
    for (const r of rows) {
      try { out.push({ ...r, box: undefined, draft: await open(key, r.box) }); }
      catch { out.push({ ...r, box: undefined, draft: null }); }
    }
    return out;
  }
  async function draft(key, id) {
    const r = await get('drafts', id);
    return r ? { ...r, box: undefined, draft: await open(key, r.box) } : null;
  }
  async function removeDraft(id) {
    const r = await get('drafts', id);
    await tx(['drafts', 'photos', 'outbox'], 'readwrite', (ds, ps, os) => {
      ds.delete(id);
      os.delete(id);
      for (const p of r?.photoIds || []) ps.delete(p);
    });
  }

  /** Encrypts a photo with its own key: { id, key, iv } for the draft, the encrypted bytes on the device. */
  async function savePhoto(user, draftId, blob) {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('atmosphere-photo') }, key, await blob.arrayBuffer());
    const id = uuid();
    await put('photos', { id, draftId, userId: user.userId, data });
    return { id, key: b64(await crypto.subtle.exportKey('raw', key)), iv: b64(iv), size: blob.size };
  }
  async function photoUrl(p) {
    const row = await get('photos', p.id);
    if (!row) return null;
    const key = await crypto.subtle.importKey('raw', unb64(p.key), 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv), additionalData: enc.encode('atmosphere-photo') }, key, row.data);
    return URL.createObjectURL(new Blob([plain], { type: 'image/jpeg' }));
  }
  const removePhoto = id => del('photos', id);

  // ------------------------------------------------------------------ submitting and sending
  /** Submit: sealed for Ecordiatlas and put in the outbox. The draft stays (locked) until Ecordiatlas has it. */
  async function submit(user, d) {
    const sealed = await seal(json(payload(d, 'submit', user)), await serverKey());
    const row = await get('drafts', d.id);
    await tx(['drafts', 'outbox'], 'readwrite', (ds, os) => {
      ds.put({ ...row, state: 'sending' });
      os.put({ id: d.id, userId: user.userId, tenantId: user.tenantId, kind: 'submit', sealed, photoIds: d.photos.map(p => p.id), queuedAt: new Date().toISOString(), status: 'waiting' });
    });
  }

  /** A refused submission back to an editable draft. */
  async function backToDraft(id) {
    const row = await get('drafts', id);
    await tx(['drafts', 'outbox'], 'readwrite', (ds, os) => { os.delete(id); if (row) ds.put({ ...row, state: 'draft' }); });
  }

  /** 14 days on: unsubmitted drafts go to the outbox unfinished (their sealed copy); old downloads and the sent list go. */
  async function expire(now = Date.now()) {
    const expired = [];
    for (const r of await all('drafts')) {
      if (r.state !== 'draft' || new Date(r.keepUntil).getTime() > now || !r.escrow) continue;
      await tx(['drafts', 'outbox'], 'readwrite', (ds, os) => {
        ds.put({ ...r, state: 'sending' });
        os.put({ id: r.id, userId: r.userId, tenantId: r.tenantId, kind: 'unfinished', sealed: r.escrow, photoIds: r.photoIds || [], queuedAt: new Date(now).toISOString(), status: 'waiting' });
      });
      expired.push(r.id);
    }
    for (const p of await all('packs')) if (new Date(p.keepUntil).getTime() <= now) await del('packs', p.id);
    for (const s of await all('sent')) if (new Date(s.sentAt).getTime() + KEEP_DAYS * DAY <= now) await del('sent', s.recordId);
    return expired;
  }

  const outbox = userId => userId ? forUser('outbox', userId) : all('outbox');
  const sent = userId => forUser('sent', userId);

  /**
   * Sends what is waiting, one at a time. Answers { sent, refused, needSignIn, noSignal }. Each one Ecordiatlas accepts
   * (or already had) is deleted from the device, with its draft and photos. Never two senders at once (Web Locks).
   */
  async function sendOutbox() {
    const run = async () => {
      const result = { sent: [], refused: [], needSignIn: false, noSignal: false };
      const atlas = await atlasUrl();
      if (!atlas) return { ...result, noSignal: true };
      for (const item of await all('outbox')) {
        if (item.status === 'refused') continue;
        const form = new FormData();
        form.append('observation', JSON.stringify(item.sealed));
        let missing = false;
        for (let n = 0; n < item.photoIds.length; n++) {
          const p = await get('photos', item.photoIds[n]);
          if (!p) { missing = true; break; }
          form.append('photo' + n, new Blob([p.data], { type: 'application/octet-stream' }), 'photo' + n);
        }
        if (missing) { await put('outbox', { ...item, status: 'refused', error: 'A photo is missing from this device, so this can\'t be sent. Go back to the draft and take it again.' }); result.refused.push(item.id); continue; }
        let res;
        try {
          res = await fetch(atlas + '/api/v1/atmosphere/observations', {
            method: 'POST', body: form, credentials: 'include', cache: 'no-store', mode: 'cors',
            headers: { 'X-ILR-Client': 'atmosphere', 'X-Tenant-Id': item.tenantId, Accept: 'application/json' }
          });
        } catch { result.noSignal = true; break; }
        const body = await res.json().catch(() => null);
        if (res.ok && body?.RecordId) {
          await tx(['drafts', 'photos', 'outbox', 'sent'], 'readwrite', (ds, ps, os, ss) => {
            os.delete(item.id);
            ds.delete(item.id);
            for (const p of item.photoIds) ps.delete(p);
            ss.put({ recordId: body.RecordId, userId: item.userId, tenantId: item.tenantId, sentAt: new Date().toISOString(), unfinished: !!body.Unfinished, draftId: item.id, link: body.Link || null });
          });
          result.sent.push({ id: item.id, recordId: body.RecordId, unfinished: !!body.Unfinished });
          continue;
        }
        if (res.status === 401 || body?.code === 'mfa_setup_required') { result.needSignIn = true; await put('outbox', { ...item, status: 'waiting', note: 'signin' }); break; }
        if (res.status === 403 && body?.data?.code === 'other_user') continue;   // someone else's: waits for them to sign in
        if ([400, 403, 404, 409, 413].includes(res.status)) {
          const errors = body?.data?.errors || [];
          await put('outbox', { ...item, status: 'refused', error: body?.title || `Ecordiatlas refused it (${res.status}).`, errors });
          result.refused.push(item.id);
          continue;
        }
        result.noSignal = true;   // 429, 5xx: try again later
        break;
      }
      return result;
    };
    return root.navigator?.locks ? root.navigator.locks.request(SEND_LOCK, run) : run();
  }

  /** Everything this user has on the device goes (after "Remove from this device"). */
  async function forget(userId) {
    await tx(['packs', 'drafts', 'photos', 'outbox', 'sent', 'meta'], 'readwrite', async (pk, dr, ph, ob, se, me) => {
      for (const [store, s] of [['packs', pk], ['drafts', dr], ['photos', ph], ['outbox', ob], ['sent', se]]) {
        const keys = await done(s.index('userId').getAllKeys(userId));
        for (const k of keys) s.delete(k);
      }
      me.delete(userKey(userId));
    });
  }

  root.Atmosphere = {
    KEEP_DAYS, deviceId, atlasUrl, saveAtlasUrl, serverKey, saveServerKey, getUser, saveProfile, lastUser, setLastUser, setUpUser, unlock, setPasscodeFromRecovery, changePasscode,
    savePack, saveVisitPack, packs, removePack, saveDraft, drafts, draft, removeDraft, savePhoto, photoUrl, removePhoto, submit, backToDraft, expire, outbox, sent,
    sendOutbox, forget, uuid
  };
})(typeof self !== 'undefined' ? self : window);
