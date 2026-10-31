// CrewCue director console
const $ = (s, el = document) => el.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let ws, pin = store.get('crewcue.pin'), cueList = [], built = false, retry;
const cards = new Map();
const camNames = new Map([['all', 'All cameras']]);

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => e.append(k));
  return e;
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  pin = $('#pin').value.trim();
  connect();
});
if (pin) connect();

function connect() {
  clearTimeout(retry);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setDot('ws', true, 'Server');
    ws.send(JSON.stringify({ type: 'hello', role: 'director', pin }));
  };
  ws.onclose = () => {
    setDot('ws', false, 'Server offline — reconnecting');
    if (pin) retry = setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
}

function handle(msg) {
  if (msg.type === 'error') {
    if (/PIN/.test(msg.message)) {
      store.del('crewcue.pin');
      pin = null;
      $('#loginErr').textContent = msg.message;
      $('#loginErr').classList.remove('hidden');
      $('#login').classList.remove('hidden');
      $('#app').classList.add('hidden');
      ws.close();
    } else toast(msg.message);
    return;
  }
  if (msg.type === 'welcome') {
    store.set('crewcue.pin', pin);
    cueList = msg.cues || [];
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    return;
  }
  if (msg.type === 'state') return renderState(msg);
  if (msg.type === 'reply') return addReply(msg);
}

function setDot(which, ok, text) {
  $(`#${which}Dot`).className = 'dot ' + (ok ? 'ok' : 'bad');
  $(`#${which}Text`).textContent = text;
}

function sendCue(target, text) {
  if (!text || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'cue', target, text }));
}

function buildCard(cam) {
  const isAll = cam.id === 'all';
  const badge = el('span', { className: 'badge' });
  const meta = el('div', { className: 'cam-meta' });
  const input = el('input', { placeholder: 'Type a message…', maxLength: 120 });
  const go = () => { sendCue(cam.id, input.value.trim()); input.value = ''; };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const card = el(
    'div',
    { className: 'card cam' + (isAll ? ' all' : '') },
    el('div', { className: 'cam-top' }, el('h2', { textContent: cam.name }), isAll ? '' : badge),
    meta,
    el('div', { className: 'cues' }, cueList.map((c) => el('button', { textContent: c, onclick: () => sendCue(cam.id, c) }))),
    el('div', { className: 'custom' }, input, el('button', { className: 'primary', textContent: 'Send', onclick: go }))
  );
  cards.set(cam.id, { card, badge, meta });
  return card;
}

function renderState(s) {
  setDot('vmix', s.vmix, s.vmix ? 'vMix connected' : 'vMix not connected');
  if (!built) {
    const root = $('#cams');
    root.innerHTML = '';
    root.append(buildCard({ id: 'all', name: 'All cameras' }));
    s.cameras.forEach((c) => { camNames.set(c.id, c.name); root.append(buildCard(c)); });
    built = true;
  }
  let totalOnline = 0, totalPush = 0;
  for (const c of s.cameras) {
    const ref = cards.get(c.id);
    if (!ref) continue;
    ref.card.classList.toggle('live', c.tally === 'live');
    ref.card.classList.toggle('preview', c.tally === 'preview');
    ref.badge.className = 'badge ' + c.tally;
    ref.badge.textContent = c.tally === 'live' ? 'LIVE' : c.tally === 'preview' ? 'PREVIEW' : `INPUT ${c.input}`;
    const who = c.online.length ? `Open now: ${c.online.join(', ')}` : 'App not open';
    const push = c.pushDevices ? `${c.pushDevices} phone${c.pushDevices > 1 ? 's get' : ' gets'} pop-ups` : '⚠ no phone registered for pop-ups';
    ref.meta.textContent = `vMix input ${c.input} · ${push} · ${who}`;
    totalOnline += c.online.length;
    totalPush += c.pushDevices;
  }
  cards.get('all').meta.textContent = `${totalPush} phone${totalPush === 1 ? '' : 's'} registered for pop-ups · ${totalOnline} with the app open`;
  renderLog(s.cues);
}

function renderLog(cues) {
  const log = $('#log');
  if (!cues.length) return;
  log.innerHTML = '';
  [...cues].reverse().forEach((c) => {
    const d = c.delivered;
    const delivered = d ? `${d.sent}/${d.total} pop-ups sent` : 'sending…';
    const acks = c.acks.length ? ` · ✓ ${c.acks.map((a) => a.operator || camNames.get(a.cameraId)).join(', ')}` : '';
    log.append(
      el('div', { className: 'item' },
        el('strong', { textContent: c.text }),
        el('small', { textContent: `${camNames.get(c.target) || c.target} · ${fmtTime(c.ts)} · ${delivered}` }),
        acks ? el('small', { className: 'acks', textContent: acks.slice(3) }) : '')
    );
  });
}

function addReply(r) {
  const box = $('#replies');
  if (box.querySelector('p')) box.innerHTML = '';
  box.prepend(
    el('div', { className: 'item reply fresh' },
      el('strong', { textContent: r.text }),
      el('small', { textContent: `${camNames.get(r.cameraId) || r.cameraId} · ${r.operator} · ${fmtTime(r.ts)}` }))
  );
  if ($('#soundToggle').checked) beep();
}

let actx;
function beep() {
  try {
    actx ||= new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.2, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
    o.connect(g).connect(actx.destination);
    o.start();
    o.stop(actx.currentTime + 0.4);
  } catch {}
}

let toastTimer;
function toast(t) {
  let n = $('.toast');
  if (!n) document.body.append((n = el('div', { className: 'toast' })));
  n.textContent = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.remove(), 3000);
}
