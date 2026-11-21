import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keepBlob, local, memoryBlobs, sha256hex, sync, takeBlob, type BlobPeer, type Form, type Peer } from "../src/index.js";
import { ENGINES, replica, Wall } from "./helpers.js";

// C-431: BLOBS -- every binary kept under its SHA-256, named in an event, and fetched from whichever replica holds it;
// bytes that are not what their name says are never kept.

const bytes = (s: string) => new TextEncoder().encode(s);
const ALBUM: Form = {
  name: "album", version: 1,
  kinds: { photo: { title: "Photo", states: [{ name: "kept", phase: "open" }], fields: { picture: { type: "blob" }, caption: { type: "text" } } } },
};

describe("a blob store", () => {
  it("keeps bytes under their SHA-256 once, and takes bytes only under their own name", () => {
    const store = memoryBlobs();
    const h = keepBlob(store, bytes("a seedling"));
    expect(h).toBe(createHash("sha256").update("a seedling").digest("hex"));
    expect(keepBlob(store, bytes("a seedling"))).toBe(h);
    expect(store.count).toBe(1);
    expect(new TextDecoder().decode(store.get(h)!)).toBe("a seedling");
    expect(takeBlob(store, h, bytes("a weed"))).toBe(false);      // bytes that are not what the name says
    expect(takeBlob(store, "not-a-hash", bytes("x"))).toBe(false);
    const big = new Uint8Array(3_000_000).map((_, i) => (i * 31) & 255);   // a photo's size, through the engine's own SHA-256
    expect(sha256hex(big)).toBe(createHash("sha256").update(big).digest("hex"));
    // a faster hasher the app has gives the same names
    expect(keepBlob(memoryBlobs(), big, (b) => createHash("sha256").update(b).digest("hex"))).toBe(sha256hex(big));
  });
});

describe.each(ENGINES)("blobs on %s", (_, make) => {
  const setUp = () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall), hub = replica(make, "hub", wall), seer = replica(make, "seer", wall);
    const stores = { phone: memoryBlobs(), hub: memoryBlobs(), seer: memoryBlobs() };
    const album = phone.makeSpace({ title: "Album", form: ALBUM, reach: "home" });
    return { wall, phone, hub, seer, stores, album };
  };

  it("names the blobs a space's fields hold -- every write, the ones written over too -- and checks a field's value", () => {
    const { wall, phone, stores, album } = setUp();
    const first = keepBlob(stores.phone, bytes("the garden in May")), second = keepBlob(stores.phone, bytes("the garden in June"));
    const p = phone.make(album, "photo", { title: "The garden", picture: first });
    wall.tick();
    phone.set(p, "picture", second);
    expect(phone.blobs()).toEqual([first, second].sort());
    expect(phone.blobs([album])).toEqual([first, second].sort());
    expect(phone.blobs(["0190a000-0000-7000-8000-000000000000"])).toEqual([]);
    expect(() => phone.set(p, "picture", "a cat")).toThrow(/SHA-256/);
    expect(() => phone.set(p, "caption", first)).not.toThrow();    // a text field that looks like one is not a blob
    expect(phone.blobs()).toHaveLength(2);
  });

  it("moves each blob with its events, from whichever replica holds it, and never one that is not what it says", async () => {
    const { phone, hub, seer, stores, album } = setUp();
    const pic = keepBlob(stores.phone, bytes("the garden in May"));
    phone.make(album, "photo", { title: "The garden", picture: pic });
    const P = local(phone, stores.phone), H = local(hub, stores.hub), S = local(seer, stores.seer);

    // the seer hears of the photo through the hub before the hub holds its bytes: it waits for them
    await sync(phone, hub, { blobs: false });
    const early = await sync(H, S);
    expect(early).toMatchObject({ blobsToB: 0, blobsMissing: [pic] });
    expect(stores.seer.has(pic)).toBe(false);
    expect(await sync(P, H)).toMatchObject({ blobsToB: 1, blobsMissing: [] });
    expect(await sync(H, S)).toMatchObject({ blobsToB: 1, blobsMissing: [] });
    expect(new TextDecoder().decode(stores.seer.get(pic)!)).toBe("the garden in May");
    expect(await sync(H, S)).toMatchObject({ blobsToA: 0, blobsToB: 0, blobsMissing: [] });   // safe to repeat

    // a replica that sends the wrong bytes under a name gives nothing
    const other = replica(make, "other", phone ? new Wall() : new Wall()), kept = memoryBlobs();
    const liar: Peer & BlobPeer = { ...local(seer, stores.seer) as Peer & BlobPeer, blob: () => bytes("not the garden") };
    expect(await sync(liar, local(other, kept))).toMatchObject({ blobsToB: 0, blobsMissing: [pic] });
    expect(kept.has(pic)).toBe(false);
  });
});
