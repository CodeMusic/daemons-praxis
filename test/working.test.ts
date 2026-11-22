import { describe, expect, it } from "vitest";
import { checkForm, hold, inMind, letGo, rehearse, SPAN, WORKING_MEMORY } from "../src/index.js";
import { ENGINES, replica, Wall } from "./helpers.js";

// C-469: WORKING MEMORY -- about seven held, rewritten rather than appended, the least rehearsed let go
describe.each(ENGINES)("working memory on %s", (_, make) => {
  const fresh = () => {
    const wall = new Wall();
    const px = replica(make, "hub", wall, 0, "daemon");
    const mind = px.makeSpace({ title: "Working memory", prefix: "HELD", form: WORKING_MEMORY, reach: "home" });
    let t = Date.UTC(2026, 10, 22, 9);
    const at = () => (t += 60_000);
    return { px, mind, at, wall };
  };

  it("is a form like any other, and pays nothing for holding", () => {
    expect(checkForm(WORKING_MEMORY)).toEqual([]);
    expect(WORKING_MEMORY.kinds.held.points ?? 0).toBe(0);
    expect(SPAN).toBe(7);
  });

  it("holds the same thing once, its words rewritten, and keeps every version in the log", () => {
    const { px, mind, at } = fresh();
    const a = hold(px, mind, "the goal's step: buy soil", { about: "goal", from: "goal", at: at() });
    const b = hold(px, mind, "the goal's step: dig the bed", { about: "goal", from: "goal", at: at() });
    expect(b).toBe(a);
    expect(inMind(px, mind).map((it) => it.title)).toEqual(["the goal's step: dig the bed"]);
    expect(px.versions(a, "title").length + px.writes(a, "title").length).toBeGreaterThanOrEqual(2);
    expect(px.item(a)!.maker).toBe("daemon");
    expect(() => hold(px, mind, "   ")).toThrow(/nothing/);
  });

  it("holds about seven: a new one lets go the least rehearsed, and rehearsing one keeps it", () => {
    const { px, mind, at } = fresh();
    const ids = Array.from({ length: SPAN }, (_, i) => hold(px, mind, `thing ${i}`, { at: at() }));
    rehearse(px, ids[0], { at: at() });                       // the oldest, touched again
    hold(px, mind, "something new", { at: at() });
    const now = inMind(px, mind);
    expect(now.length).toBe(SPAN);
    expect(now[0].title).toBe("something new");
    expect(now.map((it) => it.id)).toContain(ids[0]);         // kept by the rehearsal
    expect(now.map((it) => it.id)).not.toContain(ids[1]);     // the least rehearsed, let go
    expect(px.item(ids[1])).toMatchObject({ state: "let-go", phase: "aside" });
    expect(px.arete(mind)).toBe(0);
  });

  it("lets everything go at night, and a thing held again after is new", () => {
    const { px, mind, at } = fresh();
    const a = hold(px, mind, "you said you would call", { about: "talk:call", from: "talk", at: at() });
    hold(px, mind, "the rain", { from: "day", at: at() });
    expect(letGo(px, mind)).toBe(2);
    expect(inMind(px, mind)).toEqual([]);
    expect(hold(px, mind, "you said you would call", { about: "talk:call", at: at() })).not.toBe(a);
    expect(letGo(px, mind, a)).toBe(0);                       // let go already
  });
});
