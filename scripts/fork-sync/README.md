# Fork sync launcher (`Run_windows.bat`)

This folder belongs to the `B0904/CCC_openwhispr` fork, not to OpenWhispr. It
lets the fork be cloned once and then kept up to date and running by
double-clicking `Run_windows.bat` in the repository root. No git or npm
commands are needed afterwards.

## What one double-click does

1. `Run_windows.bat` starts `run.ps1` (Windows PowerShell, always present).
2. `run.ps1` finds Node.js with the major version pinned in `.nvmrc`. If the
   PC has none, it downloads a private, checksum-verified copy from nodejs.org
   into `%LOCALAPPDATA%\CCC_openwhispr\node\` and uses only that for this app.
3. `sync-and-run.js` then, in order:
   - makes sure the folder is a git clone with `origin` = this fork and
     `upstream` = `OpenWhispr/openwhispr` (a GitHub ZIP download is converted
     in place; a shallow clone is deepened; git itself is downloaded as
     portable MinGit if the PC has none);
   - commits any local edits as `Local changes on <pc> (<date>)`, so nothing
     is lost and nothing blocks a merge (files over 50 MB are left alone);
   - pulls the fork's `main` from GitHub;
   - merges the newest **published** OpenWhispr release (`vX.Y.Z`, taken from
     the GitHub Releases API, falling back to the newest tag). Commits on the
     OpenWhispr `main` branch that are not part of a release are never taken;
   - pushes the result back to the fork on GitHub;
   - runs `npm install` only when `package.json` / `package-lock.json` changed
     (a marker in `node_modules/.ccc-fork-sync.json` remembers the last
     install), then adds the Windows-only optional packages that npm skips;
   - starts the app with `npm run dev`. In development mode the app's own
     auto-updater is off, so it never replaces this fork with the official
     build.

Every sync step is best-effort. Offline, a rejected push or a merge conflict
becomes a warning in the summary and the app still starts on the code that is
checked out.

## Conflicts

A conflict only in `package-lock.json` is resolved automatically: the
OpenWhispr lockfile is taken and `npm install` re-adds the fork's packages.
Any other conflict is undone (`git merge --abort`), reported, and retried on
every run until someone resolves it by hand. Keeping the fork's own changes in
new files, or in small isolated edits, keeps this rare.

## Options

```
Run_windows.bat              sync, install, start
Run_windows.bat --no-sync    start without touching GitHub
Run_windows.bat --sync-only  sync and install, do not start
Run_windows.bat --reinstall  force a fresh npm install
Run_windows.bat --help
```

A log of every run is kept at `%LOCALAPPDATA%\CCC_openwhispr\fork-sync.log`.

## Tests

`test/scripts/forkSync.test.js` runs the sync logic against temporary git
repositories (an upstream with releases, a fork, a clone) and is part of
`npm test`. `run.ps1` is Windows-only and is checked with `pwsh -c` for syntax.
