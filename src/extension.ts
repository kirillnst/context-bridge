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

	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider('context-bridge', bridgeDocumentProvider, {
			isCaseSensitive: true,
		}),
		vscode.window.createTreeView(CONTEXT_BRIDGE_EXPLORER_VIEW_ID, {
			treeDataProvider: explorerProvider,
			showCollapseAll: true,
		}),
		vscode.window.registerFileDecorationProvider(selectionEngine),
		...registerCommands(explorerProvider, selectionEngine, bridgeDocumentProvider)
	);
}

export function deactivate(): void {}

