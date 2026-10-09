/*
 * Minimal CBOR (RFC 8949) codec for the ISO/IEC 18013-5 reader: definite-length
 * encoding with shortest heads, Map/array/byte string/text/int/float/tags, and
 * decoding of definite and indefinite items. Works in browsers and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CBOR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class Tag {
    constructor(tag, value) {
      this.tag = tag;
      this.value = value;
    }
  }

  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder('utf-8', { fatal: true });

  function concat(chunks) {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /* ----------------------------------------------------------- encode */

  function head(major, n) {
    const m = major << 5;
    if (typeof n === 'bigint') {
      const b = new Uint8Array(9);
      b[0] = m | 27;
      new DataView(b.buffer).setBigUint64(1, n);
      return b;
    }
    if (n < 24) return Uint8Array.of(m | n);
    if (n < 0x100) return Uint8Array.of(m | 24, n);
    if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
    if (n < 0x100000000) return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    const b = new Uint8Array(9);
    b[0] = m | 27;
    new DataView(b.buffer).setBigUint64(1, BigInt(n));
    return b;
  }

  function encodeItem(v, out) {
    if (v === null) return out.push(Uint8Array.of(0xf6));
    if (v === undefined) return out.push(Uint8Array.of(0xf7));
    if (v === false) return out.push(Uint8Array.of(0xf4));
    if (v === true) return out.push(Uint8Array.of(0xf5));
    if (typeof v === 'number') {
      if (Number.isInteger(v)) return out.push(v >= 0 ? head(0, v) : head(1, -1 - v));
      const b = new Uint8Array(9);
      b[0] = 0xfb;
      new DataView(b.buffer).setFloat64(1, v);
      return out.push(b);
    }
    if (typeof v === 'bigint') return out.push(v >= 0n ? head(0, v) : head(1, -1n - v));
    if (typeof v === 'string') {
      const bytes = utf8.encode(v);
      out.push(head(3, bytes.length));
      return out.push(bytes);
    }
    if (v instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer)) {
      const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
      out.push(head(2, bytes.length));
      return out.push(Uint8Array.from(bytes));
    }
    if (v instanceof Tag) {
      out.push(head(6, v.tag));
      return encodeItem(v.value, out);
    }
    if (Array.isArray(v)) {
      out.push(head(4, v.length));
      for (const item of v) encodeItem(item, out);
      return undefined;
    }
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
    out.push(head(5, entries.length));
    for (const [k, val] of entries) {
      encodeItem(k, out);
      encodeItem(val, out);
    }
    return undefined;
  }

  function encode(value) {
    const out = [];
    encodeItem(value, out);
    return concat(out);
  }

  /* ----------------------------------------------------------- decode */

  function decode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    const BREAK = Symbol('break');

    function need(n) {
      if (pos + n > bytes.length) throw new Error('CBOR: unexpected end of data');
    }
    function argument(info) {
      if (info < 24) return info;
      if (info === 24) { need(1); return bytes[pos++]; }
      if (info === 25) { need(2); const v = view.getUint16(pos); pos += 2; return v; }
      if (info === 26) { need(4); const v = view.getUint32(pos); pos += 4; return v; }
      if (info === 27) {
        need(8);
        const v = view.getBigUint64(pos);
        pos += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      if (info === 31) return -1; // indefinite
      throw new Error(`CBOR: invalid additional info ${info}`);
    }
    function halfFloat(h) {
      const exp = (h >> 10) & 0x1f;
      const mant = h & 0x3ff;
      const sign = h & 0x8000 ? -1 : 1;
      if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
      if (exp === 31) return mant ? NaN : sign * Infinity;
      return sign * 2 ** (exp - 15) * (1 + mant / 1024);
    }
    function chunks(major) {
      const parts = [];
      for (;;) {
        const item = next();
        if (item === BREAK) break;
        parts.push(major === 2 ? item : utf8.encode(item));
      }
      const all = concat(parts);
      return major === 2 ? all : utf8d.decode(all);
    }
    function next() {
      need(1);
      const ib = bytes[pos++];
      const major = ib >> 5;
      const info = ib & 0x1f;
      if (ib === 0xff) return BREAK;
      switch (major) {
        case 0: return argument(info);
        case 1: {
          const n = argument(info);
          return typeof n === 'bigint' ? -1n - n : -1 - n;
        }
        case 2:
        case 3: {
          const len = argument(info);
          if (len === -1) return chunks(major);
          need(len);
          const slice = bytes.slice(pos, pos + len);
          pos += len;
          return major === 2 ? slice : utf8d.decode(slice);
        }
        case 4: {
          const len = argument(info);
          const arr = [];
          if (len === -1) {
            for (let item = next(); item !== BREAK; item = next()) arr.push(item);
          } else {
            for (let i = 0; i < len; i += 1) arr.push(next());
          }
          return arr;
        }
        case 5: {
          const len = argument(info);
          const map = new Map();
          if (len === -1) {
            for (let k = next(); k !== BREAK; k = next()) map.set(k, next());
          } else {
            for (let i = 0; i < len; i += 1) {
              const k = next();
              map.set(k, next());
            }
          }
          return map;
        }
        case 6: {
          const tag = argument(info);
          return new Tag(tag, next());
        }
        default: {
          if (info === 20) return false;
          if (info === 21) return true;
          if (info === 22) return null;
          if (info === 23) return undefined;
          if (info === 25) { need(2); const v = halfFloat(view.getUint16(pos)); pos += 2; return v; }
          if (info === 26) { need(4); const v = view.getFloat32(pos); pos += 4; return v; }
          if (info === 27) { need(8); const v = view.getFloat64(pos); pos += 8; return v; }
          if (info < 24) return { simple: info };
          if (info === 24) { need(1); return { simple: bytes[pos++] }; }
          throw new Error(`CBOR: unsupported simple value ${info}`);
        }
      }
    }
    const value = next();
    if (pos !== bytes.length) throw new Error('CBOR: trailing bytes');
    return value;
  }

  /** Reads a key from a decoded map (Map or object). */
  function get(m, key) {
    if (m instanceof Map) return m.get(key);
    return m ? m[key] : undefined;
  }

  return { encode, decode, Tag, get, concat };
}));
