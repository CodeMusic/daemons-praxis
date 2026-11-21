import { describe, expect, it, vi } from "vitest";
import * as v1 from "../src/index.js";
import { FORMAT, Praxis, sync, type Db, type PxEvent } from "../src/index.js";
import { ENGINES, LIFE, replica, seeded, Wall } from "./helpers.js";

// C-435: every event carries its format, so replicas on different builds -- a phone on an older release, a hub at the
// newest -- can tell they differ. An event without one is format 1 (what C-430 wrote). A build keeps an event of a newer
// format and sends it on as it came, but folds it only once a build that reads it opens the database.

/** this engine as a build that reads formats up to `format` would be: events.ts's FORMAT changed, nothing else */
async function build(format: number): Promise<typeof v1> {
  vi.resetModules();
  vi.doMock("../src/events.js", async (original) => ({ ...(await original<typeof import("../src/events.js")>()), FORMAT: format }));
  try { return await import("../src/index.js"); } finally { vi.doUnmock("../src/events.js"); vi.resetModules(); }
}

describe.each(ENGINES)("the event format on %s", (_, make) => {
  const three = async () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall), hub = replica(make, "hub", wall), tablet = replica(make, "tablet", wall);
    const life = phone.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    const g = phone.make(life, "goal", { title: "Run" });
    await sync(phone, hub); await sync(phone, tablet);
    return { wall, phone, hub, tablet, life, g };
  };
  /** a change of a format this build does not read: an op it has never heard of, as a newer build might write */
  const newer = (from: Praxis, item: string): PxEvent => {
    from.set(item, "title", "made on a newer build");
    return { ...from.log(item).at(-1)!, v: FORMAT + 1, op: "rate" as PxEvent["op"], value: { stars: 5 } };
  };

  it("writes every change in this build's format, and sends it so", async () => {
    const { phone, life, g } = await three();
    expect(FORMAT).toBe(1);
    expect(phone.log(g).map((e) => [e.op, e.v])).toEqual([["make", FORMAT], ["set", FORMAT]]);   // made, and numbered
    expect(phone.missing({}).every((e) => e.v === FORMAT && e.space === life)).toBe(true);
  });

  it("reads an event with no format as format 1 -- the events written before the field", async () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall), hub = replica(make, "hub", wall);
    const life = phone.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    phone.state(phone.make(life, "step", { title: "Water the seedlings" }), "done");
    const old = phone.missing({}).map(({ v, ...e }) => e as PxEvent);
    expect(old.some((e) => "v" in e)).toBe(false);
    expect(hub.receive(old)).toEqual({ applied: old.length, known: 0, rejected: 0, newer: 0 });
    expect(hub.missing({}).every((e) => e.v === 1)).toBe(true);
    expect(hub.tables()).toEqual(phone.tables());
    expect(hub.ledger(life).map((x) => x.points)).toEqual([1]);
  });

  it("gives a log from before the field its column, every event format 1, and the same tables", () => {
    const wall = new Wall();
    const db: Db = make();
    const px = new Praxis(db, { replica: "phone", now: () => wall.t, random: seeded(1).bytes });
    const life = px.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    px.state(px.make(life, "goal", { title: "Plant a garden" }), "done");
    const before = px.tables();
    db.exec("ALTER TABLE px_events DROP COLUMN v; DELETE FROM px_meta WHERE key = 'format'");   // as C-430 left it
    const again = new Praxis(db, { now: () => wall.t });
    expect(again.tables()).toEqual(before);
    expect(db.prepare("SELECT value FROM px_meta WHERE key = 'format'").get()).toEqual({ value: "1" });
    expect(again.waiting()).toBe(0);
  });

  it("keeps an event of a newer format, sends it on as it came, and never folds it", async () => {
    const { wall, phone, hub, tablet, g } = await three();
    const e = newer(tablet, g);
    expect(hub.receive([e])).toEqual({ applied: 0, known: 0, rejected: 0, newer: 1 });
    expect(hub.receive([e])).toEqual({ applied: 0, known: 1, rejected: 0, newer: 0 });
    expect(hub.item(g)!.title).toBe("Run");                       // not folded
    expect(hub.waiting()).toBe(1);
    expect(hub.log(g).find((x) => x.id === e.id)).toEqual(e);       // kept as it came
    expect(hub.have()[e.space].tablet).toBe(e.hlc);                 // and counted as seen, so nothing is sent twice

    wall.tick(3);
    hub.set(g, "title", "Run a 5k");                                // after it: a batch of only the newer event must
    const late = replica(make, "late", wall);                       // not stop the exchange
    const r = await sync(hub, late, { batch: 1 });
    expect(r.toB).toBe(hub.missing({}).length);
    expect(late.log(g).find((x) => x.id === e.id)).toEqual(e);      // a relay on this build passes it on unchanged
    expect(late.item(g)!.title).toBe("Run a 5k");
    expect(late.tables()).toEqual(hub.tables());

    await sync(hub, phone);
    expect(phone.waiting()).toBe(1);
    expect(phone.tables()).toEqual(hub.tables());
  });

  it("refuses an event of a newer format whose envelope is not one", async () => {
    const { hub, tablet, g } = await three();
    const e = newer(tablet, g);
    for (const bad of [{ ...e, hlc: "yesterday" }, { ...e, v: 0 }, { ...e, v: "2" }, { ...e, v: 1.5 }, { ...e, op: "not an op" },
      { ...e, item: "x" }])
      expect(hub.receive([bad as PxEvent]), JSON.stringify(bad)).toEqual({ applied: 0, known: 0, rejected: 1, newer: 0 });
    expect(hub.waiting()).toBe(0);
    expect(v1.checkEvent(e)).toMatch(/newer than this build reads/);
    expect(v1.checkEnvelope(e)).toBeNull();
  });

  it("folds what an older build kept once a build that reads it opens the database, and unfolds it going back", async () => {
    const v2 = await build(FORMAT + 1);
    expect(v2.FORMAT).toBe(FORMAT + 1);
    const wall = new Wall();
    const db: Db = make();
    const phone = new Praxis(db, { replica: "phone", now: () => wall.t, random: seeded(1).bytes });
    const tablet = new v2.Praxis(make(), { replica: "tablet", now: () => wall.t, random: seeded(2).bytes });
    const life = phone.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    const g = phone.make(life, "goal", { title: "Run" });
    await sync(phone, tablet);                                      // the newer build reads the older's events
    expect(tablet.item(g)!.title).toBe("Run");

    wall.tick(2);
    tablet.set(g, "title", "Run a 10k");
    expect(tablet.log(g).at(-1)!.v).toBe(FORMAT + 1);
    await sync(phone, tablet);
    expect(phone.item(g)!.title).toBe("Run");                       // the older build keeps it, unfolded
    expect(phone.waiting()).toBe(1);
    const older = phone.tables();

    const updated = new v2.Praxis(db, { now: () => wall.t });       // the phone takes the newer build
    expect(updated.item(g)!.title).toBe("Run a 10k");
    expect(updated.waiting()).toBe(0);
    expect(updated.tables()).toEqual(tablet.tables());

    const back = new Praxis(db, { now: () => wall.t });             // and goes back to the older one
    expect(back.item(g)!.title).toBe("Run");
    expect(back.tables()).toEqual(older);
  });
});
