// src/extension.ts
import * as vscode from 'vscode';
import {
	CONFIG_FILE_NAME,
	EXPORT_FILE_NAME,
	IMPORT_FILE_NAME,
	ContextBridgeItem,
	ContextBridgeSelection,
	ContextBridgeSelectionEngine,
	createDefaultConfig,
	fileExists,
	getBaseName,
	isValidJsonFile,
	readContextBridgeConfig,
	toJsonBytes,
	toWorkspaceRelativeUri,
} from './selectionEngine';

const INITIALIZE_WORKSPACE_FILES_COMMAND = 'context-bridge.initializeWorkspaceFiles';
const ACTIVATE_SELECTION_COMMAND = 'context-bridge.activateSelection';
const DEACTIVATE_SELECTION_COMMAND = 'context-bridge.deactivateSelection';
const ADD_TO_SELECTION_COMMAND = 'context-bridge.addToSelection';
const REMOVE_FROM_SELECTION_COMMAND = 'context-bridge.removeFromSelection';

const CONTEXT_BRIDGE_EXPLORER_VIEW_ID = 'contextBridgeExplorer';

interface WorkspaceFolderQuickPickItem extends vscode.QuickPickItem {
	folder: vscode.WorkspaceFolder;
}

type ContextBridgeNode =
	| WorkspaceFolderNode
	| SelectionNode
	| SelectionItemNode
	| ManagedFileNode;

interface WorkspaceFolderNode {
	kind: 'workspaceFolder';
	folder: vscode.WorkspaceFolder;
}

interface SelectionNode {
	kind: 'selection';
	folder: vscode.WorkspaceFolder;
	selection: ContextBridgeSelection;
	fileCount: number;
}

interface SelectionItemNode {
	kind: 'selectionItem';
	folder: vscode.WorkspaceFolder;
	item: ContextBridgeItem;
}

interface ManagedFileNode {
	kind: 'managedFile';
	folder: vscode.WorkspaceFolder;
	fileName: typeof EXPORT_FILE_NAME | typeof IMPORT_FILE_NAME;
}

export function activate(context: vscode.ExtensionContext): void {
	const selectionEngine = new ContextBridgeSelectionEngine(context);
	const explorerProvider = new ContextBridgeExplorerProvider(context, selectionEngine);

	const treeView = vscode.window.createTreeView(CONTEXT_BRIDGE_EXPLORER_VIEW_ID, {
		treeDataProvider: explorerProvider,
		showCollapseAll: true,
	});

	const initializeWorkspaceFilesDisposable = vscode.commands.registerCommand(
		INITIALIZE_WORKSPACE_FILES_COMMAND,
		async () => {
			const folder = await getTargetWorkspaceFolder();
			if (!folder) {
				return;
			}

			await initializeWorkspaceFiles(folder);
			explorerProvider.refresh();
		}
	);

	const activateSelectionDisposable = vscode.commands.registerCommand(
		ACTIVATE_SELECTION_COMMAND,
		async (node?: ContextBridgeNode) => {
			if (!node || node.kind !== 'selection') {
				return;
			}

			const ok = await selectionEngine.setSelectionActiveState(node.folder, node.selection.id, true);
			if (!ok) {
				void vscode.window.showErrorMessage(
					`Context Bridge: не удалось активировать выборку "${node.selection.name}".`
				);
				return;
			}

			explorerProvider.refresh();
			void vscode.window.showInformationMessage(
				`Context Bridge: выборка "${node.selection.name}" активирована.`
			);
		}
	);

	const deactivateSelectionDisposable = vscode.commands.registerCommand(
		DEACTIVATE_SELECTION_COMMAND,
		async (node?: ContextBridgeNode) => {
			if (!node || node.kind !== 'selection') {
				return;
			}

			const ok = await selectionEngine.setSelectionActiveState(node.folder, node.selection.id, false);
			if (!ok) {
				void vscode.window.showErrorMessage(
					`Context Bridge: не удалось деактивировать выборку "${node.selection.name}".`
				);
				return;
			}

			explorerProvider.refresh();
			void vscode.window.showInformationMessage(
				`Context Bridge: выборка "${node.selection.name}" деактивирована.`
			);
		}
	);

	const addToSelectionDisposable = vscode.commands.registerCommand(
		ADD_TO_SELECTION_COMMAND,
		async (resourceUri?: vscode.Uri) => {
			if (!resourceUri) {
				return;
			}

			const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
			if (!folder) {
				return;
			}

			const summaries = await selectionEngine.getSelectionSummaries(folder);
			if (summaries.length === 0) {
				void vscode.window.showErrorMessage(
					'Context Bridge: не найден context-bridge.json или в нём нет selections.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				summaries.map((s, index) => ({
					label: s.selection.name,
					description: `${s.selection.active ? 'active' : 'inactive'} • ${s.fileCount} file(s)`,
					index,
				})),
				{ placeHolder: 'Добавить в какую выборку?' }
			);

			if (!picked) {
				return;
			}

			const result = await selectionEngine.addResourceToSelection(resourceUri, picked.index);

			if (result.status === 'added') {
				explorerProvider.refresh();
				void vscode.window.showInformationMessage(
					`Context Bridge: добавлено в "${result.selectionName ?? summaries[picked.index]?.selection.name ?? 'выборку'}".`
				);
				return;
			}

			handleSelectionMutationFailure(result, picked.index, summaries[picked.index]?.selection.name);
		}
	);

	const removeFromSelectionDisposable = vscode.commands.registerCommand(
		REMOVE_FROM_SELECTION_COMMAND,
		async (resourceUri?: vscode.Uri) => {
			if (!resourceUri) {
				return;
			}

			const memberships = await selectionEngine.getMemberships(resourceUri);
			if (memberships.length === 0) {
				void vscode.window.showInformationMessage(
					'Context Bridge: этот ресурс не входит ни в одну выборку.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				memberships.map((m) => ({
					label: m.selection.name,
					description:
						m.kind === 'direct'
							? 'direct'
							: m.kind === 'insideSelectedFolder'
								? 'via selected folder'
								: 'has selected descendants',
					index: m.selectionIndex,
				})),
				{ placeHolder: 'Убрать из какой выборки?' }
			);

			if (!picked) {
				return;
			}

			const result = await selectionEngine.removeResourceFromSelection(resourceUri, picked.index);

			if (result.status === 'removed') {
				explorerProvider.refresh();
				void vscode.window.showInformationMessage(
					`Context Bridge: убрано из "${result.selectionName ?? memberships.find((m) => m.selectionIndex === picked.index)?.selection.name ?? 'выборки'}".`
				);
				return;
			}

			handleSelectionMutationFailure(
				result,
				picked.index,
				memberships.find((m) => m.selectionIndex === picked.index)?.selection.name
			);
		}
	);

	context.subscriptions.push(
		treeView,
		vscode.window.registerFileDecorationProvider(selectionEngine),
		initializeWorkspaceFilesDisposable,
		activateSelectionDisposable,
		deactivateSelectionDisposable,
		addToSelectionDisposable,
		removeFromSelectionDisposable
	);
}

function handleSelectionMutationFailure(
	result: { status: string; selectionName?: string },
	selectionIndex: number,
	fallbackSelectionName?: string
): void {
	const selectionLabel = result.selectionName ?? fallbackSelectionName ?? `Выборка #${selectionIndex + 1}`;

	switch (result.status) {
		case 'alreadySelected':
			void vscode.window.showInformationMessage(
				`Context Bridge: ресурс уже добавлен в "${selectionLabel}".`
			);
			return;

		case 'coveredByFolder':
			void vscode.window.showInformationMessage(
				`Context Bridge: ресурс уже входит в "${selectionLabel}" через выбранную папку.`
			);
			return;

		case 'notDirectItem':
			void vscode.window.showInformationMessage(
				`Context Bridge: ресурс входит в "${selectionLabel}" не напрямую, а через папку. Точечные исключения пока не поддерживаются.`
			);
			return;

		case 'notFound':
			void vscode.window.showInformationMessage(
				`Context Bridge: ресурс не найден в "${selectionLabel}" как прямой элемент.`
			);
			return;

		case 'selectionNotFound':
			void vscode.window.showErrorMessage(
				`Context Bridge: выборка не найдена (index=${selectionIndex}).`
			);
			return;

		case 'configMissing':
			void vscode.window.showErrorMessage(
				'Context Bridge: сначала инициализируйте context-bridge.json, export.json и import.json.'
			);
			return;

		default:
			void vscode.window.showErrorMessage('Context Bridge: операция не выполнена.');
	}
}

class ContextBridgeExplorerProvider implements vscode.TreeDataProvider<ContextBridgeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ContextBridgeNode | undefined | void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(
		context: vscode.ExtensionContext,
		private readonly selectionEngine: ContextBridgeSelectionEngine
	) {
		const watcherPatterns = [
			`**/${CONFIG_FILE_NAME}`,
			`**/${EXPORT_FILE_NAME}`,
			`**/${IMPORT_FILE_NAME}`,
		];

		for (const pattern of watcherPatterns) {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);

			watcher.onDidCreate(() => this.refresh());
			watcher.onDidChange(() => this.refresh());
			watcher.onDidDelete(() => this.refresh());

			context.subscriptions.push(watcher);
		}

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

			case 'selection':
				return element.selection.items.map<SelectionItemNode>((item) => ({
					kind: 'selectionItem',
					folder: element.folder,
					item,
				}));

			case 'selectionItem':
			case 'managedFile':
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

				item.iconPath = vscode.ThemeIcon.Folder;
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

				item.id = `contextBridge.selection:${element.folder.uri.toString()}:${element.selection.id}`;
				item.iconPath = isActive
					? new vscode.ThemeIcon('list-tree')
					: new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('disabledForeground'));
				item.description = isActive
					? `${element.fileCount}`
					: `${element.fileCount} • неактивна`;
				item.tooltip =
					`${element.selection.name} — ${element.fileCount} file(s), ${element.selection.items.length} direct item(s)`;
				item.contextValue = isActive
					? 'contextBridge.selection.active'
					: 'contextBridge.selection.inactive';

				return item;
			}

			case 'selectionItem': {
				const targetUri = toWorkspaceRelativeUri(element.folder.uri, element.item.path);
				const label = getBaseName(element.item.path);

				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

				item.description = element.item.path;
				item.tooltip = element.item.path;
				item.iconPath =
					element.item.type === 'folder' ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
				item.contextValue = `contextBridge.selectionItem.${element.item.type}`;

				if (element.item.type === 'file') {
					item.command = {
						command: 'vscode.open',
						title: 'Open File',
						arguments: [targetUri],
					};
					item.resourceUri = targetUri;
				}

				return item;
			}

			case 'managedFile': {
				const fileUri = vscode.Uri.joinPath(element.folder.uri, element.fileName);
				const item = new vscode.TreeItem(element.fileName, vscode.TreeItemCollapsibleState.None);

				item.iconPath = vscode.ThemeIcon.File;
				item.tooltip = fileUri.fsPath;
				item.resourceUri = fileUri;
				item.contextValue = 'contextBridge.managedFile';
				item.command = {
					command: 'vscode.open',
					title: 'Open File',
					arguments: [fileUri],
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
			fileCount: summary.fileCount,
		}));

		const managedFileNodes: ManagedFileNode[] = [];

		if (await isValidJsonFile(vscode.Uri.joinPath(folder.uri, EXPORT_FILE_NAME))) {
			managedFileNodes.push({
				kind: 'managedFile',
				folder,
				fileName: EXPORT_FILE_NAME,
			});
		}

		if (await isValidJsonFile(vscode.Uri.joinPath(folder.uri, IMPORT_FILE_NAME))) {
			managedFileNodes.push({
				kind: 'managedFile',
				folder,
				fileName: IMPORT_FILE_NAME,
			});
		}

		return [...selectionNodes, ...managedFileNodes];
	}
}

async function getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;

	if (!folders || folders.length === 0) {
		void vscode.window.showErrorMessage(
			'Context Bridge: сначала откройте папку или workspace в VS Code.'
		);
		return undefined;
	}

	if (folders.length === 1) {
		return folders[0];
	}

	const picked = await vscode.window.showQuickPick<WorkspaceFolderQuickPickItem>(
		folders.map((folder) => ({
			label: folder.name,
			description: folder.uri.fsPath,
			folder,
		})),
		{
			placeHolder: 'Выберите папку для инициализации файлов Context Bridge',
		}
	);

	return picked?.folder;
}

async function initializeWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
	const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
	const exportUri = vscode.Uri.joinPath(folder.uri, EXPORT_FILE_NAME);
	const importUri = vscode.Uri.joinPath(folder.uri, IMPORT_FILE_NAME);

	const existingFiles: string[] = [];

	if (await fileExists(configUri)) {
		existingFiles.push(CONFIG_FILE_NAME);
	}
	if (await fileExists(exportUri)) {
		existingFiles.push(EXPORT_FILE_NAME);
	}
	if (await fileExists(importUri)) {
		existingFiles.push(IMPORT_FILE_NAME);
	}

	if (existingFiles.length > 0) {
		const overwriteAction = 'Перезаписать';

		const selectedAction = await vscode.window.showWarningMessage(
			`В папке "${folder.name}" уже существуют файлы: ${existingFiles.join(', ')}.`,
			{ modal: true },
			overwriteAction
		);

		if (selectedAction !== overwriteAction) {
			return;
		}
	}

	await vscode.workspace.fs.writeFile(configUri, toJsonBytes(createDefaultConfig()));
	await vscode.workspace.fs.writeFile(exportUri, toJsonBytes({}));
	await vscode.workspace.fs.writeFile(importUri, toJsonBytes({}));

	const document = await vscode.workspace.openTextDocument(configUri);
	await vscode.window.showTextDocument(document);

	void vscode.window.showInformationMessage(
		`Context Bridge: файлы инициализированы в "${folder.name}".`
	);
}

export function deactivate(): void {}