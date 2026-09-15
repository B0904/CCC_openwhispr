#!/usr/bin/env node
"use strict";

/**
 * CCC_openwhispr fork sync and launcher.
 *
 * Run_windows.bat -> run.ps1 (finds or downloads the Node.js version pinned in
 * .nvmrc) -> this script. It is plain Node.js so the same logic runs on macOS
 * and Linux and under `node --test` (see test/scripts/forkSync.test.js).
 *
 * One run does, in order:
 *   1. make sure this folder is a git clone with `origin` = this fork and
 *      `upstream` = OpenWhispr (a GitHub ZIP download is converted in place)
 *   2. commit any local edits, so nothing is lost and nothing blocks a merge
 *   3. pull the fork's main branch from GitHub
 *   4. merge the newest *published* OpenWhispr release tag (vX.Y.Z); commits on
 *      upstream main that are not part of a release are never taken
 *   5. push the result back to the fork on GitHub
 *   6. run `npm install` when package.json / package-lock.json changed
 *   7. start the app with `npm run dev`
 *
 * Every sync step is best-effort: being offline, a merge conflict or a
 * rejected push is reported as a warning and the app still starts on the code
 * that is checked out. The only hard stops are a missing git (outside Windows,
 * where a portable copy is downloaded) and a failed npm install.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FORK_URL = "https://github.com/B0904/CCC_openwhispr.git";
const UPSTREAM_URL = "https://github.com/OpenWhispr/openwhispr.git";
const UPSTREAM_LATEST_RELEASE_API =
  "https://api.github.com/repos/OpenWhispr/openwhispr/releases/latest";
const MINGIT_LATEST_RELEASE_API =
  "https://api.github.com/repos/git-for-windows/git/releases/latest";
const USER_AGENT = "CCC_openwhispr-fork-sync";
const MAIN_BRANCH = "main";
const RELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG_REFSPEC = "+refs/tags/v*:refs/tags/v*";
const LOCKFILE = "package-lock.json";
const MAX_AUTO_COMMIT_FILE_BYTES = 50 * 1024 * 1024;
// package-lock.json can miss these when it was generated on macOS/Linux
// (npm/cli#4828); upstream CI installs them the same way after npm ci.
const WINDOWS_OPTIONAL_PACKAGES = [
  "@rollup/rollup-win32-x64-msvc",
  "lightningcss-win32-x64-msvc",
  "@tailwindcss/oxide-win32-x64-msvc",
];
const INSTALL_MARKER = path.join("node_modules", ".ccc-fork-sync.json");
const ELECTRON_READY_FILE = path.join("node_modules", "electron", "path.txt");
const HTTP_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_FILE_MAX_BYTES = 2 * 1024 * 1024;

const USAGE = `Usage: Run_windows.bat [option]

  (no option)   sync with GitHub and the latest OpenWhispr release, install, start the app
  --no-sync     skip the GitHub / OpenWhispr sync, only install what is missing and start
  --sync-only   sync and install, but do not start the app
  --reinstall   force a fresh npm install
  --help        show this text
`;

class FatalError extends Error {}

class GitError extends Error {
  constructor(args, result, detail) {
    const reason = detail || lastLine(result.stderr) || `exit code ${result.status}`;
    super(`git ${args.join(" ")} failed: ${reason}`);
    this.args = args;
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function lastLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function describeError(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  return String(err);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatStamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function parseReleaseTag(tag) {
  const match = RELEASE_TAG_RE.exec(String(tag || "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareReleaseTags(a, b) {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Keeps only plain vX.Y.Z tags (helper-binary tags and pre-releases drop out), oldest first. */
function sortReleaseTags(tags) {
  return tags
    .map((tag) => String(tag).trim())
    .filter((tag) => parseReleaseTag(tag) !== null)
    .sort(compareReleaseTags);
}

/** Normalizes a remote URL so https / ssh / trailing ".git" spellings compare equal. */
function repoKey(url) {
  const key = String(url || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const github = key.match(/github\.com[/:]([^/]+\/[^/]+)$/);
  return github ? github[1] : key;
}

function ownerFromUrl(url) {
  const key = repoKey(url);
  const match = key.match(/^([^/]+)\/[^/]+$/);
  return match ? match[1] : null;
}

function pickMinGitAsset(assets) {
  return (
    (Array.isArray(assets) ? assets : []).find(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        /^MinGit-.*-64-bit\.zip$/i.test(asset.name) &&
        !/busybox/i.test(asset.name)
    ) || null
  );
}

function parseFlags(argv) {
  const flags = { noSync: false, syncOnly: false, reinstall: false, help: false, unknown: [] };
  for (const raw of argv || []) {
    const flag = String(raw)
      .replace(/^[-/]+/, "")
      .toLowerCase();
    if (flag === "no-sync" || flag === "nosync") flags.noSync = true;
    else if (flag === "sync-only" || flag === "synconly") flags.syncOnly = true;
    else if (flag === "reinstall") flags.reinstall = true;
    else if (flag === "help" || flag === "h" || flag === "?") flags.help = true;
    else flags.unknown.push(String(raw));
  }
  return flags;
}

function currentNodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

function requiredNodeMajor(ctx) {
  try {
    const text = fs.readFileSync(path.join(ctx.repoDir, ".nvmrc"), "utf8").trim();
    const match = text.match(/^v?(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function pathKeyOf(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
}

// ---------------------------------------------------------------------------
// Context, logging
// ---------------------------------------------------------------------------

function defaultToolsDir(platform, env) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "CCC_openwhispr");
  }
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ccc_openwhispr");
}

function createLogger({ toolsDir, stream = process.stdout } = {}) {
  const logFile = toolsDir ? path.join(toolsDir, "fork-sync.log") : null;
  const write = (line) => {
    stream.write(`${line}\n`);
    if (!logFile) return;
    try {
      fs.mkdirSync(toolsDir, { recursive: true });
      try {
        if (fs.statSync(logFile).size > LOG_FILE_MAX_BYTES) fs.truncateSync(logFile, 0);
      } catch {}
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {}
  };
  return {
    step: (message) => write(`[fork-sync] ${message}`),
    info: (message) => write(`[fork-sync]   ${message}`),
    warn: (message) => write(`[fork-sync] WARNING: ${message}`),
    raw: (message) => write(message),
  };
}

function createContext(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const env = overrides.env || process.env;
  const repoDir = path.resolve(overrides.repoDir || path.join(__dirname, "..", ".."));
  const toolsDir = overrides.toolsDir || defaultToolsDir(platform, env);
  const ctx = {
    platform,
    arch: overrides.arch || process.arch,
    env,
    repoDir,
    toolsDir,
    forkUrl: overrides.forkUrl || FORK_URL,
    upstreamUrl: overrides.upstreamUrl || UPSTREAM_URL,
    gitExe: overrides.gitExe || null,
    originUrl: null,
    fetchImpl: overrides.fetchImpl || (typeof fetch === "function" ? fetch : null),
    log: overrides.log || createLogger({ toolsDir }),
    now: overrides.now || (() => new Date()),
    hostname: overrides.hostname || os.hostname(),
    maxAutoCommitFileBytes: overrides.maxAutoCommitFileBytes || MAX_AUTO_COMMIT_FILE_BYTES,
    requestNode: overrides.requestNode || null,
    warnings: [],
    nodeDir: null,
    lockfileTakenFromUpstream: false,
  };
  ctx.runNpm = overrides.runNpm || ((args) => runNpm(ctx, args));
  return ctx;
}

function warn(ctx, message) {
  ctx.warnings.push(message);
  ctx.log.warn(message);
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

function git(ctx, args, { allowFailure = false } = {}) {
  if (!ctx.gitExe) throw new FatalError("git is not available.");
  const fullArgs = ["-c", `safe.directory=${ctx.repoDir}`, "-c", "core.quotePath=false", ...args];
  const result = spawnSync(ctx.gitExe, fullArgs, {
    cwd: ctx.repoDir,
    encoding: "utf8",
    env: { ...ctx.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new GitError(args, result, result.error.message);
  if (result.status !== 0 && !allowFailure) throw new GitError(args, result);
  return result;
}

function revParse(ctx, ref) {
  const result = git(ctx, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isAncestor(ctx, ancestor, descendant) {
  return (
    git(ctx, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })
      .status === 0
  );
}

function currentBranch(ctx) {
  const result = git(ctx, ["symbolic-ref", "-q", "--short", "HEAD"], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function mergeInProgress(ctx) {
  return (
    git(ctx, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFailure: true }).status === 0
  );
}

function parseStatus(ctx) {
  const out = git(ctx, ["status", "--porcelain", "-z", "--untracked-files=all"]).stdout;
  const entries = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part) continue;
    const code = part.slice(0, 2);
    entries.push({ code, file: part.slice(3) });
    // a rename/copy is followed by the original path as its own entry
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return entries;
}

function listReleaseTags(ctx) {
  return sortReleaseTags(git(ctx, ["tag", "--list", "v*"]).stdout.split(/\r?\n/));
}

// ---------------------------------------------------------------------------
// Finding (or fetching) git
// ---------------------------------------------------------------------------

function knownWindowsGitLocations(env) {
  const list = [];
  const roots = [
    env.ProgramFiles,
    env.ProgramW6432,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : null,
  ].filter(Boolean);
  for (const root of roots) list.push(path.join(root, "Git", "cmd", "git.exe"));
  if (env.LOCALAPPDATA) {
    // GitHub Desktop bundles its own git, which is not on PATH.
    const desktop = path.join(env.LOCALAPPDATA, "GitHubDesktop");
    try {
      const versions = fs
        .readdirSync(desktop)
        .filter((name) => name.startsWith("app-"))
        .sort()
        .reverse();
      for (const version of versions) {
        list.push(path.join(desktop, version, "resources", "app", "git", "cmd", "git.exe"));
      }
    } catch {}
  }
  return list;
}

function findGit(ctx) {
  if (ctx.gitExe) return ctx.gitExe;
  const isWindows = ctx.platform === "win32";
  const probe = spawnSync(isWindows ? "where" : "which", ["git"], {
    encoding: "utf8",
    windowsHide: true,
    env: ctx.env,
  });
  if (probe.status === 0) {
    const first = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  }
  if (!isWindows) return null;
  const candidates = [
    ...knownWindowsGitLocations(ctx.env),
    path.join(ctx.toolsDir, "git", "cmd", "git.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function fetchJson(ctx, url) {
  if (!ctx.fetchImpl) throw new Error("HTTP client unavailable");
  const response = await ctx.fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function downloadFile(ctx, url, destination) {
  if (!ctx.fetchImpl) throw new Error("HTTP client unavailable");
  const response = await ctx.fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function extractZip(ctx, zipPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // Windows 10+ ships bsdtar, which extracts zip files.
  const tar = spawnSync("tar", ["-xf", zipPath, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
    env: ctx.env,
  });
  if (tar.status === 0) return;
  if (ctx.platform === "win32") {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`;
    const ps = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8", windowsHide: true, env: ctx.env }
    );
    if (ps.status === 0) return;
  }
  throw new FatalError(`Could not extract ${path.basename(zipPath)}.`);
}

async function installMinGit(ctx) {
  const release = await fetchJson(ctx, MINGIT_LATEST_RELEASE_API);
  const asset = pickMinGitAsset(release && release.assets);
  if (!asset || !asset.browser_download_url) {
    throw new FatalError(
      "Could not find a portable git download. Install Git for Windows from https://git-scm.com and run again."
    );
  }
  const gitDir = path.join(ctx.toolsDir, "git");
  const zipPath = path.join(ctx.toolsDir, asset.name);
  fs.mkdirSync(ctx.toolsDir, { recursive: true });
  ctx.log.step(`Downloading ${asset.name}...`);
  await downloadFile(ctx, asset.browser_download_url, zipPath);
  fs.rmSync(gitDir, { recursive: true, force: true });
  extractZip(ctx, zipPath, gitDir);
  fs.rmSync(zipPath, { force: true });
  const gitExe = path.join(gitDir, "cmd", "git.exe");
  if (!fs.existsSync(gitExe)) {
    throw new FatalError(
      "The portable git download did not contain git.exe. Install Git for Windows from https://git-scm.com and run again."
    );
  }
  ctx.log.step(`Installed ${asset.name} into ${gitDir}`);
  return gitExe;
}

async function ensureGit(ctx) {
  const found = findGit(ctx);
  if (found) {
    ctx.gitExe = found;
    return found;
  }
  if (ctx.platform !== "win32") {
    throw new FatalError("git is not installed. Install git and run again.");
  }
  ctx.log.step("git was not found on this PC. Downloading a portable copy (MinGit)...");
  ctx.gitExe = await installMinGit(ctx);
  return ctx.gitExe;
}

// ---------------------------------------------------------------------------
// Sync steps
// ---------------------------------------------------------------------------

function abortStaleMerge(ctx) {
  if (!mergeInProgress(ctx)) return false;
  ctx.log.step("An earlier merge never finished; undoing it first.");
  git(ctx, ["merge", "--abort"], { allowFailure: true });
  return true;
}

/** A GitHub ZIP download has no .git; make it a clone of the fork without touching the files. */
function ensureRepo(ctx) {
  if (fs.existsSync(path.join(ctx.repoDir, ".git"))) return false;
  ctx.log.step(
    "This folder is not a git clone yet (a ZIP download?). Turning it into one, keeping your files..."
  );
  try {
    git(ctx, ["init", "-q"]);
    git(ctx, ["symbolic-ref", "HEAD", `refs/heads/${MAIN_BRANCH}`]);
    git(ctx, ["remote", "add", "origin", ctx.forkUrl]);
    git(ctx, ["fetch", "-q", "origin", MAIN_BRANCH]);
    git(ctx, ["update-ref", `refs/heads/${MAIN_BRANCH}`, `refs/remotes/origin/${MAIN_BRANCH}`]);
    // index = the fork's main, working tree untouched: edits show up as local changes
    git(ctx, ["reset", "-q", "--mixed"]);
  } catch (err) {
    fs.rmSync(path.join(ctx.repoDir, ".git"), { recursive: true, force: true });
    throw err;
  }
  return true;
}

function ensureRemotes(ctx) {
  const names = git(ctx, ["remote"])
    .stdout.split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.includes("origin")) {
    git(ctx, ["remote", "add", "origin", ctx.forkUrl]);
    ctx.log.step(`Added the "origin" remote: ${ctx.forkUrl}`);
  }
  if (!names.includes("upstream")) {
    git(ctx, ["remote", "add", "upstream", ctx.upstreamUrl]);
    ctx.log.step(`Added the "upstream" remote (OpenWhispr): ${ctx.upstreamUrl}`);
  } else {
    const current = git(ctx, ["remote", "get-url", "upstream"]).stdout.trim();
    if (repoKey(current) !== repoKey(ctx.upstreamUrl)) {
      git(ctx, ["remote", "set-url", "upstream", ctx.upstreamUrl]);
      ctx.log.step(`Pointed the "upstream" remote at ${ctx.upstreamUrl} (was ${current})`);
    }
  }
  ctx.originUrl = git(ctx, ["remote", "get-url", "origin"]).stdout.trim();
}

/** Commits need an author; use a GitHub no-reply identity when none is configured. */
function ensureIdentity(ctx) {
  const name = git(ctx, ["config", "--get", "user.name"], { allowFailure: true }).stdout.trim();
  const email = git(ctx, ["config", "--get", "user.email"], { allowFailure: true }).stdout.trim();
  if (name && email) return false;
  const owner = ownerFromUrl(ctx.originUrl) || "CCC_openwhispr";
  if (!name) git(ctx, ["config", "user.name", owner]);
  if (!email) git(ctx, ["config", "user.email", `${owner}@users.noreply.github.com`]);
  ctx.log.step(
    `Set the git identity for this clone to ${owner} <${owner}@users.noreply.github.com>`
  );
  return true;
}

function ensureNotShallow(ctx) {
  const probe = git(ctx, ["rev-parse", "--is-shallow-repository"], { allowFailure: true });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return false;
  ctx.log.step("This clone is shallow; fetching the full history once...");
  const fetch = git(ctx, ["fetch", "-q", "--unshallow", "origin"], { allowFailure: true });
  if (fetch.status !== 0) {
    warn(ctx, `Could not fetch the full history: ${lastLine(fetch.stderr)}`);
    return false;
  }
  return true;
}

function commitLocalChanges(ctx) {
  const entries = parseStatus(ctx);
  const result = { committed: false, message: null, skipped: [] };
  if (entries.length === 0) return result;

  for (const { code, file } of entries) {
    if (code !== "??") continue;
    let stat;
    try {
      stat = fs.statSync(path.join(ctx.repoDir, file));
    } catch {
      continue;
    }
    if (stat.isFile() && stat.size > ctx.maxAutoCommitFileBytes) result.skipped.push(file);
  }

  git(ctx, ["add", "-A", "--", "."]);
  for (const file of result.skipped) git(ctx, ["reset", "-q", "--", file], { allowFailure: true });
  if (result.skipped.length) {
    warn(
      ctx,
      `Not saving these large files to git (over ${Math.round(
        ctx.maxAutoCommitFileBytes / (1024 * 1024)
      )} MB): ${result.skipped.join(", ")}`
    );
  }

  if (git(ctx, ["diff", "--cached", "--quiet"], { allowFailure: true }).status === 0) {
    return result;
  }
  result.message = `Local changes on ${ctx.hostname} (${formatStamp(ctx.now())})`;
  git(ctx, ["commit", "-q", "--no-verify", "-m", result.message]);
  result.committed = true;
  ctx.log.step(`Saved your local changes to git as "${result.message}".`);
  return result;
}

function fetchOrigin(ctx) {
  const result = git(ctx, ["fetch", "-q", "origin", MAIN_BRANCH], { allowFailure: true });
  if (result.status !== 0) {
    warn(ctx, `Could not reach your fork on GitHub (offline?): ${lastLine(result.stderr)}`);
    return false;
  }
  return true;
}

function ensureOnMain(ctx) {
  const branch = currentBranch(ctx);
  if (branch === MAIN_BRANCH) return true;
  const where = branch ? `branch "${branch}"` : "a detached commit";
  const hasLocalMain = revParse(ctx, `refs/heads/${MAIN_BRANCH}`) !== null;
  const hasOriginMain = revParse(ctx, `refs/remotes/origin/${MAIN_BRANCH}`) !== null;
  if (!hasLocalMain && !hasOriginMain) {
    warn(
      ctx,
      `Not on "${MAIN_BRANCH}" and no "${MAIN_BRANCH}" branch exists yet; leaving things as they are.`
    );
    return false;
  }
  const checkout = hasLocalMain
    ? git(ctx, ["checkout", "-q", MAIN_BRANCH], { allowFailure: true })
    : git(ctx, ["checkout", "-q", "-b", MAIN_BRANCH, `origin/${MAIN_BRANCH}`], {
        allowFailure: true,
      });
  if (checkout.status !== 0) {
    warn(ctx, `Could not switch from ${where} to "${MAIN_BRANCH}": ${lastLine(checkout.stderr)}`);
    return false;
  }
  ctx.log.step(`You were on ${where}; switched to "${MAIN_BRANCH}". Your work there is kept.`);
  return true;
}

/**
 * Called after a merge stopped on conflicts. A conflict only in package-lock.json
 * is resolved by taking the OpenWhispr lockfile (npm install re-adds any packages
 * this fork added). Anything else is undone and left for a human.
 */
function handleConflict(ctx, what) {
  const conflicted = git(ctx, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (conflicted.length && conflicted.every((file) => file === LOCKFILE)) {
    const steps = [
      ["checkout", "--theirs", "--", LOCKFILE],
      ["add", "--", LOCKFILE],
      ["commit", "-q", "--no-verify", "--no-edit"],
    ];
    if (steps.every((args) => git(ctx, args, { allowFailure: true }).status === 0)) {
      ctx.lockfileTakenFromUpstream = true;
      ctx.log.step(
        `${LOCKFILE} conflicted while merging ${what}; took the OpenWhispr version, npm install will re-apply this fork's packages.`
      );
      return true;
    }
  }
  git(ctx, ["merge", "--abort"], { allowFailure: true });
  warn(
    ctx,
    `Merging ${what} conflicts with your changes in: ${conflicted.join(", ") || "(unknown files)"}. ` +
      "Your code was left as it was. Resolve the conflict by hand (or ask for help); every run will retry."
  );
  return false;
}

function integrateOriginMain(ctx) {
  const remote = revParse(ctx, `refs/remotes/origin/${MAIN_BRANCH}`);
  if (!remote) return "missing";
  if (isAncestor(ctx, remote, "HEAD")) return "up-to-date";
  const merge = git(
    ctx,
    [
      "merge",
      "-q",
      "--no-edit",
      "-m",
      "Merge changes from the fork on GitHub",
      `origin/${MAIN_BRANCH}`,
    ],
    { allowFailure: true }
  );
  if (merge.status === 0) {
    ctx.log.step("Pulled new commits from your fork on GitHub.");
    return "pulled";
  }
  return handleConflict(ctx, "your fork on GitHub") ? "pulled" : "conflict";
}

function fetchUpstreamTags(ctx) {
  const result = git(ctx, ["fetch", "-q", "upstream", RELEASE_TAG_REFSPEC], { allowFailure: true });
  if (result.status !== 0) {
    warn(ctx, `Could not fetch the OpenWhispr releases: ${lastLine(result.stderr)}`);
    return false;
  }
  return true;
}

/** The latest published GitHub release wins; the newest vX.Y.Z tag is the fallback. */
async function resolveLatestReleaseTag(ctx) {
  const local = listReleaseTags(ctx);
  let published = null;
  try {
    const json = await fetchJson(ctx, UPSTREAM_LATEST_RELEASE_API);
    const tag = json && typeof json.tag_name === "string" ? json.tag_name.trim() : "";
    if (parseReleaseTag(tag) && !json.draft && !json.prerelease) published = tag;
    else
      ctx.log.info(
        `GitHub's latest release "${tag}" is not a plain vX.Y.Z release; using tags instead.`
      );
  } catch (err) {
    ctx.log.info(`GitHub release lookup failed (${describeError(err)}); using tags instead.`);
  }
  if (published && local.includes(published)) return { tag: published, source: "GitHub releases" };
  if (published)
    ctx.log.info(
      `Release ${published} is not among the fetched tags; using the newest tag instead.`
    );
  return { tag: local.length ? local[local.length - 1] : null, source: "tags" };
}

function mergeRelease(ctx, tag) {
  if (!tag) {
    warn(ctx, "No OpenWhispr release tag was found; nothing to merge.");
    return "none";
  }
  if (isAncestor(ctx, tag, "HEAD")) {
    ctx.log.step(`Already includes OpenWhispr ${tag}.`);
    return "up-to-date";
  }
  ctx.log.step(`Merging OpenWhispr ${tag}...`);
  const merge = git(ctx, ["merge", "-q", "--no-edit", "-m", `Sync with OpenWhispr ${tag}`, tag], {
    allowFailure: true,
  });
  if (merge.status === 0 || handleConflict(ctx, `OpenWhispr ${tag}`)) {
    ctx.log.step(`Merged OpenWhispr ${tag}.`);
    return "merged";
  }
  return "conflict";
}

function pushOrigin(ctx) {
  const head = revParse(ctx, "HEAD");
  const remote = revParse(ctx, `refs/remotes/origin/${MAIN_BRANCH}`);
  if (head && head === remote) return "up-to-date";
  const push = git(ctx, ["push", "-q", "origin", `${MAIN_BRANCH}:${MAIN_BRANCH}`], {
    allowFailure: true,
  });
  if (push.status === 0) {
    ctx.log.step("Pushed to your fork on GitHub.");
    return "pushed";
  }
  warn(
    ctx,
    `Could not push to GitHub: ${lastLine(push.stderr)}. This PC is up to date anyway. ` +
      "If git asked for a login, install Git for Windows (it includes Git Credential Manager) and sign in once."
  );
  return "failed";
}

async function sync(ctx) {
  const results = {
    converted: false,
    local: null,
    pulled: "skipped",
    release: { tag: null, source: null, result: "skipped" },
    pushed: "skipped",
  };
  results.converted = ensureRepo(ctx);
  abortStaleMerge(ctx);
  ensureRemotes(ctx);
  ensureIdentity(ctx);
  ensureNotShallow(ctx);
  results.local = commitLocalChanges(ctx);
  const online = fetchOrigin(ctx);
  const onMain = ensureOnMain(ctx);
  if (!online) {
    results.pulled = "offline";
    results.release.result = "offline";
    results.pushed = "offline";
    return results;
  }
  if (!onMain) return results;
  results.pulled = integrateOriginMain(ctx);
  if (fetchUpstreamTags(ctx) || listReleaseTags(ctx).length) {
    const release = await resolveLatestReleaseTag(ctx);
    results.release = { ...release, result: mergeRelease(ctx, release.tag) };
  }
  results.pushed = pushOrigin(ctx);
  return results;
}

// ---------------------------------------------------------------------------
// Node.js, npm, the app
// ---------------------------------------------------------------------------

function runNpm(ctx, args) {
  const isWindows = ctx.platform === "win32";
  const env = { ...ctx.env };
  if (ctx.nodeDir) {
    const key = pathKeyOf(env);
    env[key] = `${ctx.nodeDir}${path.delimiter}${env[key] || ""}`;
  }
  return spawnSync(isWindows ? "npm.cmd" : "npm", args, {
    cwd: ctx.repoDir,
    stdio: "inherit",
    shell: isWindows,
    env,
    windowsHide: true,
  });
}

/** After a sync .nvmrc may ask for another Node.js major; on Windows run.ps1 fetches it. */
function defaultRequestNode(ctx, major) {
  if (ctx.platform !== "win32") return null;
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "run.ps1"),
      "-InstallOnly",
    ],
    { cwd: ctx.repoDir, encoding: "utf8", windowsHide: true, env: ctx.env }
  );
  const match = String(result.stdout || "").match(/^NODE_DIR=(.+)$/m);
  if (result.status !== 0 || !match) {
    throw new Error(
      lastLine(result.stderr) || lastLine(result.stdout) || `exit code ${result.status}`
    );
  }
  const nodeDir = match[1].trim();
  const probe = spawnSync(path.join(nodeDir, "node.exe"), ["-v"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = Number(
    String(probe.stdout || "")
      .trim()
      .replace(/^v/, "")
      .split(".")[0]
  );
  if (found !== major)
    throw new Error(`got Node.js ${probe.stdout.trim() || "?"} instead of ${major}`);
  return nodeDir;
}

function ensureNodeMajor(ctx) {
  const required = requiredNodeMajor(ctx);
  if (!required || required === currentNodeMajor()) return true;
  ctx.log.step(
    `OpenWhispr now needs Node.js ${required} (this run started on ${process.version}); fetching it...`
  );
  try {
    const nodeDir = (ctx.requestNode || defaultRequestNode)(ctx, required);
    if (!nodeDir) {
      warn(
        ctx,
        `Install Node.js ${required} before the next run; ${process.version} may not work anymore.`
      );
      return false;
    }
    ctx.nodeDir = nodeDir;
    return true;
  } catch (err) {
    warn(
      ctx,
      `Could not fetch Node.js ${required} (${describeError(err)}); continuing with ${process.version}.`
    );
    return false;
  }
}

function installHash(ctx) {
  const hash = crypto.createHash("sha256");
  for (const name of ["package.json", LOCKFILE]) {
    try {
      hash.update(fs.readFileSync(path.join(ctx.repoDir, name)));
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  hash.update(`node:${requiredNodeMajor(ctx) || currentNodeMajor()}\0${ctx.platform}-${ctx.arch}`);
  return hash.digest("hex");
}

function readInstallMarker(ctx) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.repoDir, INSTALL_MARKER), "utf8"));
  } catch {
    return null;
  }
}

function writeInstallMarker(ctx, marker) {
  const file = path.join(ctx.repoDir, INSTALL_MARKER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`);
}

function ensureWindowsOptionalPackages(ctx) {
  const missing = WINDOWS_OPTIONAL_PACKAGES.filter(
    (name) => !fs.existsSync(path.join(ctx.repoDir, "node_modules", name))
  );
  if (!missing.length) return true;
  ctx.log.step(`Adding Windows-only packages npm skipped: ${missing.join(", ")}`);
  const result = ctx.runNpm(["install", "--no-save", "--no-audit", "--no-fund", ...missing]);
  if (result.status !== 0) {
    warn(ctx, `Could not add ${missing.join(", ")}; the app may fail to start.`);
    return false;
  }
  return true;
}

function installDependencies(ctx, { force = false } = {}) {
  const hash = installHash(ctx);
  const marker = readInstallMarker(ctx);
  const electronReady = fs.existsSync(path.join(ctx.repoDir, ELECTRON_READY_FILE));
  const reason = force
    ? "requested"
    : ctx.lockfileTakenFromUpstream
      ? "the lockfile was reset to the OpenWhispr version"
      : !marker
        ? "first run"
        : marker.hash !== hash
          ? "package.json or package-lock.json changed"
          : !electronReady
            ? "Electron is missing"
            : null;
  if (!reason) {
    ctx.log.step("Dependencies are unchanged; skipping npm install.");
    return false;
  }
  ctx.log.step(`Installing dependencies (${reason}). The first time this takes several minutes...`);
  const install = ctx.runNpm(["install", "--no-audit", "--no-fund"]);
  if (install.status !== 0) {
    throw new FatalError(
      "npm install failed; see the output above. Run again once the cause is fixed."
    );
  }
  if (ctx.platform === "win32") ensureWindowsOptionalPackages(ctx);
  writeInstallMarker(ctx, {
    hash,
    node: process.version,
    installedAt: ctx.now().toISOString(),
  });
  return true;
}

function runApp(ctx) {
  ctx.log.step("Starting OpenWhispr. Closing this window stops the app.");
  const result = ctx.runNpm(["run", "dev"]);
  return typeof result.status === "number" ? result.status : 1;
}

function readAppVersion(ctx) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(ctx.repoDir, "package.json"), "utf8")).version || "?"
    );
  } catch {
    return "?";
  }
}

function describeBaseRelease(ctx) {
  const result = git(ctx, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"], {
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function printSummary(ctx, results) {
  const { log } = ctx;
  const line = "-".repeat(60);
  const wording = {
    pulled: {
      pulled: "pulled new commits",
      "up-to-date": "already up to date",
      conflict: "CONFLICT, kept your version",
      offline: "not reachable",
      missing: "no main branch found",
      skipped: "skipped",
    },
    pushed: {
      pushed: "done",
      "up-to-date": "nothing to push",
      failed: "FAILED (see warning above)",
      offline: "not reachable",
      skipped: "skipped",
    },
  };
  log.raw(line);
  const base = ctx.gitExe ? describeBaseRelease(ctx) : null;
  log.step(
    `OpenWhispr ${readAppVersion(ctx)}${base ? ` (based on OpenWhispr release ${base})` : ""}`
  );
  if (results) {
    log.step(
      `Your local changes: ${results.local && results.local.committed ? `saved as "${results.local.message}"` : "none"}`
    );
    log.step(`Your fork on GitHub: ${wording.pulled[results.pulled] || results.pulled}`);
    const release = results.release;
    const releaseText =
      release.result === "merged"
        ? `${release.tag} merged`
        : release.result === "up-to-date"
          ? `${release.tag} already included`
          : release.result === "conflict"
            ? `${release.tag} CONFLICTS with your changes, kept your version`
            : release.result === "offline"
              ? "not checked (offline)"
              : release.result === "none"
                ? "no release found"
                : "skipped";
    log.step(`OpenWhispr release: ${releaseText}`);
    log.step(`Push to GitHub: ${wording.pushed[results.pushed] || results.pushed}`);
  }
  if (ctx.warnings.length) {
    log.step(`${ctx.warnings.length} warning(s):`);
    for (const message of ctx.warnings) log.info(`- ${message}`);
  } else {
    log.step("No warnings.");
  }
  log.raw(line);
}

async function main(argv, overrides = {}) {
  const flags = parseFlags(argv);
  const ctx = createContext(overrides);
  const { log } = ctx;
  if (flags.help) {
    log.raw(USAGE);
    return 0;
  }
  log.raw("");
  log.step(`CCC_openwhispr launcher in ${ctx.repoDir}`);
  log.step(`Node.js ${process.version} on ${ctx.platform}-${ctx.arch}`);
  for (const unknown of flags.unknown) warn(ctx, `Ignoring unknown option "${unknown}".`);

  try {
    await ensureGit(ctx);
  } catch (err) {
    log.warn(describeError(err));
    return 1;
  }

  let results = null;
  if (flags.noSync) {
    log.step("Skipping the GitHub / OpenWhispr sync (--no-sync).");
  } else {
    try {
      results = await sync(ctx);
    } catch (err) {
      warn(ctx, `The sync stopped early: ${describeError(err)}`);
      try {
        abortStaleMerge(ctx);
      } catch {}
    }
  }

  ensureNodeMajor(ctx);
  try {
    installDependencies(ctx, { force: flags.reinstall });
  } catch (err) {
    if (!(err instanceof FatalError)) throw err;
    log.warn(describeError(err));
    printSummary(ctx, results);
    return 1;
  }

  printSummary(ctx, results);
  if (flags.syncOnly) return 0;
  return runApp(ctx);
}

module.exports = {
  FatalError,
  GitError,
  MAIN_BRANCH,
  WINDOWS_OPTIONAL_PACKAGES,
  commitLocalChanges,
  createContext,
  ensureIdentity,
  ensureNodeMajor,
  ensureRemotes,
  ensureRepo,
  installDependencies,
  main,
  parseFlags,
  pickMinGitAsset,
  repoKey,
  sortReleaseTags,
  sync,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[fork-sync] Unexpected error: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    }
  );
}
