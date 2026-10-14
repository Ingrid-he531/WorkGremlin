# AGENTS.md

Guidance for AI coding agents working in this repository.

## Comment language: English only

- **All comments must be written in English.** Do not add Chinese comments — not in new files, and not when editing existing files.
- When you touch a file that still has Chinese comments, translate the lines you are changing to English. Do not mix languages inside one comment block.
- User-facing strings are **not** comments: UI text, log lines, and error messages shown to the user stay in their existing language (this product ships Chinese UI text). The rule applies to **comments** only. A Chinese string literal is fine; a Chinese comment is not.

## Identity model: `client` is the floor base name, `form` is the form

- `client` (a.k.a. agent) is **always the bare floor base name** — `codebuddy` / `kilo` / `opencode` / `claude` / … Never synthesize or strip a `-plugin` suffix; the old `codebuddy-plugin` / `codebuddy` duality is gone.
- `form` describes the shape: `vscode` / `cli` / `ide`, or `null` / `''` when a floor does not distinguish.
- Plugin-vs-not is decided **only** by `isPluginClient(form)`; the frontend `source` (plugin / cli / ide) comes **only** from `formToSource(form)`. Both live in `shared/index.js`.
- `agentBase(id)` normalizes an identity to the base name (strips an `@<project>` suffix, lowercases). It must **not** handle `-plugin`.

## Storage paths: one source of truth

- WorkGremlin's own storage locations and logic-free file I/O live in **`shared/paths.js`** (`home`, `hooksDir`, `statePath`, `readState` / `writeState` / `updateState`, `serverInfoPath`, `readServerInfo`, `isPidAlive`, …).
- Do **not** hand-build `~/.workgremlin/...` paths in server / plugin / desktop / renderer — import from `shared/paths.js`. This is what keeps the server and the client from reading different directories.
- Agent-specific on-disk layouts (Kilo / OpenCode / CodeBuddy data roots, etc.) are **not** in `shared/paths.js`; those belong to each floor module.
