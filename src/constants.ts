import * as vscode from 'vscode';

export const COMMANDS = {
	initializeWorkspaceFiles: 'context-bridge.initializeWorkspaceFiles',
	createSelection: 'context-bridge.createSelection',
	exportSelection: 'context-bridge.exportSelection',
	importSelection: 'context-bridge.importSelection',
	activateSelection: 'context-bridge.activateSelection',
	deactivateSelection: 'context-bridge.deactivateSelection',
	renameSelection: 'context-bridge.renameSelection',
	renameSelectionShort: 'context-bridge.renameSelectionShort',
	deleteSelection: 'context-bridge.deleteSelection',
	addToSelection: 'context-bridge.addToSelection',
	removeFromSelection: 'context-bridge.removeFromSelection',
	removeSelectionItem: 'context-bridge.removeSelectionItem',
	removeExclusionItem: 'context-bridge.removeExclusionItem',
	addIgnoredContentExtension: 'context-bridge.addIgnoredContentExtension',
	removeIgnoredContentExtension: 'context-bridge.removeIgnoredContentExtension',
} as const;

export const CONTEXT_BRIDGE_EXPLORER_VIEW_ID = 'contextBridgeExplorer';
export const BRIDGE_DOCUMENT_URI = vscode.Uri.from({
	scheme: 'context-bridge',
	path: '/bridge',
});