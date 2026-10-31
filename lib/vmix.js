// Connects to the vMix TCP API (default port 8099) and subscribes to tally.
// vMix sends "TALLY OK 0120..." — one digit per input, starting at input 1:
//   0 = off, 1 = program (live), 2 = preview.
import net from 'node:net';
import { EventEmitter } from 'node:events';

export class VmixTally extends EventEmitter {
  constructor({ host = '127.0.0.1', tcpPort = 8099 } = {}) {
    super();
    this.host = host;
    this.port = tcpPort;
    this.connected = false;
    this.tally = '';
    this.buffer = '';
    this.retryMs = 2000;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    this.socket?.destroy();
  }

  #connect() {
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.socket = sock;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 5000);

    sock.on('connect', () => {
      this.connected = true;
      this.buffer = '';
      this.emit('status', true);
      sock.write('SUBSCRIBE TALLY\r\n');
      sock.write('TALLY\r\n'); // ask for the current state right away
    });

    sock.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 2);
        this.#handleLine(line);
      }
    });

    const onDown = () => {
      if (this.socket !== sock) return;
      if (this.connected) {
        this.connected = false;
        this.emit('status', false);
      }
      if (!this.stopped) setTimeout(() => this.#connect(), this.retryMs);
    };
    sock.on('error', () => {}); // 'close' follows and handles reconnect
    sock.on('close', onDown);
  }

  #handleLine(line) {
    const m = /^TALLY OK (\d*)$/.exec(line);
    if (!m) return;
    if (m[1] !== this.tally) {
      this.tally = m[1];
      this.emit('tally', this.tally);
    }
  }

  /** State of a 1-based vMix input number: 'live' | 'preview' | 'off' */
  stateOf(input) {
    const c = this.tally[input - 1];
    return c === '1' ? 'live' : c === '2' ? 'preview' : 'off';
  }
}
