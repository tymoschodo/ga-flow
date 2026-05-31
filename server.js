const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── CREDENTIALS (fill these in before deploying) ──────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || 'YOUR_SID';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || 'YOUR_TOKEN';
const TWILIO_WA_NUMBER   = process.env.TWILIO_WA_NUMBER   || 'whatsapp:+14155238886';
const FIREBASE_DB_URL    = process.env.FIREBASE_DB_URL    || 'https://general-anesthesia-cf511-default-rtdb.europe-west1.firebasedatabase.app';

// ── FIREBASE ADMIN ─────────────────────────────────────────────
// Uses GOOGLE_APPLICATION_CREDENTIALS env var OR service account JSON
let db;
try {
  if (!admin.apps.length) {
    // If FIREBASE_SERVICE_ACCOUNT env var is set (JSON string), use it
    // Otherwise falls back to application default credentials
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

// ── TWILIO CLIENT ──────────────────────────────────────────────
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── SEND WHATSAPP MESSAGE ──────────────────────────────────────
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

// ── INCOMING WHATSAPP MESSAGES (webhook) ──────────────────────
app.post('/webhook', async (req, res) => {
  const from = req.body.From?.replace('whatsapp:', '');
  const body = (req.body.Body || '').trim().toUpperCase();

  console.log(`Incoming from ${from}: ${body}`);

  if (!db) { res.set('Content-Type', 'text/xml').send('<Response></Response>'); return; }

  // Check if this phone is already linked to a participant
  const phoneSnap = await db.ref('/phoneIndex/' + from.replace('+', '')).once('value');
  const linkedId = phoneSnap.val();

  if (!linkedId) {
    // Not linked yet — expect participant ID
    const allowedSnap = await db.ref('/allowedIds/' + body).once('value');
    if (!allowedSnap.exists()) {
      await sendWA(from, `ID not recognised. Please send your participant ID exactly as given by staff.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Check if ID already linked to another phone
    const pSnap = await db.ref('/participants/' + body).once('value');
    const pData = pSnap.val();
    if (pData?.phone && pData.phone !== from) {
      await sendWA(from, `This ID is already registered on another device. Please ask staff for help.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Link phone to ID
    await db.ref('/phoneIndex/' + from.replace('+', '')).set(body);
    await db.ref('/participants/' + body).update({ phone: from, whatsappLinked: true });

    // Check if role already answered
    if (pData?.rolePreference) {
      await sendWA(from, `Welcome back, ${body}. You are connected. Stand by for instructions.`);
    } else {
      // Ask role preference
      await sendWA(from,
        `⚕️ Welcome to General Anesthesia ⚕️\n\nSome stations include immersive, hands-on roles — for example, being the center of a simulated medical procedure. 💉\n\nWould you be comfortable taking on an active, immersive role if needed?\n\n🩻 Reply:\n*YES* — I'm comfortable being an active participant 🫀\n*NO* — I prefer to remain a pure observer 🩺`
      );
      await db.ref('/participants/' + body).update({ status: 'role_pending_wa' });
    }

    res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
  }

  // Phone is linked — handle replies
  const pSnap = await db.ref('/participants/' + linkedId).once('value');
  const pData = pSnap.val();
  if (!pData) { res.set('Content-Type', 'text/xml').send('<Response></Response>'); return; }

  // If participant exists but no role yet — re-ask
  if (!pData.rolePreference && pData.status !== 'role_pending_wa' && pData.status !== 'role_pending') {
    await db.ref('/participants/' + linkedId).update({ status: 'role_pending_wa' });
    await sendWA(from,
      `⚕️ Welcome to General Anesthesia ⚕️\n\nSome stations include immersive, hands-on roles — for example, being the center of a simulated medical procedure. 💉\n\nWould you be comfortable taking on an active, immersive role if needed?\n\n🩻 Reply:\n*YES* — I'm comfortable being an active participant 🫀\n*NO* — I prefer to remain a pure observer 🩺`
    );
    res.status(200).send('<Response></Response>');
    return;
  }

  // Role preference answer
  if (pData.status === 'role_pending_wa' || pData.status === 'role_pending') {
    if (body === 'YES' || body === 'Y') {
      await db.ref('/participants/' + linkedId).update({
        rolePreference: 'active',
        status: 'waiting_s3',
        currentStation: 's3',
      });
      await db.ref('/occupancy/s3').transaction(v => (v || 0) + 1);
      await sendWA(from,
        `Thank you. You have been registered as willing to take an active role.\n\nPlease take a seat and wait for your appointment. You will receive further instructions here.`
      );
    } else if (body === 'NO' || body === 'N') {
      await db.ref('/participants/' + linkedId).update({
        rolePreference: 'observer',
        status: 'waiting_s3',
        currentStation: 's3',
      });
      await db.ref('/occupancy/s3').transaction(v => (v || 0) + 1);
      await sendWA(from,
        `Thank you. You have been registered as a pure observer.\n\nPlease take a seat and wait for your appointment. You will receive further instructions here.`
      );
    } else {
      await sendWA(from, `Please reply *YES* or *NO*.`);
    }
    res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
  }

  // General replies — acknowledge
  await sendWA(from, `Stand by. Instructions will follow.`);
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// ── SEND INSTRUCTION TO PARTICIPANT (called from Firebase trigger) ─
// This endpoint is called by a Firebase Cloud Function or by the admin
// posting to it directly
app.post('/send', async (req, res) => {
  const { pid, message } = req.body;
  if (!pid || !message) { res.status(400).json({ error: 'pid and message required' }); return; }

  const pSnap = await db.ref('/participants/' + pid).once('value');
  const p = pSnap.val();
  if (!p?.phone) { res.json({ sent: false, reason: 'no phone linked' }); return; }

  await sendWA(p.phone, message);
  res.json({ sent: true });
});

// ── BROADCAST ─────────────────────────────────────────────────
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

// ── FIREBASE LISTENER — watch for instruction changes ─────────
// Watches /participants and sends WA when instruction changes
function watchParticipants() {
  if (!db) return;
  db.ref('/participants').on('child_changed', async snap => {
    const p = snap.val();
    if (!p?.phone || !p?.instruction || !p?.instructionAt) return;

    // Only send if instruction changed recently (within 10 seconds)
    if (Date.now() - p.instructionAt > 10000) return;

    await sendWA(p.phone, p.instruction);
  });
  console.log('Watching Firebase participants for instruction changes...');
}

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'GA WhatsApp Bot', uptime: process.uptime() });
});

// ── KEEPALIVE (pinged by UptimeRobot every 5 min) ─────────────
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: new Date().toISOString() });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GA WhatsApp Bot running on port ${PORT}`);
  watchParticipants();
});
