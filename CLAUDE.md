# daemons-praxis -- for a session working here

PRAXIS's engine, for the DAEMONS companion and the site EUDAIMONIA. Read `README.md` first; the design is the
companion's `docs/PROJECTS.md` (section 4 is this repository, section 5 its sync).

- **`src/` runs on the phone too** (expo-sqlite, Hermes): no `node:*`, no package, nothing from any app -- only its own
  files, each saying so on its first line. `test/portable.test.ts` fails otherwise.
- **The event format is a promise between builds** (C-435; README "The event format"). Never change the envelope. Raise
  `FORMAT` in `src/events.ts` with any change an older build would fold wrongly, teach `formatFor` which changes need it
  (C-431: every other event stays in the oldest format that reads it), and test it in `test/format.test.ts`.
- **Test with Node 22.13 or later**: `npm test` and `npm run typecheck`, both clean before a commit.
- **Release by tag** (`vX.Y.Z` on `main`, pushed); each app moves its pin itself, in its own repository.
- Tickets are the companion's `C-` ids, held in Redmine; commit messages and code comments cite them.
- This repository is **public**: nothing personal goes in it. DAEMONS is said **DAY-mons**.
