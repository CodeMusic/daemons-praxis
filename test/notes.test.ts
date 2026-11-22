// v0.3.0: a note may say when it was written; a database from before that gains the column and is folded again.
import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vitest";
import { Praxis, type Db } from "../src/index.js";
it("adds the at column to a database from before it, and folds again", () => {
  const d = new DatabaseSync(":memory:");
  const form = { name: "T", version: 1, kinds: { step: { title: "Step", states: [{ name: "open", phase: "open" as const }] } } };
  const px = new Praxis(d as unknown as Db);
  const s = px.makeSpace({ title: "Life", form });
  const i = px.make(s, "step", { title: "a" });
  px.note(i, "old");
  d.exec("ALTER TABLE px_notes DROP COLUMN at");
  const again = new Praxis(d as unknown as Db);
  expect(again.notes(i).map((n) => [n.text, n.at])).toEqual([["old", null]]);
  again.note(i, "new", { at: "2026-11-01T00:00:00Z" });
  expect(again.notes(i).map((n) => n.at)).toEqual([null, "2026-11-01T00:00:00Z"]);
});
