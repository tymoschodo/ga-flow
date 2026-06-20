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
    await sendWA(from, `Thank you. Please take a seat and wait for your appointment. You'll be receiving notifications via WhatsApp. You can also decide to receive them in the GA phone app`);

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

    await db.ref('/participants/' + pid).update({
      status:            'arrived',
      currentStation:    sid,
      transitTo:         null,
      transitStartedAt:  null,
      transitDur:        null,
      instruction:       `You have arrived at ${stationName}.\nWait for check-in.`,
      instructionAt:     t,
      checkedIn:         false,
    });

    // Increment occupancy for the station now that participant has physically arrived
    await db.ref('/occupancy/' + sid).transaction(v => (v || 0) + 1);

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
    updates[`/participants/${p.id}/instruction`] = `Proceed to ${toSt.name}.${groupNote}\nPlease keep your GA app open for scanning.`;
  }

  // Reset the roster-change timestamp so remaining waiting participants'
  // timer starts fresh from this moment
  updates['/waitingRoom/lastRosterChangeAt'] = t;

  // Write all participant updates in a single atomic multi-path operation
  await db.ref('/').update(updates);

  // Decrement waiting-room occupancy per dispatched participant (use transaction
  // to be safe against concurrent updates from admin.html)
  for (const p of dispatched) {
    await db.ref('/occupancy/s3').transaction(v => Math.max(0, (v || 0) - 1));
  }

  // Schedule arrival handlers — fire after transit duration
  // Extra 500ms buffer so Firebase write above has fully propagated
  const arrivalDelayMs = tDur * 1000 + 500;
  for (const p of dispatched) {
    const pid = p.id; // capture for async closure
    setTimeout(() => handleArrivalServer(pid, toSid), arrivalDelayMs);
  }

  const ids = dispatched.map(p => p.id).join(', ');
  console.log(`[dispatch] [${ids}] → ${toSid} | transit ${tDur}s | arrival in ~${Math.round(arrivalDelayMs / 1000)}s`);

  // Send video via WhatsApp if station has one
  if (stationVideoUrl) {
    for (const p of dispatched) {
      const pData = (await db.ref('/participants/' + p.id).once('value')).val();
      if (pData?.phone) {
        try {
          await client.messages.create({
            from: TWILIO_WA_NUMBER,
            to: `whatsapp:${pData.phone}`,
            body: `Proceed to ${toSt.name}. Here is a short video showing where to go:`,
            mediaUrl: [stationVideoUrl],
          });
          console.log(`[dispatch] Sent video to ${p.id}`);
        } catch(e) {
          console.error(`[dispatch] Video WA error for ${p.id}:`, e.message);
        }
      }
    }
  }
}

// ── WAITING ROOM WATCHER ──────────────────────────────────────────────────────
// Listens for participants entering waiting_s3. On detection:
//   1. Stamps waitingEnteredAt so the dispatch loop has accurate FIFO ordering.
//   2. Updates /waitingRoom/lastRosterChangeAt to start the dispatch timer.
//
// Infinite-loop guard: we only act when status==='waiting_s3' AND !waitingEnteredAt.
// When we write waitingEnteredAt, Firebase fires child_changed again — but now
// waitingEnteredAt is set, so the condition is false and we do not act again.
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
    if (!showStarted) return;

    // ── Gate 2: config must exist ────────────────────────────────────────────
    const cfg = (await db.ref('/config').once('value')).val();
    if (!cfg) return;

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
    if (!targetStation) return;

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
    if (stationBusy) return;

    // ── Collect eligible waiting room participants ────────────────────────────
    const now = Date.now();
    const waiting = allList.filter(p => {
      if (p.status === 'waiting_s3') return true;
      // s3_holding participants are eligible once their hold time has passed
      if (p.status === 's3_holding' && (!p.holdUntil || now >= p.holdUntil)) return true;
      return false;
    });
    if (!waiting.length) return;

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
    if (didStamp) return;

    // ── Read roster-change timestamp ─────────────────────────────────────────
    const lastChange = (await db.ref('/waitingRoom/lastRosterChangeAt').once('value')).val() || 0;
    const elapsedMs  = now - lastChange;

    // ── Separate by role, FIFO within each group ─────────────────────────────
    // FIFO = longest-waiting first (earliest waitingEnteredAt).
    // waitingEnteredAt is guaranteed to be present at this point (backfill above).
    const byEntry = p => p.waitingEnteredAt || p.registeredAt || 0;

    const actives = waiting
      .filter(p => p.rolePreference === 'active')
      .sort((a, b) => byEntry(a) - byEntry(b));

    const passives = waiting
      .filter(p => p.rolePreference !== 'active')
      .sort((a, b) => byEntry(a) - byEntry(b));

    // ── Evaluate dispatch rules in order (first match wins) ──────────────────
    // Selection always sends: 1 active (longest-waiting) + up to 2 passives (longest-waiting).
    // The rule's minPassive is the THRESHOLD to trigger; we always try to fill up to 2 passives.
    const rules = targetStation.dispatchRules;
    let selectedGroup = null;

    for (const rule of rules) {
      const waitMs     = (rule.waitSeconds || 0) * 1000;
      const minActive  = rule.minActive  ?? 1;
      const minPassive = rule.minPassive ?? 0;

      if (elapsedMs >= waitMs && actives.length >= minActive && passives.length >= minPassive) {
        const selectedActive   = actives[0];
        const selectedPassives = passives.slice(0, 2); // Up to 2 passives, FIFO

        selectedGroup = [selectedActive, ...selectedPassives];

        console.log(
          `[loop] Rule matched | elapsed=${Math.round(elapsedMs / 1000)}s ` +
          `waitSeconds=${rule.waitSeconds} minPassive=${minPassive} | ` +
          `group=[${selectedGroup.map(p => p.id + '(' + p.rolePreference + ')').join(', ')}]`
        );
        break;
      }
    }

    if (!selectedGroup) return; // No rule triggered yet

    // ── Dispatch ─────────────────────────────────────────────────────────────
    await dispatchGroupToStation(selectedGroup, toSid, cfg);

  } catch (e) {
    console.error('[dispatchLoop] error:', e.message, e.stack);
  } finally {
    dispatchLoopRunning = false;
  }
}

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
