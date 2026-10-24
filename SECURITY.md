# Security policy

Holdpane is a safety net in front of risky shell commands. It is not a permission system and not a sandbox (see [How far to trust it](README.md#how-far-to-trust-it)).

## What counts as a security problem

Please report it privately if:

- a command that Holdpane should hold runs anyway, or runs after you pressed Cancel, interrupted the turn, or let the 10 minutes pass;
- Holdpane itself fails and the command is not refused (a missing `.catch`, an exception that lets the call through);
- measuring runs something it should not (a project's own tool, a script from the folder, a network path);
- a crafted command line, path or file name makes Holdpane run code, hang, or show a wrong "Would" line that hides what the command deletes.

The [known limits](README.md#how-far-to-trust-it) (for example `Invoke-Expression`, `eval`, `find -delete`) are documented and are not security problems; a bug report about them is still welcome as a normal issue.

## How to report

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a problem that bypasses the hold.

Include the command line, the Claude Code version, your Windows and Git versions, and what you expected. You will get an answer as soon as possible; this is a small project maintained by one person.

## Supported versions

Only the latest release gets fixes.
