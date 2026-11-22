import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fromBase64, fromUtf8, keepBlob, keepSealed, keyringName, local, memoryBlobs, newKey, openEvent, SEALED, sealEvent,
  sealed, sealedName, syncSealed, toBase64, unwrapKeys, utf8, wrapKeys, type BlobPeer, type Cipher, type Form, type Peer,
  type PxEvent, type Sealing,
} from "../src/index.js";
import { ENGINES, LIFE, replica, seeded, Wall } from "./helpers.js";

// C-434: SEALED SPACES -- a keyless replica (a relay, a backup) keeps, orders and passes on a space's events and blobs
// without reading them; a keyed one folds what it passed on as if it had been there.

/** ChaCha20-Poly1305 from Node's crypto: the hub's cipher (the phone brings a pure-JS one) */
const chacha: Cipher = {
  nonceBytes: 12,
  seal(key, nonce, plain, ad) {
    const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
    c.setAAD(ad, { plaintextLength: plain.length });
    return new Uint8Array(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
  },
  open(key, nonce, sealed, ad) {
    if (sealed.length < 16) return null;
    try {
      const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
      d.setAAD(ad, { plaintextLength: sealed.length - 16 });
      d.setAuthTag(sealed.subarray(sealed.length - 16));
      return new Uint8Array(Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]));
    } catch { return null; }
  },
};

describe("bytes as text", () => {
  it("writes and reads base64 and UTF-8 as Node does", () => {
    const r = seeded(7);
    for (const n of [0, 1, 2, 3, 4, 5, 31, 32, 33, 1000]) {
      const b = new Uint8Array(n);
      r.bytes(b);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
    expect(fromBase64("abc")).toBeNull();
    expect(fromBase64("ab$=")).toBeNull();
    for (const s of ["", "a garden", "Mom’s cat — Kalie", "é", "𝄞 the clef", "日本"]) expect(fromUtf8(utf8(s))).toBe(s);
    expect(fromUtf8(Uint8Array.from([0xc3]))).toBeNull();
    expect(fromUtf8(Uint8Array.from([0xff]))).toBeNull();
  });
});

describe("a sealed event", () => {
  const wall = new Wall();
  const hub = replica(ENGINES[0][1], "hub", wall);
  const life = hub.makeSpace({ title: "Life", form: LIFE, reach: "home" });
  hub.make(life, "goal", { title: "Clear the garden" });
  const made = hub.missing({}).find((e) => e.op === "make" && (e.value as { kind?: string }).kind === "goal")!;
  const key = newKey(seeded(1).bytes);

  it("keeps only its space, replica, clock and id open, and opens to the event it was", () => {
    const s = sealEvent(made, key, chacha);
    expect(s).toMatchObject({ v: SEALED, id: made.id, space: made.space, item: made.space, op: "sealed", actor: "sealed",
      replica: made.replica, hlc: made.hlc });
    expect(Object.keys(s).sort()).toEqual(["actor", "hlc", "id", "item", "op", "replica", "space", "v", "value"]);
    expect(JSON.stringify(s)).not.toMatch(/garden|goal|Clear/);
    expect(openEvent(s, key, chacha)).toEqual(made);
    expect(sealEvent(made, key, chacha).value).not.toBe(s.value);      // a fresh nonce each time
  });

  it("opens with no other key, and not when its box is moved to another event's open part", () => {
    const s = sealEvent(made, key, chacha);
    expect(openEvent(s, newKey(seeded(2).bytes), chacha)).toBeNull();
    const other = hub.missing({}).find((e) => e.id !== made.id)!;
    expect(openEvent({ ...sealEvent(other, key, chacha), value: s.value }, key, chacha)).toBeNull();
    expect(openEvent({ ...s, hlc: other.hlc }, key, chacha)).toBeNull();
    expect(openEvent({ ...s, value: "not base64!" }, key, chacha)).toBeNull();
    expect(openEvent(made, key, chacha)).toBeNull();                   // an event that was never sealed
  });
});

const ALBUM: Form = {
  name: "album", version: 1,
  kinds: { photo: { title: "Photo", states: [{ name: "kept", phase: "open" }], fields: { picture: { type: "blob" } } } },
};
const bytes = (s: string) => new TextEncoder().encode(s);

describe.each(ENGINES)("a relay on %s", (_, make) => {
  const setUp = () => {
    const wall = new Wall();
    const hub = replica(make, "hub", wall), relay = replica(make, "relay", wall);
    const stores = { hub: memoryBlobs(), relay: memoryBlobs(), fresh: memoryBlobs() };
    const life = hub.makeSpace({ title: "Life", form: LIFE, reach: "home" });
    const album = hub.makeSpace({ title: "Album", form: ALBUM, reach: "home" });
    const mine = hub.makeSpace({ title: "This phone's", form: LIFE, reach: "phone" });
    const keys = new Map([[life, newKey(seeded(11).bytes)], [album, newKey(seeded(12).bytes)], [mine, newKey(seeded(13).bytes)]]);
    const goal = hub.make(life, "goal", { title: "Clear the garden" });
    wall.tick();
    const beds = hub.make(life, "milestone", { title: "BEDS" }, { parent: goal });
    const weeds = hub.make(life, "step", { title: "Pull the weeds" }, { parent: beds });
    const soil = hub.make(life, "step", { title: "Turn the soil" }, { parent: beds });
    wall.tick();
    hub.state(weeds, "done");
    wall.tick();
    hub.state(soil, "done");
    hub.state(beds, "done");
    const secret = hub.make(mine, "goal", { title: "A secret of the phone's" });
    const relayPeer: Peer & BlobPeer = { ...local(relay), ...keepSealed(stores.relay) };
    const sealing = (named: (s: string) => string[]): Sealing => ({ keys, cipher: chacha, named });
    return { wall, hub, relay, stores, life, album, mine, secret, keys, goal, weeds, soil, relayPeer, sealing };
  };

  it("keeps what it cannot read, and a fresh replica with the keys folds it as the hub did, table for table", async () => {
    const { wall, hub, relay, life, album, mine, secret, keys, relayPeer, sealing } = setUp();
    const r = await syncSealed(local(hub), relayPeer, sealing((s) => hub.blobs([s])), { reaches: ["home", "shared"] });
    expect(r.toB).toBe(hub.missing({}, { spaces: [life, album] }).length);
    expect(r.unread).toBe(0);

    // the relay holds every event of the two HOME spaces, as many as the hub, and has seen what the hub has
    expect(relay.have()).toEqual(hub.have([life, album]));
    expect(relay.waiting()).toBe(r.toB);                     // all kept unfolded
    expect(relay.items(life)).toEqual([]);
    const held = JSON.stringify(relay.missing({}));
    for (const word of ["garden", "weeds", "BEDS", "goal", "milestone", "Life", "Album", "life-test", "award"])
      expect(held).not.toContain(word);
    // THIS PHONE's space never left, key or no key
    expect(relay.have()[mine]).toBeUndefined();

    // a fresh replica that holds only the keys gets back the hub's world from the relay
    const fresh = replica(make, "fresh", wall);
    const back = await syncSealed(local(fresh), relayPeer, { ...sealing((s) => fresh.blobs([s])), keys: new Map([[life, keys.get(life)!], [album, keys.get(album)!]]) });
    expect(back.toA).toBe(r.toB);
    for (const t of ["px_items", "px_ledger", "px_writes", "px_made", "px_spaces"])
      expect(fresh.tables()[t], t).toEqual(hub.tables()[t]?.filter((row) => !row.includes(mine) && !row.includes(secret)));
    expect(fresh.arete(life)).toBe(hub.arete(life));
    expect(fresh.arete(life)).toBe(1 + 1 + 5);
    expect(fresh.items(life).map((i) => `${i.kind} ${i.title} ${i.state}`).sort())
      .toEqual(["goal Clear the garden open", "milestone BEDS done", "step Pull the weeds done", "step Turn the soil done"]);
  });

  it("carries a change made on the restored replica back to the hub, and is safe to repeat", async () => {
    const { wall, hub, life, keys, goal, relayPeer, sealing } = setUp();
    const hubSide = sealing((s) => hub.blobs([s]));
    await syncSealed(local(hub), relayPeer, hubSide);
    const fresh = replica(make, "fresh", wall);
    await syncSealed(local(fresh), relayPeer, { ...sealing((s) => fresh.blobs([s])), keys });
    wall.tick();
    const rake = fresh.make(life, "step", { title: "Rake the leaves" }, { parent: goal });
    fresh.state(rake, "done");
    expect((await syncSealed(local(fresh), relayPeer, { ...sealing((s) => fresh.blobs([s])), keys })).toB).toBeGreaterThan(0);
    await syncSealed(local(hub), relayPeer, hubSide);
    expect(hub.item(rake)).toMatchObject({ title: "Rake the leaves", state: "done" });
    expect(hub.arete(life)).toBe(fresh.arete(life));
    const again = await syncSealed(local(hub), relayPeer, hubSide);
    expect(again).toMatchObject({ toA: 0, toB: 0, unread: 0 });
    void keys;
  });

  it("sends no space it holds no key of", async () => {
    const { hub, relay, life, album, keys, relayPeer } = setUp();
    await syncSealed(local(hub), relayPeer, { keys: new Map([[album, keys.get(album)!]]), cipher: chacha });
    expect(Object.keys(relay.have())).toEqual([album]);
    expect(relay.have()[life]).toBeUndefined();
  });

  it("never takes an event its key will not open, nor any later one of that replica in that space", async () => {
    const { wall, hub, life, keys, relayPeer, sealing } = setUp();
    await syncSealed(local(hub), relayPeer, sealing((s) => hub.blobs([s])));
    const theirs = hub.missing({}, { spaces: [life] });
    const bad = theirs[2];                                  // a box spoiled on the way
    const spoiled: Peer = {
      ...relayPeer,
      missing: async (have, o) => (await relayPeer.missing(have, o)).map((e) => (e.id === bad.id ? { ...e, value: toBase64(new Uint8Array(40)) } : e)),
    };
    const fresh = replica(make, "fresh", wall);
    const r = await syncSealed(local(fresh), spoiled, { keys: new Map([[life, keys.get(life)!]]), cipher: chacha });
    expect(r.unread).toBeGreaterThan(0);
    const kept = new Set(fresh.missing({}).map((e) => e.id));
    expect(kept.has(bad.id)).toBe(false);
    for (const e of theirs) if (e.replica === bad.replica && e.hlc > bad.hlc) expect(kept.has(e.id)).toBe(false);
    for (const e of theirs) if (e.hlc < bad.hlc) expect(kept.has(e.id)).toBe(true);
    // once the relay gives the real box again, the rest comes
    await syncSealed(local(fresh), relayPeer, { keys: new Map([[life, keys.get(life)!]]), cipher: chacha });
    expect(fresh.have([life])).toEqual(hub.have([life]));
  });

  it("moves a blob sealed, under a name that says nothing, and back only as what its hash says", async () => {
    const { wall, hub, stores, album, keys, relayPeer, sealing } = setUp();
    const photo = bytes("the garden in May, before the weeds");
    const pic = keepBlob(stores.hub, photo);
    hub.make(album, "photo", { title: "The garden", picture: pic });
    const r = await syncSealed(local(hub, stores.hub), relayPeer, sealing((s) => hub.blobs([s])));
    expect(r).toMatchObject({ blobsToB: 1, blobsMissing: [] });
    expect(stores.relay.has(pic)).toBe(false);
    const name = sealedName(keys.get(album)!, pic);
    expect(stores.relay.has(name)).toBe(true);
    expect(Buffer.from(stores.relay.get(name)!).includes(Buffer.from("garden"))).toBe(false);

    const fresh = replica(make, "fresh", wall);
    const back = await syncSealed(local(fresh, stores.fresh), relayPeer, { ...sealing((s) => fresh.blobs([s])), keys });
    expect(back).toMatchObject({ blobsToA: 1, blobsMissing: [] });
    expect(new TextDecoder().decode(stores.fresh.get(pic)!)).toBe("the garden in May, before the weeds");
    expect(createHash("sha256").update(stores.fresh.get(pic)!).digest("hex")).toBe(pic);

    // a relay that hands back other bytes gives nothing
    const other = replica(make, "other", wall), otherStore = memoryBlobs();
    const liar: Peer & BlobPeer = { ...relayPeer, blob: async () => new Uint8Array(64) };
    const lied = await syncSealed(local(other, otherStore), liar, { ...sealing((s) => other.blobs([s])), keys });
    expect(lied.blobsMissing).toEqual([pic]);
    expect(otherStore.has(pic)).toBe(false);
  });
});

describe("a household's keys", () => {
  it("wrap under one key, open with it alone, and are kept under a name only its holder can make", () => {
    const keys = new Map([["0190a000-0000-7000-8000-000000000001", newKey(seeded(3).bytes)], ["0190a000-0000-7000-8000-000000000002", newKey(seeded(4).bytes)]]);
    const wrapping = newKey(seeded(5).bytes);
    const ring = wrapKeys(keys, wrapping, chacha);
    expect(unwrapKeys(ring, wrapping, chacha)).toEqual(keys);
    expect(unwrapKeys(ring, newKey(seeded(6).bytes), chacha)).toBeNull();
    expect(keyringName(wrapping)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyringName(wrapping)).not.toBe(keyringName(newKey(seeded(6).bytes)));
    expect(keyringName(wrapping, 1)).not.toBe(keyringName(wrapping, 0));
    expect(keyringName(wrapping)).toBe(keyringName(wrapping, 0));
    const sealedPeer = sealed({ have: () => ({}), missing: () => [] as PxEvent[], receive: () => ({ applied: 0, known: 0, rejected: 0, newer: 0, ahead: 0 }) },
      { keys, cipher: chacha });
    expect(sealedPeer.unread).toBe(0);
  });
});
