export const CONFIG_FILE_NAME = 'context-bridge.json';
export const CONFIG_DIRECTORY_NAME = '.vscode';
export const CONFIG_FILE_PATH = `${CONFIG_DIRECTORY_NAME}/${CONFIG_FILE_NAME}`;

export type ContextBridgeItemType = 'file' | 'folder';

export interface ContextBridgeItem {
	path: string;
	type: ContextBridgeItemType;
}

export interface ContextBridgeSelection {
	name: string;
	short: string;
	active: boolean;
	items: ContextBridgeItem[];
	excludeItems: ContextBridgeItem[];
}

export interface ContextBridgeConfig {
	version: number;
	selections: ContextBridgeSelection[];
}

export interface SelectionSummary {
	selection: ContextBridgeSelection;
	selectionIndex: number;
	fileCount: number;
}

export interface ContextBridgeExportFile {
	path: string;
	content: string;
}

export interface ContextBridgeImportSummary {
	added: number;
	modified: number;
	deleted: number;
	moved: number;
}

export type SelectionMutationStatus =
	| 'added'
	| 'removed'
	| 'excluded'
	| 'alreadySelected'
	| 'coveredByFolder'
	| 'notDirectItem'
	| 'notFound'
	| 'selectionNotFound'
	| 'invalidResource'
	| 'configMissing';

export interface SelectionMutationResult {
	status: SelectionMutationStatus;
	selectionName?: string;
}

export type SelectionManagementStatus =
	| 'created'
	| 'renamed'
	| 'deleted'
	| 'duplicateName'
	| 'selectionNotFound'
	| 'invalidName'
	| 'configMissing';

export interface SelectionManagementResult {
	status: SelectionManagementStatus;
	selectionName?: string;
}



export type ResourceMembershipKind =
	| 'direct'
	| 'insideSelectedFolder'
	| 'containsSelectedDescendant';

export interface ResourceMembershipInfo {
	selection: ContextBridgeSelection;
	selectionIndex: number;
	kind: ResourceMembershipKind;
}

