import * as vscode from 'vscode';

export const COMMANDS = {
	initializeWorkspaceFiles: 'context-bridge.initializeWorkspaceFiles',
	exportSelection: 'context-bridge.exportSelection',
	importSelection: 'context-bridge.importSelection',
	activateSelection: 'context-bridge.activateSelection',
	deactivateSelection: 'context-bridge.deactivateSelection',
	addToSelection: 'context-bridge.addToSelection',
	removeFromSelection: 'context-bridge.removeFromSelection',
} as const;

export const CONTEXT_BRIDGE_EXPLORER_VIEW_ID = 'contextBridgeExplorer';
export const BRIDGE_DOCUMENT_URI = vscode.Uri.from({
	scheme: 'context-bridge',
	path: '/bridge',
});

export type ActionCommand =
	| typeof COMMANDS.initializeWorkspaceFiles
	| typeof COMMANDS.exportSelection
	| typeof COMMANDS.importSelection;

