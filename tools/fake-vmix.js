// Pretends to be vMix's TCP API so you can rehearse without vMix running.
// Usage: npm run fake-vmix   then type a number + Enter to cut that input to LIVE,
//        "p 3" to put input 3 on preview, or "auto" to cycle cameras every 4 seconds.
import net from 'node:net';
import readline from 'node:readline';

const PORT = Number(process.env.PORT || 8099);
const INPUTS = 6;
let program = 1, preview = 2, timer;
const clients = new Set();

const tally = () => Array.from({ length: INPUTS }, (_, i) => (i + 1 === program ? '1' : i + 1 === preview ? '2' : '0')).join('');
const emit = () => {
  for (const c of clients) c.write(`TALLY OK ${tally()}\r\n`);
  console.log(`program=${program} preview=${preview}  (${tally()})`);
};

net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 2);
      if (line === 'SUBSCRIBE TALLY') { clients.add(sock); sock.write('SUBSCRIBE OK TALLY\r\n'); }
      else if (line === 'TALLY') sock.write(`TALLY OK ${tally()}\r\n`);
    }
  });
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => {});
}).listen(PORT, () => console.log(`Fake vMix TCP API on port ${PORT}. Type 1-${INPUTS}, "p N", or "auto".`));

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  l = l.trim();
  if (l === 'auto') {
    clearInterval(timer);
    timer = setInterval(() => { [program, preview] = [preview, (preview % 4) + 1 === preview ? 1 : (preview % 4) + 1]; emit(); }, 4000);
    return;
  }
  const p = /^p\s*(\d+)$/.exec(l);
  if (p) { preview = Number(p[1]); return emit(); }
  if (/^\d+$/.test(l)) { preview = program; program = Number(l); emit(); }
});
