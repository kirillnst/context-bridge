import * as vscode from 'vscode';
import type { ActionCommand } from '../constants';
import type { ContextBridgeItem, ContextBridgeSelection } from '../core/types';

export type SelectionItemSource = 'item' | 'excludeItem';

export type ContextBridgeNode =
	| WorkspaceFolderNode
	| SelectionNode
	| SelectionItemNode
	| ActionNode;

export interface WorkspaceFolderNode {
	kind: 'workspaceFolder';
	folder: vscode.WorkspaceFolder;
}

export interface SelectionNode {
	kind: 'selection';
	folder: vscode.WorkspaceFolder;
	selection: ContextBridgeSelection;
	selectionIndex: number;
	fileCount: number;
}



export interface SelectionItemNode {
	kind: 'selectionItem';
	folder: vscode.WorkspaceFolder;
	item: ContextBridgeItem;
	source: SelectionItemSource;
}

export interface ActionNode {
	kind: 'action';
	folder: vscode.WorkspaceFolder;
	command: ActionCommand;
}

