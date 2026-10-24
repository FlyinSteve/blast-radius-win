# Blast Radius for Windows

**See what a command will touch, before it runs.** A [Claude Code](https://claude.com/claude-code) mod that holds risky shell commands, shows what they would change, and waits for your Proceed or Cancel. It works for **Bash and PowerShell**, and it is built to run on **Windows**.

When Claude proposes `rm -rf build`, `Remove-Item -Recurse -Force build` or `git reset --hard`, the command stops. A pane opens with the files it would delete, the count and the size. Cancel is pre-selected, so a stray Enter refuses the command. Claude gets the refusal and the reason.

```
╭────────────────────────────────────────────────────────────────╮
│ ⚠ Blast Radius · Remove-Item -Recurse -Force                   │
│ Command  Remove-Item -Recurse -Force build                     │
│ Would    delete 3 files (about 7 B)                            │
│                                                                │
│   build/Größe äöü.txt                                          │
│   build/sub/a.txt                                              │
│   build/sub/b.txt                                              │
│ Paths: build. 1 junction or symbolic link folder not followed. │
│                                                                │
│ Proceed   Cancel   Claude is waiting on your answer            │
╰────────────────────────────────────────────────────────────────╯
```

> Based on [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) from `anthropics/claude-code-playground` (Apache-2.0). Not an official Anthropic product. See [what changed](#what-is-different-from-the-original).

## Install

In a terminal session of Claude Code:

```
/plugin install blast-radius-win --marketplace FlyinSteve/blast-radius-win
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell:

```
claude plugin install blast-radius-win --marketplace FlyinSteve/blast-radius-win
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `FlyinSteve/blast-radius-win`, then **Add plugin**.

To remove it: `claude plugin uninstall blast-radius-win`.

**Try it:** in a throwaway folder, ask Claude to delete a folder with `rm -rf` or `Remove-Item -Recurse -Force`.

**Using the pane:** press `2` to Cancel, or click Proceed (or Tab to it and press Enter). Proceed has no hotkey on purpose, so a typed `1` can never run a command. No answer within 10 minutes refuses the command, and so does interrupting the turn (Esc).

## What it holds

| Tool | Commands |
|---|---|
| Bash, PowerShell | `git reset --hard`, `git checkout -- .` and `-f`, `git switch -f`, `git restore .`, `git clean`, `git push --force` (also `-fu`, `+ref`), migrations (`manage.py migrate`, `alembic upgrade`, `db:migrate`, `prisma migrate`) |
| Bash | `rm -r`, `rm -f`, `xargs rm -rf`, `bash -c '...'`, `powershell -Command`, `cmd /c rd /s`, anything after a single `&` |
| PowerShell | `Remove-Item` (also `rm`, `ri`, `del`, `rd`, `erase`) with `-Recurse` or `-Force`, abbreviated (`-r -fo`) or across lines with backticks, `$x = ...`, `[void](...)`, `Start-Process git -ArgumentList ...`, `cmd /c rd /s/q`, `powershell -Command` |
| Monitor | the command, read as Bash and as PowerShell |
| all | command lines over 8000 characters, `-EncodedCommand` and `Remove-Item @splat` are held without being read |

Every other command runs as normal. If a `cd`, `pushd`, `Set-Location` or `git -C` comes first on the line, Blast Radius measures in that folder.

## What the pane shows

| Command | What you see |
|---|---|
| `rm`, `Remove-Item`, `rd /s` | the files it would delete, with count and size; globs, `-LiteralPath`, `~` (in Bash) and Windows paths (`C:\...` and `C:/...`) are resolved |
| `git reset --hard`, `git checkout -- .` | the files with uncommitted changes and the diff summary |
| `git clean` | the untracked paths from `git clean -n` with the same flags |
| `git push --force` | the commits on the remote branch that your branch doesn't have (from your last fetch) |
| migrations | the tool's own status command to check by hand (see [below](#measuring-only-reads)) |
| anything it cannot measure | an honest note instead of a guess: variables, `( )` expressions, `%VAR%`, network paths and `del /s` are reported as *not measurable*, never as "deletes nothing" |

## What is different from the original

The original is a good small example, written for macOS and Linux. This version:

- **Hooks PowerShell and Monitor too**, and reads PowerShell syntax: parameter abbreviations, `-Recurse:$false`, `-WhatIf`, backtick line continuation, script blocks like `try{...}`, comments, here-strings, `Start-Process`, nested `powershell -Command` and `cmd /c`.
- **Finds its tools on Windows** instead of assuming them. It locates Git's `bash`, `find`, `du` and `sleep` through `git --exec-path`. On a normal Windows PATH, `find` is the Windows `find` and `bash` can be the WSL launcher, which would measure wrongly.
- **Measures PowerShell natively** with `powershell.exe`. Paths travel as ASCII JSON on stdin, so umlauts survive and nothing in a path can run as code. Junctions and symbolic links are counted, not followed.
- **Fails closed.** Every hook has a `.catch`: if the mod itself throws, the command is refused instead of slipping through. Command lines over 8000 characters are held unread, and the line reader runs in bounded time on hostile input.
- <a id="measuring-only-reads"></a>**Measuring only reads.** The measuring happens before you answer, even before the permission prompt. So it never runs a project's own tools (a migration status command loads your project's code) and it starts Git with `core.fsmonitor=false`. Network paths (`\\server\share`) are not touched.
- **Reads the command line properly.** It splits at `;`, `|`, `&&`, `||`, `&` and line breaks, but not inside quotes. Quotes in comments, heredocs and here-strings don't confuse it, and if a quote is left open it reads the line again without regard to quotes.

## Requirements

- Claude Code with mods support (the original names 2.1.287 or later). Tested with **2.1.310**.
- **Windows:** Git for Windows (it brings `bash`, `find`, `du`, `sleep`) and Windows PowerShell 5.1, which is part of Windows. Tested on Windows 11 with Git 2.55.
- macOS and Linux: the Bash part is the original's and should work as before; this version has not been tested there. The PowerShell part uses `pwsh`.
- No packages to install, no configuration.

## How far to trust it

This is a safety net, not a permission system. It reads the text of a command, it does not run a shell parser, and it cannot see what a script does. Use [permission rules](https://code.claude.com/docs/en/settings) for a hard block.

It has been tested on a real Windows setup, including live sessions with Claude Code, and reviewed twice by an AI reviewer (Claude Opus). That is **not** an independent security audit.

Known limits:

- Not recognised: `Invoke-Expression`, `eval`, `[IO.Directory]::Delete`, scripts and functions that delete by themselves, `find -delete` and `find -exec rm`, commands inside `$(...)` or aliases, a backslash-escaped space in a Bash program path (`Program\ Files`), `-WhatIf:0`.
- Only the first risky part of a line is measured, and the pane cuts the command line off. Proceed runs the whole line: `rm -rf build⏎git push --force` shows only the first part.
- `Remove-Item` through a pipeline and `del /s` are held but not measured. `-Include`, `-Exclude` and `-Filter` are not applied when counting.
- Git Bash re-parses arguments at start, so a Bash path with `'` or `{}` may be reported as "not found". The command is still held.
- A Git filter (`filter.<name>.clean`) from a changed `.git/config` could run code during `git status`. Claude Code protects `.git`, so this is theoretical.
- `git` and `powershell.exe` are found through PATH, not by fixed paths.
- Without a user interface (`claude -p`), a held command waits the full 10 minutes.

## Deutsch (Kurzfassung)

**Blast Radius für Windows** hält riskante Befehle an, bevor sie laufen, und zeigt, was sie treffen würden: `rm -rf`, `Remove-Item -Recurse -Force`, `git reset --hard`, `git clean`, Force-Push und Migrationen. In einer Pane siehst du die betroffenen Dateien mit Anzahl und Größe und entscheidest mit **Proceed** oder **Cancel**. Cancel ist vorausgewählt (Taste 2); Proceed hat bewusst keine Taste.

Gegenüber dem Original (macOS/Linux) funktioniert es mit **Bash und PowerShell unter Windows**: Es findet Git-Bash, `find` und `du` selbst, misst PowerShell-Löschungen nativ (Umlaute, Junctions, `C:\`-Pfade), liest auch mehrzeilige und verschachtelte Befehle und **lehnt einen Befehl ab, wenn der Mod selbst einen Fehler hat**. Die Messung liest nur: Sie führt keine Werkzeuge deines Projekts aus, bevor du geantwortet hast.

Installation im Claude-Code-Terminal: `/plugin install blast-radius-win --marketplace FlyinSteve/blast-radius-win`

Es ist ein Sicherheitsnetz, kein Berechtigungssystem: Harte Sperren gehören in die Permission-Regeln. Die Grenzen stehen oben unter *Known limits*.

## License and credits

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on Blast Radius, Copyright 2026 Anthropic PBC, from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground). Modifications Copyright 2026 FlyinSteve. Not affiliated with or endorsed by Anthropic. Git is a trademark of Software Freedom Conservancy; PowerShell and Windows are trademarks of Microsoft.
