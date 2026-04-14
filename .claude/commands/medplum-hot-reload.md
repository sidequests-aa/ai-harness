---
description: Run the seed with a locally-built, hot-reloading Medplum monorepo (instead of npm @medplum/*)
---

Run the seed's Vite dev server linked against a locally-cloned Medplum monorepo so edits to Medplum source rebuild and hot-reload into the seed.

**Caveat to print up front:** DESIGN.md §0 deliberately rejected cloning the Medplum monorepo because of its 5–15 min install time. This command opts *into* that cost — it is a debugging/exploration workflow, not the canonical demo path. Do not run this during the live demo.

**Expected sibling layout:**
```
C:/Users/Alex/Projects/intrahealth/
├── intrahealth-harness/     ← this repo
└── medplum/                 ← medplum/medplum cloned here
```

---

**Step 1 — prerequisites.** Check if `C:/Users/Alex/Projects/intrahealth/medplum/package.json` exists. If not, stop and instruct the user to run this setup (do NOT run it for them without confirmation — the install is heavy):

```bash
cd C:/Users/Alex/Projects/intrahealth
git clone https://github.com/medplum/medplum.git
cd medplum
npm ci                          # 5–15 min, one-time
npm run build                   # first full build so each package has dist/
```

Then tell them to rerun `/medplum-hot-reload`.

---

**Step 2 — link local Medplum into the seed.**

The seed depends on these 4 packages (check `seed/package.json` to confirm):
- `@medplum/core`
- `@medplum/react`
- `@medplum/mock`
- `@medplum/fhirtypes`

Each maps to `medplum/packages/<name>/` in the monorepo.

Verify the link state: run `node -e "console.log(require.resolve('@medplum/core'))"` from `seed/`. If the resolved path is inside `seed/node_modules/@medplum/core/` with no symlink to `../../../medplum`, linking is not set up.

**Two linking approaches — prefer (A):**

**(A) npm overrides (recommended, persistent):**

Add to `seed/package.json`:
```json
"overrides": {
  "@medplum/core": "file:../../medplum/packages/core",
  "@medplum/react": "file:../../medplum/packages/react",
  "@medplum/mock": "file:../../medplum/packages/mock",
  "@medplum/fhirtypes": "file:../../medplum/packages/fhirtypes"
}
```

Then `cd seed && npm install` to materialize the links.

**(B) npm link (transient):**
```bash
cd C:/Users/Alex/Projects/intrahealth/medplum/packages/core && npm link
# repeat for react, mock, fhirtypes
cd C:/Users/Alex/Projects/intrahealth/intrahealth-harness/seed
npm link @medplum/core @medplum/react @medplum/mock @medplum/fhirtypes
```

Ask the user which approach they prefer before modifying files. Default to (A) if they don't say.

---

**Step 3 — start the watchers in parallel.**

Terminal 1 (Medplum build watcher — rebuilds dist/ on source change):
```bash
cd C:/Users/Alex/Projects/intrahealth/medplum
npm run dev
```

Terminal 2 (seed Vite dev server — HMR):
```bash
cd C:/Users/Alex/Projects/intrahealth/intrahealth-harness/seed
npm run dev
```

Use the Bash tool with `run_in_background: true` for both so they don't block. Capture the PIDs. Wait for Vite to print its local URL and report it.

---

**Step 4 — verify HMR is wired.**

Print these manual sanity checks the user can try:
1. Edit a file under `medplum/packages/core/src/` (e.g. add a `console.log` to an exported function the seed imports). Save.
2. The Medplum watcher rebuilds `medplum/packages/core/dist/`.
3. Vite picks up the changed dep and triggers HMR in the browser.

**Known caveats:**
- Vite HMR through `file:` deps works but is less reliable than intra-project HMR. If a change doesn't reflect, kill and restart Vite (Ctrl+C, `npm run dev`).
- Medplum's monorepo uses turbo; package-granular rebuilds can take 2–10s. HMR latency = Medplum rebuild + Vite refresh.
- If a Medplum package's `package.json` `exports` field doesn't expose the changed path, Vite won't see it. Check the package's export map.
- If the user changes Medplum source but sees no rebuild, they may need to run the package's own `npm run dev` or `build:watch` — `npm run dev` at the monorepo root doesn't always catch every package.

Report both PIDs, the Vite URL, and the first terminal output from each process.
