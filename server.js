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
    // Not linked yet — check if greeting or ID
    const looksLikeId = /^[A-Z0-9]{4,10}$/.test(body);
    if (!looksLikeId) {
      await sendWA(from, `⚕️ Welcome to General Anesthesia ⚕️\n\nYou are now connected. Please type in your ID code.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Looks like an ID — try to match
    const allowedSnap = await db.ref('/allowedIds/' + body).once('value');
    if (!allowedSnap.exists()) {
      await sendWA(from, `ID not recognised. Please check your code and try again.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Check participant exists (must be registered by nurse first)
    const pSnap = await db.ref('/participants/' + body).once('value');
    const pData = pSnap.val();
    if (!pData) {
      await sendWA(from, `Your ID is valid but you have not been checked in yet. Please see the nurse at reception first.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Check if ID already linked to another phone
    if (pData.phone && pData.phone !== from) {
      await sendWA(from, `This ID is already registered on another device. Please ask staff for help.`);
      res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
    }

    // Link phone to ID
    await db.ref('/phoneIndex/' + from.replace('+', '')).set(body);
    await db.ref('/participants/' + body).update({ phone: from, whatsappLinked: true });
    await sendWA(from, `Thank you. Please take a seat and wait for your appointment. You'll be receiving notifications via WhatsApp. You can also decide to receive them in the GA phone app`);

    res.set('Content-Type', 'text/xml').send('<Response></Response>'); return;
  }

  // Phone is linked — handle replies
  const pSnap = await db.ref('/participants/' + linkedId).once('value');
  const pData = pSnap.val();
  if (!pData) { res.set('Content-Type', 'text/xml').send('<Response></Response>'); return; }

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
