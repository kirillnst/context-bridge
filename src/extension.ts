import * as path from 'path';
import * as vscode from 'vscode';
import {
	CONFIG_FILE_NAME,
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
	toJsonBytes,
	toWorkspaceRelativeUri,
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
const EXPORT_DOCUMENT_FILE_NAME = 'context-bridge-export.txt';
const MANAGED_FILE_NAMES = [CONFIG_FILE_NAME] as const;

type ManagedFileName = (typeof MANAGED_FILE_NAMES)[number];
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

export function activate(context: vscode.ExtensionContext): void {
	const selectionEngine = new ContextBridgeSelectionEngine(context);
	const explorerProvider = new ContextBridgeExplorerProvider(context, selectionEngine);

	context.subscriptions.push(
		vscode.window.createTreeView(CONTEXT_BRIDGE_EXPLORER_VIEW_ID, {
			treeDataProvider: explorerProvider,
			showCollapseAll: true,
		}),
		vscode.window.registerFileDecorationProvider(selectionEngine),
		...registerCommands(explorerProvider, selectionEngine)
	);
}

function registerCommands(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable[] {
	return [
		registerInitializeWorkspaceFilesCommand(explorerProvider),
		registerExportCommand(),
		registerImportCommand(explorerProvider),
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

function registerExportCommand(): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.exportSelection,
		async (targetFolder?: vscode.WorkspaceFolder) => {
			const folder = targetFolder ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			const config = await readContextBridgeConfig(folder);
			if (!config) {
				void vscode.window.showErrorMessage('Context Bridge: не найден корректный context-bridge.json.');
				return;
			}

			const exportFiles = await collectExportFiles(folder);
			const exportContent = buildExportDocument(exportFiles);

			await openUntitledExportDocument(folder, exportContent);
		}
	);
}

function registerImportCommand(
	explorerProvider: ContextBridgeExplorerProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.importSelection,
		async (targetFolder?: vscode.WorkspaceFolder) => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				void vscode.window.showErrorMessage(
					'Context Bridge: откройте документ с patch-ответом и повторите импорт.'
				);
				return;
			}

			const patchText = editor.document.getText();
			if (patchText.trim().length === 0) {
				void vscode.window.showErrorMessage('Context Bridge: активный документ пустой.');
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
						? 'Context Bridge: импорт выполнен, изменений нет.'
						: `Context Bridge: импорт выполнен (${formatImportSummary(summary)}).`
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
							? ` Уже применено: ${formatImportSummary(error.summary)}.`
							: '';

					void vscode.window.showErrorMessage(
						`Context Bridge: импорт не завершён. ${error.message}${partialSuffix}`
					);
					return;
				}

				const message = error instanceof Error ? error.message : 'неизвестная ошибка.';
				void vscode.window.showErrorMessage(`Context Bridge: импорт не выполнен. ${message}`);
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
				`Context Bridge: не удалось ${active ? 'активировать' : 'деактивировать'} выборку "${node.selection.name}".`
			);
			return;
		}

		explorerProvider.refresh();
		void vscode.window.showInformationMessage(
			`Context Bridge: выборка "${node.selection.name}" ${active ? 'активирована' : 'деактивирована'}.`
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
				'Context Bridge: не найден context-bridge.json или в нём нет корректных выборок.'
			);
			return;
		}

		const picked = await vscode.window.showQuickPick(
			summaries.map((summary, index) => ({
				label: summary.selection.name,
				description: `${summary.selection.short} • ${summary.selection.active ? 'активна' : 'неактивна'} • ${formatFileCount(summary.fileCount)}`,
				index,
			})),
			{ placeHolder: 'Добавить ресурс в какую выборку?' }
		);

		if (!picked) {
			return;
		}

		const fallbackSelectionName = summaries[picked.index]?.selection.name;
		const result = await selectionEngine.addResourceToSelection(resourceUri, picked.index);

		if (result.status === 'added') {
			explorerProvider.refresh();
			void vscode.window.showInformationMessage(
				`Context Bridge: добавлено в "${result.selectionName ?? fallbackSelectionName ?? 'выборку'}".`
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
					'Context Bridge: этот ресурс не входит ни в одну выборку.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				memberships.map((membership) => ({
					label: membership.selection.name,
					description: `${membership.selection.short} • ${formatMembershipKind(membership.kind)}`,
					index: membership.selectionIndex,
				})),
				{ placeHolder: 'Убрать ресурс из какой выборки?' }
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
					`Context Bridge: ${result.status === 'excluded' ? 'исключено из' : 'убрано из'} "${result.selectionName ?? fallbackSelectionName ?? 'выборки'}".`
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
				`Context Bridge: ресурс в "${selectionLabel}" не выбран напрямую и не покрыт выбранной папкой. Уберите вложенные элементы отдельно.`
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

		case 'invalidResource':
			void vscode.window.showErrorMessage(
				'Context Bridge: не удалось определить ресурс файла или папки.'
			);
			return;

		case 'configMissing':
			void vscode.window.showErrorMessage(
				'Context Bridge: сначала инициализируйте context-bridge.json.'
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
		const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);

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
					: `${element.selection.short} • ${formatFileCount(element.fileCount)} • неактивна`;
				item.tooltip =
					`${element.selection.name} [${element.selection.short}]\n` +
					`Файлы: ${element.fileCount}\n` +
					`Прямые элементы: ${element.selection.items.length}\n` +
					`Исключения: ${element.selection.excludeItems.length}\n` +
					`Статус: ${isActive ? 'активна' : 'неактивна'}`;
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
				item.tooltip = `${isExclude ? 'Исключение' : isFolder ? 'Папка' : 'Файл'}\n${element.item.path}`;
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
			return 'Инициализировать';
		case COMMANDS.exportSelection:
			return 'Экспортировать';
		case COMMANDS.importSelection:
			return 'Импортировать';
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
			return 'напрямую';
		case 'insideSelectedFolder':
			return 'через выбранную папку';
		case 'containsSelectedDescendant':
			return 'содержит выбранные элементы';
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
		void vscode.window.showErrorMessage('Context Bridge: сначала откройте папку или workspace в VS Code.');
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
			placeHolder: 'Выберите папку для Context Bridge',
		}
	);

	return picked?.folder;
}

async function initializeWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
	const existingFiles = await getExistingManagedFiles(folder);

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

	await vscode.workspace.fs.writeFile(
		vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME),
		toJsonBytes(createDefaultConfig())
	);

	const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME));
	await vscode.window.showTextDocument(document);

	void vscode.window.showInformationMessage(`Context Bridge: файл инициализирован в "${folder.name}".`);
}

async function openUntitledExportDocument(
	folder: vscode.WorkspaceFolder,
	content: string
): Promise<void> {
	const documentUri = vscode.Uri.parse(
		`untitled:${path.join(folder.uri.fsPath, EXPORT_DOCUMENT_FILE_NAME)}`
	);
	const document = await vscode.workspace.openTextDocument(documentUri);
	const editor = await vscode.window.showTextDocument(document, { preview: false });
	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(document.getText().length)
	);

	await editor.edit((editBuilder) => {
		editBuilder.replace(fullRange, content);
	});
}

async function getExistingManagedFiles(folder: vscode.WorkspaceFolder): Promise<ManagedFileName[]> {
	const existingFiles: ManagedFileName[] = [];

	for (const fileName of MANAGED_FILE_NAMES) {
		if (await fileExists(vscode.Uri.joinPath(folder.uri, fileName))) {
			existingFiles.push(fileName);
		}
	}

	return existingFiles;
}

export function deactivate(): void {}