# Context Bridge

Context Bridge helps you build workspace-based context selections for LLM prompts and apply structured patch responses back to your project.

## What it does

- Creates named selections in `.vscode/context-bridge.json`
- Exports selected files into a single bridge document
- Opens the bridge document in a virtual `context-bridge://bridge` editor
- Imports structured patch responses back into the workspace
- Shows file decorations for selection membership
- Lets you add and remove files from selections directly from Explorer

## Quick start

1. Open a folder or workspace in VS Code
2. Open the **Context Bridge** view in Explorer
3. Run **Initialize**
4. Edit `.vscode/context-bridge.json`
5. Run **Export**
6. Send the exported document to your LLM
7. Paste the patch response back into the bridge document
8. Run **Import**

## Configuration example

```json
{
  "version": 2,
  "selections": [
    {
      "name": "Primary",
      "short": "PR",
      "active": true,
      "items": [
        { "path": "src", "type": "folder" }
      ],
      "excludeItems": []
    }
  ]
}
```

## Patch format

Context Bridge imports a strict patch format:

```text
FILE: src/example.ts
ACTION: modify

SEARCH:
old text

REPLACE:
new text
```

Supported actions:

- `modify`
- `add`
- `delete`
- `move`

A no-op response can be:

```text
NO_CHANGES
```

## Development

```bash
npm install
npm run compile
```

For production bundle:

```bash
npm run package
```

## Before first Marketplace publish

Fill in the following extension-specific metadata in `package.json`:

- `publisher`
- `repository`
- `homepage`
- `bugs`
- `icon` pointing to a PNG file

The existing `src/media/context-bridge.svg` can be used as the source asset for a future PNG icon.

## Notes

- The extension currently targets desktop VS Code through the Node.js extension host
- The bridge document is virtual and does not exist in the workspace file system