import * as path from 'path';
import * as vscode from 'vscode';

const INITIALIZE_WORKSPACE_FILES_COMMAND = 'context-bridge.initializeWorkspaceFiles';
const CONTEXT_BRIDGE_EXPLORER_VIEW_ID = 'contextBridgeExplorer';

const CONFIG_FILE_NAME = 'context-bridge.json';
const EXPORT_FILE_NAME = 'export.json';
const IMPORT_FILE_NAME = 'import.json';

type ContextBridgeItemType = 'file' | 'folder';

interface ContextBridgeItem {
	path: string;
	type: ContextBridgeItemType;
}

interface ContextBridgeSelection {
	id: string;
	name: string;
	items: ContextBridgeItem[];
}

interface ContextBridgeConfig {
	version: number;
	selections: ContextBridgeSelection[];
}

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
	const explorerProvider = new ContextBridgeExplorerProvider(context);

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

	context.subscriptions.push(treeView, initializeWorkspaceFilesDisposable);
}

class ContextBridgeExplorerProvider implements vscode.TreeDataProvider<ContextBridgeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ContextBridgeNode | undefined | void>();

	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(context: vscode.ExtensionContext) {
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
				const count = element.selection.items.length;
				const item = new vscode.TreeItem(
					element.selection.name,
					vscode.TreeItemCollapsibleState.Collapsed
				);

				item.iconPath = new vscode.ThemeIcon('list-tree');
				item.description = `${count}`;
				item.tooltip = `${element.selection.name} — ${count} item(s)`;
				item.contextValue = 'contextBridge.selection';

				return item;
			}

			case 'selectionItem': {
				const targetUri = toWorkspaceRelativeUri(element.folder.uri, element.item.path);
				const label = getBaseName(element.item.path);

				const item = new vscode.TreeItem(
					label,
					vscode.TreeItemCollapsibleState.None
				);

				item.description = element.item.path;
				item.tooltip = element.item.path;
				item.iconPath = element.item.type === 'folder'
					? vscode.ThemeIcon.Folder
					: vscode.ThemeIcon.File;
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
				const item = new vscode.TreeItem(
					element.fileName,
					vscode.TreeItemCollapsibleState.None
				);

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
		const config = await readContextBridgeConfig(folder);

		// 1) Выборки: показываем только те, у которых после валидации реально есть существующие элементы
		let selectionNodes: SelectionNode[] = [];
		if (config) {
			const validatedSelections: ContextBridgeSelection[] = [];

			for (const selection of config.selections) {
				const existingItems = await filterExistingItems(folder, selection.items);
				if (existingItems.length > 0) {
					validatedSelections.push({
						...selection,
						items: existingItems,
					});
				}
			}

			selectionNodes = validatedSelections.map((selection) => ({
				kind: 'selection',
				folder,
				selection,
			}));
		}

		// 2) export/import: показываем только если файл существует и это валидный JSON
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

async function filterExistingItems(
	folder: vscode.WorkspaceFolder,
	items: ContextBridgeItem[]
): Promise<ContextBridgeItem[]> {
	const checks = await Promise.all(items.map(async (item) => {
		// безопасность: не даём абсолютные/вылазящие пути
		if (!isSafeRelativePath(item.path)) {
			return undefined;
		}

		const uri = toWorkspaceRelativeUri(folder.uri, item.path);

		try {
			const stat = await vscode.workspace.fs.stat(uri);
			const isDir = (stat.type & vscode.FileType.Directory) !== 0;
			const isFile = (stat.type & vscode.FileType.File) !== 0;

			if (item.type === 'folder' && isDir) {
				return item;
			}

			if (item.type === 'file' && isFile) {
				return item;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}));

	return checks.filter((x): x is ContextBridgeItem => x !== undefined);
}

function isSafeRelativePath(p: string): boolean {
	// запрещаем абсолютные пути (в т.ч. C:\...)
	if (path.isAbsolute(p)) {
		return false;
	}

	const normalized = p.replace(/\\/g, '/').trim();
	if (normalized.length === 0) {
		return false;
	}

	// запрещаем выход из workspace
	const segments = normalized.split('/').filter(Boolean);
	if (segments.some((s) => s === '..')) {
		return false;
	}

	return true;
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

	const defaultConfig = createDefaultConfig();

	await vscode.workspace.fs.writeFile(configUri, toJsonBytes(defaultConfig));
	await vscode.workspace.fs.writeFile(exportUri, toJsonBytes({}));
	await vscode.workspace.fs.writeFile(importUri, toJsonBytes({}));

	const document = await vscode.workspace.openTextDocument(configUri);
	await vscode.window.showTextDocument(document);

	void vscode.window.showInformationMessage(
		`Context Bridge: файлы инициализированы в "${folder.name}".`
	);
}

function createDefaultConfig(): ContextBridgeConfig {
	return {
		version: 1,
		selections: [1, 2, 3].map((index) => ({
			id: `selection-${index}`,
			name: `Выборка ${index}`,
			items: [],
		})),
	};
}

async function readContextBridgeConfig(
	folder: vscode.WorkspaceFolder
): Promise<ContextBridgeConfig | undefined> {
	const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);

	try {
		const raw = await vscode.workspace.fs.readFile(configUri);
		const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;

		return normalizeConfig(parsed);
	} catch {
		return undefined;
	}
}

function normalizeConfig(value: unknown): ContextBridgeConfig | undefined {
	if (!isRecord(value) || !Array.isArray(value.selections)) {
		return undefined;
	}

	// ВАЖНО: выборку считаем валидной только если после нормализации items не пустые
	const selections = value.selections
		.map((selection, index) => normalizeSelection(selection, index))
		.filter((selection): selection is ContextBridgeSelection => selection !== undefined);

	if (selections.length === 0) {
		return undefined;
	}

	return {
		version: typeof value.version === 'number' ? value.version : 1,
		selections,
	};
}

function normalizeSelection(value: unknown, index: number): ContextBridgeSelection | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const itemsSource = Array.isArray(value.items) ? value.items : [];
	const items = itemsSource
		.map((item) => normalizeSelectionItem(item))
		.filter((item): item is ContextBridgeItem => item !== undefined);

	// если файлов/папок нет или все невалидные — выборку НЕ показываем
	if (items.length === 0) {
		return undefined;
	}

	return {
		id: typeof value.id === 'string' && value.id.trim().length > 0
			? value.id
			: `selection-${index + 1}`,
		name: typeof value.name === 'string' && value.name.trim().length > 0
			? value.name
			: `Выборка ${index + 1}`,
		items,
	};
}

function normalizeSelectionItem(value: unknown): ContextBridgeItem | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (typeof value.path !== 'string' || value.path.trim().length === 0) {
		return undefined;
	}

	if (!isSafeRelativePath(value.path)) {
		return undefined;
	}

	if (value.type !== 'file' && value.type !== 'folder') {
		return undefined;
	}

	return {
		path: value.path,
		type: value.type,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function getBaseName(targetPath: string): string {
	const normalized = targetPath.replace(/[\\/]+$/, '');
	return path.basename(normalized);
}

function toWorkspaceRelativeUri(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
	const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
	return vscode.Uri.joinPath(baseUri, ...segments);
}

function toJsonBytes(value: unknown): Uint8Array {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	return Buffer.from(json, 'utf8');
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function isValidJsonFile(uri: vscode.Uri): Promise<boolean> {
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		JSON.parse(Buffer.from(raw).toString('utf8'));
		return true;
	} catch {
		return false;
	}
}

export function deactivate(): void {}