// C-429: PRAXIS runs on the phone too (C-111) -- no node:*, no fs, and nothing imported from the companion.
// SYNC (PROJECTS.md 5) is one exchange: "here is what I have seen; send me the rest" -- both ways, safe to repeat, in any
// order. What carries it does not matter (HTTP to the hub, the n8n relay's envelope, Bluetooth, a USB cable, a file
// carried by hand): a transport only has to put a Peer's three calls at the far end. A Praxis is a Peer as it is.
// C-431: the blobs beside the events (blobs.ts), each fetched from whichever side holds it; a push one way, for a phone
// that hosted alone handing what it made to a hub; and which reaches a side is sent (`reaches`).

import { takeBlob, type BlobPeer, type BlobStore, type Hasher } from "./blobs.js";
import type { Have, Praxis, Reach, Received } from "./engine.js";
import type { PxEvent } from "./events.js";
import { HASH, sha256hex } from "./ids.js";

export interface Peer {
  have(spaces?: string[]): Have | Promise<Have>;
  missing(have: Have, o?: { spaces?: string[]; limit?: number; reaches?: readonly Reach[] }): PxEvent[] | Promise<PxEvent[]>;
  receive(events: PxEvent[]): Received | Promise<Received>;
}
export interface Exchange {
  spaces?: string[];             // only these spaces (every space either holds, when unsaid)
  batch?: number;                // events a call carries (500)
  reaches?: readonly Reach[];    // only spaces of these reaches (every one but THIS PHONE, which is never sent)
  blobs?: boolean;               // the blobs too, when both sides keep them (true)
}

/** C-431: a Praxis and the store its blobs are kept in, as one side of an exchange -- events and blobs */
export function local(px: Praxis, store?: BlobStore, hash: Hasher = sha256hex): Peer & Partial<BlobPeer> {
  const peer: Peer & Partial<BlobPeer> = {
    have: (spaces) => px.have(spaces),
    missing: (have, o) => px.missing(have, o),
    receive: (events) => px.receive(events),
  };
  if (!store) return peer;
  return Object.assign(peer, {
    wanted: (spaces?: string[]) => px.blobs(spaces).filter((h) => !store.has(h)),
    holds: (hashes: string[]) => hashes.filter((h) => HASH.test(h) && store.has(h)),
    blob: (h: string) => (HASH.test(h) ? store.get(h) : null),
    putBlob: (h: string, bytes: Uint8Array) => takeBlob(store, h, bytes, hash),
  } satisfies BlobPeer);
}

const blobby = (p: Peer & Partial<BlobPeer>): p is Peer & BlobPeer =>
  typeof p.wanted === "function" && typeof p.holds === "function" && typeof p.blob === "function" && typeof p.putBlob === "function";

/** C-431: what `to` lacks of `from`'s events, sent in batches until it lacks nothing -- one way. How many it took, and how
 *  many wait for its clock to catch up (AHEAD): those are offered again at the next exchange. */
export async function push(from: Peer, to: Peer, o: Exchange = {}): Promise<{ sent: number; ahead: number }> {
  const batch = o.batch ?? 500;
  let sent = 0, ahead = 0;
  for (;;) {
    const events = await from.missing(await to.have(o.spaces), { spaces: o.spaces, limit: batch, reaches: o.reaches });
    if (!events.length) return { sent, ahead };
    const r = await to.receive(events);
    // C-435: events of a newer format are taken too (kept, unfolded), so they move `have` on as well. A peer from
    // before the field says nothing of them.
    const took = r.applied + (r.newer ?? 0);
    ahead = r.ahead ?? 0;
    if (!took) return { sent, ahead };    // nothing it would take: stop rather than offer it again
    sent += took;
  }
}

/** C-431: the blobs `to` wants that `from` holds, fetched and checked -- how many it kept, and what `from` could not give */
export async function moveBlobs(from: BlobPeer, to: BlobPeer, spaces?: string[]): Promise<{ moved: number; missing: string[] }> {
  const wanted = await to.wanted(spaces);
  if (!wanted.length) return { moved: 0, missing: [] };
  const held = new Set(await from.holds(wanted));
  let moved = 0;
  const missing: string[] = [];
  for (const h of wanted) {
    const bytes = held.has(h) ? await from.blob(h) : null;
    if (bytes && await to.putBlob(h, bytes)) moved++; else missing.push(h);
  }
  return { moved, missing };
}

/** a and b exchange until neither has anything the other lacks. A keeper that numbers what it was sent makes new
 *  events, so this goes round again until a round moves nothing. Then (C-431) the blobs either names and the other
 *  holds, when both keep blobs. Returns what each was sent, and the events that wait for a clock (AHEAD). */
export async function sync(a: Peer & Partial<BlobPeer>, b: Peer & Partial<BlobPeer>, o: Exchange = {}):
  Promise<{ toA: number; toB: number; ahead: number; blobsToA: number; blobsToB: number; blobsMissing: string[] }> {
  let toA = 0, toB = 0, ahead = 0;
  for (let round = 0; round < 8; round++) {
    const b1 = await push(a, b, o), a1 = await push(b, a, o);
    toB += b1.sent; toA += a1.sent; ahead = b1.ahead + a1.ahead;
    if (!a1.sent && !b1.sent) break;
  }
  let blobsToA = 0, blobsToB = 0;
  const blobsMissing = new Set<string>();
  if (o.blobs !== false && blobby(a) && blobby(b)) {
    const ba = await moveBlobs(b, a, o.spaces), bb = await moveBlobs(a, b, o.spaces);
    blobsToA = ba.moved; blobsToB = bb.moved;
    for (const h of [...ba.missing, ...bb.missing]) blobsMissing.add(h);
  }
  return { toA, toB, ahead, blobsToA, blobsToB, blobsMissing: [...blobsMissing].sort() };
}
