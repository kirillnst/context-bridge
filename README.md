# Context Bridge

**Context Bridge** helps you send the right project context to an LLM and safely apply structured changes back to your VS Code workspace.

## Features

- Create reusable file and folder selections
- Add or remove resources directly from Explorer
- Export selected project context into a single document
- Import structured LLM patches back into your workspace
- Create, rename, activate, deactivate, and delete selections
- See selection membership directly in Explorer

## Quick Start

1. Open a project in VS Code.
2. Open the **Context Bridge** view in Explorer.
3. Click **Initialize**.
4. Create a selection.
5. Add files or folders from Explorer.
6. Click **Export**.
7. Send the generated context to your LLM.
8. Paste the returned patch into the Context Bridge document.
9. Click **Import** to apply it.

## Patch Format

Context Bridge supports structured operations:

- `modify`
- `add`
- `delete`
- `move`

Example:

```text
cFILEb src/example.ts
cACTIONb modify
cSEARCHb
old text
cREPLACEb
new text
```

No changes:

```text
NO_CHANGES
```

## Configuration

Selections are stored in:

```text
.vscode/context-bridge.json
```

This lets project-specific context selections live alongside your workspace configuration.

## Repository

https://github.com/kirillnst/context-bridge

## License

MIT