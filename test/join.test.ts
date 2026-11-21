import { describe, expect, it } from "vitest";
import { AHEAD, push, sync, type Praxis } from "../src/index.js";
import { ENGINES, LIFE, replica, Wall } from "./helpers.js";

// C-431: a phone that hosted alone joins a hub and loses nothing. Its space is JOINED to the hub's: read there from then
// on -- its items numbered by the hub's keeper (each keeping the number it had), its ARETE counted there -- while every
// one of its events stays its own, so the exchange is unchanged.

const titles = (px: Praxis, space: string) => px.items(space).map((i) => `${i.handle} ${i.title}`).sort();
const same = (a: Praxis, b: Praxis) => expect(a.tables()).toEqual(b.tables());

describe.each(ENGINES)("joining on %s", (_, make) => {
  /** a phone that hosted alone, and a hub, each with a LIFE of its own: a goal, two steps, one of them done */
  const apart = () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall), hub = replica(make, "hub", wall);
    const mine = phone.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    const pg = phone.make(mine, "goal", { title: "Learn the cello" });
    const ps = phone.make(mine, "step", { title: "Rent a cello" }, { parent: pg });
    phone.make(mine, "step", { title: "Find a teacher" }, { parent: pg });
    phone.state(ps, "done");
    wall.tick(5);
    const home = hub.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    const hg = hub.make(home, "goal", { title: "Paint the fence" });
    hub.state(hub.make(home, "step", { title: "Buy paint" }, { parent: hg }), "done");
    return { wall, phone, hub, mine, home, pg, ps };
  };

  it("reads the phone's LIFE in the hub's: its items numbered there, their old numbers kept, its ARETE counted", async () => {
    const { wall, phone, hub, mine, home, pg, ps } = apart();
    expect(await push(phone, hub)).toEqual({ sent: phone.missing({}).length, ahead: 0 });
    expect(hub.spaces().map((s) => s.id).sort()).toEqual([mine, home].sort());   // two LIFEs, side by side
    hub.join(mine, home);

    expect(titles(hub, home)).toEqual(["LIFE-1 Paint the fence", "LIFE-2 Buy paint", "LIFE-3 Learn the cello",
      "LIFE-4 Rent a cello", "LIFE-5 Find a teacher"]);
    expect(hub.items(mine)).toEqual([]);                           // read in its home now, not on its own
    expect(hub.space(mine)).toMatchObject({ joined: home, home });
    expect(hub.item(ps)).toMatchObject({ space: mine, home, number: 4, phase: "done" });
    expect(hub.writes(ps, "handle").map((w) => w.value)).toEqual([2]);   // the phone's own number, kept
    expect(hub.numbered(home, 3)!.id).toBe(pg);
    // ARETE: a step finished on each, paid once each, all of it counted in the home
    expect(hub.arete(home)).toBe(2);
    expect(hub.ledger(home).map((e) => e.item)).toContain(ps);
    expect(hub.arete(mine)).toBe(0);
    expect(hub.tree(home).map((n) => [n.item.title, n.children.map((c) => c.item.title)])).toEqual([
      ["Learn the cello", ["Rent a cello", "Find a teacher"]], ["Paint the fence", ["Buy paint"]]]);

    // the phone, still alone, adds a step and pushes again: only what is new is sent, and it lands in the home
    wall.tick(5);
    phone.make(mine, "step", { title: "Tune it" }, { parent: pg });
    expect(await push(phone, hub)).toMatchObject({ sent: 2 });     // the step, and the phone's own number for it
    expect(hub.item(phone.items(mine).at(-1)!.id)).toMatchObject({ home, number: 6, handle: "LIFE-6" });
    expect(await push(phone, hub)).toEqual({ sent: 0, ahead: 0 });

    // both ways, at last: the phone reads its LIFE in the hub's too, and the two hold the same tables
    await sync(phone, hub);
    same(phone, hub);
    expect(phone.items(mine)).toEqual([]);
    expect(titles(phone, home)).toEqual(titles(hub, home));
  });

  it("numbers in the home only: a joined space's own keeper numbers nothing more, and the home's keeper does", async () => {
    const { wall, phone, hub, mine, home } = apart();
    await push(phone, hub);
    hub.join(mine, home);
    await sync(phone, hub);
    wall.tick(5);
    const late = phone.make(mine, "step", { title: "Practise scales" });
    expect(phone.item(late)!.number).toBeNull();                   // the phone keeps its LIFE, but not the home
    expect(phone.item(late)!.handle).toMatch(/^LIFE-~/);
    await sync(phone, hub);
    expect(phone.item(late)).toMatchObject({ number: 6, handle: "LIFE-6" });
    same(phone, hub);
  });

  it("lets a parent, a move and a spend cross from a joined space to its home", async () => {
    const { phone, hub, mine, home, pg } = apart();
    await push(phone, hub);
    hub.join(mine, home);
    const s = hub.make(home, "step", { title: "Book a lesson" }, { parent: pg });   // under the phone's goal
    expect(hub.item(s)!.parent).toBe(pg);
    const hg = hub.items(home, { kind: "goal" }).find((g) => g.title === "Paint the fence")!;
    hub.move(s, hg.id);
    expect(hub.item(s)!.parent).toBe(hg.id);
    hub.spend(home, 1, { item: pg, reason: "a reward" });
    expect(hub.arete(home)).toBe(1);
    expect(() => hub.join(home, mine)).toThrow(/joined to it/);   // a loop, made here: refused
  });

  it("reads two joins that make a loop with the earliest-made space as their home, the same everywhere", async () => {
    const { phone, hub, mine, home } = apart();
    await sync(phone, hub);
    phone.join(mine, home);                                        // each joins its LIFE to the other's, unseen
    hub.join(home, mine);
    await sync(phone, hub);
    for (const px of [phone, hub]) {
      expect(px.space(mine)!.home).toBe(mine);                     // the phone's was made first
      expect(px.space(home)!.home).toBe(mine);
      expect(px.items(mine)).toHaveLength(5);
    }
    same(phone, hub);
  });

  it("reads a space on its own again when its join is undone, with its own numbers", async () => {
    const { phone, hub, mine, home, ps } = apart();
    await push(phone, hub);
    hub.join(mine, home);
    expect(hub.item(ps)!.number).toBe(4);
    hub.join(mine, null);
    expect(hub.item(ps)).toMatchObject({ home: mine, number: 2, handle: "LIFE-2" });
    expect(titles(hub, home)).toEqual(["LIFE-1 Paint the fence", "LIFE-2 Buy paint"]);
    hub.join(mine, home);
    expect(hub.item(ps)!.number).toBe(4);                          // the home's number for it, kept from before
  });

  it("opens a database from before joins (v0.1.0) with the columns added and the same tables", async () => {
    const { phone, hub, mine, home } = apart();
    await push(phone, hub);
    const before = hub.tables();
    hub.db.exec("DROP INDEX px_items_home; DROP INDEX px_items_numbered; DROP INDEX px_items_kinds; DROP INDEX px_spaces_home; " +
      "ALTER TABLE px_items DROP COLUMN home; ALTER TABLE px_spaces DROP COLUMN joined; ALTER TABLE px_spaces DROP COLUMN home");
    const again = new (hub.constructor as typeof Praxis)(hub.db, { now: () => Date.now() });
    expect(again.tables()).toEqual(before);
    again.join(mine, home);
    expect(again.items(home)).toHaveLength(5);
  });

  it("folds a join the same whatever order it arrives in -- before the space it names, before the items it moves", async () => {
    const { phone, hub, mine, home } = apart();
    await push(phone, hub);
    hub.join(mine, home);
    const events = hub.missing({});
    for (const order of [events, [...events].reverse(), [...events].sort((a, b) => (a.id < b.id ? -1 : 1))]) {
      const late = replica(make, "late", new Wall());
      for (const e of order) late.receive([e]);
      same(late, hub);
    }
  });
});

describe.each(ENGINES)("the exchange on %s (C-431)", (_, make) => {
  it("holds back a time further ahead than AHEAD, so one wrong clock cannot drag every replica's with it", async () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall, 3 * 24 * 3600_000), hub = replica(make, "hub", wall);   // three days fast
    const life = phone.makeSpace({ title: "Life", prefix: "LIFE", form: LIFE, reach: "home" });
    phone.make(life, "goal", { title: "Run" });
    expect(await push(phone, hub)).toEqual({ sent: 0, ahead: phone.missing({}).length });
    expect(hub.have()).toEqual({});
    hub.makeSpace({ title: "Hub's", form: LIFE, reach: "home" });
    expect(hub.log(hub.spaces()[0].id)[0].hlc < phone.log(life)[0].hlc).toBe(true);   // its clock was not moved on
    wall.tick(3 * 24 * 3600_000 - AHEAD + 60_000);                 // until the hub's own clock comes within a day
    expect(await push(phone, hub)).toMatchObject({ sent: phone.missing({}).length, ahead: 0 });
    expect(hub.items(life).map((i) => i.title)).toEqual(["Run"]);
  });

  it("sends only the reaches it is asked for -- and never THIS PHONE", async () => {
    const wall = new Wall();
    const phone = replica(make, "phone", wall), hub = replica(make, "hub", wall);
    const home = phone.makeSpace({ title: "Life", form: LIFE, reach: "home" });
    const lab = phone.makeSpace({ title: "Lab", form: LIFE, reach: "shared" });
    phone.makeSpace({ title: "Diary", form: LIFE, reach: "phone" });
    await push(phone, hub, { reaches: ["home"] });
    expect(hub.spaces().map((s) => s.id)).toEqual([home]);
    await push(phone, hub, { reaches: ["home", "shared", "phone"] });
    expect(hub.spaces().map((s) => s.id)).toEqual([home, lab]);
  });
});
