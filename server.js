// CrewCue — tally, cues and pop-up alerts for vMix camera crews.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import webpush from 'web-push';
import { VmixTally } from './lib/vmix.js';
import { Store } from './lib/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const configPath = path.join(ROOT, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), configPath);
  console.log('Created config.json from config.example.json — edit it to match your vMix inputs.');
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const cameras = config.cameras;
const camById = new Map(cameras.map((c) => [c.id, c]));
const auto = { live: true, standby: true, clear: true, standbyDelayMs: 1500, ...(config.autoAlerts || {}) };

// ---------- push ----------
const store = new Store(path.join(ROOT, 'data'));
const vapid = store.vapidKeys();
webpush.setVapidDetails(config.contactEmail || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

async function pushTo(target, payload, { ttl = 60 } = {}) {
  const subs = store.subsFor(target);
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' })
    )
  );
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') return sent++;
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) {
      store.removeSub(subs[i].subscription.endpoint); // phone uninstalled / permission revoked
    } else {
      console.warn(`[push] ${subs[i].operator || '?'} (${subs[i].cameraId}): ${r.reason?.message || r.reason}`);
    }
  });
  return { sent, total: subs.length };
}

// ---------- live state ----------
const tallyState = new Map(cameras.map((c) => [c.id, 'off']));
const cues = []; // recent cues, newest last
const standbyTimers = new Map();
const clients = new Set(); // { ws, role, cameraId, operator }

const now = () => Date.now();
const newId = () => crypto.randomBytes(6).toString('hex');

function snapshot() {
  return {
    type: 'state',
    vmix: vmix.connected,
    cameras: cameras.map((c) => ({
      ...c,
      tally: tallyState.get(c.id),
      online: [...clients].filter((x) => x.role === 'operator' && x.cameraId === c.id).map((x) => x.operator),
      pushDevices: store.subsFor(c.id).length,
    })),
    cues: cues.slice(-30),
  };
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(msg, filter = () => true) {
  for (const c of clients) if (filter(c)) send(c.ws, msg);
}
const toDirectors = (msg) => broadcast(msg, (c) => c.role === 'director');
const toCamera = (cameraId, msg) =>
  broadcast(msg, (c) => c.role === 'operator' && (cameraId === 'all' || c.cameraId === cameraId));
const pushState = () => toDirectors(snapshot());

async function sendCue({ target, text, kind = 'cue' }) {
  text = String(text || '').trim().slice(0, 120);
  if (!text || (target !== 'all' && !camById.has(target))) return null;
  const cue = { id: newId(), target, text, kind, ts: now(), acks: [] };
  if (kind === 'cue') {
    cues.push(cue);
    if (cues.length > 100) cues.shift();
  }
  toCamera(target, { type: 'cue', cue });

  const camName = target === 'all' ? 'All cameras' : camById.get(target).name;
  const payload =
    kind === 'cue'
      ? { title: text, body: camName, cueId: cue.id, cameraId: target, tag: `cue-${cue.id}` }
      : { title: text, body: camName, cameraId: target, tag: `tally-${target}` }; // tally alerts replace each other
  const res = await pushTo(target, payload, { ttl: kind === 'cue' ? 60 : 15 });
  cue.delivered = res;
  if (kind === 'cue') pushState();
  return cue;
}

function recordAck(cueId, cameraId, operator) {
  const cue = cues.find((c) => c.id === cueId);
  if (!cue) return;
  if (!cue.acks.some((a) => a.cameraId === cameraId && a.operator === operator)) {
    cue.acks.push({ cameraId, operator, ts: now() });
    pushState();
  }
}

// ---------- vMix ----------
const vmix = new VmixTally(config.vmix);
vmix.on('status', (up) => {
  console.log(up ? `[vmix] connected to ${vmix.host}:${vmix.port}` : '[vmix] disconnected — retrying…');
  pushState();
});
vmix.on('tally', () => {
  for (const cam of cameras) {
    const prev = tallyState.get(cam.id);
    const next = vmix.stateOf(cam.input);
    if (prev === next) continue;
    tallyState.set(cam.id, next);
    toCamera(cam.id, { type: 'tally', cameraId: cam.id, tally: next });

    clearTimeout(standbyTimers.get(cam.id));
    if (next === 'live' && auto.live) {
      sendCue({ target: cam.id, text: "🔴 YOU'RE LIVE", kind: 'auto' });
    } else if (next === 'preview' && auto.standby) {
      // Wait a moment so flicking through preview doesn't spam the crew.
      standbyTimers.set(
        cam.id,
        setTimeout(() => {
          if (tallyState.get(cam.id) === 'preview')
            sendCue({ target: cam.id, text: "🟢 STAND BY — you're next", kind: 'auto' });
        }, auto.standbyDelayMs)
      );
    } else if (prev === 'live' && auto.clear) {
      sendCue({ target: cam.id, text: '⚪ Clear — you are off air', kind: 'auto' });
    }
  }
  pushState();
});
vmix.start();

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

const crewOk = (code) => !config.crewCode || code === config.crewCode;

app.get('/api/public-config', (req, res) => {
  if (!crewOk(req.query.code)) return res.status(403).json({ error: 'Wrong crew code' });
  res.json({
    cameras: cameras.map(({ id, name }) => ({ id, name })),
    replies: config.replies || [],
    vapidPublicKey: vapid.publicKey,
  });
});

app.post('/api/subscribe', (req, res) => {
  const { code, subscription, cameraId, operator } = req.body || {};
  if (!crewOk(code)) return res.status(403).json({ error: 'Wrong crew code' });
  if (!subscription?.endpoint || !camById.has(cameraId))
    return res.status(400).json({ error: 'Bad subscription or camera' });
  store.upsertSub({ subscription, cameraId, operator: String(operator || '').slice(0, 40) });
  pushState();
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  if (req.body?.endpoint) store.removeSub(req.body.endpoint);
  pushState();
  res.json({ ok: true });
});

app.post('/api/test-push', async (req, res) => {
  const { code, endpoint } = req.body || {};
  if (!crewOk(code)) return res.status(403).json({ error: 'Wrong crew code' });
  const sub = store.subs.find((s) => s.subscription.endpoint === endpoint);
  if (!sub) return res.status(404).json({ error: 'This phone is not registered yet' });
  try {
    await webpush.sendNotification(
      sub.subscription,
      JSON.stringify({ title: '✅ Test alert', body: 'Pop-ups are working on this phone', tag: 'test' }),
      { TTL: 30, urgency: 'high' }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Called by the service worker when an operator taps a cue notification.
app.post('/api/ack', (req, res) => {
  const { code, cueId, cameraId, operator } = req.body || {};
  if (!crewOk(code)) return res.status(403).json({ error: 'Wrong crew code' });
  recordAck(cueId, cameraId, String(operator || '').slice(0, 40));
  res.json({ ok: true });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const client = { ws, role: null };
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      if (msg.role === 'director') {
        if (String(msg.pin) !== String(config.directorPin))
          return send(ws, { type: 'error', message: 'Wrong director PIN' });
        Object.assign(client, { role: 'director' });
        clients.add(client);
        send(ws, { type: 'welcome', role: 'director', cues: config.cues, replies: config.replies });
        return send(ws, snapshot());
      }
      if (msg.role === 'operator') {
        if (!crewOk(msg.code)) return send(ws, { type: 'error', message: 'Wrong crew code' });
        if (!camById.has(msg.cameraId)) return send(ws, { type: 'error', message: 'Unknown camera' });
        Object.assign(client, {
          role: 'operator',
          cameraId: msg.cameraId,
          operator: String(msg.operator || 'Operator').slice(0, 40),
        });
        clients.add(client);
        send(ws, { type: 'welcome', role: 'operator' });
        send(ws, { type: 'tally', cameraId: msg.cameraId, tally: tallyState.get(msg.cameraId) });
        return pushState();
      }
      return;
    }

    if (client.role === 'director' && msg.type === 'cue') {
      const cue = await sendCue({ target: msg.target, text: msg.text });
      if (!cue) send(ws, { type: 'error', message: 'Could not send cue' });
      return;
    }

    if (client.role === 'operator') {
      if (msg.type === 'ack') return recordAck(msg.cueId, client.cameraId, client.operator);
      if (msg.type === 'reply') {
        const text = String(msg.text || '').trim().slice(0, 120);
        if (text)
          toDirectors({ type: 'reply', cameraId: client.cameraId, operator: client.operator, text, ts: now() });
      }
    }
  });

  ws.on('close', () => {
    const wasOperator = client.role === 'operator';
    clients.delete(client);
    if (wasOperator) pushState();
  });
});

// Drop dead connections (phones that went to sleep, lost Wi-Fi…)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(config.port || 3000, () => {
  const port = config.port || 3000;
  console.log(`\nCrewCue running`);
  console.log(`  Director console : http://localhost:${port}/director`);
  console.log(`  Operator app     : https://<your-public-https-url>/   (must be HTTPS for iPhone pop-ups)`);
  console.log(`  vMix             : ${config.vmix?.host || '127.0.0.1'}:${config.vmix?.tcpPort || 8099}\n`);
});
