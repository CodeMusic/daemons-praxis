# PRAXIS -- the engine

PRAXIS is the project system under the [DAEMONS companion](https://github.com/CodeMusic/daemons-companion)'s life
management: goals, journals, tending, and any project a person runs. Its points are **ARETE**. The design is the
companion's [`docs/PROJECTS.md`](https://github.com/CodeMusic/daemons-companion/blob/main/docs/PROJECTS.md); this
repository is its section 4, the engine (C-429). It was a package inside the companion until two apps needed it, and it
came out with its history (C-435): the companion and the site EUDAIMONIA each pin it by tag.

It imports **nothing from the companion and no package at all**: it runs on the phone's expo-sqlite and Node's
`node:sqlite` through the same small `Db` interface the companion's Store uses (C-111). `test/portable.test.ts` holds it
to that.

## What it is

- **One append-only log.** Every change is an event, `{ v, id, space, item, op, field?, value?, actor, replica, hlc }`,
  with ops `make set move link unlink state note effort award spend propose accept decline archive`. The tables
  (`px_*`) are a fold of the log and can be rebuilt from it at any time (`rebuild()`).
- **Ids** are UUIDv7s, made anywhere, offline. An id two replicas must make alike (an award, an accepted proposal's
  change) is a UUIDv8 derived from a SHA-256 of what it names. The SHA-256 is plain TypeScript, so the phone and the
  hub derive the same id.
- **A hybrid logical clock** orders every event, so "the later write wins" means the same thing on every replica, and a
  change made after reading another always comes later, even from a slow clock.
- **SPACES, KINDS, STATES, FIELDS and FORMS.** A space is made from a form (data: kinds, each with states in four
  phases, open, doing, done and aside, and typed fields). Taking a newer form is an event.
- **Handles** (`LIFE-12`) are numbered by the space's keeper, provisional (`LIFE-~a3f2`) until then, kept once given. A
  kind with a `prefix` of its own is numbered on its own (`STEP-17`; kinds sharing a prefix share its numbers), and the
  keeper may give an item a chosen number as it is made (`make(..., { number })`), so items brought in from elsewhere
  keep the numbers they had (C-430: GOALS).

## How two replicas merge

| What | Rule |
|---|---|
| a field | the later write wins; every write is kept (`writes()`) and can be set again |
| a long body | the same, and a write that lost to one it never saw is set aside (`versions()`) |
| links, tags, a checklist | added and removed by event id: a concurrent add stands |
| a parent | a field; two moves that make a loop set the later aside (`tree()`) |
| ARETE | awards and spends are entries, summed. An award's id comes from its item and key (`finish:1`), so two replicas that finish one step offline pay once. Undo takes it back, and finishing again pays once. A rule can say what a finish pays (`state(item, "done", { pay })`, under its own cap), and a finish paid nothing is still an entry, so every finish can be read from the ledger (`ledger(space, { since })`, each entry with its item's kind) |
| a proposal | counts only once accepted; an accept anywhere takes it |

## Sync

`have()` says what a replica has seen (per space, the latest time from each replica). `missing(have)` is what the
other lacks, and `receive(events)` takes it. `sync(a, b)` runs the exchange both ways over any `Peer`, so the transport
does not matter. A space whose reach is `phone` is never sent. Which replicas may exchange which spaces, and blobs,
come in C-431.

## The event format

Replicas run different builds: a phone on last month's release syncs with a hub on today's. So **every event carries
its format as `v`** (`FORMAT` in `src/events.ts`; it is 1). An event without one is format 1, which is what the engine
wrote before the field, and a log from then is given the column, every event at 1, the first time it is opened.

- **A build folds every format up to its own.** An event of a newer format is checked as far as its **envelope** (`v`,
  `id`, `space`, `item`, `op`, `field`, `actor`, `replica`, `hlc`), **kept and sent on as it came, but not folded**.
  `receive()` counts it as `newer`, and `waiting()` says how many the log holds. Because the log holds it, `have` stays
  true, nothing is sent twice, and a replica on an older build still relays it to one that reads it.
- **When a build that reads it opens the database, the tables are folded again**, and what waited is in them. Going back
  to an older build folds again without it. The format of the build that last opened a database is in `px_meta`.
- **The envelope never changes.** A new format may change what an event says -- a new op, a new field, a new value --
  and puts anything new inside `value`. Raise `FORMAT` in the same commit as any change an older build would fold
  wrongly, and say so in the tag's notes.

`test/format.test.ts` runs an older and a newer build against one database.

## Use

In an app's `package.json`, pinned by tag:

```json
"dependencies": { "@daemons/praxis": "git+https://github.com/CodeMusic/daemons-praxis.git#v0.1.0" }
```

```ts
import { Praxis } from "@daemons/praxis";
const px = new Praxis(db);                 // a node:sqlite DatabaseSync, or fromExpo(openDatabaseSync(...))
const life = px.makeSpace({ title: "Life", prefix: "LIFE", form, reach: "home" });
const step = px.make(life, "step", { title: "Water the seedlings" });
px.state(step, "done");                    // pays the step's ARETE, once
```

The package is TypeScript source (`src/`); nothing is compiled. Its files import each other as `./x.js`, as Node's
ESM does, so a bundler is told to resolve that to `x.ts`. **tsx and vitest** do it already. **Metro** needs a line in
`metro.config.js`'s `resolveRequest` (the companion's `app/metro.config.js` has it).

The companion's GOALS are the first use (`server/src/goals.ts`, C-430): a LIFE space, its form's rules paying ARETE
under daily caps, behind the routes the app and the boards already call.

## Test

Node 22.13 or later: `npm install`, then `npm test` and `npm run typecheck` (GitHub runs both at every push). Every
suite runs twice, on `node:sqlite` and through `fromExpo()` over expo-sqlite's call shapes. The native expo-sqlite
itself is only exercised on a phone. `test/converge.test.ts` has three replicas with skewed clocks make random changes
and exchange them at random. They must end with the same tables and the same ARETE, and so must fresh replicas that
receive every event one at a time in shuffled orders.

## Releasing

A release is a tag, `v<major>.<minor>.<patch>`, on `main`, with its tests passing. Each app moves its pin when it is
ready. A new `FORMAT` is at least a minor release. The tickets are the companion's (`C-` ids).
