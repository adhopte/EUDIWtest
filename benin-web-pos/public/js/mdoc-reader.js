/*
 * ISO/IEC 18013-5 mdoc reader for the browser (proximity flow):
 *
 *   1. device engagement   wallet QR code "mdoc:<base64url DeviceEngagement>"
 *   2. session encryption  EReaderKey (P-256) · ECDH with EDeviceKey · HKDF → SKReader / SKDevice
 *                          AES-256-GCM with the ISO IV (identifier ‖ counter), §9.1.1
 *   3. data retrieval      BLE, "mdoc peripheral server mode" (the browser is the GATT
 *                          central through Web Bluetooth), §8.3.3.1.1
 *   4. SessionTranscript = [DeviceEngagementBytes, EReaderKeyBytes, null] (QR handover),
 *                          sent with the DeviceResponse to the server for verification
 *
 * Same module in the browser (window.MdocReader) and in Node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cbor.js'), globalThis.crypto);
  else root.MdocReader = factory(root.CBOR, root.crypto);
}(typeof self !== 'undefined' ? self : this, function (CBOR, webcrypto) {
  'use strict';

  const { encode, decode, Tag, get, concat } = CBOR;
  const subtle = webcrypto.subtle;
  const utf8 = new TextEncoder();

  /** GATT characteristics, mdoc peripheral server mode (ISO/IEC 18013-5 Table 12). */
  const BLE = {
    STATE: '00000001-a123-48ce-896b-4c76973373e6',
    CLIENT2SERVER: '00000002-a123-48ce-896b-4c76973373e6',
    SERVER2CLIENT: '00000003-a123-48ce-896b-4c76973373e6',
    IDENT: '00000008-a123-48ce-896b-4c76973373e6'
  };
  const STATE_START = 0x01;
  const STATE_END = 0x02;

  /* ---------------------------------------------------------- helpers */

  function b64urlDecode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    if (typeof atob === 'function') return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  function b64urlEncode(bytes) {
    let s;
    if (typeof btoa === 'function') {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      s = btoa(bin);
    } else {
      s = Buffer.from(bytes).toString('base64');
    }
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  function uuidFromBytes(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16) return null;
    const h = hex(bytes);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const untag24 = (v) => {
    if (!(v instanceof Tag) || v.tag !== 24 || !(v.value instanceof Uint8Array)) throw new Error('expected an embedded CBOR item (tag 24)');
    return v.value;
  };

  /* ---------------------------------------------------- 1. engagement */

  const METHOD_NAMES = { 1: 'NFC', 2: 'BLE', 3: 'Wi-Fi Aware' };

  /**
   * Parses the wallet's QR code. Returns the exact DeviceEngagement bytes (they
   * go into the SessionTranscript), the EDeviceKey and the BLE options.
   */
  function parseEngagement(qrText) {
    const text = String(qrText || '').trim();
    const m = /^mdoc:(.+)$/i.exec(text);
    if (!m) throw new Error('not_mdoc_qr');
    const engagementBytes = b64urlDecode(m[1]);
    const de = decode(engagementBytes);
    const version = get(de, 0);
    const security = get(de, 1);
    if (!Array.isArray(security) || security[0] !== 1) throw new Error('unsupported_cipher_suite');
    const eDeviceKeyBytes = untag24(security[1]);
    const coseKey = decode(eDeviceKeyBytes);
    if (get(coseKey, 1) !== 2 || get(coseKey, -1) !== 1) throw new Error('unsupported_device_key (P-256 EC2 expected)');
    const eDeviceKeyJwk = { kty: 'EC', crv: 'P-256', x: b64urlEncode(get(coseKey, -2)), y: b64urlEncode(get(coseKey, -3)), ext: true };

    const methods = [];
    let ble = null;
    for (const method of get(de, 2) || []) {
      const [type, , options] = method;
      methods.push(METHOD_NAMES[type] || `type ${type}`);
      if (type === 2) {
        const psUuid = uuidFromBytes(get(options, 10));
        const ccUuid = uuidFromBytes(get(options, 11));
        ble = {
          peripheralServer: get(options, 0) === true,
          centralClient: get(options, 1) === true,
          peripheralServerUuid: psUuid,
          centralClientUuid: ccUuid,
          address: get(options, 20) instanceof Uint8Array ? hex(get(options, 20)).match(/../g).join(':') : null
        };
      }
    }
    return { version, engagementBytes, eDeviceKeyBytes, eDeviceKeyJwk, methods, ble };
  }

  /** Why this browser reader can (not) talk to the wallet; null when it can. */
  function bleCompatibility(engagement) {
    if (!engagement.ble) return 'no_ble';
    if (!engagement.ble.peripheralServer || !engagement.ble.peripheralServerUuid) return 'central_only';
    return null;
  }

  /* --------------------------------------------- 2. session encryption */

  function iv(identifier, counter) {
    const out = new Uint8Array(12);
    out[7] = identifier; // 0 = reader → mdoc, 1 = mdoc → reader
    new DataView(out.buffer).setUint32(8, counter);
    return out;
  }

  async function hkdfKey(ikm, salt, info, usage) {
    const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, usage);
  }

  /**
   * Creates the reader session for an engagement: fresh EReaderKey, the
   * SessionTranscript and the two session keys.
   */
  async function createSession(engagement, { readerKeyPair = null, handover = null } = {}) {
    // readerKeyPair: only for test vectors; a live session always uses a fresh key.
    // handover: null for QR engagement (this POS); NFC handovers carry their messages here.
    const eReader = readerKeyPair || await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = await subtle.exportKey('jwk', eReader.publicKey);
    const eReaderKeyBytes = encode(new Map([[1, 2], [-1, 1], [-2, b64urlDecode(pub.x)], [-3, b64urlDecode(pub.y)]]));
    const sessionTranscript = encode([new Tag(24, engagement.engagementBytes), new Tag(24, eReaderKeyBytes), handover]);
    const sessionTranscriptBytes = encode(new Tag(24, sessionTranscript));
    const salt = new Uint8Array(await subtle.digest('SHA-256', sessionTranscriptBytes));

    const devicePub = await subtle.importKey('jwk', engagement.eDeviceKeyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: devicePub }, eReader.privateKey, 256));
    const skReader = await hkdfKey(z, salt, 'SKReader', ['encrypt']);
    const skDevice = await hkdfKey(z, salt, 'SKDevice', ['decrypt']);
    let readerCounter = 1;
    let deviceCounter = 1;

    return {
      sessionTranscript,
      eReaderKeyBytes,
      async encrypt(plain) {
        return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv(0, readerCounter++) }, skReader, plain));
      },
      async decrypt(cipher) {
        return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv(1, deviceCounter++) }, skDevice, cipher));
      },
      /** SessionEstablishment carrying the encrypted DeviceRequest. */
      async establishment(deviceRequestBytes) {
        return encode(new Map([['eReaderKey', new Tag(24, eReaderKeyBytes)], ['data', await this.encrypt(deviceRequestBytes)]]));
      },
      /** SessionData from the wallet → { deviceResponse?: Uint8Array, status?: number } */
      async open(sessionDataBytes) {
        const sd = decode(sessionDataBytes);
        const data = get(sd, 'data');
        return { deviceResponse: data ? await this.decrypt(data) : null, status: get(sd, 'status') };
      },
      /** Only needed when the wallet authenticates with DeviceMac (EMacKey = ECDH with EReaderKey). */
      exportReaderPrivateKey: () => subtle.exportKey('jwk', eReader.privateKey)
    };
  }

  /** DeviceRequest for one docType; `elements` = { name: intentToRetain }. */
  function deviceRequest(docType, namespace, elements) {
    const itemsRequest = new Map([['docType', docType], ['nameSpaces', new Map([[namespace, new Map(Object.entries(elements))]])]]);
    return encode(new Map([['version', '1.0'], ['docRequests', [new Map([['itemsRequest', new Tag(24, encode(itemsRequest))]])]]]));
  }

  /* --------------------------------------------------------- 3. BLE */

  /** BLEIdent = HKDF(EDeviceKeyBytes, "", "BLEIdent", 16) — §8.3.3.1.1.4 */
  async function bleIdent(eDeviceKeyBytes) {
    const base = await subtle.importKey('raw', eDeviceKeyBytes, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('BLEIdent') }, base, 128));
  }

  /**
   * Opens the browser's Bluetooth chooser for the wallet. MUST be the first call
   * in a click handler (Web Bluetooth needs the user gesture).
   */
  function requestWalletDevice(engagement) {
    if (!(typeof navigator !== 'undefined' && navigator.bluetooth)) return Promise.reject(new Error('no_web_bluetooth'));
    return navigator.bluetooth.requestDevice({ filters: [{ services: [engagement.ble.peripheralServerUuid] }] });
  }

  /**
   * GATT transport to an mdoc in peripheral server mode.
   * `exchange(message)` sends one message and resolves with the next complete
   * message from the wallet (chunked with the 0x01 "more" / 0x00 "last" prefix).
   */
  async function bleTransport(device, engagement, { chunkSize = 20, onStep = () => {} } = {}) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(engagement.ble.peripheralServerUuid);
    const state = await service.getCharacteristic(BLE.STATE);
    const c2s = await service.getCharacteristic(BLE.CLIENT2SERVER);
    const s2c = await service.getCharacteristic(BLE.SERVER2CLIENT);

    let identOk = null;
    try {
      const ident = new Uint8Array((await (await service.getCharacteristic(BLE.IDENT)).readValue()).buffer);
      identOk = hex(ident) === hex(await bleIdent(engagement.eDeviceKeyBytes));
    } catch (_) {
      identOk = null; // optional characteristic not exposed
    }

    let parts = [];
    let waiter = null;
    const fail = (err) => {
      if (waiter) waiter.reject(err);
      waiter = null;
    };
    s2c.addEventListener('characteristicvaluechanged', (e) => {
      const v = new Uint8Array(e.target.value.buffer);
      if (v.length === 0) return;
      parts.push(v.slice(1));
      if (v[0] === 0x00) {
        const msg = concat(parts);
        parts = [];
        if (waiter) waiter.resolve(msg);
        waiter = null;
      }
    });
    state.addEventListener('characteristicvaluechanged', (e) => {
      const v = new Uint8Array(e.target.value.buffer);
      if (v[0] === STATE_END) fail(new Error('wallet_ended_session'));
    });
    device.addEventListener('gattserverdisconnected', () => fail(new Error('ble_disconnected')));
    await s2c.startNotifications();
    await state.startNotifications();
    await state.writeValueWithoutResponse(Uint8Array.of(STATE_START));

    async function send(message) {
      const size = Math.max(2, chunkSize) - 1;
      for (let off = 0; off < message.length; off += size) {
        const last = off + size >= message.length;
        await c2s.writeValueWithoutResponse(concat([Uint8Array.of(last ? 0x00 : 0x01), message.slice(off, off + size)]));
      }
    }

    return {
      kind: 'ble',
      identOk,
      async exchange(message, timeoutMs = 120000) {
        let timer;
        const reply = new Promise((resolve, reject) => {
          waiter = { resolve, reject };
          timer = setTimeout(() => fail(new Error('timeout_waiting_for_wallet')), timeoutMs);
        }).finally(() => clearTimeout(timer));
        await send(message);
        onStep('WAITING_CONSENT');
        return reply;
      },
      async close() {
        try {
          await state.writeValueWithoutResponse(Uint8Array.of(STATE_END));
        } catch (_) { /* already gone */ }
        try {
          server.disconnect();
        } catch (_) { /* ignore */ }
      }
    };
  }

  /* ------------------------------------------------------- full read */

  /**
   * Runs request → response over a transport. Returns what the server needs to
   * verify the presentation.
   */
  async function readPid({ engagement, session, transport, docType, namespace, elements, onStep = () => {} }) {
    const establishment = await session.establishment(deviceRequest(docType, namespace, elements));
    onStep('REQUEST_SENT');
    const reply = await transport.exchange(establishment);
    onStep('RESPONSE_RECEIVED');
    const { deviceResponse, status } = await session.open(reply);
    await transport.close();
    if (!deviceResponse) throw new Error(`wallet_status_${status}`);
    return {
      deviceResponse: b64urlEncode(deviceResponse),
      sessionTranscript: b64urlEncode(session.sessionTranscript),
      // ephemeral, this session only: lets the server check a DeviceMac (EMacKey)
      readerKey: await session.exportReaderPrivateKey(),
      engagementMethods: engagement.methods,
      bleIdent: transport.identOk
    };
  }

  return { BLE, parseEngagement, bleCompatibility, createSession, deviceRequest, bleIdent, requestWalletDevice, bleTransport, readPid, b64urlEncode, b64urlDecode };
}));
