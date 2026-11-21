// C-429: PRAXIS runs on the phone too (C-111) -- no node:*, no fs, and nothing imported from the companion.
// The event (PROJECTS.md 4.4): every change is one, append-only, and the tables are a fold of them. History is the log,
// undo is a compensating event, and sync is sending events. This file says what a well-formed event is; an event from
// another replica that is not one is refused before it is kept -- unless it is of a newer format than this build reads,
// when only its envelope can be checked, and it is kept unfolded (FORMAT, C-435).

import { parseHlc } from "./hlc.js";
import { UUID } from "./ids.js";

export const OPS = ["make", "set", "move", "link", "unlink", "state", "note", "effort", "award", "spend",
  "propose", "accept", "decline", "archive"] as const;
export type Op = typeof OPS[number];

/** what an AI (or anyone) may propose: a change that counts only once it is accepted */
export const PROPOSABLE: readonly Op[] = ["make", "set", "move", "link", "unlink", "state", "note", "effort", "award", "archive"];

/** C-435: the newest event format this build folds. Every event carries its format as `v`, so replicas on different
 *  builds (a phone on an older release, a hub at the newest) can tell they differ; an event without one is format 1,
 *  the events written before the field. A build folds every format up to its own. One of a newer format is kept and
 *  sent on as it came, never folded, until a build that reads it opens the database (engine.ts). What a format may
 *  change is what an event says -- its op, field and value; the ENVELOPE is the same in every format (v, id, space,
 *  item, op, field, actor, replica, hlc), so an older build can still keep, order and pass on an event it cannot read.
 *  A newer format puts anything new inside the value.
 *
 *  C-431: format 2 joins one space to another (formatFor). An event is written in the OLDEST format that reads it as it
 *  is meant, not always the newest, so a build that reads only format 1 still folds every change but a join. */
export const FORMAT = 2;
/** an event's format: 1 when it carries none */
export const formatOf = (e: { v?: unknown }): number => (e.v === undefined ? 1 : (e.v as number));

/** C-431: the fields format 2 added -- a space's `joined` (the space it is read in), and the number its new home gives an
 *  item of a joined space (`handle.<home>`) */
const joins = (field: unknown) => field === "joined" || (typeof field === "string" && field.startsWith("handle."));
/** the oldest format that folds a change as it is meant: the format an event of it is written in */
export function formatFor(op: Op, field?: unknown, value?: unknown): number {
  if (op === "set" && joins(field)) return 2;
  if (op === "propose" && obj(value) && value.op === "set" && joins(value.field)) return 2;
  return 1;
}

export interface PxEvent {
  v?: number;          // its format (FORMAT above); absent is 1
  id: string;          // a UUIDv7
  space: string;       // the SPACE it belongs to -- the unit of sharing and of sync
  item: string;        // the ITEM it changes (the space itself, for a change to the space)
  op: Op;
  field?: string;      // set: the field; award, spend: the entry's key
  value?: unknown;     // what the op carries (below)
  actor: string;       // who: a person, the daemon, a device, an agent
  replica: string;     // which copy wrote it
  hlc: string;         // when (hlc.ts)
}
//  make     { kind, ...the fields it starts with }          the space is made with kind "space"
//  set      the field's new value; a long body is { text, base } (base: the write it was made over)
//  move     { parent, position }
//  state    the state's name                                archive   true or false
//  link     { type, to }                                    unlink    { link }: the link event it takes away
//  note     { text }                                        effort    { seconds, note? }
//  award, spend   { points, reason? }, or { back: true } to take the entry with that key back
//  propose  { op, field?, value? }: the change proposed     accept, decline   { proposal }

/** a long body as a field holds it: its text, and the write it was made over (null for the first) */
export interface Long { text: string; base: string | null }
export const isLong = (v: unknown): v is Long => typeof v === "object" && v !== null && !Array.isArray(v) &&
  typeof (v as Long).text === "string" && "base" in v && Object.keys(v).length === 2 &&
  ((v as Long).base === null || typeof (v as Long).base === "string");

export const NAME = /^[\w.:@-]{1,64}$/;            // a replica, an actor, a field, a kind, a state, a key
export const POSITION = /^[0-9A-Za-z]{0,1023}[1-9A-Za-z]$/;   // position.ts's keys, which never end in "0"
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string";
const points = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9;

/** what is wrong with a change's op, field and value, or null when nothing is */
export function checkChange(op: Op, field: unknown, value: unknown): string | null {
  switch (op) {
    case "make":
      if (!obj(value) || !str(value.kind) || !NAME.test(value.kind as string)) return "make needs { kind }";
      if (Object.keys(value).some((k) => !NAME.test(k))) return "make's fields are names";
      return value.position === undefined || (str(value.position) && POSITION.test(value.position as string))
        ? null : "make's position is a position";
    case "set": return str(field) && NAME.test(field as string) && value !== undefined ? null : "set needs a field and a value";
    case "move": return obj(value) && (value.parent === null || str(value.parent)) && str(value.position) &&
      POSITION.test(value.position as string) ? null : "move needs { parent, position }";
    case "state": return str(value) && NAME.test(value as string) ? null : "state needs a state's name";
    case "archive": return typeof value === "boolean" ? null : "archive needs true or false";
    case "link": return obj(value) && str(value.type) && NAME.test(value.type as string) && str(value.to) ? null : "link needs { type, to }";
    case "unlink": return obj(value) && str(value.link) ? null : "unlink needs { link }";
    case "note": return obj(value) && str(value.text) ? null : "note needs { text }";
    case "effort": return obj(value) && typeof value.seconds === "number" && Number.isFinite(value.seconds)
      ? null : "effort needs { seconds }";
    case "award": case "spend":
      if (!str(field) || !NAME.test(field as string)) return `${op} needs a key`;
      return obj(value) && (value.back === true || points(value.points)) ? null : `${op} needs { points } or { back: true }`;
    case "propose": {
      if (!obj(value) || !str(value.op) || !PROPOSABLE.includes(value.op as Op)) return "propose needs { op } of a change";
      return checkChange(value.op as Op, value.field, value.value);
    }
    case "accept": case "decline": return obj(value) && str(value.proposal) ? null : `${op} needs { proposal }`;
  }
}

/** what is wrong with an event's envelope (FORMAT), the part every format shares, or null when nothing is */
export function checkEnvelope(e: unknown): string | null {
  if (!obj(e)) return "not an object";
  if (e.v !== undefined && !(Number.isSafeInteger(e.v) && (e.v as number) >= 1)) return "v is not a format";
  for (const k of ["id", "space", "item"] as const) if (!str(e[k]) || !UUID.test(e[k] as string)) return `${k} is not an id`;
  if (!str(e.op) || !NAME.test(e.op as string)) return "op is not a name";
  for (const k of ["actor", "replica"] as const) if (!str(e[k]) || !NAME.test(e[k] as string)) return `${k} is not a name`;
  const h = str(e.hlc) ? parseHlc(e.hlc as string) : null;
  if (!h || h.replica !== e.replica) return "hlc is not this replica's time";
  if (e.field !== undefined && (!str(e.field) || !NAME.test(e.field as string))) return "field is not a name";
  return null;
}

/** what is wrong with an event, for a build that reads formats up to `format`, or null when nothing is. An event of a
 *  newer format than that is never well-formed here: only its envelope can be read (checkEnvelope). */
export function checkEvent(e: unknown, format = FORMAT): string | null {
  const bad = checkEnvelope(e);
  if (bad) return bad;
  const ev = e as Record<string, unknown>;
  if (formatOf(ev) > format) return `format ${ev.v} is newer than this build reads (${format})`;
  if (!OPS.includes(ev.op as Op)) return "no such op";
  // a change written in a format too old for it would be folded wrongly by a build of that format
  const needs = formatFor(ev.op as Op, ev.field, ev.value);
  if (formatOf(ev) < needs) return `a change of format ${needs} cannot be format ${formatOf(ev)}`;
  return checkChange(ev.op as Op, ev.field, ev.value);
}
