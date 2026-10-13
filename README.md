# Context Bridge

**Context Bridge** is a VS Code extension for preparing focused project context for an LLM and applying structured changes returned by the model to your workspace.

## Requirements

- VS Code 1.109.0 or newer.
- An open folder or workspace.

## Quick Start

1. Open a project in VS Code and find the **Context Bridge** view in the Explorer sidebar.
2. Select **Initialize** to create `.vscode/context-bridge.json`.
3. Select **Create Selection**, then give it a name.
4. Right-click files or folders in the VS Code Explorer and choose **Context Bridge: Add to Selection…**. Pick the target selection.
5. Check the selections you want to export, then select **Export Selection** in the Context Bridge view.
6. Send the content of the opened `context-bridge://bridge` document to your LLM.
7. Paste the LLM's Context Bridge patch into that document and select **Import Patch** to apply it.

Exporting again replaces the bridge document. If it contains unsaved edits, Context Bridge asks for confirmation first.

## Managing Selections

Each selection has a name, a short label, an active state, included items, and exclusions.

- **Create, rename, or delete** selections from the Context Bridge view. Deleting a selection does not delete project files.
- **Activate or deactivate** a selection with its checkbox (or the context menu). Only active selections contribute files to an export.
- **Rename Short Name…** sets a 1–2 character label used by Explorer decorations. `E` and `I` are reserved, case-insensitively, for export and ignore indicators. Automatically generated labels avoid those reserved values.
- **Add to Selection…** and **Remove from Selection…** are available from the VS Code Explorer for files and folders, including multiple selected resources.
- Including a **folder** includes its files recursively. Removing a file or subfolder covered by a selected folder creates an exclusion rather than removing the parent folder.
- Use **Remove from Selection** or **Remove Exclusion** in the Context Bridge tree to manage individual included or excluded entries.

The same file can belong to multiple selections. Files collected from active selections are exported once.

## Explorer Decorations

Context Bridge supplies separate decorations:

- **Selection short label** — the file or folder belongs to the indicated selection. Membership can be shown for inactive selections too.
- **E** — the file is included in the current export through an active selection. A containing folder can also receive `E`.
- **I** — content for the file's extension is ignored during export. This is independent of selection membership and whether the file is currently exported.

`E` and `I` are separate indicators, not a combined `EI` badge. VS Code controls how multiple decorations are displayed; Git decorations or other extensions may take priority.

> **Tip:** To reduce competing badges in Explorer, set `"git.decorations.enabled": false` in VS Code settings. This hides Git status decorations without disabling Git.

## Ignoring File Content by Extension

Right-click a **file** in the VS Code Explorer and choose one of these commands:

- **Context Bridge: Ignore File Content by Extension** — add its extension to the ignore list.
- **Context Bridge: Stop Ignoring File Content by Extension** — remove its extension from the ignore list.

The list starts empty in a newly initialized configuration and is stored in `ignoreContentExtensions` in `.vscode/context-bridge.json`. Entries are matched case-insensitively. For example, ignoring `.png` affects every matching PNG file in that workspace, not just the file you clicked.

Files without an extension — including `README`, `.env`, and `.gitignore` — share the special entry `<no-extension>`. A filename such as `archive.tar.gz` uses `.gz` when a context-menu command is invoked; manually configured compound suffixes such as `.tar.gz` are also supported.

Ignoring content **does not exclude a file from a selection or from the list of exported paths**. When a matching file is part of an active selection, its `FILE:` path is exported without a `CONTENT:` section. An unreadable file is also exported without content. Ignored files still show the independent `I` decoration even if they are not selected.

## Configuration

Context Bridge stores its workspace-specific configuration at `.vscode/context-bridge.json`. Initializing an existing configuration requires confirmation before it is overwritten. A configuration has the following structure:

```json
{
  "version": 2,
  "prompt": "Review the provided project files and return a Context Bridge patch.",
  "ignoreContentExtensions": [".png", "<no-extension>"],
  "selections": [
    {
      "name": "Source",
      "short": "SO",
      "active": true,
      "items": [{ "path": "src", "type": "folder" }],
      "excludeItems": [{ "path": "src/generated", "type": "folder" }]
    }
  ]
}
```

This is an example, not the initialization default: the initial `selections` and `ignoreContentExtensions` are both empty, and `prompt` contains the built-in instructions for generating a patch.

- `prompt` is included at the beginning of the exported document.
- `selections` contains named groups of files and folders.
- `items` and `excludeItems` use workspace-relative paths and `file` or `folder` types.
- `active` controls whether a selection contributes to export; it does not delete the selection or its decorations.
- `ignoreContentExtensions` omits contents, not file paths, from exported context.

## Export and Import

**Export Selection** combines files from active selections into the virtual `context-bridge://bridge` document. Each included file appears as a `FILE: relative/path` section, followed by `CONTENT:` and its text when content is available and not ignored.

**Import Patch** reads the bridge document and applies the patch to the chosen workspace folder. In multi-root workspaces, export and import ask you to choose a folder. Review AI-generated changes before importing them.

Supported patch operations are `modify`, `add`, `delete`, and `move`:

1. Example using all four operations:

   ```text
   cFILEb src/example.ts
   cACTIONb modify
   cSEARCHb
   export const enabled = false;
   cREPLACEb
   export const enabled = true;
   cFILEb src/new.ts
   cACTIONb add
   export const ready = true;
   cFILEb src/old.ts
   cACTIONb move
   cTOb src/renamed.ts
   cFILEb src/unused.ts
   cACTIONb delete
   ```

For `modify`, the `cSEARCHb` text must match one location (either exactly or by relative indentation), and replacements are applied in order. `cSEARCHb` containing `*` replaces the entire file. Paths must be safe workspace-relative paths. `add` cannot overwrite existing files, and `move` cannot overwrite an existing destination.

If the LLM proposes no changes, it can return `NO_CHANGES`.

> **Important:** Import is not a general rollback transaction. If a patch contains several operations and one fails after earlier operations succeed, the earlier changes may remain. Save or revert unsaved edits to target files before importing.

## Development

```sh
npm install
npm run compile
npm test
```

Use **Run Extension** in VS Code's Run and Debug panel for local testing. Other available scripts include `npm run check-types`, `npm run lint`, and `npm run package`.

## Repository

https://github.com/kirillnst/context-bridge

## License

MIT