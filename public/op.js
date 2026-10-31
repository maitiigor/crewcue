// CrewCue operator app (PWA)
const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let me = store.get('crewcue.me'); // { code, name, cameraId, cameraName }
let cfg = null, ws, retry, currentCue = null, tally = 'off', autoCueFor = null, speak = !!store.get('crewcue.speak'), wakeLock = null;

const show = (id) => ['install', 'setup', 'main'].forEach((x) => $('#' + x).classList.toggle('hidden', x !== id));

// ---------- boot ----------
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (isIOS && !isStandalone) return show('install');
  if (!me) return showSetup();
  try {
    cfg = await fetchConfig(me.code);
  } catch {
    return showSetup();
  }
  startMain();
})();

async function fetchConfig(code) {
  const r = await fetch('/api/public-config?code=' + encodeURIComponent(code));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Cannot reach server');
  return r.json();
}

// ---------- setup ----------
function showSetup() {
  show('setup');
  if (me) { $('#code').value = me.code; $('#name').value = me.name; }
  if ($('#code').value) loadCameras();
}
let codeTimer;
$('#code').addEventListener('input', () => { clearTimeout(codeTimer); codeTimer = setTimeout(loadCameras, 400); });

async function loadCameras() {
  const sel = $('#camera'), err = $('#setupErr');
  err.classList.add('hidden');
  try {
    cfg = await fetchConfig($('#code').value.trim());
    sel.innerHTML = '';
    cfg.cameras.forEach((c) => sel.append(new Option(c.name, c.id)));
    if (me?.cameraId) sel.value = me.cameraId;
    sel.disabled = false;
  } catch (e) {
    sel.disabled = true;
    sel.innerHTML = '<option>Enter crew code first…</option>';
    if ($('#code').value.trim()) { err.textContent = e.message; err.classList.remove('hidden'); }
  }
}

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!cfg) return loadCameras();
  const sel = $('#camera');
  me = {
    code: $('#code').value.trim(),
    name: $('#name').value.trim(),
    cameraId: sel.value,
    cameraName: sel.options[sel.selectedIndex].text,
  };
  store.set('crewcue.me', me);
  ws?.close();
  startMain();
  // If this phone already gets pop-ups, move them to the newly chosen camera.
  const sub = await currentSub();
  if (sub) registerSub(sub);
});

// ---------- main ----------
function startMain() {
  show('main');
  $('#camName').textContent = me.cameraName;
  renderReplies();
  refreshPushUI();
  updateToggles();
  connect();
  const ack = new URLSearchParams(location.search).get('ack');
  if (ack) { sendAck(ack); history.replaceState(null, '', '/'); }
}

function connect() {
  clearTimeout(retry);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = (ws = new WebSocket(`${proto}://${location.host}/ws`));
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'hello', role: 'operator', code: me.code, cameraId: me.cameraId, operator: me.name }));
    $('#connDot').className = 'dot ok';
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    $('#connDot').className = 'dot bad';
    retry = setTimeout(connect, 1500);
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'tally') setTally(msg.tally);
    else if (msg.type === 'cue') showCue(msg.cue);
    else if (msg.type === 'error') { toast(msg.message); if (/crew code|camera/i.test(msg.message)) { ws = null; sock.close(); showSetup(); } }
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!ws || ws.readyState > 1) connect();
    if (wakeLock === 'wanted') requestWake();
  }
});
navigator.serviceWorker?.addEventListener('message', (e) => e.data?.type === 'ack' && sendAck(e.data.cueId));

function setTally(t) {
  const main = $('#main');
  main.classList.toggle('live', t === 'live');
  main.classList.toggle('preview', t === 'preview');
  $('#tallyText').textContent = t === 'live' ? 'LIVE' : t === 'preview' ? 'STAND BY' : 'OFF AIR';
  tally = t;
  // An auto alert ("STAND BY — you're next", "YOU'RE LIVE") is stale once the tally moves on.
  if (autoCueFor && autoCueFor !== t) {
    autoCueFor = null;
    $('#cueText').textContent = '';
    $('#cueWhen').textContent = '';
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.getNotifications({ tag: `tally-${me?.cameraId}` }))
      .then((list) => list?.forEach((n) => n.close()))
      .catch(() => {});
  }
}

function showCue(cue) {
  autoCueFor = cue.kind === 'auto' ? tally : null;
  $('#cueText').textContent = cue.text;
  $('#cueWhen').textContent = (cue.target === 'all' ? 'To everyone · ' : '') + new Date(cue.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (cue.kind === 'cue') { currentCue = cue; $('#ackBtn').classList.remove('hidden'); $('#ackBtn').disabled = false; $('#ackBtn').textContent = 'Got it ✓'; }
  else { currentCue = null; $('#ackBtn').classList.add('hidden'); }
  navigator.vibrate?.([200, 100, 200]);
  if (document.visibilityState === 'visible') playCueTone();
  if (speak && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(cue.text.replace(/[^\p{L}\p{N}\s'’,.—-]/gu, '')));
  }
}

let cueAudioCtx;
function playCueTone() {
  try {
    cueAudioCtx ||= new AudioContext();
    if (cueAudioCtx.state === 'suspended') cueAudioCtx.resume().catch(() => {});
    const o = cueAudioCtx.createOscillator();
    const g = cueAudioCtx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(880, cueAudioCtx.currentTime);
    g.gain.setValueAtTime(0.0001, cueAudioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, cueAudioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, cueAudioCtx.currentTime + 0.55);
    o.connect(g).connect(cueAudioCtx.destination);
    o.start();
    o.stop(cueAudioCtx.currentTime + 0.6);
  } catch {}
}

$('#playCueBtn').addEventListener('click', () => {
  if (currentCue) playCueTone();
  else toast('No active cue yet');
});

$('#ackBtn').addEventListener('click', () => {
  if (!currentCue) return;
  sendAck(currentCue.id);
  $('#ackBtn').disabled = true;
  $('#ackBtn').textContent = 'Sent ✓';
});

function sendAck(cueId) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'ack', cueId }));
  else fetch('/api/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: me.code, cueId, cameraId: me.cameraId, operator: me.name }) }).catch(() => {});
}

function renderReplies() {
  const box = $('#replies');
  box.innerHTML = '';
  (cfg?.replies || []).forEach((text) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = () => {
      if (ws?.readyState !== 1) return toast('Not connected');
      ws.send(JSON.stringify({ type: 'reply', text }));
      toast('Sent to director');
    };
    box.append(b);
  });
}

// ---------- push ----------
async function currentSub() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushUI() {
  const banner = $('#pushBanner');
  if (!pushSupported) {
    banner.classList.remove('hidden');
    banner.innerHTML = '<strong>Pop-ups not supported here.</strong><div>Update to iOS 16.4+ and open CrewCue from the Home Screen, or use Chrome on Android.</div>';
    return;
  }
  const sub = await currentSub();
  const on = sub && Notification.permission === 'granted';
  banner.classList.toggle('hidden', !!on);
  $('#testPush').classList.toggle('hidden', !on);
  if (on) registerSub(sub); // keep the server's copy fresh
  if (Notification.permission === 'denied') {
    banner.innerHTML = '<strong>Notifications are blocked.</strong><div>iPhone: Settings → Notifications → CrewCue → Allow. Android: site settings → Notifications → Allow.</div>';
  }
}

$('#enablePush').addEventListener('click', async () => {
  try {
    const perm = await Notification.requestPermission(); // must run from a tap on iOS
    if (perm !== 'granted') return refreshPushUI();
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
    await registerSub(sub);
    toast('Pop-ups on ✓');
    refreshPushUI();
  } catch (e) {
    toast('Could not enable: ' + e.message);
  }
});

async function registerSub(sub) {
  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: me.code, subscription: sub.toJSON(), cameraId: me.cameraId, operator: me.name }),
  });
}

$('#testPush').addEventListener('click', async () => {
  const sub = await currentSub();
  if (!sub) return refreshPushUI();
  const r = await fetch('/api/test-push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: me.code, endpoint: sub.endpoint }) });
  toast(r.ok ? 'Test sent — check for a pop-up' : 'Test failed: ' + ((await r.json().catch(() => ({}))).error || r.status));
});

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ---------- toggles ----------
$('#speakBtn').addEventListener('click', () => {
  speak = !speak;
  store.set('crewcue.speak', speak);
  if (speak && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance('Cues will be spoken'));
  updateToggles();
});
$('#wakeBtn').addEventListener('click', async () => {
  if (wakeLock) { if (wakeLock !== 'wanted') await wakeLock.release().catch(() => {}); wakeLock = null; }
  else await requestWake();
  updateToggles();
});
async function requestWake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { if (wakeLock) wakeLock = 'wanted'; }); }
  catch { toast('This phone cannot keep the screen on from the browser'); wakeLock = null; }
}
function updateToggles() {
  $('#speakBtn').textContent = `🔈 Speak cues: ${speak ? 'on' : 'off'}`;
  $('#wakeBtn').textContent = `Keep screen on: ${wakeLock ? 'on' : 'off'}`;
}
$('#changeBtn').addEventListener('click', showSetup);

let toastTimer;
function toast(t) {
  let n = document.querySelector('.toast');
  if (!n) { n = document.createElement('div'); n.className = 'toast'; document.body.append(n); }
  n.textContent = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.remove(), 2500);
}
