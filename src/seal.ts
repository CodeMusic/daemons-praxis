// C-434: PRAXIS runs on the phone too (C-111) -- no node:*, no fs, and nothing imported from the companion.
// SEALED SPACES (PROJECTS.md 5, "Who sees what"): a replica that keeps a space's events and blobs without reading them --
// a relay, a backup in a cloud. Each space has a key. An event's content is sealed under it, and only what an exchange
// needs to say what it has seen stays open: the space, the replica that wrote it, when (its clock), and its id (whose
// time the clock says already). Its item, op, field, value and actor are inside the box.
//
// A keyless replica is an ordinary Praxis: a sealed event is of a format no build reads (SEALED), so every build keeps it,
// orders it and passes it on as it came, never folding it (C-435) -- the relay needs no code of its own to hold one.
// A keyed replica sees the keyless one through sealed(): what it sends is sealed first, what it is sent is opened.
//
// A blob is sealed under the key of a space that names it, and kept by the relay under a name made from that key and the
// blob's own hash, so the relay cannot tell two spaces' copies of one photo apart, nor a name from the photo's hash.
//
// The cipher is the app's (this package imports nothing): an AEAD such as ChaCha20-Poly1305 -- Node's crypto on the hub,
// a pure-JS one on the phone. The nonce is made here and travels at the front of the box.

import type { BlobPeer, BlobStore, Hasher } from "./blobs.js";
import { checkEnvelope, type PxEvent } from "./events.js";
import type { Exchange, Peer } from "./exchange.js";
import { sync } from "./exchange.js";
import type { Received } from "./engine.js";
import { cryptoRandom, HASH, sha256hex, utf8, type Random } from "./ids.js";

/** the format a sealed event carries: one no build will ever read, so every build keeps it unfolded. FORMAT never comes
 *  near it. */
export const SEALED = 1_000_000;
/** a sealed event's op and actor: the real ones are inside */
export const SEALED_OP = "sealed";
/** a space key's length in bytes */
export const KEY_BYTES = 32;

/** an AEAD the app supplies. `seal` returns the ciphertext with its tag; `open` returns the plaintext, or null when the
 *  bytes, the key or the associated data are not the ones it was sealed with. */
export interface Cipher {
  readonly nonceBytes: number;
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, ad: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, ad: Uint8Array): Uint8Array | null;
}

/** a new space key */
export function newKey(random: Random = cryptoRandom): Uint8Array {
  const k = new Uint8Array(KEY_BYTES);
  random(k);
  return k;
}

// ---- bytes as text (Buffer, btoa and TextDecoder are not on every engine the app runs on) ---------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_OF = new Map([...B64].map((c, i) => [c, i]));

/** bytes as base64 */
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return s;
}
/** base64 as bytes, or null when it is not base64 */
export function fromBase64(s: string): Uint8Array | null {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_OF.get(s[i])! << 18) | (B64_OF.get(s[i + 1])! << 12) | ((B64_OF.get(s[i + 2]) ?? 0) << 6) | (B64_OF.get(s[i + 3]) ?? 0);
    for (const x of [(n >> 16) & 255, (n >> 8) & 255, n & 255]) if (o < out.length) out[o++] = x;
  }
  return out;
}
/** UTF-8 bytes as a string, or null when they are not UTF-8 */
export function fromUtf8(b: Uint8Array): string | null {
  let s = "";
  for (let i = 0; i < b.length;) {
    const c = b[i];
    const n = c < 0x80 ? 1 : (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 0;
    if (!n || i + n > b.length) return null;
    let cp = n === 1 ? c : c & (0xff >> (n + 1));
    for (let j = 1; j < n; j++) {
      if ((b[i + j] & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b[i + j] & 63);
    }
    s += String.fromCodePoint(cp);
    i += n;
  }
  return s;
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** sealed bytes: a fresh nonce, then what the cipher made of the plaintext */
function box(cipher: Cipher, key: Uint8Array, plain: Uint8Array, ad: Uint8Array, random: Random): Uint8Array {
  const nonce = new Uint8Array(cipher.nonceBytes);
  random(nonce);
  return join(nonce, cipher.seal(key, nonce, plain, ad));
}
function unbox(cipher: Cipher, key: Uint8Array, sealed: Uint8Array, ad: Uint8Array): Uint8Array | null {
  if (sealed.length <= cipher.nonceBytes) return null;
  return cipher.open(key, sealed.subarray(0, cipher.nonceBytes), sealed.subarray(cipher.nonceBytes), ad);
}

// ---- events -----------------------------------------------------------------------------------------------------------

/** what a sealed event's box is bound to: its open part, so a box cannot be moved to another event */
const eventAd = (e: { id: string; space: string; replica: string; hlc: string }) =>
  utf8(`praxis-sealed-event-1|${e.id}|${e.space}|${e.replica}|${e.hlc}`);

/** an event sealed under its space's key: the space, replica, clock and id open, everything else inside */
export function sealEvent(e: PxEvent, key: Uint8Array, cipher: Cipher, random: Random = cryptoRandom): PxEvent {
  return {
    v: SEALED, id: e.id, space: e.space, item: e.space, op: SEALED_OP as PxEvent["op"], actor: SEALED_OP,
    replica: e.replica, hlc: e.hlc, value: toBase64(box(cipher, key, utf8(JSON.stringify(e)), eventAd(e), random)),
  };
}

export const isSealed = (e: { v?: unknown; op?: unknown }) => e.v === SEALED && e.op === SEALED_OP;

/** a sealed event opened: the event as it was written, or null when this key does not open it or what is inside is not
 *  the event its open part says */
export function openEvent(s: PxEvent, key: Uint8Array, cipher: Cipher): PxEvent | null {
  if (!isSealed(s) || typeof s.value !== "string") return null;
  const sealed = fromBase64(s.value);
  const plain = sealed && unbox(cipher, key, sealed, eventAd(s));
  const text = plain && fromUtf8(plain);
  if (!text) return null;
  let e: PxEvent;
  try { e = JSON.parse(text); } catch { return null; }
  if (checkEnvelope(e) || isSealed(e) || e.id !== s.id || e.space !== s.space || e.replica !== s.replica || e.hlc !== s.hlc) return null;
  return e;
}

// ---- blobs ------------------------------------------------------------------------------------------------------------

/** the name a relay keeps a blob under, for a space: made from the space's key and the blob's own hash, so it says
 *  nothing of either */
export const sealedName = (key: Uint8Array, hash: string): string =>
  sha256hex(join(utf8("praxis-sealed-blob-name-1|"), key, utf8(`|${hash}`)));
const blobAd = (hash: string) => utf8(`praxis-sealed-blob-1|${hash}`);

export function sealBlob(bytes: Uint8Array, hash: string, key: Uint8Array, cipher: Cipher, random: Random = cryptoRandom): Uint8Array {
  return box(cipher, key, bytes, blobAd(hash), random);
}
/** a sealed blob opened, and only if it is the blob `hash` names */
export function openBlob(sealed: Uint8Array, hash: string, key: Uint8Array, cipher: Cipher, hasher: Hasher = sha256hex): Uint8Array | null {
  const plain = unbox(cipher, key, sealed, blobAd(hash));
  return plain && hasher(plain) === hash ? plain : null;
}

/** C-434: a relay's blobs -- kept as they are given, under the names they are given (a relay cannot check sealed bytes
 *  against anything; the keyed side does, when it opens them). It wants nothing: keyed replicas bring what they have. */
export function keepSealed(store: BlobStore, most = 64 * 1024 * 1024): BlobPeer {
  return {
    wanted: () => [],
    holds: (names) => names.filter((n) => HASH.test(n) && store.has(n)),
    blob: (n) => (HASH.test(n) ? store.get(n) : null),
    putBlob: (n, bytes) => {
      if (!HASH.test(n) || bytes.length > most) return false;
      if (!store.has(n)) store.put(n, bytes);
      return true;
    },
  };
}

// ---- a keyless replica, as a keyed one sees it ------------------------------------------------------------------------

export interface Sealing {
  /** the keys this side holds, by space: only these spaces are sent and taken */
  keys: ReadonlyMap<string, Uint8Array>;
  cipher: Cipher;
  random?: Random;
  hasher?: Hasher;
  /** the blobs a space names, on this side (a Praxis's blobs([space])): needed for blobs, not for events */
  named?: (space: string) => string[];
}

/** C-434: a keyless replica (`far`: a relay, over any transport) as a keyed replica sees it. Every event sent to it is
 *  sealed under its space's key; every event it sends is opened, and one that will not open is never taken, nor any
 *  later one of the same replica in that space, so what this side holds is never missing a middle (`unread` counts
 *  them). Only the spaces this side holds a key of are asked of it. */
export function sealed(far: Peer & Partial<BlobPeer>, s: Sealing): Peer & Partial<BlobPeer> & { readonly unread: number } {
  const random = s.random ?? cryptoRandom, hasher = s.hasher ?? sha256hex;
  const keyed = (spaces?: string[]) => (spaces ?? [...s.keys.keys()]).filter((x) => s.keys.has(x));
  let unread = 0;

  const peer: Peer = {
    have: async (spaces) => {
      const only = keyed(spaces);
      return only.length ? await far.have(only) : {};
    },
    missing: async (have, o) => {
      const only = keyed(o?.spaces);
      if (!only.length) return [];
      const out: PxEvent[] = [];
      const stuck = new Set<string>();             // space|replica runs that met a box this key will not open
      for (const e of await far.missing(have, { ...o, spaces: only })) {
        const run = `${e.space}|${e.replica}`;
        if (stuck.has(run)) continue;
        const key = s.keys.get(e.space);
        const opened = key && openEvent(e, key, s.cipher);
        if (opened) out.push(opened); else { stuck.add(run); unread++; }
      }
      return out;
    },
    receive: async (events) => {
      const out: Received = { applied: 0, known: 0, rejected: 0, newer: 0, ahead: 0 };
      const sent: PxEvent[] = [];
      for (const e of events) {
        const key = s.keys.get(e.space);
        if (key && !checkEnvelope(e) && !isSealed(e)) sent.push(sealEvent(e, key, s.cipher, random)); else out.rejected++;
      }
      if (!sent.length) return out;
      const r = await far.receive(sent);
      // the far side keeps a sealed event unfolded (newer, to it): to this side, it was taken
      return { applied: r.applied + (r.newer ?? 0), known: r.known, rejected: out.rejected + r.rejected, newer: 0, ahead: r.ahead ?? 0 };
    },
  };
  const result = Object.defineProperty(peer, "unread", { get: () => unread, enumerable: true }) as Peer & { readonly unread: number };
  const named = s.named;
  if (!named || typeof far.holds !== "function" || typeof far.blob !== "function" || typeof far.putBlob !== "function") return result;
  const farBlobs = far as Peer & BlobPeer;

  /** where each of these blobs could be on the far side: a name for every keyed space that names it */
  const places = (hashes: string[], spaces?: string[]) => {
    const want = new Set(hashes);
    const out: { hash: string; space: string; name: string }[] = [];
    for (const space of keyed(spaces)) for (const hash of named(space))
      if (want.has(hash)) out.push({ hash, space, name: sealedName(s.keys.get(space)!, hash) });
    return out;
  };
  return Object.assign(result, {
    // what the far side lacks of what this side's keyed spaces name -- for pushing this side's blobs to it
    wanted: async (spaces?: string[]) => {
      const all = keyed(spaces).flatMap((space) => named(space).map((hash) => ({ hash, name: sealedName(s.keys.get(space)!, hash) })));
      if (!all.length) return [];
      const held = new Set(await farBlobs.holds(all.map((p) => p.name)));
      return [...new Set(all.filter((p) => !held.has(p.name)).map((p) => p.hash))].sort();
    },
    holds: async (hashes: string[]) => {
      const ps = places(hashes);
      if (!ps.length) return [];
      const held = new Set(await farBlobs.holds(ps.map((p) => p.name)));
      return [...new Set(ps.filter((p) => held.has(p.name)).map((p) => p.hash))];
    },
    blob: async (hash: string) => {
      for (const p of places([hash])) {
        const got = await farBlobs.blob(p.name);
        const plain = got && openBlob(got, hash, s.keys.get(p.space)!, s.cipher, hasher);
        if (plain) return plain;
      }
      return null;
    },
    putBlob: async (hash: string, bytes: Uint8Array) => {
      if (!HASH.test(hash) || hasher(bytes) !== hash) return false;
      const ps = places([hash]);
      if (!ps.length) return false;
      const held = new Set(await farBlobs.holds(ps.map((p) => p.name)));
      let kept = true;
      for (const p of ps) if (!held.has(p.name))
        kept = (await farBlobs.putBlob(p.name, sealBlob(bytes, hash, s.keys.get(p.space)!, s.cipher, random))) && kept;
      return kept;
    },
  } satisfies BlobPeer);
}

/** C-434: a keyed replica and a keyless one exchange, only in the spaces the keyed one holds keys of (and of those, only
 *  the ones `o.spaces` names, when it does) -- sync() through sealed() */
export async function syncSealed(near: Peer & Partial<BlobPeer>, far: Peer & Partial<BlobPeer>, s: Sealing, o: Exchange = {}) {
  const spaces = (o.spaces ?? [...s.keys.keys()]).filter((x) => s.keys.has(x));
  const relay = sealed(far, s);
  if (!spaces.length) return { toA: 0, toB: 0, ahead: 0, blobsToA: 0, blobsToB: 0, blobsMissing: [] as string[], unread: 0 };
  const r = await sync(near, relay, { ...o, spaces });
  return { ...r, unread: relay.unread };
}

// ---- a household's keys, wrapped -------------------------------------------------------------------------------------

const ringAd = utf8("praxis-keyring-1");
/** the name a keyring is kept under at a relay: made from the key that wraps it, so only its holder can ask for it */
export const keyringName = (wrapping: Uint8Array) => sha256hex(join(utf8("praxis-keyring-name-1|"), wrapping));

/** every space key a household holds, sealed under one wrapping key (the app derives it from a recovery code) */
export function wrapKeys(keys: ReadonlyMap<string, Uint8Array>, wrapping: Uint8Array, cipher: Cipher, random: Random = cryptoRandom): Uint8Array {
  const text = JSON.stringify(Object.fromEntries([...keys].sort(([a], [b]) => (a < b ? -1 : 1)).map(([space, k]) => [space, toBase64(k)])));
  return box(cipher, wrapping, utf8(text), ringAd, random);
}
/** a keyring opened, or null when this wrapping key does not open it */
export function unwrapKeys(sealed: Uint8Array, wrapping: Uint8Array, cipher: Cipher): Map<string, Uint8Array> | null {
  const plain = unbox(cipher, wrapping, sealed, ringAd);
  const text = plain && fromUtf8(plain);
  if (!text) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text); } catch { return null; }
  const out = new Map<string, Uint8Array>();
  for (const [space, k] of Object.entries(o)) {
    const key = typeof k === "string" ? fromBase64(k) : null;
    if (!key || key.length !== KEY_BYTES) return null;
    out.set(space, key);
  }
  return out;
}
