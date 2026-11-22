// C-469: PRAXIS runs on the phone too (C-111) -- no node:*, no fs, and nothing imported from the companion.
// WORKING MEMORY (the user, 2026-11-22: "there should be a project which represents the working memory of daemon"; by
// multiple choice, every daemon, one form; PROJECTS.md 8). Every daemon account keeps one space of what it has in mind
// NOW -- the part before the night's memory, small, and not meant to last:
//
//   about seven     SPAN held at most, as working memory is; a new one lets go the one held longest without being
//                   touched again, and touching one (rehearsing it) keeps it
//   rewritten       an item is ABOUT one thing (a talk's thread, the goal's step, what was noticed): holding the same
//                   thing again rewrites its words, it is never held twice. The log keeps every version, so nothing is
//                   lost to the record, only to the daemon's attention
//   let go          never deleted: its state is "let go", out of mind
//   unpaid          no points: a mind is not paid for holding
//
// The companion holds its daemon's (C-469); each lane's agent holds its own on EUDAIMONIA (E-12). Both read it here.

import type { By, Item, Praxis } from "./engine.js";
import type { Form } from "./form.js";

/** what a daemon holds in mind at once */
export const SPAN = 7;

export const WORKING_MEMORY: Form = {
  name: "working-memory",
  version: 1,
  kinds: {
    held: {
      title: "Held",
      states: [{ name: "held", phase: "doing" }, { name: "let-go", phase: "aside", title: "let go" }],
      fields: {
        about: { type: "text", title: "what it is about: holding the same thing again rewrites it" },
        from: { type: "text", title: "where it came from: a talk, the goal, the day, a handoff" },
        rehearsed: { type: "date", title: "when it was last held or touched (an ISO time)" },
      },
    },
  },
  views: [{ name: "now", most: SPAN }],
};

const iso = (at: number) => new Date(at).toISOString();
const when = (it: Item) => (typeof it.fields.rehearsed === "string" ? it.fields.rehearsed : it.made);
const aboutOf = (it: Item) => (typeof it.fields.about === "string" ? it.fields.about : it.title.toLowerCase());

/** what the daemon has in mind now, the most lately rehearsed first */
export function inMind(px: Praxis, space: string): Item[] {
  return px.items(space, { kind: "held", phase: "doing" }).sort((a, b) => when(b).localeCompare(when(a)) || b.id.localeCompare(a.id));
}

/** a thing held in mind: the words for what it is `about` -- rewritten if it is held already, else held anew, letting go
 *  of the least rehearsed past SPAN. Returns the item's id. */
export function hold(px: Praxis, space: string, words: string, o: { about?: string; from?: string; at?: number } & By = {}): string {
  const title = words.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!title) throw new Error("nothing to hold");
  const about = (o.about ?? title.toLowerCase()).slice(0, 200), at = iso(o.at ?? Date.now()), by: By = { actor: o.actor };
  return px.transaction(() => {
    const had = inMind(px, space).find((it) => aboutOf(it) === about);
    if (had) {
      if (had.title !== title) px.set(had.id, "title", title, by);
      if (o.from !== undefined && had.fields.from !== o.from) px.set(had.id, "from", o.from, by);
      px.set(had.id, "rehearsed", at, by);
      return had.id;
    }
    const id = px.make(space, "held", { title, about, rehearsed: at, ...(o.from !== undefined ? { from: o.from } : {}) }, by);
    for (const old of inMind(px, space).slice(SPAN)) px.state(old.id, "let-go", by);
    return id;
  });
}

/** a held thing touched again: it stays in mind longer */
export function rehearse(px: Praxis, item: string, o: { at?: number } & By = {}) {
  px.set(item, "rehearsed", iso(o.at ?? Date.now()), { actor: o.actor });
}

/** one thing let go, or (no item) everything held: the night, once it has made its memory */
export function letGo(px: Praxis, space: string, item?: string, o: By = {}): number {
  const going = item ? inMind(px, space).filter((it) => it.id === item) : inMind(px, space);
  px.transaction(() => { for (const it of going) px.state(it.id, "let-go", o); });
  return going.length;
}
