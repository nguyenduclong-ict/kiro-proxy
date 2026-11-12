/** Writes one row per proxied request, plus bodies when capture is on. Never throws into the request path. */
export class Recorder {
  constructor(store, log) {
    this.store = store;
    this.log = log;
  }

  record(row, bodies) {
    try {
      const id = this.store.insertRequest(row);
      if (bodies && this.store.getSettings().capture_bodies) this.store.insertBody(id, row.ts, bodies);
      return id;
    } catch (err) {
      this.log?.error?.({ err }, 'failed to record request');
      return null;
    }
  }
}
