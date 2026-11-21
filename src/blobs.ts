// C-431: PRAXIS runs on the phone too (C-111) -- no node:*, no fs, and nothing imported from the companion.
// BLOBS (PROJECTS.md 5: "your data as a CDN"). Every binary -- a photo, a painting, a voice, a song, a recording, a save --
// is kept under its SHA-256, so one name is always the same bytes: stored once, cached for good, and served by whichever
// replica holds it. An event names the hash (a field of type "blob"); the bytes travel beside the events, asked for by
// what a replica wants and checked against their name before they are kept. Where the bytes live is the app's -- a
// folder on the hub, the phone's documents, memory in a test -- behind a BlobStore.

import { HASH, sha256hex } from "./ids.js";

/** where a replica keeps blobs, each under its SHA-256 (hex) */
export interface BlobStore {
  has(hash: string): boolean;
  get(hash: string): Uint8Array | null;
  put(hash: string, bytes: Uint8Array): void;
}
/** a SHA-256 of bytes, as hex: the engine's own (plain TypeScript, so every replica names a blob alike), or a faster
 *  one the app has (Node's crypto on the hub, expo-crypto on the phone) -- the same answer either way */
export type Hasher = (bytes: Uint8Array) => string;

/** a BlobStore in memory -- for tests, and for a replica that only passes blobs on */
export function memoryBlobs(): BlobStore & { readonly count: number } {
  const held = new Map<string, Uint8Array>();
  return {
    has: (h) => held.has(h),
    get: (h) => held.get(h) ?? null,
    put: (h, b) => { held.set(h, b.slice()); },
    get count() { return held.size; },
  };
}

/** bytes kept under their SHA-256 (once: the same bytes are already there under it); the hash, to name in a field */
export function keepBlob(store: BlobStore, bytes: Uint8Array, hash: Hasher = sha256hex): string {
  const h = hash(bytes);
  if (!store.has(h)) store.put(h, bytes);
  return h;
}

/** bytes another replica sent under a name, kept only if they are what the name says; whether they were */
export function takeBlob(store: BlobStore, name: string, bytes: Uint8Array, hash: Hasher = sha256hex): boolean {
  if (!HASH.test(name) || hash(bytes) !== name) return false;
  if (!store.has(name)) store.put(name, bytes);
  return true;
}

/** a replica's blobs, as the other end of an exchange asks for them (exchange.ts). A transport puts these four calls at
 *  the far end, as it does a Peer's three. */
export interface BlobPeer {
  /** the blobs its spaces name that it does not hold */
  wanted(spaces?: string[]): string[] | Promise<string[]>;
  /** which of these it holds */
  holds(hashes: string[]): string[] | Promise<string[]>;
  blob(hash: string): Uint8Array | null | Promise<Uint8Array | null>;
  /** bytes for it to keep, if they are what their name says (takeBlob); whether it kept them */
  putBlob(hash: string, bytes: Uint8Array): boolean | Promise<boolean>;
}
