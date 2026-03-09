import * as vscode from 'vscode';
import {
	CONFIG_FILE_PATH,
	ContextBridgeItem,
	ContextBridgeSelection,
	ContextBridgeSelectionEngine,
	ResourceMembershipInfo,
	SelectionMutationResult,
	buildExportDocument,
	collectExportFiles,
	ContextBridgeImportError,
	ContextBridgeImportSummary,
	createDefaultConfig,
	fileExists,
	getBaseName,
	importContextBridgePatch,
	readContextBridgeConfig,
	toWorkspaceRelativeUri,
	writeContextBridgeConfig,
} from './selectionEngine';

const COMMANDS = {
	initializeWorkspaceFiles: 'context-bridge.initializeWorkspaceFiles',
	exportSelection: 'context-bridge.exportSelection',
	importSelection: 'context-bridge.importSelection',
	activateSelection: 'context-bridge.activateSelection',
	deactivateSelection: 'context-bridge.deactivateSelection',
	addToSelection: 'context-bridge.addToSelection',
	removeFromSelection: 'context-bridge.removeFromSelection',
} as const;

const CONTEXT_BRIDGE_EXPLORER_VIEW_ID = 'contextBridgeExplorer';
const BRIDGE_DOCUMENT_URI = vscode.Uri.from({
	scheme: 'context-bridge',
	path: '/bridge',
});
const MANAGED_FILE_PATHS = [CONFIG_FILE_PATH] as const;

type ManagedFilePath = (typeof MANAGED_FILE_PATHS)[number];
type SelectionItemSource = 'item' | 'excludeItem';
type ActionCommand =
	| typeof COMMANDS.initializeWorkspaceFiles
	| typeof COMMANDS.exportSelection
	| typeof COMMANDS.importSelection;

interface WorkspaceFolderQuickPickItem extends vscode.QuickPickItem {
	folder: vscode.WorkspaceFolder;
}

type ContextBridgeNode =
	| WorkspaceFolderNode
	| SelectionNode
	| SelectionItemNode
	| ActionNode;

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
	source: SelectionItemSource;
}

interface ActionNode {
	kind: 'action';
	folder: vscode.WorkspaceFolder;
	command: ActionCommand;
}

class ContextBridgeVirtualFileSystemProvider implements vscode.FileSystemProvider {
	private readonly fileChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private content = new Uint8Array();
	private modifiedAt = Date.now();

	public readonly onDidChangeFile = this.fileChangeEmitter.event;

	public watch(
		_uri: vscode.Uri,
		_options: { recursive: boolean; excludes: string[] }
	): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	public stat(uri: vscode.Uri): vscode.FileStat {
		this.ensureBridgeUri(uri);

		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: this.modifiedAt,
			size: this.content.byteLength,
		};
	}

	public readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
		return [];
	}

	public createDirectory(_uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document does not support directories.'
		);
	}

	public readFile(uri: vscode.Uri): Uint8Array {
		this.ensureBridgeUri(uri);
		return this.content;
	}

	public writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		_options: { create: boolean; overwrite: boolean }
	): void {
		this.ensureBridgeUri(uri);
		this.content = Uint8Array.from(content);
		this.modifiedAt = Date.now();
		this.emitChanged();
	}

	public delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document cannot be deleted.'
		);
	}

	public rename(
		_oldUri: vscode.Uri,
		_newUri: vscode.Uri,
		_options: { overwrite: boolean }
	): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document cannot be renamed.'
		);
	}

	public async replaceContent(content: string): Promise<void> {
		const document = this.getOpenDocument();

		if (document) {
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const fullRange = new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length)
			);

			await editor.edit((editBuilder) => {
				editBuilder.replace(fullRange, content);
			});
			await document.save();
			return;
		}

		this.content = Buffer.from(content, 'utf8');
		this.modifiedAt = Date.now();
		this.emitChanged();
	}

	public async getContent(): Promise<string> {
		const document = this.getOpenDocument();
		if (document) {
			return document.getText();
		}

		const raw = await vscode.workspace.fs.readFile(BRIDGE_DOCUMENT_URI);
		return Buffer.from(raw).toString('utf8');
	}

	private getOpenDocument(): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((document) => this.isBridgeUri(document.uri));
	}

	private ensureBridgeUri(uri: vscode.Uri): void {
		if (!this.isBridgeUri(uri)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
	}

	private isBridgeUri(uri: vscode.Uri): boolean {
		return uri.scheme === BRIDGE_DOCUMENT_URI.scheme && uri.path === BRIDGE_DOCUMENT_URI.path;
	}

	private emitChanged(): void {
		this.fileChangeEmitter.fire([
			{
				type: vscode.FileChangeType.Changed,
				uri: BRIDGE_DOCUMENT_URI,
			},
		]);
	}
}

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

function registerCommands(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine,
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable[] {
	return [
		registerInitializeWorkspaceFilesCommand(explorerProvider),
		registerExportCommand(bridgeDocumentProvider),
		registerImportCommand(explorerProvider, bridgeDocumentProvider),
		registerSetSelectionActiveStateCommand(
			COMMANDS.activateSelection,
			true,
			explorerProvider,
			selectionEngine
		),
		registerSetSelectionActiveStateCommand(
			COMMANDS.deactivateSelection,
			false,
			explorerProvider,
			selectionEngine
		),
		registerAddToSelectionCommand(explorerProvider, selectionEngine),
		registerRemoveFromSelectionCommand(explorerProvider, selectionEngine),
	];
}

function registerInitializeWorkspaceFilesCommand(
	explorerProvider: ContextBridgeExplorerProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.initializeWorkspaceFiles,
		async (targetFolder?: vscode.WorkspaceFolder) => {
			const folder = targetFolder ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			await initializeWorkspaceFiles(folder);
			explorerProvider.refresh();
		}
	);
}

function registerExportCommand(
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.exportSelection,
		async (targetFolder?: vscode.WorkspaceFolder) => {
			const folder = targetFolder ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			const config = await readContextBridgeConfig(folder);
			if (!config) {
				void vscode.window.showErrorMessage(
					'Context Bridge: valid .vscode/context-bridge.json was not found.'
				);
				return;
			}

			const exportFiles = await collectExportFiles(folder);
			const exportContent = buildExportDocument(exportFiles);

			await bridgeDocumentProvider.replaceContent(exportContent);
			await openBridgeDocument();
		}
	);
}

function registerImportCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.importSelection,
		async (targetFolder?: vscode.WorkspaceFolder) => {
			const patchText = await bridgeDocumentProvider.getContent();
			if (patchText.trim().length === 0) {
				void vscode.window.showErrorMessage(
					'Context Bridge: the context-bridge://bridge document is empty.'
				);
				return;
			}

			const folder = targetFolder ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			try {
				const summary = await importContextBridgePatch(folder, patchText);

				explorerProvider.refresh();

				const appliedCount =
					summary.added + summary.modified + summary.deleted + summary.moved;

				void vscode.window.showInformationMessage(
					appliedCount === 0
						? 'Context Bridge: import completed, no changes.'
						: `Context Bridge: import completed (${formatImportSummary(summary)}).`
				);
			} catch (error) {
				explorerProvider.refresh();

				if (error instanceof ContextBridgeImportError) {
					const appliedCount =
						error.summary.added +
						error.summary.modified +
						error.summary.deleted +
						error.summary.moved;
					const partialSuffix =
						appliedCount > 0
							? ` Already applied: ${formatImportSummary(error.summary)}.`
							: '';

					void vscode.window.showErrorMessage(
						`Context Bridge: import did not finish. ${error.message}${partialSuffix}`
					);
					return;
				}

				const message = error instanceof Error ? error.message : 'unknown error.';
				void vscode.window.showErrorMessage(`Context Bridge: import failed. ${message}`);
			}
		}
	);
}

function registerSetSelectionActiveStateCommand(
	command: typeof COMMANDS.activateSelection | typeof COMMANDS.deactivateSelection,
	active: boolean,
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selection') {
			return;
		}

		const ok = await selectionEngine.setSelectionActiveState(node.folder, node.selection.name, active);
		if (!ok) {
			void vscode.window.showErrorMessage(
				`Context Bridge: could not ${active ? 'activate' : 'deactivate'} selection "${node.selection.name}".`
			);
			return;
		}

		explorerProvider.refresh();
		void vscode.window.showInformationMessage(
			`Context Bridge: selection "${node.selection.name}" ${active ? 'activated' : 'deactivated'}.`
		);
	});
}

function registerAddToSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(COMMANDS.addToSelection, async (resourceUri?: vscode.Uri) => {
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
				'Context Bridge: .vscode/context-bridge.json was not found or does not contain valid selections.'
			);
			return;
		}

		const picked = await vscode.window.showQuickPick(
			summaries.map((summary, index) => ({
				label: summary.selection.name,
				description: `${summary.selection.short} • ${summary.selection.active ? 'active' : 'inactive'} • ${formatFileCount(summary.fileCount)}`,
				index,
			})),
			{ placeHolder: 'Which selection should this resource be added to?' }
		);

		if (!picked) {
			return;
		}

		const fallbackSelectionName = summaries[picked.index]?.selection.name;
		const result = await selectionEngine.addResourceToSelection(resourceUri, picked.index);

		if (result.status === 'added') {
			explorerProvider.refresh();
			void vscode.window.showInformationMessage(
				`Context Bridge: added to "${result.selectionName ?? fallbackSelectionName ?? 'selection'}".`
			);
			return;
		}

		handleSelectionMutationFailure(result, picked.index, fallbackSelectionName);
	});
}

function registerRemoveFromSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.removeFromSelection,
		async (resourceUri?: vscode.Uri) => {
			if (!resourceUri) {
				return;
			}

			const memberships = await selectionEngine.getMemberships(resourceUri);
			if (memberships.length === 0) {
				void vscode.window.showInformationMessage(
					'Context Bridge: this resource is not part of any selection.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				memberships.map((membership) => ({
					label: membership.selection.name,
					description: `${membership.selection.short} • ${formatMembershipKind(membership.kind)}`,
					index: membership.selectionIndex,
				})),
				{ placeHolder: 'Remove this resource from which selection?' }
			);

			if (!picked) {
				return;
			}

			const fallbackSelectionName = memberships.find(
				(membership) => membership.selectionIndex === picked.index
			)?.selection.name;

			const result = await selectionEngine.removeResourceFromSelection(resourceUri, picked.index);

			if (result.status === 'removed' || result.status === 'excluded') {
				explorerProvider.refresh();
				void vscode.window.showInformationMessage(
					`Context Bridge: ${result.status === 'excluded' ? 'excluded from' : 'removed from'} "${result.selectionName ?? fallbackSelectionName ?? 'selection'}".`
				);
				return;
			}

			handleSelectionMutationFailure(result, picked.index, fallbackSelectionName);
		}
	);
}

function handleSelectionMutationFailure(
	result: SelectionMutationResult,
	selectionIndex: number,
	fallbackSelectionName?: string
): void {
	const selectionLabel = result.selectionName ?? fallbackSelectionName ?? `Selection #${selectionIndex + 1}`;

	switch (result.status) {
		case 'alreadySelected':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource is already added to "${selectionLabel}".`
			);
			return;

		case 'coveredByFolder':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource is already included in "${selectionLabel}" through a selected folder.`
			);
			return;

		case 'notDirectItem':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource in "${selectionLabel}" is not selected directly and is not covered by a selected folder. Remove nested items separately.`
			);
			return;

		case 'notFound':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource was not found in "${selectionLabel}" as a direct item.`
			);
			return;

		case 'selectionNotFound':
			void vscode.window.showErrorMessage(
				`Context Bridge: selection not found (index=${selectionIndex}).`
			);
			return;

		case 'invalidResource':
			void vscode.window.showErrorMessage(
				'Context Bridge: could not determine the file or folder resource.'
			);
			return;

		case 'configMissing':
			void vscode.window.showErrorMessage(
				'Context Bridge: initialize .vscode/context-bridge.json first.'
			);
			return;

		default:
			void vscode.window.showErrorMessage('Context Bridge: operation failed.');
	}
}

class ContextBridgeExplorerProvider implements vscode.TreeDataProvider<ContextBridgeNode> {
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
				const item = new vscode.TreeItem(element.folder.name, vscode.TreeItemCollapsibleState.Expanded);

				item.iconPath = new vscode.ThemeIcon('folder');
				item.tooltip = element.folder.uri.fsPath;
				item.contextValue = 'contextBridge.workspaceFolder';
				return item;
			}

			case 'selection': {
				const isActive = element.selection.active;
				const item = new vscode.TreeItem(element.selection.name, vscode.TreeItemCollapsibleState.Collapsed);

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
				const item = new vscode.TreeItem(getBaseName(element.item.path), vscode.TreeItemCollapsibleState.None);

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
		case COMMANDS.exportSelection:
			return 'arrow-up';
		case COMMANDS.importSelection:
			return 'arrow-down';
	}
}

function formatMembershipKind(kind: ResourceMembershipInfo['kind']): string {
	switch (kind) {
		case 'direct':
			return 'directly';
		case 'insideSelectedFolder':
			return 'through selected folder';
		case 'containsSelectedDescendant':
			return 'contains selected items';
	}
}

function formatFileCount(fileCount: number): string {
	return `${fileCount} file(s)`;
}

function formatImportSummary(summary: ContextBridgeImportSummary): string {
	const parts: string[] = [];

	if (summary.modified > 0) {
		parts.push(`изменено ${summary.modified}`);
	}

	if (summary.added > 0) {
		parts.push(`добавлено ${summary.added}`);
	}

	if (summary.deleted > 0) {
		parts.push(`удалено ${summary.deleted}`);
	}

	if (summary.moved > 0) {
		parts.push(`перемещено ${summary.moved}`);
	}

	return parts.length > 0 ? parts.join(', ') : 'изменений нет';
}

async function getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;

	if (!folders || folders.length === 0) {
		void vscode.window.showErrorMessage(
			'Context Bridge: first open a folder or workspace in VS Code.'
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
			placeHolder: 'Select a folder for Context Bridge',
		}
	);

	return picked?.folder;
}

async function initializeWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
	const existingFiles = await getExistingManagedFiles(folder);

	if (existingFiles.length > 0) {
		const overwriteAction = 'Overwrite';
		const selectedAction = await vscode.window.showWarningMessage(
			`The following files already exist in "${folder.name}": ${existingFiles.join(', ')}.`,
			{ modal: true },
			overwriteAction
		);

		if (selectedAction !== overwriteAction) {
			return;
		}
	}

	await writeContextBridgeConfig(folder, createDefaultConfig());

	const document = await vscode.workspace.openTextDocument(
		toWorkspaceRelativeUri(folder.uri, CONFIG_FILE_PATH)
	);
	await vscode.window.showTextDocument(document);

	void vscode.window.showInformationMessage(
		`Context Bridge: "${CONFIG_FILE_PATH}" was initialized in "${folder.name}".`
	);
}



async function openBridgeDocument(): Promise<void> {
	const document = await vscode.workspace.openTextDocument(BRIDGE_DOCUMENT_URI);
	await vscode.window.showTextDocument(document, { preview: false });
}

async function getExistingManagedFiles(folder: vscode.WorkspaceFolder): Promise<ManagedFilePath[]> {
	const existingFiles: ManagedFilePath[] = [];

	for (const filePath of MANAGED_FILE_PATHS) {
		if (await fileExists(toWorkspaceRelativeUri(folder.uri, filePath))) {
			existingFiles.push(filePath);
		}
	}

	return existingFiles;
}



export function deactivate(): void {}