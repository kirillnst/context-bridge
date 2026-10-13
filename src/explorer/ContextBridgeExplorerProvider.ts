import * as vscode from 'vscode';
import {
	CONFIG_FILE_PATH,
	readContextBridgeConfig,
	ContextBridgeSelectionEngine,
	getBaseName,
	toWorkspaceRelativeUri,
} from '../selectionEngine';
import type { ContextBridgeNode, SelectionNode, SelectionItemNode, WorkspaceFolderNode } from './types';

export class ContextBridgeExplorerProvider implements vscode.TreeDataProvider<ContextBridgeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ContextBridgeNode | undefined | void>();
	private configurationRefreshVersion = 0;
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

		void this.updateConfigurationContext();
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
		void this.updateConfigurationContext();
	}

	private async updateConfigurationContext(): Promise<void> {
		const version = ++this.configurationRefreshVersion;
		const folders = vscode.workspace.workspaceFolders ?? [];
		const configs = await Promise.all(folders.map((folder) => readContextBridgeConfig(folder)));
		if (version !== this.configurationRefreshVersion) {
			return;
		}

		await vscode.commands.executeCommand(
			'setContext',
			'contextBridge.hasConfiguration',
			configs.some((config) => config !== undefined)
		);
		await vscode.commands.executeCommand(
			'setContext',
			'contextBridge.needsInitialization',
			configs.some((config) => config === undefined)
		);
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
					selectionIndex: element.selectionIndex,
					item,
					source: 'item',
				}));
				const excludeNodes = element.selection.excludeItems.map<SelectionItemNode>((item) => ({
					kind: 'selectionItem',
					folder: element.folder,
					selectionIndex: element.selectionIndex,
					item,
					source: 'excludeItem',
				}));

				return [...itemNodes, ...excludeNodes];
			}

			case 'selectionItem':
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
					`${element.selection.short} ${element.selection.name}`,
					vscode.TreeItemCollapsibleState.Collapsed
				);

				item.id = `contextBridge.selection:${element.folder.uri.toString()}:${element.selection.name}`;
				item.checkboxState = isActive
					? vscode.TreeItemCheckboxState.Checked
					: vscode.TreeItemCheckboxState.Unchecked;
				item.description = formatFileCount(element.fileCount);
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
				const pathDescription = element.item.path === getBaseName(element.item.path)
					? ''
					: element.item.path;
				item.description = isExclude
					? `excluded${pathDescription ? ` • ${pathDescription}` : ''}`
					: pathDescription;
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

		return selectionNodes;
	}
}

function formatFileCount(fileCount: number): string {
	return `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
}

