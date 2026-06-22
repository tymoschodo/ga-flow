const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Debug middleware — log every incoming request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} | body keys: ${Object.keys(req.body||{}).join(',') || 'empty'}`);
  next();
});

// ── CREDENTIALS ───────────────────────────────────────────────────────────────
const GA_BASE_URL = 'https://tymoschodo.github.io/ga-flow';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'YOUR_SID';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || 'YOUR_TOKEN';
const TWILIO_WA_NUMBER   = process.env.TWILIO_WA_NUMBER   || 'whatsapp:+14155238886';
const FIREBASE_DB_URL    = process.env.FIREBASE_DB_URL    || 'https://general-anesthesia-cf511-default-rtdb.europe-west1.firebasedatabase.app';

// ── FIREBASE ADMIN ────────────────────────────────────────────────────────────
let db;
try {
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;

    admin.initializeApp({
      credential: serviceAccount
        ? admin.credential.cert(serviceAccount)
        : admin.credential.applicationDefault(),
      databaseURL: FIREBASE_DB_URL,
    });
  }
  db = admin.database();
  console.log('Firebase connected');
} catch(e) {
  console.error('Firebase init error:', e.message);
}

// ── TWILIO CLIENT ─────────────────────────────────────────────────────────────
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── SEND WHATSAPP MESSAGE ─────────────────────────────────────────────────────
async function sendWA(to, body) {
  try {
    await client.messages.create({
      from: TWILIO_WA_NUMBER,
      to: `whatsapp:${to}`,
      body,
    });
    console.log(`WA sent to ${to}: ${body.substring(0, 50)}`);
  } catch(e) {
    console.error(`WA send error to ${to}:`, e.message);
  }
}

// ── INCOMING WHATSAPP MESSAGES (webhook) ──────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const from = req.body.From?.replace('whatsapp:', '');
  const body = (req.body.Body || '').trim().toUpperCase();

  console.log(`Incoming from ${from}: ${body}`);

  if (!db) { res.set('Content-Type', 'text/xml').send('<Response></Response>'); return; }

  const phoneSnap = await db.ref('/phoneIndex/' + from.replace('+', '')).once('value');
  const linkedId = phoneSnap.val();

  if (!linkedId) {
    const looksLikeId = /^[A-Z0-9]{4,10}$/.test(body);
    if (!looksLikeId) {
      await sendWA(from, `⚕️ Welcome to General Anesthesia ⚕️\n\nYou are now connected. Please type in your ID code.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    const allowedSnap = await db.ref('/allowedIds/' + body).once('value');
    if (!allowedSnap.exists()) {
      await sendWA(from, `ID not recognised. Please check your code and try again.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    const pSnap = await db.ref('/participants/' + body).once('value');
    const pData = pSnap.val();
    if (!pData) {
      await sendWA(from, `Your ID is valid but you have not been checked in yet. Please see the nurse at reception first.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    if (pData.phone && pData.phone !== from) {
      await sendWA(from, `This ID is already registered on another device. Please ask staff for help.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    await db.ref('/phoneIndex/' + from.replace('+', '')).set(body);
    await db.ref('/participants/' + body).update({ phone: from, whatsappLinked: true });

    // If already dispatched — send current instruction immediately
    if (pData.instruction && ['transit','arrived','active'].includes(pData.status)) {
      // Send instruction
      await sendWA(from, pData.instruction);
      // If in transit to a station with a video — send video too
      if (pData.status === 'transit' && pData.transitTo) {
        const cfgSnap = await db.ref('/config/stations/' + pData.transitTo + '/videoUrl').once('value');
        const videoUrl = cfgSnap.val();
        if (videoUrl) {
          try {
            await client.messages.create({
              from: TWILIO_WA_NUMBER,
              to: `whatsapp:${from}`,
              body: `Here is a short video showing where to go:`,
              mediaUrl: [videoUrl],
            });
          } catch(e) {
            console.error(`[link] Video WA error:`, e.message);
          }
        }
      }
    } else {
      await sendWA(from, `Thank you. Please take a seat and wait for your appointment. You'll be receiving notifications via WhatsApp. You can also decide to receive them in the GA phone app.`);
    }

    res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
  }

  const pSnap = await db.ref('/participants/' + linkedId).once('value');
  const pData = pSnap.val();
  if (!pData) { res.set('Content-Type', 'text/xml').send('<Response></Response>'); return; }

  await sendWA(from, `Stand by. Instructions will follow.`);
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// ── SEND INSTRUCTION TO PARTICIPANT ───────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { pid, message } = req.body;
  if (!pid || !message) { res.status(400).json({ error: 'pid and message required' }); return; }

  const pSnap = await db.ref('/participants/' + pid).once('value');
  const p = pSnap.val();
  if (!p?.phone) { res.json({ sent: false, reason: 'no phone linked' }); return; }

  await sendWA(p.phone, message);
  res.json({ sent: true });
});

// ── BROADCAST ─────────────────────────────────────────────────────────────────
app.post('/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) { res.status(400).json({ error: 'message required' }); return; }

  const pSnap = await db.ref('/participants').once('value');
  const participants = pSnap.val() || {};
  let sent = 0;

  for (const [pid, p] of Object.entries(participants)) {
    if (p?.phone) {
      await sendWA(p.phone, message);
      sent++;
      await new Promise(r => setTimeout(r, 200)); // rate limit
    }
  }
  res.json({ sent });
});

// ── FIREBASE LISTENER — watch for instruction changes ─────────────────────────
// Fires whenever a participant record changes; sends WA if instruction is fresh.
function watchParticipants() {
  if (!db) return;
  db.ref('/participants').on('child_changed', async snap => {
    const p = snap.val();
    if (!p?.phone || !p?.instruction || !p?.instructionAt) return;

    // Only send if instruction was set in the last 10 seconds
    if (Date.now() - p.instructionAt > 10000) return;

    // Don't send WA for done status — participant sees it on screen,
    // and dispatch/arrival messages are sent explicitly to avoid doubles
    if (p.status === 'done' || p.status === 'transit' || p.status === 'arrived') return;

    await sendWA(p.phone, p.instruction);
  });
  console.log('Watching participants for instruction changes...');
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTO-DISPATCH ENGINE
//
// How it works:
//   • watchWaitingRoom() listens for participants entering waiting_s3 and stamps
//     waitingEnteredAt + updates lastRosterChangeAt in /waitingRoom.
//   • runDispatchLoop() runs every 5s. It reads the waiting room roster, checks
//     elapsed time since the last roster change, and applies the dispatchRules
//     array stored on the target station's config in Firebase.
//   • dispatchRules format (stored on the station in /config/stations/{id}):
//       [
//         { "minActive": 1, "minPassive": 2, "waitSeconds": 30 },
//         { "minActive": 1, "minPassive": 1, "waitSeconds": 60 },
//         { "minActive": 1, "minPassive": 0, "waitSeconds": 90 }
//       ]
//     Rules are evaluated in order; first match wins.
//     Selection always picks: 1 active (longest-waiting FIFO) + up to 2 passives (FIFO).
//   • dispatchGroupToStation() writes all participant updates atomically, then
//     schedules handleArrivalServer() via setTimeout.
//   • handleArrivalServer() fires after the transit duration and sets status:'arrived'.
//
// The loop is gated by /showStarted so it is inactive before the show begins.
// ════════════════════════════════════════════════════════════════════════════════

// ── HELPER: transit duration lookup ──────────────────────────────────────────
// Mirrors getT() in admin.html. Falls back to 90s if key not found.
function getTransitTime(transit, fromSid, toSid) {
  if (!transit) return 90;
  return transit[`${fromSid}-${toSid}`] || transit[`${toSid}-${fromSid}`] || 90;
}

// ── HELPER: find step index for a station in a participant's path ──────────────
// Scans forward from the participant's current stepIndex to find targetSid.
// Returns the index (integer) or null if not found ahead in the path.
// Needed because different paths place the same station at different indices:
//   Path A: s2 is at index 2
//   Path B: s2 is at index 2
//   Path C: s2 is at index 3
function findStepIndexForStation(p, cfg, targetSid) {
  const path = (cfg.paths || {})[p.path];
  if (!path || !Array.isArray(path.seq)) return null;

  const curIdx = p.stepIndex ?? 0;
  for (let i = curIdx + 1; i < path.seq.length; i++) {
    if (path.seq[i] === targetSid) return i;
  }
  return null;
}

// ── SERVER-SIDE ARRIVAL HANDLER ───────────────────────────────────────────────
// Called via setTimeout after transit duration has elapsed.
// Sets participant to 'arrived' and increments station occupancy.
// Reads fresh state from Firebase in case anything changed during transit.
async function handleArrivalServer(pid, sid) {
  if (!db) return;
  try {
    const [pSnap, cfgSnap] = await Promise.all([
      db.ref('/participants/' + pid).once('value'),
      db.ref('/config').once('value'),
    ]);
    const p   = pSnap.val();
    const cfg = cfgSnap.val() || {};

    // Stale check: if participant is no longer heading to this station, abort.
    // This handles the case where admin manually redirected them during transit.
    if (!p || p.transitTo !== sid) {
      console.log(`[arrival] ${pid}→${sid}: stale (transitTo=${p?.transitTo ?? 'null'}), skipping`);
      return;
    }

    const station     = (cfg.stations || {})[sid] || {};
    const stationName = station.name || sid;
    const t           = Date.now();

    const arrivalInstruction = `Please show your QR code to the anesthesiologist Somina.`;

    await db.ref('/participants/' + pid).update({
      status:            'arrived',
      currentStation:    sid,
      transitTo:         null,
      transitStartedAt:  null,
      transitDur:        null,
      instruction:       arrivalInstruction,
      instructionAt:     t,
      checkedIn:         false,
    });

    // Increment occupancy for the station now that participant has physically arrived
    await db.ref('/occupancy/' + sid).transaction(v => (v || 0) + 1);

    // Send WA arrival notification + QR code image
    if (p.phone) {
      try {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pid)}&format=jpg&margin=10`;
        await client.messages.create({
          from: TWILIO_WA_NUMBER,
          to: `whatsapp:${p.phone}`,
          body: arrivalInstruction,
          mediaUrl: [qrUrl],
        });
        console.log(`[arrival] Sent WA + QR image to ${pid}`);
      } catch(e) {
        console.error(`[arrival] WA + QR error for ${pid}:`, e.message);
        try { await sendWA(p.phone, arrivalInstruction); } catch(e2) {}
      }
    }

    console.log(`[arrival] ${pid} arrived at ${sid}`);
  } catch (e) {
    console.error(`[arrival] error for ${pid}:`, e.message);
  }
}

// ── DISPATCH GROUP TO STATION ─────────────────────────────────────────────────
// Atomically moves a group of participants from the waiting room to toSid.
// Re-verifies each participant's status immediately before writing to guard
// against race conditions with admin.html manual dispatch.
async function dispatchGroupToStation(group, toSid, cfg) {
  if (!db || !group.length) return;

  const t    = Date.now();
  const toSt = (cfg.stations || {})[toSid];
  if (!toSt) {
    console.error('[dispatch] Unknown target station:', toSid);
    return;
  }

  const tDur    = getTransitTime(cfg.transit, 's3', toSid);
  const updates = {};
  const dispatched = [];

  for (const p of group) {
    // Re-read fresh state — guards against race with admin.html manual dispatch
    let current;
    try {
      current = (await db.ref('/participants/' + p.id).once('value')).val();
    } catch (e) {
      console.error(`[dispatch] re-read error for ${p.id}:`, e.message);
      continue;
    }

    if (!current || (current.status !== 'waiting_s3' && current.status !== 's3_holding')) {
      console.log(`[dispatch] ${p.id}: status='${current?.status}' — no longer eligible, skipping`);
      continue;
    }

    // Find the correct stepIndex for the target station in this participant's path.
    // This is path-dependent: path C places s2 at a different index than A or B.
    const stepIndex = findStepIndexForStation(current, cfg, toSid);
    if (stepIndex === null) {
      console.warn(`[dispatch] ${p.id}: ${toSid} not found ahead in path '${current.path}', skipping`);
      continue;
    }

    // Build atomic multi-path update for this participant
    updates[`/participants/${p.id}/status`]           = 'transit';
    updates[`/participants/${p.id}/transitStartedAt`] = t;
    updates[`/participants/${p.id}/transitDur`]       = tDur;
    updates[`/participants/${p.id}/transitTo`]        = toSid;
    updates[`/participants/${p.id}/transitToName`]    = toSt.name;
    updates[`/participants/${p.id}/stepIndex`]        = stepIndex;
    updates[`/participants/${p.id}/currentStation`]   = null;
    updates[`/participants/${p.id}/stationStartedAt`] = null;
    updates[`/participants/${p.id}/checkedIn`]        = false;
    updates[`/participants/${p.id}/assignedRole`]     = null;
    updates[`/participants/${p.id}/holdUntil`]        = null;
    updates[`/participants/${p.id}/waitingEnteredAt`] = null;
    updates[`/participants/${p.id}/instructionAt`]    = t;

    dispatched.push(p);
  }

  if (!dispatched.length) {
    console.log('[dispatch] No participants eligible after re-verification, aborting');
    return;
  }

  // Build instruction — include group note when more than one person is dispatched
  const groupNote = dispatched.length > 1
    ? '\nYour appointment coincides with other patients — this is expected.'
    : '';

  // Check if this station has a video URL
  const stationVideoUrl = toSt.videoUrl || null;

  for (const p of dispatched) {
    updates[`/participants/${p.id}/instruction`] = `Proceed to ${toSt.name}. Please keep your GA app open for scanning. For instructions, watch the video.`;
  }

  // Reset the roster-change timestamp so remaining waiting participants'
  // timer starts fresh from this moment
  updates['/waitingRoom/lastRosterChangeAt'] = t;

  // Read phone numbers BEFORE atomic update (fresh from DB)
  const phoneMap = {};
  for (const p of dispatched) {
    try {
      const pSnap = await db.ref('/participants/' + p.id).once('value');
      const pData = pSnap.val();
      if (pData?.phone) phoneMap[p.id] = pData.phone;
    } catch(e) {
      console.error(`[dispatch] phone read error for ${p.id}:`, e.message);
    }
  }

  // Write all participant updates in a single atomic multi-path operation
  await db.ref('/').update(updates);

  // Decrement waiting-room occupancy per dispatched participant
  for (const p of dispatched) {
    await db.ref('/occupancy/s3').transaction(v => Math.max(0, (v || 0) - 1));
  }

  // Schedule arrival handlers — fire after transit duration
  const arrivalDelayMs = tDur * 1000 + 500;
  for (const p of dispatched) {
    const pid = p.id;
    setTimeout(() => handleArrivalServer(pid, toSid), arrivalDelayMs);
  }

  const ids = dispatched.map(p => p.id).join(', ');
  console.log(`[dispatch] [${ids}] → ${toSid} | transit ${tDur}s | arrival in ~${Math.round(arrivalDelayMs / 1000)}s`);

  // Send WhatsApp notifications explicitly (don't rely on watchParticipants for dispatch)
  // Multi-path updates don't always trigger child_changed listeners reliably
  const instruction = updates[`/participants/${dispatched[0].id}/instruction`];
  for (const p of dispatched) {
    const phone = phoneMap[p.id];
    if (!phone) { console.log(`[dispatch] No phone for ${p.id} — skipping WA`); continue; }

    try {
      // Send text first
      await sendWA(phone, updates[`/participants/${p.id}/instruction`]);
      console.log(`[dispatch] Sent text WA to ${p.id}`);
      // Then video separately
      if (stationVideoUrl) {
        await new Promise(r => setTimeout(r, 500));
        await client.messages.create({
          from: TWILIO_WA_NUMBER,
          to: `whatsapp:${phone}`,
          body: '',
          mediaUrl: [stationVideoUrl],
        });
        console.log(`[dispatch] Sent video WA to ${p.id}`);
      }
    } catch(e) {
      console.error(`[dispatch] WA error for ${p.id}:`, e.message);
    }

    // Rate limit between messages
    await new Promise(r => setTimeout(r, 300));
  }
}

// ── WAITING ROOM WATCHER ──────────────────────────────────────────────────────
// Listens for participants entering waiting_s3. On detection:
//   1. Stamps waitingEnteredAt so the dispatch loop has accurate FIFO ordering.
//   2. Updates /waitingRoom/lastRosterChangeAt to start the dispatch timer.
//
// Infinite-loop guard: we only act when status==='waiting_s3' AND !waitingEnteredAt.
// Primary stamping happens in participant.html (proceedToApp) — this is a server-side
// fallback for participants who were registered but never opened the app, or for
// server restarts where in-memory state was lost.
function watchWaitingRoom() {
  if (!db) return;

  db.ref('/participants').on('child_changed', async snap => {
    const p   = snap.val();
    const pid = snap.key;
    if (!p) return;

    if (p.status === 'waiting_s3' && !p.waitingEnteredAt) {
      const t = Date.now();
      try {
        // Two separate writes: participant stamp + roster timestamp
        await db.ref('/participants/' + pid).update({ waitingEnteredAt: t });
        await db.ref('/waitingRoom/lastRosterChangeAt').set(t);
        console.log(`[waiting] ${pid} entered waiting room — stamped ${new Date(t).toISOString()}`);
      } catch (e) {
        console.error(`[waiting] stamp error for ${pid}:`, e.message);
      }
    }
  });

  console.log('Watching waiting room for new arrivals...');
}

// ── STATION READY WATCHER ─────────────────────────────────────────────────────
// When performer clicks "Ready for next session", triggers dispatch immediately
// rather than waiting for the next 5s loop tick.
function watchStationReady() {
  if (!db) return;
  db.ref('/stationReady').on('child_changed', async snap => {
    const data = snap.val();
    if (!data?.readyAt) return;
    console.log(`[ready] Station ${data.stationId} marked ready — triggering dispatch`);
    // Small delay to let Firebase settle
    setTimeout(() => runDispatchLoop(), 500);
    // Clear the ready flag
    await db.ref('/stationReady/' + snap.key).remove();
  });
  console.log('Watching station ready signals...');
}

// ── DISPATCH LOOP ─────────────────────────────────────────────────────────────
// Runs every 5 seconds while the show is active.
// Guards: show must be started, target station must have dispatchRules,
//         station must be clear, there must be eligible waiting participants.
let dispatchLoopRunning = false;

async function runDispatchLoop() {
  if (!db || dispatchLoopRunning) return;
  dispatchLoopRunning = true;

  try {

    // ── Gate 1: show must be running ────────────────────────────────────────
    const showStarted = (await db.ref('/showStarted').once('value')).val();
    if (!showStarted) { dispatchLoopRunning = false; return; }

    // ── Gate 2: config must exist ────────────────────────────────────────────
    const cfg = (await db.ref('/config').once('value')).val();
    if (!cfg) { dispatchLoopRunning = false; return; }

    // ── Gate 3: a station with dispatchRules must be configured ─────────────
    // The first enabled, non-waiting, non-final station that has dispatchRules
    // becomes the auto-dispatch target. There should only ever be one.
    const targetStation = Object.values(cfg.stations || {}).find(s =>
      s.dispatchRules &&
      s.dispatchRules.length > 0 &&
      s.enabled &&
      !s.isWaiting &&
      !s.isFinal
    );
    if (!targetStation) { dispatchLoopRunning = false; return; }

    const toSid = targetStation.id;

    // ── Gate 4: read all participants (single read for efficiency) ───────────
    const allSnap = await db.ref('/participants').once('value');
    const all     = allSnap.val() || {};
    const allList = Object.values(all);

    // ── Gate 5: target station must be clear ─────────────────────────────────
    // "Clear" means: nobody arrived/active there AND nobody in transit heading there.
    // We check participant statuses directly rather than the /occupancy counter,
    // which can lag during rapid state changes.
    const stationBusy = allList.some(p =>
      (p.currentStation === toSid && (p.status === 'arrived' || p.status === 'active')) ||
      (p.transitTo === toSid && p.status === 'transit')
    );
    if (stationBusy) { dispatchLoopRunning = false; return; }

    // ── Collect eligible waiting room participants ────────────────────────────
    const now = Date.now();
    const waiting = allList.filter(p => {
      if (p.status === 'waiting_s3') return true;
      // s3_holding participants are eligible once their hold time has passed
      if (p.status === 's3_holding' && (!p.holdUntil || now >= p.holdUntil)) return true;
      return false;
    });
    if (!waiting.length) { dispatchLoopRunning = false; return; }

    // ── Backfill: stamp any unstamped waitingEnteredAt ───────────────────────
    // This handles the server-restart edge case where participants entered
    // waiting_s3 while the server was down and have no timestamp.
    let didStamp = false;
    for (const p of waiting) {
      if (!p.waitingEnteredAt) {
        const t = Date.now();
        await db.ref('/participants/' + p.id).update({ waitingEnteredAt: t });
        await db.ref('/waitingRoom/lastRosterChangeAt').set(t);
        console.log(`[loop] Backfill: stamped ${p.id} waitingEnteredAt=${new Date(t).toISOString()}`);
        didStamp = true;
      }
    }
    // Skip this cycle after stamping so timers start cleanly next tick
    if (didStamp) { dispatchLoopRunning = false; return; }

    // ── Separate by role, FIFO within each group ─────────────────────────────
    const byEntry = p => p.waitingEnteredAt || p.registeredAt || 0;

    const actives = waiting
      .filter(p => p.rolePreference === 'active')
      .sort((a, b) => byEntry(a) - byEntry(b));

    const passives = waiting
      .filter(p => p.rolePreference !== 'active')
      .sort((a, b) => byEntry(a) - byEntry(b));

    // ── Elapsed time = time since FIRST active entered the waiting room ───────
    // This way the timer is NOT reset by new arrivals — it counts from when
    // the first active person sat down. This ensures the algo dispatches
    // after a predictable wait regardless of how many people keep trickling in.
    const firstActiveEnteredAt = actives.length > 0 ? byEntry(actives[0]) : now;
    const elapsedMs = now - firstActiveEnteredAt;

    // ── Group formation helper ────────────────────────────────────────────────
    const buildGroup = () => {
      const cap = 4;
      const primary = actives[0];
      const selPassives = passives.slice(0, cap - 1);
      const slotsLeft = cap - 1 - selPassives.length;
      const extra = slotsLeft > 0 && actives.length > 1 ? actives.slice(1, 2) : [];
      return [primary, ...selPassives, ...extra];
    };

    // ── Two independent dispatch conditions ───────────────────────────────────
    //
    // Condition A — FULL GROUP: 1A + 3P ready → dispatch after 30s
    // This fires as soon as a full group assembles, regardless of how long
    // anyone has been waiting.
    //
    // Condition B — TIMEOUT: oldest active has waited too long → dispatch
    // whatever is available. Uses the active's personal waitingEnteredAt,
    // NOT the roster change time — so new arrivals don't reset this clock.
    // Rules define how long to wait based on how many passives are available.

    const rules = targetStation.dispatchRules;
    let selectedGroup = null;
    let matchReason = '';

    // Condition A: full group
    if (actives.length >= 1 && passives.length >= 3) {
      const tentative = buildGroup();
      if (tentative.length >= 4) {
        // Wait 30s after the 4th person entered
        const allFour = [...actives.slice(0,1), ...passives.slice(0,3)];
        const lastOfFour = Math.max(...allFour.map(p => byEntry(p)));
        if (now - lastOfFour >= 80000) {
          selectedGroup = tentative;
          matchReason = 'full group (30s)';
        }
      }
    }

    // Condition B: timeout based on oldest active's personal wait time
    if (!selectedGroup) {
      for (const rule of rules) {
        const waitMs     = (rule.waitSeconds || 0) * 1000;
        const minActive  = rule.minActive  ?? 1;
        const minPassive = rule.minPassive ?? 0;

        if (actives.length >= minActive && passives.length >= minPassive) {
          // Use oldest active's personal wait time — NOT reset by new arrivals
          const oldestActiveWait = now - byEntry(actives[0]);
          if (oldestActiveWait >= waitMs) {
            selectedGroup = buildGroup();
            matchReason = `timeout ${Math.round(oldestActiveWait/1000)}s (rule: ${rule.waitSeconds}s, minP=${minPassive})`;
            break;
          }
        }
      }
    }

    if (!selectedGroup) { dispatchLoopRunning = false; return; } // No condition triggered yet

    console.log(`[loop] Dispatch triggered: ${matchReason} | group=[${selectedGroup.map(p => p.id + '(' + p.rolePreference + ')').join(', ')}]`);

    // ── Dispatch ─────────────────────────────────────────────────────────────
    await dispatchGroupToStation(selectedGroup, toSid, cfg);

  } catch (e) {
    console.error('[dispatchLoop] error:', e.message, e.stack);
  } finally {
    dispatchLoopRunning = false;
  }
}

// ── MANUAL DISPATCH WA ENDPOINT ──────────────────────────────────────────────
// Called by admin.html when manually dispatching a participant
app.post('/dispatch-wa', async (req, res) => {
  const { phone, instruction, videoUrl } = req.body;
  if (!phone) { res.json({ sent: false }); return; }
  try {
    // Send text instruction first
    await sendWA(phone, instruction);
    // Then send video separately if available
    if (videoUrl) {
      await new Promise(r => setTimeout(r, 500)); // small delay
      await client.messages.create({
        from: TWILIO_WA_NUMBER,
        to: `whatsapp:${phone}`,
        body: '',
        mediaUrl: [videoUrl],
      });
    }
    console.log(`[manual-dispatch] WA sent to ${phone}`);
    res.json({ sent: true });
  } catch(e) {
    console.error(`[manual-dispatch] WA error:`, e.message);
    res.json({ sent: false, error: e.message });
  }
});

// ── MANUAL ARRIVAL WA ENDPOINT ────────────────────────────────────────────────
// Called by admin.html handleArrival — sends arrival message + QR code
app.post('/arrival-wa', async (req, res) => {
  const { phone, pid, instruction } = req.body;
  if (!phone || !pid) { res.json({ sent: false }); return; }
  try {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pid)}&format=jpg&margin=10`;
    await client.messages.create({
      from: TWILIO_WA_NUMBER,
      to: `whatsapp:${phone}`,
      body: instruction,
      mediaUrl: [qrUrl],
    });
    console.log(`[manual-arrival] WA + QR sent to ${phone} for ${pid}`);
    res.json({ sent: true });
  } catch(e) {
    console.error(`[manual-arrival] WA error:`, e.message);
    try { await sendWA(phone, instruction); } catch(e2) {}
    res.json({ sent: false, error: e.message });
  }
});

// ── RESET LOOP FLAG ──────────────────────────────────────────────────────────
// Called by admin.html Reset button to unstick the dispatch loop mutex
app.post('/reset-loop', (req, res) => {
  dispatchLoopRunning = false;
  console.log('[reset] dispatch loop flag cleared');
  res.json({ ok: true });
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'GA WhatsApp Bot', uptime: process.uptime() });
});

// ── KEEPALIVE (pinged by UptimeRobot every 5 min) ─────────────────────────────
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: new Date().toISOString() });
});

// ── START ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GA WhatsApp Bot running on port ${PORT}`);
  watchParticipants();                     // WA on instruction change
  watchWaitingRoom();                      // stamp waitingEnteredAt + roster clock
  watchStationReady();                     // trigger dispatch when station resets
  setInterval(runDispatchLoop, 5000);      // auto-dispatch loop every 5s
});
