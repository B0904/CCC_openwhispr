const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const forkSync = require("../../scripts/fork-sync/sync-and-run.js");

const NODE_MAJOR = process.versions.node.split(".")[0];

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), "utf8");
}

function packageJson(version, extraDeps = {}) {
  return `${JSON.stringify(
    {
      name: "demo",
      version,
      description: "fork-sync test fixture",
      private: true,
      keywords: ["one", "two", "three"],
      dependencies: { base: "1.0.0", ...extraDeps },
    },
    null,
    2
  )}\n`;
}

/**
 * Builds: an OpenWhispr-like upstream (work clone + bare), a fork of it (bare
 * "origin") and a working clone of the fork, all on disk, with an isolated git
 * config so the script has to provide its own identity.
 */
function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-sync-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const emptyConfig = path.join(root, "empty-gitconfig");
  fs.writeFileSync(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  const git = (cwd, ...args) => {
    const result = spawnSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args],
      { cwd, encoding: "utf8", env }
    );
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
    return result.stdout;
  };

  const upstreamWork = path.join(root, "upstream-work");
  fs.mkdirSync(upstreamWork);
  git(upstreamWork, "init", "-q");
  git(upstreamWork, "symbolic-ref", "HEAD", "refs/heads/main");
  write(upstreamWork, "package.json", packageJson("1.0.0"));
  write(upstreamWork, "package-lock.json", "lockfile for 1.0.0\n");
  write(upstreamWork, "app.js", "console.log('v1.0.0');\n");
  write(upstreamWork, ".nvmrc", `${NODE_MAJOR}\n`);
  git(upstreamWork, "add", "-A");
  git(upstreamWork, "commit", "-q", "-m", "release 1.0.0");
  git(upstreamWork, "tag", "-a", "v1.0.0", "-m", "v1.0.0");

  const upstreamBare = path.join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", upstreamWork, upstreamBare);
  const originBare = path.join(root, "origin.git");
  git(root, "clone", "-q", "--bare", upstreamBare, originBare);
  const clone = path.join(root, "clone");
  git(root, "clone", "-q", originBare, clone);

  const world = { root, env, git, upstreamWork, upstreamBare, originBare, clone };

  world.upstreamCommit = (message, files) => {
    for (const [rel, content] of Object.entries(files)) write(upstreamWork, rel, content);
    git(upstreamWork, "add", "-A");
    git(upstreamWork, "commit", "-q", "-m", message);
    git(upstreamWork, "push", "-q", upstreamBare, "main");
  };
  world.upstreamRelease = (version, files) => {
    world.upstreamCommit(`release ${version}`, files);
    git(upstreamWork, "tag", "-a", `v${version}`, "-m", `v${version}`);
    git(upstreamWork, "push", "-q", upstreamBare, `refs/tags/v${version}`);
  };
  world.commitInClone = (message, files, dir = clone) => {
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  };
  world.head = (dir = clone) => git(dir, "rev-parse", "HEAD").trim();
  world.status = (dir = clone) => git(dir, "status", "--porcelain").trim();
  world.subjects = (dir = clone) => git(dir, "log", "--format=%s").trim().split("\n");
  world.includes = (ref, dir = clone) =>
    spawnSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd: dir, env }).status === 0;
  world.mergeInProgress = (dir = clone) =>
    spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir, env }).status === 0;
  return world;
}

function makeCtx(world, options = {}) {
  const npmCalls = [];
  const logs = [];
  const latestRelease = options.latestRelease || "v1.0.0";
  const ctx = forkSync.createContext({
    repoDir: options.repoDir || world.clone,
    gitExe: "git",
    forkUrl: world.originBare,
    upstreamUrl: world.upstreamBare,
    platform: options.platform || "linux",
    toolsDir: path.join(world.root, "tools"),
    env: world.env,
    hostname: "test-pc",
    now: () => new Date(2026, 8, 15, 12, 30),
    fetchImpl:
      options.fetchImpl ||
      (async () => ({ ok: true, status: 200, json: async () => ({ tag_name: latestRelease }) })),
    runNpm:
      options.runNpm ||
      ((args) => {
        npmCalls.push(args);
        return { status: 0 };
      }),
    log: {
      step: (message) => logs.push(message),
      info: (message) => logs.push(message),
      warn: (message) => logs.push(`WARNING: ${message}`),
      raw: (message) => logs.push(message),
    },
    ...(options.ctx || {}),
  });
  return { ctx, npmCalls, logs };
}

test("merges the newest published release, keeps local edits and pushes to the fork", async (t) => {
  const world = makeWorld(t);
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  world.upstreamCommit("unreleased work", { "unreleased.js": "// not in any release\n" });
  world.commitInClone("fork: add launcher", { "Run_windows.bat": "@echo off\r\n" });
  world.git(world.clone, "push", "-q", "origin", "main");
  write(world.clone, "notes.txt", "my local edit\n");

  const { ctx } = makeCtx(world, { latestRelease: "v1.1.0" });
  const results = await forkSync.sync(ctx);

  assert.equal(world.status(), "");
  assert.equal(world.mergeInProgress(), false);
  assert.ok(world.includes("v1.1.0"));
  assert.equal(fs.existsSync(path.join(world.clone, "unreleased.js")), false);
  assert.equal(read(world.clone, "app.js"), "console.log('v1.1.0');\n");
  assert.equal(read(world.clone, "notes.txt"), "my local edit\n");
  assert.equal(read(world.clone, "Run_windows.bat"), "@echo off\r\n");
  assert.equal(world.subjects()[0], "Sync with OpenWhispr v1.1.0");
  assert.ok(world.subjects().includes("Local changes on test-pc (2026-09-15 12:30)"));
  assert.equal(world.git(world.originBare, "rev-parse", "main").trim(), world.head());
  assert.equal(world.git(world.clone, "remote", "get-url", "upstream").trim(), world.upstreamBare);
  assert.deepEqual(
    { ...results, local: results.local.committed },
    {
      converted: false,
      local: true,
      pulled: "up-to-date",
      release: { tag: "v1.1.0", source: "GitHub releases", result: "merged" },
      pushed: "pushed",
    }
  );
  assert.deepEqual(ctx.warnings, []);

  const again = await forkSync.sync(makeCtx(world, { latestRelease: "v1.1.0" }).ctx);
  assert.equal(again.release.result, "up-to-date");
  assert.equal(again.pushed, "up-to-date");
  assert.equal(again.local.committed, false);
});

test("the published release wins over a newer tag; the newer one follows once published", async (t) => {
  const world = makeWorld(t);
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  world.upstreamRelease("1.2.0", { "app.js": "console.log('v1.2.0');\n" });

  await forkSync.sync(makeCtx(world, { latestRelease: "v1.1.0" }).ctx);
  assert.ok(world.includes("v1.1.0"));
  assert.equal(world.includes("v1.2.0"), false);

  const later = await forkSync.sync(makeCtx(world, { latestRelease: "v1.2.0" }).ctx);
  assert.equal(later.release.result, "merged");
  assert.ok(world.includes("v1.2.0"));
});

test("falls back to the newest vX.Y.Z tag when the GitHub release lookup fails", async (t) => {
  const world = makeWorld(t);
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  world.upstreamRelease("1.2.0", { "app.js": "console.log('v1.2.0');\n" });
  world.git(world.upstreamWork, "tag", "windows-fast-paste-v9.0.0");
  world.git(
    world.upstreamWork,
    "push",
    "-q",
    world.upstreamBare,
    "refs/tags/windows-fast-paste-v9.0.0"
  );

  const { ctx } = makeCtx(world, {
    fetchImpl: async () => {
      throw new Error("rate limited");
    },
  });
  const results = await forkSync.sync(ctx);

  assert.deepEqual(results.release, { tag: "v1.2.0", source: "tags", result: "merged" });
  assert.ok(world.includes("v1.2.0"));
  assert.deepEqual(ctx.warnings, []);
});

test("a conflicting release is undone and reported; the fork keeps its own code", async (t) => {
  const world = makeWorld(t);
  world.commitInClone("fork: change app.js", { "app.js": "console.log('fork');\n" });
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  const before = world.head();

  const { ctx } = makeCtx(world, { latestRelease: "v1.1.0" });
  const results = await forkSync.sync(ctx);

  assert.equal(results.release.result, "conflict");
  assert.equal(world.head(), before);
  assert.equal(world.status(), "");
  assert.equal(world.mergeInProgress(), false);
  assert.equal(read(world.clone, "app.js"), "console.log('fork');\n");
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /OpenWhispr v1\.1\.0 conflicts with your changes in: app\.js/);
  assert.equal(results.pushed, "pushed");
  assert.equal(world.git(world.originBare, "rev-parse", "main").trim(), before);
});

test("a package-lock.json-only conflict takes the OpenWhispr lockfile and triggers npm install", async (t) => {
  const world = makeWorld(t);
  world.commitInClone("fork: add a package", {
    "package.json": packageJson("1.0.0", { "fork-extra": "2.0.0" }),
    "package-lock.json": "lockfile for 1.0.0 plus fork-extra\n",
  });
  world.upstreamRelease("1.1.0", {
    "package.json": packageJson("1.1.0"),
    "package-lock.json": "lockfile for 1.1.0\n",
  });

  const { ctx, npmCalls } = makeCtx(world, { latestRelease: "v1.1.0" });
  const results = await forkSync.sync(ctx);

  assert.equal(results.release.result, "merged");
  assert.equal(ctx.lockfileTakenFromUpstream, true);
  assert.equal(world.mergeInProgress(), false);
  assert.equal(world.status(), "");
  assert.equal(read(world.clone, "package-lock.json"), "lockfile for 1.1.0\n");
  const merged = JSON.parse(read(world.clone, "package.json"));
  assert.equal(merged.version, "1.1.0");
  assert.equal(merged.dependencies["fork-extra"], "2.0.0");
  assert.deepEqual(ctx.warnings, []);

  write(world.clone, "node_modules/electron/path.txt", "electron");
  assert.equal(forkSync.installDependencies(ctx), true);
  assert.deepEqual(npmCalls, [["install", "--no-audit", "--no-fund"]]);
});

test("pulls commits that were pushed to the fork on GitHub", async (t) => {
  const world = makeWorld(t);
  const other = path.join(world.root, "other");
  world.git(world.root, "clone", "-q", world.originBare, other);
  world.commitInClone("edited on GitHub", { "from-github.txt": "hello\n" }, other);
  world.git(other, "push", "-q", "origin", "main");

  const results = await forkSync.sync(makeCtx(world).ctx);

  assert.equal(results.pulled, "pulled");
  assert.equal(read(world.clone, "from-github.txt"), "hello\n");
  assert.equal(results.release.result, "up-to-date");
});

test("turns a ZIP download into a clone of the fork without losing edits", async (t) => {
  const world = makeWorld(t);
  const zipDir = path.join(world.root, "CCC_openwhispr-main");
  fs.cpSync(world.clone, zipDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== ".git",
  });
  assert.equal(fs.existsSync(path.join(zipDir, ".git")), false);
  write(zipDir, "app.js", "console.log('edited in the zip');\n");

  const { ctx } = makeCtx(world, { repoDir: zipDir });
  const results = await forkSync.sync(ctx);

  assert.equal(results.converted, true);
  assert.equal(world.git(zipDir, "remote", "get-url", "origin").trim(), world.originBare);
  assert.equal(world.status(zipDir), "");
  assert.equal(read(zipDir, "app.js"), "console.log('edited in the zip');\n");
  assert.equal(world.subjects(zipDir)[0], "Local changes on test-pc (2026-09-15 12:30)");
  assert.equal(world.subjects(zipDir).length, 2);
  assert.equal(world.git(world.originBare, "rev-parse", "main").trim(), world.head(zipDir));
  assert.equal(
    world.git(zipDir, "config", "--local", "--get", "user.email").trim(),
    "CCC_openwhispr@users.noreply.github.com"
  );
});

test("a shallow clone is deepened so releases can merge", async (t) => {
  const world = makeWorld(t);
  const shallow = path.join(world.root, "shallow");
  world.git(world.root, "clone", "-q", "--depth", "1", `file://${world.originBare}`, shallow);
  assert.equal(world.git(shallow, "rev-parse", "--is-shallow-repository").trim(), "true");
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });

  const { ctx } = makeCtx(world, { repoDir: shallow, latestRelease: "v1.1.0" });
  const results = await forkSync.sync(ctx);

  assert.equal(world.git(shallow, "rev-parse", "--is-shallow-repository").trim(), "false");
  assert.equal(results.release.result, "merged");
  assert.deepEqual(ctx.warnings, []);
});

test("switches back to main from another branch, keeping the work there", async (t) => {
  const world = makeWorld(t);
  world.git(world.clone, "checkout", "-q", "-b", "experiment");
  write(world.clone, "experiment.txt", "wip\n");

  await forkSync.sync(makeCtx(world).ctx);

  assert.equal(world.git(world.clone, "symbolic-ref", "--short", "HEAD").trim(), "main");
  assert.equal(fs.existsSync(path.join(world.clone, "experiment.txt")), false);
  assert.match(
    world.git(world.clone, "log", "--format=%s", "experiment"),
    /Local changes on test-pc/
  );
});

test("offline: local edits are still saved and nothing crashes", async (t) => {
  const world = makeWorld(t);
  world.git(world.clone, "remote", "set-url", "origin", path.join(world.root, "missing.git"));
  write(world.clone, "notes.txt", "offline edit\n");

  const { ctx } = makeCtx(world);
  const results = await forkSync.sync(ctx);

  assert.equal(results.local.committed, true);
  assert.equal(results.pulled, "offline");
  assert.equal(results.release.result, "offline");
  assert.equal(results.pushed, "offline");
  assert.equal(ctx.warnings.length, 1);
  assert.match(ctx.warnings[0], /Could not reach your fork on GitHub/);
  assert.equal(world.status(), "");
});

test("an unfinished merge from a crashed run is undone before syncing", async (t) => {
  const world = makeWorld(t);
  world.commitInClone("fork: change app.js", { "app.js": "console.log('fork');\n" });
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  world.git(world.clone, "remote", "add", "upstream", world.upstreamBare);
  world.git(world.clone, "fetch", "-q", "upstream", "+refs/tags/v*:refs/tags/v*");
  const merge = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "merge", "v1.1.0"],
    { cwd: world.clone, env: world.env, encoding: "utf8" }
  );
  assert.notEqual(merge.status, 0, "the fixture merge should stop on a conflict");
  assert.equal(world.mergeInProgress(), true);

  const { ctx } = makeCtx(world, { latestRelease: "v1.1.0" });
  const results = await forkSync.sync(ctx);

  assert.equal(results.release.result, "conflict");
  assert.equal(world.mergeInProgress(), false);
  assert.equal(world.status(), "");
});

test("large untracked files are not committed", async (t) => {
  const world = makeWorld(t);
  write(world.clone, "small.txt", "small\n");
  write(world.clone, "big.bin", "x".repeat(2048));

  const { ctx } = makeCtx(world, { ctx: { maxAutoCommitFileBytes: 1024 } });
  forkSync.ensureRemotes(ctx);
  forkSync.ensureIdentity(ctx);
  const result = forkSync.commitLocalChanges(ctx);

  assert.equal(result.committed, true);
  assert.deepEqual(result.skipped, ["big.bin"]);
  assert.equal(world.status(), "?? big.bin");
  assert.match(ctx.warnings[0], /big\.bin/);
});

test("npm install runs only when needed and adds the Windows-only packages", (t) => {
  const world = makeWorld(t);
  const first = makeCtx(world);
  assert.equal(forkSync.installDependencies(first.ctx), true);
  assert.deepEqual(first.npmCalls, [["install", "--no-audit", "--no-fund"]]);

  // Electron missing after the install: install again next time.
  const second = makeCtx(world);
  assert.equal(forkSync.installDependencies(second.ctx), true);

  write(world.clone, "node_modules/electron/path.txt", "electron");
  const third = makeCtx(world);
  assert.equal(forkSync.installDependencies(third.ctx), false);
  assert.deepEqual(third.npmCalls, []);

  write(world.clone, "package-lock.json", "lockfile changed\n");
  const fourth = makeCtx(world);
  assert.equal(forkSync.installDependencies(fourth.ctx), true);

  const forced = makeCtx(world);
  assert.equal(forkSync.installDependencies(forced.ctx, { force: true }), true);

  const windows = makeCtx(world, { platform: "win32" });
  forkSync.installDependencies(windows.ctx, { force: true });
  assert.deepEqual(windows.npmCalls, [
    ["install", "--no-audit", "--no-fund"],
    ["install", "--no-save", "--no-audit", "--no-fund", ...forkSync.WINDOWS_OPTIONAL_PACKAGES],
  ]);
  for (const name of forkSync.WINDOWS_OPTIONAL_PACKAGES) {
    fs.mkdirSync(path.join(world.clone, "node_modules", name), { recursive: true });
  }
  const windowsAgain = makeCtx(world, { platform: "win32" });
  forkSync.installDependencies(windowsAgain.ctx, { force: true });
  assert.deepEqual(windowsAgain.npmCalls, [["install", "--no-audit", "--no-fund"]]);

  const failing = makeCtx(world, { runNpm: () => ({ status: 1 }) });
  assert.throws(
    () => forkSync.installDependencies(failing.ctx, { force: true }),
    forkSync.FatalError
  );
});

test("main() syncs, installs and starts the app, or stops after the sync with --sync-only", async (t) => {
  const world = makeWorld(t);
  world.upstreamRelease("1.1.0", { "app.js": "console.log('v1.1.0');\n" });
  const options = (extra = {}) => {
    const { ctx, npmCalls } = makeCtx(world, { latestRelease: "v1.1.0", ...extra });
    return { overrides: ctx, npmCalls };
  };

  const syncOnly = options();
  assert.equal(await forkSync.main(["--sync-only"], syncOnly.overrides), 0);
  assert.ok(world.includes("v1.1.0"));
  assert.deepEqual(syncOnly.npmCalls, [["install", "--no-audit", "--no-fund"]]);

  write(world.clone, "node_modules/electron/path.txt", "electron");
  const full = options({
    runNpm: (args) => {
      full.npmCalls.push(args);
      return { status: args[0] === "run" ? 7 : 0 };
    },
  });
  assert.equal(await forkSync.main([], full.overrides), 7);
  assert.deepEqual(full.npmCalls, [["run", "dev"]]);

  const noSync = options();
  assert.equal(await forkSync.main(["--help"], noSync.overrides), 0);
  assert.deepEqual(noSync.npmCalls, []);
});

test("release tags sort numerically and ignore other tags", () => {
  assert.deepEqual(
    forkSync.sortReleaseTags([
      "v1.10.2",
      "v1.9.2",
      "windows-fast-paste-v2.0.0",
      "v2.0.0-beta.1",
      "v1.10.0",
      " v1.8.3 ",
    ]),
    ["v1.8.3", "v1.9.2", "v1.10.0", "v1.10.2"]
  );
});

test("remote URLs compare by repository, not by spelling", () => {
  const key = forkSync.repoKey("https://github.com/OpenWhispr/openwhispr.git");
  assert.equal(key, "openwhispr/openwhispr");
  assert.equal(forkSync.repoKey("git@github.com:openwhispr/OpenWhispr"), key);
  assert.equal(forkSync.repoKey("https://github.com/OpenWhispr/openwhispr/"), key);
  assert.notEqual(forkSync.repoKey("https://github.com/B0904/CCC_openwhispr.git"), key);
  assert.equal(forkSync.repoKey("/tmp/upstream.git"), "/tmp/upstream");
});

test("the portable git download is the plain 64-bit MinGit", () => {
  const assets = [
    { name: "Git-2.50.0-64-bit.exe" },
    { name: "MinGit-2.50.0-busybox-64-bit.zip" },
    { name: "MinGit-2.50.0-32-bit.zip" },
    { name: "MinGit-2.50.0-64-bit.zip" },
    { name: "MinGit-2.50.0-arm64.zip" },
  ];
  assert.equal(forkSync.pickMinGitAsset(assets).name, "MinGit-2.50.0-64-bit.zip");
  assert.equal(forkSync.pickMinGitAsset([]), null);
  assert.equal(forkSync.pickMinGitAsset(undefined), null);
});

test("launcher options are recognised with or without dashes", () => {
  assert.deepEqual(forkSync.parseFlags(["--no-sync", "/reinstall", "SYNC-ONLY", "bogus"]), {
    noSync: true,
    syncOnly: true,
    reinstall: true,
    help: false,
    unknown: ["bogus"],
  });
  assert.equal(forkSync.parseFlags(["-h"]).help, true);
  assert.equal(forkSync.parseFlags([]).help, false);
});
