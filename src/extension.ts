import * as vscode from 'vscode';
import { ContextBridgeVirtualFileSystemProvider } from './bridge/ContextBridgeVirtualFileSystemProvider';
import { registerCommands } from './commands/registerCommands';
import { CONTEXT_BRIDGE_EXPLORER_VIEW_ID } from './constants';
import { ContextBridgeExplorerProvider } from './explorer/ContextBridgeExplorerProvider';
import { ContextBridgeSelectionEngine } from './selectionEngine';

export function activate(context: vscode.ExtensionContext): void {
	const selectionEngine = new ContextBridgeSelectionEngine(context);
	const explorerProvider = new ContextBridgeExplorerProvider(context, selectionEngine);
	const bridgeDocumentProvider = new ContextBridgeVirtualFileSystemProvider();

	const treeView = vscode.window.createTreeView(CONTEXT_BRIDGE_EXPLORER_VIEW_ID, {
		treeDataProvider: explorerProvider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		treeView.onDidChangeCheckboxState(async (event) => {
			for (const [node, state] of event.items) {
				if (node.kind !== 'selection') {
					continue;
				}

				try {
					const updated = await selectionEngine.setSelectionActiveState(
						node.folder,
						node.selectionIndex,
						state === vscode.TreeItemCheckboxState.Checked
					);
					if (!updated) {
						void vscode.window.showErrorMessage(
							`Context Bridge: could not update selection "${node.selection.name}".`
						);
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : 'unknown error';
					void vscode.window.showErrorMessage(`Context Bridge: ${message}`);
				}
			}
			explorerProvider.refresh();
		}),
		treeView,
		vscode.workspace.registerFileSystemProvider('context-bridge', bridgeDocumentProvider, {
			isCaseSensitive: true,
		}),
		...registerCommands(explorerProvider, selectionEngine, bridgeDocumentProvider)
	);
}

export function deactivate(): void {}

