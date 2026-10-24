# Contributing

Thanks for helping. Haltline is small on purpose: one hook module, no dependencies, no build step.

- **Found a command that should be held, or one held by mistake?** Open an issue with the exact command line; the templates ask for what is needed.
- **Security problems:** see [SECURITY.md](SECURITY.md), not a public issue.
- **Code changes:** open an issue first for anything bigger than a fix. Keep `hooks/haltline.mjs` free of packages and network access, keep measuring read-only, and keep failing closed (every hook refuses the command when the mod itself fails).
- **Before a pull request:** run `claude plugin validate --profile directory .`, and try your change in a live session with `claude --plugin-dir .` on a throwaway folder. Describe what you tried and on which system.
- **Text:** English in the repository. Do not add personal data, local paths or network addresses, not even in examples.

Contributions are licensed under the Apache License 2.0, like the rest of the project.
