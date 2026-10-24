# Changelog

## 0.3.2

- Renamed to **Holdpane** (`holdpane`). Uninstall the old name first.

## 0.3.1

- Renamed from `blast-radius-win` to **Haltline** (`haltline`). Uninstall the old name first.
- Pane: a blank line under the title; two spaces after the warning sign.
- Added an icon, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates and this changelog.
- README: new sections "Examples", "What it runs and what it sends" and "Support".

## 0.3.0

- Hooks for PowerShell and Monitor next to Bash; reads PowerShell, `cmd /c` and nested shell commands.
- Finds Git's `bash`, `find`, `du` and `sleep` on Windows instead of assuming them on PATH.
- Measures PowerShell deletions natively with `powershell.exe`; junctions and symbolic links are counted, not followed.
- Fails closed: if the mod throws, the command is refused.
- Measuring only reads; no project tools run before you answer.
