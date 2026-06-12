import * as vscode from 'vscode';
import { COMMANDS, type ActionCommand } from '../constants';
import {
	CONFIG_FILE_PATH,
	ContextBridgeSelectionEngine,
	getBaseName,
	toWorkspaceRelativeUri,
} from '../selectionEngine';
import type { ActionNode, ContextBridgeNode, SelectionNode, SelectionItemNode, WorkspaceFolderNode } from './types';

export class ContextBridgeExplorerProvider implements vscode.TreeDataProvider<ContextBridgeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ContextBridgeNode | undefined | void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly selectionEngine: ContextBridgeSelectionEngine
	) {
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_PATH}`);

		watcher.onDidCreate(() => this.refresh());
		watcher.onDidChange(() => this.refresh());
		watcher.onDidDelete(() => this.refresh());

		context.subscriptions.push(watcher);

		context.subscriptions.push(
			vscode.workspace.onDidCreateFiles(() => this.refresh()),
			vscode.workspace.onDidDeleteFiles(() => this.refresh()),
			vscode.workspace.onDidRenameFiles(() => this.refresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
		);
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	public async getChildren(element?: ContextBridgeNode): Promise<ContextBridgeNode[]> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return [];
		}

		if (!element) {
			if (folders.length === 1) {
				return this.getWorkspaceContent(folders[0]);
			}

			return folders.map<WorkspaceFolderNode>((folder) => ({
				kind: 'workspaceFolder',
				folder,
			}));
		}

		switch (element.kind) {
			case 'workspaceFolder':
				return this.getWorkspaceContent(element.folder);

			case 'selection': {
				const itemNodes = element.selection.items.map<SelectionItemNode>((item) => ({
					kind: 'selectionItem',
					folder: element.folder,
					item,
					source: 'item',
				}));
				const excludeNodes = element.selection.excludeItems.map<SelectionItemNode>((item) => ({
					kind: 'selectionItem',
					folder: element.folder,
					item,
					source: 'excludeItem',
				}));

				return [...itemNodes, ...excludeNodes];
			}

			case 'selectionItem':
			case 'action':
				return [];
		}
	}

	public getTreeItem(element: ContextBridgeNode): vscode.TreeItem {
		switch (element.kind) {
			case 'workspaceFolder': {
				const item = new vscode.TreeItem(
					element.folder.name,
					vscode.TreeItemCollapsibleState.Expanded
				);

				item.iconPath = new vscode.ThemeIcon('folder');
				item.tooltip = element.folder.uri.fsPath;
				item.contextValue = 'contextBridge.workspaceFolder';
				return item;
			}

			case 'selection': {
				const isActive = element.selection.active;
				const item = new vscode.TreeItem(
					element.selection.name,
					vscode.TreeItemCollapsibleState.Collapsed
				);

				item.id = `contextBridge.selection:${element.folder.uri.toString()}:${element.selection.name}`;
				item.iconPath = isActive
					? new vscode.ThemeIcon('list-tree')
					: new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('disabledForeground'));
				item.description = isActive
					? `${element.selection.short} • ${formatFileCount(element.fileCount)}`
					: `${element.selection.short} • ${formatFileCount(element.fileCount)} • inactive`;
				item.tooltip =
					`${element.selection.name} [${element.selection.short}]\n` +
					`Files: ${element.fileCount}\n` +
					`Direct items: ${element.selection.items.length}\n` +
					`Exclusions: ${element.selection.excludeItems.length}\n` +
					`Status: ${isActive ? 'active' : 'inactive'}`;
				item.contextValue = isActive
					? 'contextBridge.selection.active'
					: 'contextBridge.selection.inactive';

				return item;
			}

			case 'selectionItem': {
				const targetUri = toWorkspaceRelativeUri(element.folder.uri, element.item.path);
				const isFolder = element.item.type === 'folder';
				const isExclude = element.source === 'excludeItem';
				const item = new vscode.TreeItem(
					getBaseName(element.item.path),
					vscode.TreeItemCollapsibleState.None
				);

				item.resourceUri = targetUri;
				item.description = isExclude ? `exclude • ${element.item.path}` : element.item.path;
				item.tooltip = `${isExclude ? 'Excluded item' : isFolder ? 'Folder' : 'File'}\n${element.item.path}`;
				item.iconPath = isExclude
					? new vscode.ThemeIcon('circle-slash')
					: new vscode.ThemeIcon(isFolder ? 'folder' : 'file');
				item.contextValue = isExclude
					? `contextBridge.selectionExcludeItem.${element.item.type}`
					: `contextBridge.selectionItem.${element.item.type}`;
				item.command = isFolder
					? {
						command: 'revealInExplorer',
						title: 'Reveal in Explorer',
						arguments: [targetUri],
					}
					: {
						command: 'vscode.open',
						title: 'Open File',
						arguments: [targetUri],
					};

				return item;
			}

			case 'action': {
				const item = new vscode.TreeItem(
					getActionLabel(element.command),
					vscode.TreeItemCollapsibleState.None
				);

				item.iconPath = new vscode.ThemeIcon(getActionIcon(element.command));
				item.tooltip = getActionLabel(element.command);
				item.contextValue = 'contextBridge.action';
				item.command = {
					command: element.command,
					title: getActionLabel(element.command),
					arguments: [element.folder],
				};

				return item;
			}
		}
	}

	private async getWorkspaceContent(folder: vscode.WorkspaceFolder): Promise<ContextBridgeNode[]> {
		const selectionSummaries = await this.selectionEngine.getSelectionSummaries(folder);
		const selectionNodes: SelectionNode[] = selectionSummaries.map((summary) => ({
			kind: 'selection',
			folder,
			selection: summary.selection,
			selectionIndex: summary.selectionIndex,
			fileCount: summary.fileCount,
		}));

		return [...selectionNodes, ...this.getActionNodes(folder)];
	}

	private getActionNodes(folder: vscode.WorkspaceFolder): ActionNode[] {
		return [
			{
				kind: 'action',
				folder,
				command: COMMANDS.initializeWorkspaceFiles,
			},
			{
				kind: 'action',
				folder,
				command: COMMANDS.createSelection,
			},
			{
				kind: 'action',
				folder,
				command: COMMANDS.exportSelection,
			},
			{
				kind: 'action',
				folder,
				command: COMMANDS.importSelection,
			},
		];
	}
}

function getActionLabel(command: ActionCommand): string {
	switch (command) {
		case COMMANDS.initializeWorkspaceFiles:
			return 'Initialize';
		case COMMANDS.createSelection:
			return 'Create Selection';
		case COMMANDS.exportSelection:
			return 'Export';
		case COMMANDS.importSelection:
			return 'Import';
	}
}

function getActionIcon(command: ActionCommand): string {
	switch (command) {
		case COMMANDS.initializeWorkspaceFiles:
			return 'add';
		case COMMANDS.createSelection:
			return 'list-selection';
		case COMMANDS.exportSelection:
			return 'arrow-up';
		case COMMANDS.importSelection:
			return 'arrow-down';
	}


}

function formatFileCount(fileCount: number): string {
	return `${fileCount} file(s)`;
}

