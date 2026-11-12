import { crc32 } from 'node:zlib';

/**
 * Incremental decoder for the AWS EventStream binary framing Kiro streams back.
 * Frame: total_len(u32) headers_len(u32) prelude_crc(u32) headers payload message_crc(u32)
 */
export class EventStreamDecoder {
  constructor(maxFrameBytes = 16 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b;
    const events = [];
    while (this.buf.length >= 12) {
      const total = this.buf.readUInt32BE(0);
      const headersLen = this.buf.readUInt32BE(4);
      if (crc32(this.buf.subarray(0, 8)) !== this.buf.readUInt32BE(8)) throw new Error('EventStream prelude CRC mismatch');
      if (total < 16 || total > this.maxFrameBytes || headersLen > total - 16) throw new Error(`Invalid EventStream frame length ${total}`);
      if (this.buf.length < total) break;
      const frame = this.buf.subarray(0, total);
      if (crc32(frame.subarray(0, total - 4)) !== frame.readUInt32BE(total - 4)) throw new Error('EventStream message CRC mismatch');
      events.push(toEvent(parseHeaders(frame.subarray(12, 12 + headersLen)), frame.subarray(12 + headersLen, total - 4)));
      this.buf = Buffer.from(this.buf.subarray(total));
    }
    return events;
  }

  get pendingBytes() {
    return this.buf.length;
  }
}

function parseHeaders(h) {
  const out = {};
  let i = 0;
  while (i < h.length) {
    const nameLen = h[i];
    const name = h.toString('utf8', i + 1, i + 1 + nameLen);
    i += 1 + nameLen;
    const type = h[i++];
    let value;
    switch (type) {
      case 0: value = true; break;
      case 1: value = false; break;
      case 2: value = h.readInt8(i); i += 1; break;
      case 3: value = h.readInt16BE(i); i += 2; break;
      case 4: value = h.readInt32BE(i); i += 4; break;
      case 5: case 8: value = h.readBigInt64BE(i); i += 8; break;
      case 6: case 7: {
        const len = h.readUInt16BE(i);
        const bytes = h.subarray(i + 2, i + 2 + len);
        value = type === 7 ? bytes.toString('utf8') : Buffer.from(bytes);
        i += 2 + len;
        break;
      }
      case 9: value = h.subarray(i, i + 16).toString('hex'); i += 16; break;
      default: throw new Error(`Unknown EventStream header type ${type}`);
    }
    out[name] = value;
  }
  return out;
}

function toEvent(headers, payloadBuf) {
  const text = payloadBuf.toString('utf8');
  let payload = text;
  try { payload = text ? JSON.parse(text) : {}; } catch { /* keep text */ }
  const messageType = headers[':message-type'] || 'event';
  const type = headers[':event-type'] || headers[':exception-type'] || headers[':error-code'] || 'unknown';
  return { messageType, type, payload, headers };
}

export function eventErrorMessage(ev) {
  const p = ev.payload;
  const msg = (p && typeof p === 'object' && (p.message || p.Message)) || (typeof p === 'string' ? p : '') || ev.headers?.[':error-message'] || '';
  return `${ev.type}: ${msg}`.slice(0, 2000);
}

/** Encoder with string headers only. Used by tests to build fixtures. */
export function encodeFrame(headers, payload) {
  const hparts = [];
  for (const [name, value] of Object.entries(headers)) {
    const n = Buffer.from(name);
    const v = Buffer.from(String(value));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(v.length);
    hparts.push(Buffer.from([n.length]), n, Buffer.from([7]), len, v);
  }
  const hbuf = Buffer.concat(hparts);
  const pbuf = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const total = 12 + hbuf.length + pbuf.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(hbuf.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const body = Buffer.concat([prelude, hbuf, pbuf]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([body, crc]);
}

export function encodeEvent(eventType, payload) {
  return encodeFrame({ ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' }, payload);
}
