// Based on Blast Radius from anthropics/claude-code-playground (Apache-2.0,
// Copyright 2026 Anthropic PBC). Changed for Windows and PowerShell.
//
// Holdpane: holds a risky Bash or PowerShell command and shows what it would change.
//
// tool.call (Bash, PowerShell): if the command is risky, work out its blast
// radius, open a pane with Proceed and Cancel, and hold the call until one is
// pressed. A hook that fails is skipped by the host and the tool then runs, so
// both registrations carry a `.catch` that refuses in the hook's place.
// ui.render (Pane): draws the report. If the surface won't place the pane (a
// narrow terminal), the same report is drawn in the AbovePrompt band instead.
//
// Holding: a hook has 10 s of its own time, but time spent inside a `$` call is
// free. So the hold loop waits on a short `$.process.run` of a sleep until a
// button's onPress sets the decision. ($.clock.sleep would use up the budget.)
//
// Measuring happens BEFORE the user has answered, so it only reads: it never runs
// the project's own tools (migration status commands run project code), and git
// runs with fsmonitor off.
//
// Windows: the tools are looked up, not assumed. Bash measuring runs in Git's
// bash (found through `git --exec-path`), and its scripts put /usr/bin first on
// PATH, so `find` is not the Windows find. PowerShell measuring runs in
// powershell.exe, with the paths passed as ASCII JSON on stdin, never as source.
//
// The host reads `on(...)` and `$.noun.method(...)` from source, so they are
// spelled literally, and helpers that take `$` are top-level functions.

const PANE_ID = "holdpane";
const POLL_SECONDS = "0.25";
const HOLD_LIMIT_MS = 10 * 60 * 1000;
const STALE_SLACK_MS = 30 * 1000;
const LIST_MAX = 10;
// Longer command lines are held without being read: the reading is where a
// pathological input could cost time, and no real risky command is this long.
const MAX_COMMAND = 8000;
// git for the measuring: fsmonitor runs a program named in the repository's config.
const GIT = ["git", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

// The call being held, or null. One at a time: Bash calls in a turn run in order.
let held = null;
// Where bash, sleep and PowerShell live on this machine; looked up on first use.
let tools = null;

export function register(on) {
  on("tool.call", { tool: "Bash" }, async ($, e, next) => hold($, e, next, "bash")).catch(($, e, next) => refuse(e, next));
  on("tool.call", { tool: "PowerShell" }, async ($, e, next) => hold($, e, next, "ps")).catch(($, e, next) => refuse(e, next));
  // Monitor runs a shell command too; which shell is not known here, so it is read as both.
  on("tool.call", { tool: "Monitor" }, async ($, e, next) => hold($, e, next, "any")).catch(($, e, next) => refuse(e, next));

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID || held === null || held.report === null) {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (held === null || held.report === null || held.where !== "band") {
      return next(e);
    }
    return draw($.ui.resolve(e), held);
  });
}

/** What the `.catch` answers when the hook itself failed: refuse, unless the command was already let through. */
function refuse(e, next) {
  return next.called ? next(e) : { deny: "Holdpane hit an error and did not run this command. Do not retry it unless the user asks you to." };
}

async function hold($, e, next, shell) {
  const text = String(e.command ?? "");
  const risk = shell === "any" ? (classify(text, "bash", null) ?? classify(text, "ps", null)) : classify(text, shell, null);
  if (risk === null) {
    return next(e);
  }
  // One hold at a time. If another risky call is already held (a subagent's,
  // say), wait until it is answered. `held` is claimed with no await between
  // the check and the claim, so two waiting calls can't both get through.
  let since = await $.clock.now();
  const waitStart = since;
  while (held !== null) {
    if (next.signal.aborted) {
      return { deny: "Holdpane held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to." };
    }
    if (since - held.since > HOLD_LIMIT_MS + STALE_SLACK_MS) {
      held = null; // the call that claimed it is gone without releasing it
      break;
    }
    if (since - waitStart > HOLD_LIMIT_MS) {
      return { deny: "Holdpane did not run this command: another held command was not answered within 10 minutes. Do not retry it unless the user asks you to." };
    }
    await pause($);
    since = await $.clock.now();
  }
  const mine = { command: String(e.command), risk, report: null, decision: null, where: "pane", since };
  held = mine;

  let opened = { isPlaced: false };
  let decision;
  let summary = risk.label;
  try {
    await findTools($);
    // Measure where the command will run: the session folder, moved by any
    // `cd dir &&` or `git -C dir` earlier in the same command line.
    const sessionCwd = await $.session.cwd();
    let cwd = sessionCwd;
    if (risk.dir) {
      try {
        cwd = await resolveDir($, sessionCwd, risk.dir, risk.shell);
      } catch {
        cwd = null; // no tool to look the folder up with: the pane still opens and says so
      }
    }
    mine.report = cwd === null
      ? { summary: `${risk.label} in ${risk.dir}`, lines: [], note: `Couldn't find the folder ${risk.dir}, so I couldn't measure what this would change.` }
      : await measure($, risk, cwd);
    summary = mine.report.summary;

    opened = await $.ui.open({ id: PANE_ID, title: "Holdpane", focus: true, rows: paneRows(mine.report) });
    if (!opened.isPlaced) {
      mine.where = "band";
    }
    $.ui.invalidate("ui.render");

    const startedAt = await $.clock.now();
    mine.since = startedAt; // the 10 minutes run from here, so a waiting call must not take over before that
    while (mine.decision === null) {
      if (next.signal.aborted) {
        mine.decision = "interrupted";
        break;
      }
      if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) {
        mine.decision = "timeout";
        break;
      }
      await pause($);
    }
  } catch {
    mine.decision = "error"; // anything unexpected refuses the command
  } finally {
    decision = mine.decision;
    // Close this call's pane before releasing the hold, so the next call's
    // pane can't be the one that gets closed. A pane that was not placed waits
    // unseen and could appear later, so it is closed too. If the hold was taken
    // over as stale, the pane belongs to the new holder and is left alone.
    if (held === mine) {
      try {
        await $.ui.close({ id: PANE_ID });
      } catch {
        // the pane is already gone
      }
      if (held === mine) {
        held = null;
      }
    }
    try {
      $.ui.invalidate("ui.render");
    } catch {
      // nothing to redraw
    }
  }

  if (decision === "proceed") {
    $.ui.toast("Holdpane: running it");
    return next(e);
  }
  const why = {
    cancel: "the user pressed Cancel",
    timeout: "no answer within 10 minutes",
    interrupted: "the turn was interrupted",
    error: "Holdpane hit an error while holding it",
  }[decision] ?? "no answer was recorded";
  return {
    deny: `Holdpane held this command and did not run it: ${why}. It would have: ${summary}. Do not retry it unless the user asks you to.`,
  };
}

// ---- Where the tools are ----------------------------------------------------

/**
 * Looks up bash, sleep and PowerShell. Never throws. On Windows the plain name
 * `bash` can be the WSL launcher, so without Git's bash there is none (null) and the
 * result is not kept: the next call looks again.
 */
async function findTools($) {
  if (tools !== null) {
    return tools;
  }
  const found = { win: false, bash: "bash", sleep: ["sleep", POLL_SECONDS], ps: "pwsh" };
  let complete = true;
  try {
    found.win = (await $.env.get("OS")) === "Windows_NT";
    if (found.win) {
      found.ps = "powershell.exe";
      found.bash = null;
      complete = false;
      const git = await $.process.run(["git", "--exec-path"], { timeoutMs: 5000 });
      const exec = git.stdout.trim().replace(/[\\/]+$/, "");
      const root = exec.replace(/[\\/](?:(?:mingw64|mingw32|clangarm64)[\\/])?libexec[\\/]git-core$/i, "");
      if (git.exitCode === 0 && root !== exec) {
        const usr = `${root}/usr/bin`;
        const probe = await $.process.run([`${usr}/bash.exe`, "-c", "echo ok"], { timeoutMs: 8000 });
        if (probe.exitCode === 0 && probe.stdout.trim() === "ok") {
          found.bash = `${usr}/bash.exe`;
          found.sleep = [`${usr}/sleep.exe`, POLL_SECONDS];
          complete = true;
        }
      }
    }
  } catch {
    // keep what was found
  }
  try {
    await $.process.run(found.sleep, { timeoutMs: 5000 });
  } catch {
    found.sleep = [found.ps, "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 250"];
  }
  if (complete) {
    tools = found;
  }
  return found;
}

async function pause($) {
  const t = await findTools($);
  await $.process.run(t.sleep, { timeoutMs: 5000 });
}

/** JSON that is pure ASCII, so no code page can change a path on its way into PowerShell. */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function runBash($, script, args, init) {
  const t = await findTools($);
  if (t.bash === null) {
    throw new Error("Git's bash was not found, so the paths can't be measured with it");
  }
  return await $.process.run([t.bash, "-c", script, "holdpane", ...args], init);
}

// The script has single quotes only and no line breaks that matter, so the command
// line survives Windows argument quoting. Its input arrives as ASCII JSON on stdin.
async function runPowerShell($, script, input, init) {
  const t = await findTools($);
  return await $.process.run([t.ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { ...init, stdin: asciiJson(input) });
}

// ---- Cutting a command line apart ---------------------------------------------

/**
 * Cuts a command line at `;` `|` `&&` `||` and line breaks, in Bash also at a single `&`,
 * in PowerShell also at the braces of a script block. Nothing is cut inside quotes, and a
 * brace that sits inside a word (`C:\x\{guid}`, `${env:TEMP}`, `@{a=1}`) is not a block.
 * Comments, Bash heredocs and PowerShell here-strings are text, not commands: their quotes
 * are skipped. Returns { parts, open }; `open` is true when a quote was never closed, which
 * means the scan lost track, and the caller then also reads the line without regard to quotes.
 */
function splitCommand(command, shell) {
  const ps = shell === "ps";
  const parts = [];
  const blocks = []; // for each open `{`: whether it was cut at (a block) or part of a word
  const heredocs = []; // Bash: delimiters whose bodies start after the current line
  let cur = "";
  let quote = null;
  const cut = () => {
    parts.push(cur);
    cur = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const after = command[i + 1];
    const before = command[i - 1];
    if (quote !== null) {
      cur += ch;
      if (ch === "`" && ps && quote === "\"" && after !== undefined) {
        cur += after;
        i += 1;
      } else if (ch === "\\" && !ps && quote === "\"" && after !== undefined) {
        cur += after;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|&(]/.test(before))) {
      const end = command.indexOf("\n", i); // a comment runs to the end of the line
      i = end < 0 ? command.length : end - 1;
    } else if (ps && ch === "<" && after === "#") {
      const end = command.indexOf("#>", i + 2); // <# block comment #>
      i = end < 0 ? command.length : end + 1;
    } else if (ps && ch === "@" && (after === "'" || after === "\"") && /^[ \t]*\r?\n/.test(command.slice(i + 2, i + 40))) {
      const close = command.indexOf(`\n${after}@`, i + 2); // @' here-string '@
      const stop = close < 0 ? command.length : close + 3;
      cur += command.slice(i, stop);
      i = stop - 1;
    } else if (!ps && ch === "<" && after === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z0-9_.-]+))/.exec(command.slice(i, i + 200));
      if (m === null) {
        cur += ch;
      } else {
        heredocs.push({ delim: m[2] ?? m[3] ?? m[4], strip: m[1] === "-" });
        cur += m[0];
        i += m[0].length - 1;
      }
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      cur += ch;
    } else if ((ch === "`" && ps) || (ch === "\\" && !ps)) {
      cur += ch;
      if (after !== undefined) {
        cur += after;
        i += 1;
      }
    } else if (ps && ch === "$" && after === "{") {
      const end = command.indexOf("}", i);
      const stop = end < 0 ? command.length : end + 1;
      cur += command.slice(i, stop);
      i = stop - 1;
    } else if ((ch === "&" && after === "&") || (ch === "|" && after === "|")) {
      cut();
      i += 1;
    } else if (ch === ";" || ch === "|" || ch === "\n") {
      cut();
      if (ch === "\n" && heredocs.length > 0) {
        let pos = i + 1;
        for (const h of heredocs) {
          pos = skipHeredoc(command, pos, h.delim, h.strip);
        }
        heredocs.length = 0;
        i = pos - 1;
      }
    } else if (ch === "&" && !ps && before !== ">" && before !== "<" && after !== ">") {
      cut();
    } else if (ps && ch === "{") {
      // A block follows whitespace, ( ; | & { }, a closing ), %, ? or a keyword (try{ else{ ForEach-Object{).
      const isBlock = before === undefined || /[\s(;|&{})%?]/.test(before) || /(?:^|[\s;|&(){}])(?:try|catch|finally|else|do|begin|process|end|dynamicparam|foreach-object|where-object)$/i.test(cur);
      blocks.push(isBlock);
      if (isBlock) {
        cut();
      } else {
        cur += ch;
      }
    } else if (ps && ch === "}") {
      if (blocks.pop() === true) {
        cut();
      } else {
        cur += ch;
      }
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return { parts, open: quote !== null };
}

/** The index after the line that ends a heredoc body (the line that is just the delimiter). */
function skipHeredoc(command, from, delim, strip) {
  let pos = from;
  while (pos < command.length) {
    const end = command.indexOf("\n", pos);
    let line = command.slice(pos, end < 0 ? command.length : end).replace(/\r$/, "");
    if (strip) {
      line = line.replace(/^\t+/, "");
    }
    pos = end < 0 ? command.length : end + 1;
    if (line === delim) {
      return pos;
    }
  }
  return command.length;
}

/** The line cut at every operator, with no regard to quotes: what the scan falls back on when it lost track of them. */
function splitNaively(command, shell) {
  return command.split(shell === "ps" ? /&&|\|\||;|\||\n|[{}]/ : /&&|\|\||;|\||\n|(?<![<>&])&(?![>&])/);
}

/** The segment without trailing redirects and `&`: `(cd sub && make) > log` still shows its closing ). */
function stripRedirects(segment) {
  let text = segment;
  for (let guard = 0; guard < 50; guard += 1) {
    // Bounded white space keeps this linear-ish on a line of thousands of spaces.
    const next = text.replace(/\s{0,64}(?:\d*>>?&?|&>>?|<)\s{0,64}[^\s<>&]+\s{0,64}$/, "").replace(/\s{0,64}&\s{0,64}$/, "");
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

// ---- What counts as risky -------------------------------------------------

// sudo options that take a value, so the value isn't read as the command.
const SUDO_VALUE_OPTIONS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]);
// Commands that only read, so a bare word "migrate" in them isn't a migration.
const READ_ONLY = new Set(["ls", "cat", "echo", "printf", "grep", "rg", "find", "less", "head", "tail", "cd", "git", "get-content", "select-string", "write-host", "write-output", "get-childitem", "gci", "dir"]);

/** A risk the command line can't be read for: it is held and the pane says so. */
function opaque(shell, label, note, dir) {
  return { kind: "opaque", shell, label, note, dir: dir ?? null };
}

/** A folder a later `cd arg` moves to, given the folder so far (null = the session folder). */
function joinDir(dir, arg) {
  if (arg === undefined || arg === "~" || arg.startsWith("/") || arg.startsWith("\\") || /^[A-Za-z]:/.test(arg) || arg.startsWith("~/") || arg.startsWith("~\\")) {
    return arg ?? "~";
  }
  return dir ? `${dir}/${arg}` : arg;
}

/** The first risky segment of a shell command, or null. `shell` is "bash" or "ps". */
function classify(command, shell, startDir) {
  if (command.length > MAX_COMMAND) {
    return opaque(shell, "a very long command", `The command line has ${command.length} characters. Commands over ${MAX_COMMAND} are held without being read, so I can't tell what this does.`, startDir);
  }
  // PowerShell reads en and em dashes as a hyphen in front of a parameter.
  const text = shell === "ps" ? command.replace(/[–—―]/g, "-") : command;
  // A line continuation joins the lines before the command is cut apart.
  const joined = shell === "ps" ? text.replace(/`\r?\n/g, " ") : text.replace(/\\\r?\n/g, " ");
  const { parts, open } = splitCommand(joined, shell);
  const risk = scanSegments(parts, shell, startDir);
  if (risk !== null || !open) {
    return risk;
  }
  // A quote was never closed: the scan lost track (a quote inside a $( ) heredoc, say).
  // Read the line again without regard to quotes, so nothing hides behind the lost quote.
  return scanSegments(splitNaively(joined, shell), shell, startDir);
}

/** The first risky one of the segments, following cd, pushd and popd; null if none. */
function scanSegments(segments, shell, startDir) {
  let dir = startDir; // where a `cd` earlier on the line moved to; null means the session folder
  const scopes = []; // dir to restore when a ( subshell ) closes
  const pushed = []; // pushd stack, for popd
  for (const raw of segments) {
    const opens = (raw.match(/^\s*\(+/)?.[0].trim().length) ?? 0;
    const closes = (stripRedirects(raw).match(/\)+\s*$/)?.[0].trim().length) ?? 0;
    for (let k = 0; k < opens; k += 1) {
      scopes.push(dir);
    }
    const risk = shell === "ps" ? classifyPsSegment(raw, dir, pushed) : classifySegment(raw, dir, pushed);
    if (risk !== null && risk.cd === undefined) {
      return risk;
    }
    if (risk !== null) {
      dir = risk.cd; // a cd, pushd or popd moved the folder
    }
    for (let k = 0; k < closes && scopes.length > 0; k += 1) {
      dir = scopes.pop(); // a cd inside ( ... ) doesn't outlive it
    }
  }
  return null;
}

// Words that can come before the real command without changing what it does.
const PREFIXES = new Set(["command", "exec", "env", "nohup", "time", "then", "do", "else", "!"]);

/** Whether the flags of an `rm` make it recursive, forced, or both. */
function rmFlags(flags) {
  return {
    recursive: flags.some((f) => f === "--recursive" || (/^-[^-]/.test(f) && /[rR]/.test(f))),
    force: flags.some((f) => f === "--force" || (/^-[^-]/.test(f) && f.includes("f"))),
  };
}

/** A git risk for `git args...` run in `dir`, or null. Git's own options come first; -C moves where it runs. */
function classifyGit(args, dir) {
  let gitDir = dir;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C" && i + 1 < args.length) {
      gitDir = joinDir(gitDir, args[i + 1]);
      i += 2;
    } else if ((args[i] === "-c" || args[i] === "--git-dir" || args[i] === "--work-tree" || args[i] === "--namespace") && i + 1 < args.length) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "reset" && rest.includes("--hard")) {
    return { kind: "git-reset", label: "git reset --hard", args: rest, dir: gitDir };
  }
  if (sub === "clean") {
    return { kind: "git-clean", label: "git clean", args: rest, dir: gitDir };
  }
  // -f may sit in a bundle of short flags (-fu, -uf).
  if (sub === "push" && rest.some((a) => a === "--force" || a.startsWith("--force-with-lease") || /^\+/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) {
    return { kind: "git-push-force", label: "git push --force", args: rest, dir: gitDir };
  }
  const stagedOnly = sub === "restore" && rest.includes("--staged") && !rest.includes("--worktree") && !rest.includes("-W");
  if ((sub === "checkout" || sub === "restore") && rest.includes(".") && !stagedOnly) {
    return { kind: "git-checkout", label: `git ${sub} -- .`, args: rest, dir: gitDir };
  }
  // checkout -f and switch -f throw away local changes.
  if ((sub === "checkout" && rest.some((a) => a === "-f" || a === "--force")) || (sub === "switch" && rest.some((a) => a === "-f" || a === "--force" || a === "--discard-changes"))) {
    return { kind: "git-checkout", label: `git ${sub} --force`, args: rest, dir: gitDir };
  }
  return null;
}

/** A migration risk for the words of one segment, or null. */
function classifyMigration(cmd, args, joined, dir, shell) {
  if (/\balembic\s+upgrade\b/.test(joined)) {
    return { kind: "migrate", shell, tool: "alembic", label: "alembic upgrade", dir };
  }
  if (/\bdb:migrate(?!:status\b)/.test(joined)) {
    return { kind: "migrate", shell, tool: "rails", label: "db:migrate", dir };
  }
  if (/\bprisma\s+migrate\b/.test(joined)) {
    return { kind: "migrate", shell, tool: "prisma", label: "prisma migrate", dir };
  }
  if (/\bmanage\.py\s+migrate\b/.test(joined)) {
    return { kind: "migrate", shell, tool: "django", label: "manage.py migrate", dir };
  }
  if (!READ_ONLY.has(cmd) && args.includes("migrate")) {
    return { kind: "migrate", shell, tool: "unknown", label: "migrate", dir };
  }
  return null;
}

/** `powershell -Command "..."` (args as strings): the text is classified as PowerShell; an encoded command is held unread. */
function classifyPowerShellCall(args, dir) {
  const named = (a, full, min) => /^-[A-Za-z]+$/.test(a) && a.length - 1 >= min && full.startsWith(a.slice(1).toLowerCase());
  const at = args.findIndex((a) => named(a, "command", 1));
  if (at >= 0) {
    return classify(args.slice(at + 1).join(" "), "ps", dir);
  }
  if (args.some((a) => named(a, "encodedcommand", 1) || a.toLowerCase() === "-ec")) {
    return opaque("ps", "an encoded PowerShell command", "The command is passed base64-encoded, so I can't read what it does.", dir);
  }
  // Without -Command, the first word that is neither an option nor an option's value is the command
  // (Windows PowerShell's default parameter). A script given with -File is not read.
  const valued = ["executionpolicy", "ep", "windowstyle", "outputformat", "inputformat", "version", "configurationname", "workingdirectory", "psconsolefile", "custompipename"];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("-")) {
      if (named(args[i], "file", 1)) {
        return null;
      }
      if (valued.some((v) => v.startsWith(args[i].slice(1).toLowerCase()))) {
        i += 1;
      }
    } else {
      return classify(args.slice(i).join(" "), "ps", dir);
    }
  }
  return null;
}

/** One segment: a risk, { cd } for a folder change, or null. */
function classifySegment(segment, dir, pushed) {
  // Redirects at the end go first, so `(cd sub && rm -rf out) > log 2>&1` leaves `rm -rf out`.
  // A closing } is only dropped when the segment opened a { group: in `rm -rf {a,b}` it is part of a path.
  const trimmed = stripRedirects(segment.trim());
  const words = tokenize(trimmed.replace(/^[({]+\s*/, "").replace(/\s*\)+$/, "").replace(trimmed.startsWith("{") ? /\s*}+$/ : /(?!)/, ""));
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    words.shift(); // leading VAR=value
  }
  if (words[0] === "sudo") {
    words.shift();
    while (words.length > 0 && words[0].startsWith("-")) {
      const option = words.shift();
      if (SUDO_VALUE_OPTIONS.has(option)) {
        words.shift();
      }
    }
  }
  let prefixed = false;
  while (words.length > 0 && (PREFIXES.has(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) {
    words.shift();
    prefixed = true;
  }
  while (prefixed && words.length > 0 && words[0].startsWith("-")) {
    words.shift(); // env -i, time -p
  }
  if (words[0] === "timeout") {
    words.shift();
    while (words.length > 0 && words[0].startsWith("-")) {
      const option = words.shift();
      if (option === "-s" || option === "-k" || option === "--signal" || option === "--kill-after") {
        words.shift();
      }
    }
    words.shift(); // the duration
  }
  if (words[0] === "nice") {
    words.shift();
    if (words[0] === "-n") {
      words.splice(0, 2);
    } else if (/^-\d+$/.test(words[0] ?? "")) {
      words.shift();
    }
  }
  const [first, ...args] = words;
  if (first === undefined) {
    return null;
  }
  const cmd = first.replace(/^\\/, ""); // \rm skips aliases; it's still rm
  if (cmd === "cd") {
    return { cd: args[0] === "-" ? "-" : joinDir(dir, args[0]) };
  }
  if (cmd === "pushd") {
    pushed.push(dir);
    return { cd: joinDir(dir, args[0]) };
  }
  if (cmd === "popd") {
    return { cd: pushed.length > 0 ? pushed.pop() : "-" };
  }
  // The program's name without its folder and .exe, so /c/Program Files/Git/cmd/git.exe is git.
  const base = cmd.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  if (base === "rm") {
    const flags = args.filter((a) => a.startsWith("-"));
    const { recursive, force } = rmFlags(flags);
    if (recursive || force) {
      const targets = args.filter((a) => (!a.startsWith("-") || a === "-") && !/^(?:\d*>|&>|<)/.test(a));
      return { kind: "rm", shell: "bash", label: `rm ${flags.join(" ")}`.trim(), targets, dir };
    }
  }
  if (base === "xargs") {
    const at = args.findIndex((a) => a.replace(/^.*[\\/]/, "") === "rm");
    if (at >= 0) {
      const flags = args.slice(at + 1).filter((a) => a.startsWith("-"));
      const { recursive, force } = rmFlags(flags);
      if (recursive || force) {
        return { kind: "rm", shell: "bash", label: `xargs rm ${flags.join(" ")}`.trim(), targets: [], piped: true, dir };
      }
    }
  }
  if (base === "git") {
    const risk = classifyGit(args, dir);
    if (risk !== null) {
      return { ...risk, shell: "bash" };
    }
  }
  if (["bash", "sh", "zsh", "dash"].includes(base)) {
    const at = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (at >= 0 && args[at + 1] !== undefined) {
      const risk = classify(args[at + 1], "bash", dir);
      if (risk !== null) {
        return risk;
      }
    }
  }
  if (base.toLowerCase() === "powershell" || base.toLowerCase() === "pwsh") {
    const risk = classifyPowerShellCall(args, dir);
    if (risk !== null) {
      return risk;
    }
  }
  if (base.toLowerCase() === "cmd") {
    const at = args.findIndex((a) => /^\/{1,2}[ck]$/i.test(a));
    if (at >= 0) {
      const risk = classifyCmd(args.slice(at + 1).join(" "), dir);
      if (risk !== null) {
        return risk;
      }
    }
  }
  return classifyMigration(base, args, words.join(" "), dir, "bash");
}

// ---- PowerShell -------------------------------------------------------------

const PS_REMOVE = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const PS_CD = new Set(["cd", "chdir", "sl", "set-location"]);
const PS_PUSH = new Set(["pushd", "push-location"]);
const PS_POP = new Set(["popd", "pop-location"]);
const PS_START = new Set(["start-process", "saps", "start"]);
// Parameters that take a value, so the value isn't read as a path. PowerShell accepts
// any unambiguous start of a name; a start of one of these is taken as theirs.
const PS_VALUE_PARAMS = ["path", "literalpath", "filter", "include", "exclude", "credential", "stream", "erroraction", "errorvariable", "warningaction", "warningvariable", "informationaction", "informationvariable", "outvariable", "outbuffer", "pipelinevariable", "ea", "ev", "wa", "wv", "infa", "iv", "ov", "ob", "pv"];
const PS_START_VALUE_PARAMS = ["workingdirectory", "redirectstandardinput", "redirectstandardoutput", "redirectstandarderror", "verb", "windowstyle", "credential", "environment"];

/**
 * Splits one PowerShell segment into words, honouring quotes ('' and "" inside them,
 * a backtick escape in double quotes). A word is { raw, parts }: the text as written,
 * and its comma-separated pieces unquoted (`a,'b c'` is two pieces).
 */
function psTokenize(text) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i += 1;
      continue;
    }
    const parts = [""];
    let raw = "";
    while (i < text.length && !/\s/.test(text[i])) {
      const ch = text[i];
      if (ch === "\"" || ch === "'") {
        let j = i + 1;
        let value = "";
        while (j < text.length) {
          if (ch === "\"" && text[j] === "`" && j + 1 < text.length) {
            value += text[j + 1];
            j += 2;
          } else if (text[j] === ch) {
            if (text[j + 1] === ch) {
              value += ch;
              j += 2;
            } else {
              break;
            }
          } else {
            value += text[j];
            j += 1;
          }
        }
        parts[parts.length - 1] += value;
        raw += text.slice(i, j + 1);
        i = j + 1;
      } else if (ch === ",") {
        parts.push("");
        raw += ch;
        i += 1;
      } else if (ch === "`" && i + 1 < text.length) {
        parts[parts.length - 1] += text[i + 1];
        raw += text.slice(i, i + 2);
        i += 2;
      } else {
        parts[parts.length - 1] += ch;
        raw += ch;
        i += 1;
      }
    }
    words.push({ raw, parts });
  }
  return words;
}

/** { name, value } for `-Name` or `-Name:value` (name lower-cased), or null for any other word. */
function psParam(word) {
  const m = /^-([A-Za-z]+)(?::(.*))?$/.exec(word.raw);
  return m === null ? null : { name: m[1].toLowerCase(), value: m[2] };
}

/** Whether a parameter name is a start of `full` at least `min` letters long. */
function isParam(name, full, min) {
  return name.length >= min && full.startsWith(name);
}

/** Whether a word as written is worked out by PowerShell or cmd at run time: a variable, a ( ) expression, @splat or %VAR%. */
function isDynamic(raw) {
  return (!raw.startsWith("'") && raw.includes("$")) || /^[(@]/.test(raw) || /%[A-Za-z_][^%\s]*%/.test(raw);
}

/** The unquoted pieces of the value in `-Name:value`. */
function psValueParts(value) {
  return psTokenize(value)[0]?.parts ?? [];
}

/** One PowerShell segment: a risk, { cd } for a folder change, or null. */
function classifyPsSegment(segment, dir, pushed) {
  const text = stripRedirects(segment.trim())
    .replace(/^(?:\[[\w.,[\]\s]+\]\s*)?\$[\w:.]+(?:\[[^\]]*\])?\s*[+\-*/%]?=\s*/, "") // $out = cmd, [string]$o = cmd, $x[0] = cmd
    .replace(/^\$[\w:.]+\s*=\s*/, "") // $a = $b = cmd
    .replace(/^\[[\w.,[\]\s]+\]\s*/, "") // [void](cmd)
    .replace(/^[&.](?=["'])/, "") // &"git" with no space
    .replace(/^[({]+\s*/, "")
    .replace(/\s*[)}]+$/, "");
  const words = psTokenize(text);
  while (words.length > 0 && (words[0].raw === "&" || words[0].raw === ".")) {
    words.shift(); // call operator and dot-sourcing
  }
  if (words.length === 0) {
    return null;
  }
  const cmd = words[0].parts.join(",").replace(/^.*[\\/]/, "").replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase();
  const args = words.slice(1);

  if (PS_CD.has(cmd) || PS_PUSH.has(cmd) || PS_POP.has(cmd)) {
    if (PS_POP.has(cmd)) {
      return { cd: pushed.length > 0 ? pushed.pop() : "-" };
    }
    let target;
    for (let i = 0; i < args.length && target === undefined; i += 1) {
      const p = psParam(args[i]);
      if (p === null && !args[i].raw.startsWith("-")) {
        target = args[i].parts.join(",");
      } else if (p !== null && (isParam(p.name, "path", 1) || isParam(p.name, "literalpath", 1))) {
        target = p.value !== undefined ? psValueParts(p.value).join(",") : args[i + 1]?.parts.join(",");
      }
    }
    if (PS_PUSH.has(cmd)) {
      pushed.push(dir);
    }
    if (target === undefined) {
      return { cd: dir }; // a bare cd stays where it is
    }
    return { cd: target === "-" ? "-" : joinDir(dir, target) };
  }

  if (PS_REMOVE.has(cmd)) {
    const name = cmd === "remove-item" ? "Remove-Item" : cmd;
    if (args.some((w) => w.raw.startsWith("@"))) {
      return opaque("ps", `${name} with splatted parameters`, "The parameters come from a variable (@name), so I can't tell what this removes.", dir);
    }
    let recurse = false;
    let force = false;
    let whatIf = false;
    let filters = false;
    const flags = [];
    const targets = [];
    for (let i = 0; i < args.length; i += 1) {
      const p = psParam(args[i]);
      if (p === null) {
        if (/^\d*>/.test(args[i].raw)) {
          continue; // a redirect, not a path
        }
        for (const part of args[i].parts) {
          if (part !== "") {
            targets.push({ p: part, lit: false, dyn: isDynamic(args[i].raw) });
          }
        }
        continue;
      }
      const on = p.value === undefined ? true : !/^\$?false$/i.test(p.value);
      if (isParam(p.name, "recurse", 1)) {
        recurse = on;
        flags.push(args[i].raw);
      } else if (isParam(p.name, "force", 2)) {
        force = on;
        flags.push(args[i].raw);
      } else if (isParam(p.name, "whatif", 2)) {
        whatIf = on;
      } else if (isParam(p.name, "path", 2) || isParam(p.name, "literalpath", 1)) {
        const lit = isParam(p.name, "literalpath", 1);
        const parts = p.value !== undefined ? psValueParts(p.value) : (args[i + 1]?.parts ?? []);
        const dyn = isDynamic(p.value !== undefined ? p.value : (args[i + 1]?.raw ?? ""));
        if (p.value === undefined) {
          i += 1;
        }
        for (const part of parts) {
          if (part !== "") {
            targets.push({ p: part, lit, dyn });
          }
        }
      } else if (PS_VALUE_PARAMS.some((n) => n.startsWith(p.name))) {
        filters = filters || isParam(p.name, "filter", 2) || isParam(p.name, "include", 3) || isParam(p.name, "exclude", 2);
        if (p.value === undefined) {
          i += 1; // its value
        }
      }
    }
    if (whatIf || (!recurse && !force)) {
      return null;
    }
    return { kind: "rm", shell: "ps", label: `${name} ${flags.join(" ")}`.trim(), targets, filters, dir };
  }

  if (cmd === "git") {
    const risk = classifyGit(args.map((w) => w.parts.join(",")), dir);
    if (risk !== null) {
      return { ...risk, shell: "ps" };
    }
  }

  if (PS_START.has(cmd)) {
    // Start-Process git -ArgumentList 'reset','--hard' runs git as well.
    let file;
    let list = [];
    for (let i = 0; i < args.length; i += 1) {
      const p = psParam(args[i]);
      if (p === null) {
        if (file === undefined) {
          file = args[i].parts.join(",");
        } else if (list.length === 0) {
          list = args[i].parts; // the second positional parameter is ArgumentList
        }
      } else if (isParam(p.name, "filepath", 2)) {
        file = p.value !== undefined ? psValueParts(p.value).join(",") : args[i + 1]?.parts.join(",");
        i += p.value === undefined ? 1 : 0;
      } else if (isParam(p.name, "argumentlist", 1) || p.name === "args") {
        list = p.value !== undefined ? psValueParts(p.value) : (args[i + 1]?.parts ?? []);
        i += p.value === undefined ? 1 : 0;
      } else if (PS_START_VALUE_PARAMS.some((n) => n.startsWith(p.name)) && p.value === undefined) {
        i += 1;
      }
    }
    if (file !== undefined) {
      const risk = classify([file, ...list].join(" "), "ps", dir);
      if (risk !== null) {
        return risk;
      }
    }
  }

  // powershell -Command "..." and cmd /c "..." run text of their own.
  if (cmd === "powershell" || cmd === "pwsh") {
    const risk = classifyPowerShellCall(args.map((w) => w.parts.join(",")), dir);
    if (risk !== null) {
      return risk;
    }
  }
  if (cmd === "cmd") {
    const at = args.findIndex((w) => /^\/[ck]$/i.test(w.raw));
    if (at >= 0) {
      const risk = classifyCmd(args.slice(at + 1).map((w) => w.parts.join(",")).join(" "), dir);
      if (risk !== null) {
        return risk;
      }
    }
  }

  return classifyMigration(cmd, args.map((w) => w.parts.join(",")), words.map((w) => w.parts.join(",")).join(" "), dir, "ps");
}

/** A risk in cmd.exe text: `rd /s` or `rmdir /s`, also `/s/q`; `del /s` too, which is held but not measured. */
function classifyCmd(text, dir) {
  for (const part of text.split(/&&|\|\||&|\|/)) {
    const words = psTokenize(part.trim());
    const cmd = (words[0]?.parts.join(",") ?? "").toLowerCase();
    if (!["rd", "rmdir", "del", "erase"].includes(cmd)) {
      continue;
    }
    const args = words.slice(1);
    const switches = args.filter((w) => w.raw.startsWith("/")).flatMap((w) => w.raw.split("/").filter((s) => s !== ""));
    if (!switches.some((s) => /^s$/i.test(s))) {
      continue;
    }
    const lit = cmd === "rd" || cmd === "rmdir"; // del matches wildcards, rd does not
    const targets = args.filter((w) => !w.raw.startsWith("/")).flatMap((w) => w.parts.filter((p) => p !== "").map((p) => ({ p, lit, dyn: isDynamic(w.raw) })));
    return { kind: "rm", shell: "ps", label: `${cmd} /s`, targets, filters: false, unmeasurable: !lit, dir };
  }
  return null;
}

// Resolves a `cd` target to an absolute folder, or null if it doesn't exist.
// The target is passed as an argument, never as source.
const CD_SCRIPT = `PATH="/usr/bin:$PATH"; unset CDPATH; d="$1"; case "$d" in "~") d="$HOME";; "~/"*) d="$HOME/\${d#\\~/}";; esac; cd -- "$d" 2>/dev/null && { pwd -W 2>/dev/null || pwd -P; }`;
const PS_CD_SCRIPT = "$ErrorActionPreference='Stop'; $d=([Console]::In.ReadToEnd()|ConvertFrom-Json).d; if($d -eq '~'){$d=$HOME}elseif($d.StartsWith('~/') -or $d.StartsWith('~\\')){$d=Join-Path $HOME $d.Substring(2)}; try{Set-Location -LiteralPath $d; [Uri]::EscapeDataString((Get-Location).ProviderPath)}catch{exit 1}";

/** A \\server\share or //server/share path: even looking at it opens a network connection. */
function isNetworkPath(p) {
  return /^(?:\\\\|\/\/)/.test(p);
}

async function resolveDir($, sessionCwd, dir, shell) {
  if (dir === "-" || isNetworkPath(dir)) {
    return null; // `cd -` depends on the shell's history; a network folder is not touched before the answer
  }
  if (shell === "ps") {
    const run = await runPowerShell($, PS_CD_SCRIPT, { d: dir }, { cwd: sessionCwd, timeoutMs: 15000 });
    const out = run.stdout.trim();
    return run.exitCode === 0 && out !== "" ? decodeURIComponent(out) : null;
  }
  const run = await runBash($, CD_SCRIPT, [dir], { cwd: sessionCwd, timeoutMs: 5000 });
  const out = run.stdout.trim();
  return run.exitCode === 0 && out !== "" ? out : null;
}

/** Splits one segment into words, honouring quotes. Good enough to read flags and paths. */
function tokenize(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push(m[1] ?? m[2] ?? m[3]);
  }
  return words;
}

// ---- Measuring the blast radius -------------------------------------------

/** { summary, lines, note } for the pane. Never throws: a failed read is said, not hidden. */
async function measure($, risk, cwd) {
  try {
    if (risk.kind === "opaque") {
      return { summary: `${risk.label}: I can't tell what it does`, lines: [], note: risk.note };
    }
    if (risk.kind === "rm") {
      return risk.shell === "ps" ? await measureRmPs($, risk, cwd) : await measureRm($, risk, cwd);
    }
    if (risk.kind === "migrate") {
      return measureMigrations(risk);
    }
    return await measureGit($, risk, cwd);
  } catch (error) {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `Could not measure: ${String(error?.message ?? error).slice(0, 200)}` };
  }
}

/** A report for paths that hold a variable or an expression: they are not expanded, so nothing can be said. */
function unexpandedReport(risk, targets) {
  return {
    summary: `${risk.label}: the target is worked out when it runs`,
    lines: [],
    note: `Paths: ${targets.join(" ")}. They use a variable or an expression, which I can't expand, so I can't tell what this would delete.`,
  };
}

/** A report for a network path: looking at it would open a connection before you have answered. */
function networkReport(risk, targets) {
  return {
    summary: `${risk.label}: the target is on the network`,
    lines: [],
    note: `Paths: ${targets.join(" ")}. I don't touch network paths before you answer, so I can't tell what this would delete.`,
  };
}

// The paths are passed to bash as arguments, never as source, so nothing in
// them runs. compgen -G expands a glob without command substitution.
const RM_SCRIPT = `
PATH="/usr/bin:$PATH"  # Git's find and du, not the Windows find
shopt -s nullglob dotglob
paths=()
for p in "$@"; do
  case "$p" in [A-Za-z]:?*) p=$(cygpath -u "$p");; esac  # C:\\x or C:/x
  case "$p" in "~"|"~/"*) p="$HOME\${p#\\~}";; esac
  if [[ "$p" == *[*?[]* ]]; then
    while IFS= read -r m; do paths+=("$m"); done < <(compgen -G "$p")
  elif [[ -e "$p" || -L "$p" ]]; then
    paths+=("$p")
  fi
done
if (( \${#paths[@]} == 0 )); then echo "0 0 0"; exit 0; fi
# A relative path gets ./ in front, so find never reads a name like -delete as an action.
for i in "\${!paths[@]}"; do case "\${paths[$i]}" in /*) ;; *) paths[$i]="./\${paths[$i]}";; esac; done
files=$(find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | wc -l | tr -d ' ')
kb=$(du -skc "\${paths[@]}" 2>/dev/null | tail -n1 | cut -f1)
echo "$files $(( \${kb:-0} * 1024 )) \${#paths[@]}"
find "\${paths[@]}" \\( -type f -o -type l \\) 2>/dev/null | head -n ${LIST_MAX}
`;

async function measureRm($, risk, cwd) {
  if (risk.targets.length === 0) {
    return risk.piped
      ? { summary: `${risk.label} on what an earlier command lists`, lines: [], note: "The paths come from an earlier command, so I can't list them." }
      : { summary: "rm with no paths", lines: [], note: "No paths to expand." };
  }
  if (risk.targets.some(isNetworkPath)) {
    return networkReport(risk, risk.targets);
  }
  if (risk.targets.some((t) => /\$|`|[{}]/.test(t))) {
    return unexpandedReport(risk, risk.targets);
  }
  const run = await runBash($, RM_SCRIPT, risk.targets, { cwd, timeoutMs: 15000 });
  if (run.exitCode !== 0 && run.stdout.trim() === "") {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `bash failed: ${run.stderr.trim().slice(0, 200)}` };
  }
  const [head, ...rest] = run.stdout.split("\n").filter((l) => l !== "");
  const [files, bytes, found] = (head ?? "0 0 0").split(" ").map(Number);
  if (!found) {
    return { summary: `delete nothing: no file matches ${risk.targets.join(" ")}`, lines: [], note: "The paths don't exist, so rm has nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${risk.targets.join(" ")}` };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines: rest.map((l) => l.replace(/^\.\//, "")),
    more: Math.max(0, files - rest.length),
    note: `Paths: ${risk.targets.join(" ")}`,
  };
}

// Counts the files below the given paths without following junctions or symbolic links.
// Output: "files bytes found links", then up to LIST_MAX percent-encoded file paths.
const PS_RM_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$in=([Console]::In.ReadToEnd()|ConvertFrom-Json).t",
  "$n=0;$bytes=0;$found=0;$links=0",
  "$list=New-Object Collections.ArrayList;$stack=New-Object Collections.Stack",
  "foreach($t in @($in)){ if($t.lit){$r=@(Get-Item -LiteralPath $t.p -Force)}else{$r=@(Get-Item -Path $t.p -Force)}; foreach($i in $r){ $found++; if($i -is [IO.DirectoryInfo]){ if($i.Attributes -band 1024){$links++}else{$stack.Push($i)} }else{ $n++; $bytes+=$i.Length; if($list.Count -lt " + LIST_MAX + "){[void]$list.Add($i.FullName)} } } }",
  "while($stack.Count -gt 0){ $d=$stack.Pop(); try{ foreach($c in $d.EnumerateFileSystemInfos()){ if($c -is [IO.DirectoryInfo]){ if($c.Attributes -band 1024){$links++}else{$stack.Push($c)} }else{ $n++; $bytes+=$c.Length; if($list.Count -lt " + LIST_MAX + "){[void]$list.Add($c.FullName)} } } }catch{} }",
  "'{0} {1} {2} {3}' -f $n,$bytes,$found,$links",
  "foreach($p in $list){[Uri]::EscapeDataString($p)}",
].join("; ");

async function measureRmPs($, risk, cwd) {
  const paths = risk.targets.map((t) => t.p);
  if (risk.unmeasurable) {
    return { summary: `${risk.label}: deletes every matching file in the folder and below it`, lines: [], note: `Paths: ${paths.join(" ")}. I don't measure del /s, because it matches names at every level.` };
  }
  if (paths.length === 0) {
    return { summary: `${risk.label} on what the pipeline passes it`, lines: [], note: "The paths come from an earlier command, so I can't list them." };
  }
  if (paths.some(isNetworkPath)) {
    return networkReport(risk, paths);
  }
  if (risk.targets.some((t) => t.dyn)) {
    return unexpandedReport(risk, paths);
  }
  const run = await runPowerShell($, PS_RM_SCRIPT, { t: risk.targets.map(({ p, lit }) => ({ p, lit })) }, { cwd, timeoutMs: 25000 });
  if (run.exitCode !== 0 && run.stdout.trim() === "") {
    return { summary: `${risk.label} (could not measure it)`, lines: [], note: `PowerShell failed: ${run.stderr.trim().slice(0, 200)}` };
  }
  const [head, ...rest] = run.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const [files, bytes, found, links] = (head ?? "0 0 0 0").split(" ").map(Number);
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const lines = rest.map((l) => {
    const full = decodeURIComponent(l).replace(/\\/g, "/");
    return full.toLowerCase().startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
  });
  const extra = [
    risk.filters ? "Include, Exclude and Filter are not applied here, so the real number may be smaller." : "",
    links ? `${links} junction or symbolic link folder${links === 1 ? "" : "s"} not followed.` : "",
  ].filter((s) => s !== "").join(" ");
  if (!found) {
    return { summary: `delete nothing: no file matches ${paths.join(" ")}`, lines: [], note: "The paths don't exist, so there is nothing to remove." };
  }
  if (!files) {
    return { summary: `delete ${found} ${found === 1 ? "path" : "paths"} with no files in ${found === 1 ? "it" : "them"}`, lines: [], note: `Paths: ${paths.join(" ")}. ${extra}`.trim() };
  }
  return {
    summary: `delete ${files} ${files === 1 ? "file" : "files"} (about ${size(bytes)})`,
    lines,
    more: Math.max(0, files - lines.length),
    note: `Paths: ${paths.join(" ")}. ${extra}`.trim(),
  };
}

async function measureGit($, risk, cwd) {
  if (risk.kind === "git-push-force") {
    return await measurePush($, risk, cwd);
  }
  if (risk.kind === "git-clean") {
    const flags = [];
    const paths = [];
    for (let i = 0; i < risk.args.length; i += 1) {
      const a = risk.args[i];
      if (a === "--") {
        paths.push(...risk.args.slice(i + 1));
        break;
      }
      if (a === "-e" || a === "--exclude") {
        flags.push(a, risk.args[i + 1] ?? "");
        i += 1;
      } else if (a.startsWith("--exclude=") || /^-e./.test(a)) {
        flags.push(a);
      } else if (/^-[a-zA-Z]+$/.test(a)) {
        const kept = a.replace(/[finq]/g, ""); // -n is added below; -f, -i and -q would change the dry run
        if (kept !== "-") {
          flags.push(kept);
        }
        if (a.endsWith("e")) {
          flags.push(risk.args[i + 1] ?? ""); // -fde 'pattern': the e takes the next word
          i += 1;
        }
      } else if (!a.startsWith("-")) {
        paths.push(a);
      }
    }
    const run = await $.process.run([...GIT, "clean", "-n", ...flags, "--", ...paths], { cwd, timeoutMs: 15000 });
    if (run.exitCode !== 0) {
      return { summary: "git clean (could not dry-run it)", lines: [], note: run.stderr.trim().slice(0, 200) };
    }
    const gone = run.stdout.split("\n").filter((l) => l.startsWith("Would remove ")).map((l) => l.slice(13).trim());
    return {
      summary: gone.length === 0 ? "remove nothing: no untracked files match" : `remove ${gone.length} untracked ${gone.length === 1 ? "path" : "paths"}`,
      lines: gone.slice(0, LIST_MAX),
      more: Math.max(0, gone.length - LIST_MAX),
      note: "From git clean -n. Untracked files are not in git, so they can't be recovered.",
    };
  }
  const status = await $.process.run([...GIT, "-c", "core.quotepath=false", "status", "--porcelain"], { cwd, timeoutMs: 15000 });
  if (status.exitCode !== 0) {
    return { summary: `${risk.label} (not a git repo here?)`, lines: [], note: status.stderr.trim().slice(0, 200) };
  }
  const rows = status.stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 3 && !l.startsWith("??"));
  // reset --hard drops staged and unstaged changes; checkout -- . drops unstaged ones.
  const lost = risk.kind === "git-reset" ? rows : rows.filter((l) => l[1] !== " ");
  const stat = await $.process.run([...GIT, "diff", "--no-ext-diff", "--no-textconv", "--shortstat", risk.kind === "git-reset" ? "HEAD" : "--"], { cwd, timeoutMs: 15000 });
  return {
    summary: lost.length === 0 ? "discard nothing: no uncommitted changes" : `discard uncommitted changes in ${lost.length} ${lost.length === 1 ? "file" : "files"}`,
    lines: lost.slice(0, LIST_MAX).map((l) => `${l.slice(0, 2)} ${l.slice(3)}`),
    more: Math.max(0, lost.length - LIST_MAX),
    note: stat.stdout.trim() !== "" ? `${stat.stdout.trim()}. Uncommitted changes can't be recovered.` : "From git status --porcelain.",
  };
}

async function measurePush($, risk, cwd) {
  const positional = risk.args.filter((a) => !a.startsWith("-"));
  const remote = positional[0] ?? "origin";
  // A refspec is src:dst. With no colon, the local branch of the same name is pushed.
  const spec = (positional[1] ?? "").replace(/^\+/, "");
  let [source, branch] = spec.includes(":") ? spec.split(":") : [spec, spec];
  branch = (branch ?? "").replace(/^refs\/heads\//, "");
  if (source.startsWith("-") || branch.startsWith("-") || remote.startsWith("-")) {
    return { summary: "force-push", lines: [], note: "The branch names start with a dash, so I can't tell which commits the push would drop." };
  }
  if (!branch) {
    const head = await $.process.run([...GIT, "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  } else if (branch === "HEAD") {
    // `git push origin HEAD` pushes the current branch to its namesake.
    const head = await $.process.run([...GIT, "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 10000 });
    branch = head.stdout.trim();
    source = "HEAD";
  }
  source = source || "HEAD";
  const ref = `${remote}/${branch}`;
  const known = await $.process.run([...GIT, "rev-parse", "--verify", "--quiet", ref], { cwd, timeoutMs: 10000 });
  if (known.exitCode !== 0) {
    return { summary: `force-push to ${ref}`, lines: [], note: `No local copy of ${ref}, so I can't tell which commits the push would drop. Run git fetch first.` };
  }
  const log = await $.process.run([...GIT, "log", "--oneline", "--no-decorate", "--end-of-options", `${source}..${ref}`], { cwd, timeoutMs: 15000 });
  const dropped = log.stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l !== "");
  return {
    summary: dropped.length === 0 ? `force-push to ${ref}: drops no commits` : `force-push to ${ref}: drops ${dropped.length} ${dropped.length === 1 ? "commit" : "commits"}`,
    lines: dropped.slice(0, LIST_MAX),
    more: Math.max(0, dropped.length - LIST_MAX),
    note: `Commits on ${ref} that ${source} doesn't have, as of the last fetch.`,
  };
}

// The tool's own status command is NOT run for the pane: it loads the project's code
// (manage.py, the alembic revisions, prisma from node_modules) before you have answered.
const MIGRATION_STATUS = {
  django: "python manage.py showmigrations",
  alembic: "alembic history -r current:head",
  rails: "bin/rails db:migrate:status",
  prisma: "npx prisma migrate status",
};

function measureMigrations(risk) {
  const status = MIGRATION_STATUS[risk.tool];
  return {
    summary: `run ${risk.label}`,
    lines: [],
    note: `I don't list the pending migrations: the status command runs your project's code, and you haven't answered yet.${status ? ` Check with: ${status}` : ""}`,
  };
}

function size(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = -1;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Drawing --------------------------------------------------------------

function paneRows(report) {
  return Math.min(24, 10 + report.lines.length + (report.more ? 1 : 0));
}

function draw(t, state) {
  const { Box, Text, Button } = t;
  const { report } = state;
  const list = report.lines.map((line, i) => Text({ key: `l${i}`, children: `  ${line}`, wrap: "truncate-end" }));
  if (report.more) {
    list.push(Text({ key: "more", dimColor: true, children: `  + ${report.more} more` }));
  }
  // The buttons answer the call this pane was drawn for, never whichever one is held now.
  const decide = (choice) => () => {
    if (state.decision === null) {
      state.decision = choice;
    }
  };
  return Box({
    flexDirection: "column",
    borderStyle: "round",
    borderColor: "yellow",
    paddingX: 1,
    children: [
      Box({ key: "title", marginBottom: 1, children: Text({ bold: true, color: "yellow", children: `⚠  Holdpane · ${state.risk.label}` }) }),
      Text({ key: "cmd", children: [Text({ dimColor: true, children: "Command  " }), Text({ bold: true, children: state.command })], wrap: "truncate-end" }),
      Text({ key: "sum", children: [Text({ dimColor: true, children: "Would    " }), Text({ color: "red", bold: true, children: report.summary })] }),
      Box({ key: "list", flexDirection: "column", marginTop: 1, children: list }),
      report.note ? Text({ key: "note", dimColor: true, italic: true, children: report.note, wrap: "wrap" }) : null,
      Box({
        key: "buttons",
        marginTop: 1,
        gap: 2,
        children: [
          // No hotkey on Proceed: a typed "1" must never run a command. Cancel has the focus.
          Button({ key: "proceed", label: "Proceed", plain: true, onPress: decide("proceed") }),
          Button({ key: "cancel", label: "Cancel", hotkey: "2", plain: true, autoFocus: true, onPress: decide("cancel") }),
          Text({ key: "hint", dimColor: true, children: "Claude is waiting on your answer" }),
        ],
      }),
    ],
  });
}
