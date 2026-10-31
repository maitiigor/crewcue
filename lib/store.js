// Tiny JSON-file persistence for VAPID keys and push subscriptions.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.subsFile = path.join(dir, 'subscriptions.json');
    this.subs = this.#read(this.subsFile, []);
  }

  #read(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  #write(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  /** VAPID keys are generated once and reused so installed phones keep working. */
  vapidKeys() {
    const file = path.join(this.dir, 'vapid.json');
    let keys = this.#read(file, null);
    if (!keys) {
      keys = webpush.generateVAPIDKeys();
      this.#write(file, keys);
    }
    return keys;
  }

  upsertSub({ subscription, cameraId, operator }) {
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
    this.subs.push({ subscription, cameraId, operator, addedAt: Date.now() });
    this.#write(this.subsFile, this.subs);
  }

  removeSub(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.subscription.endpoint !== endpoint);
    if (this.subs.length !== before) this.#write(this.subsFile, this.subs);
  }

  subsFor(cameraId) {
    return cameraId === 'all' ? this.subs : this.subs.filter((s) => s.cameraId === cameraId);
  }
}
