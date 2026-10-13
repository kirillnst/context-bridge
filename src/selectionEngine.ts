import * as vscode from 'vscode';
import { filterExistingItems, countSelectionFiles, collectActiveExportPaths, getFileContentExtension, shouldIgnoreFileContent } from './core/fileCollection';
import { createSelectionShort, isReservedSelectionShort, readContextBridgeConfig, toShortLabel, writeContextBridgeConfig } from './core/config';
import { buildDecorationTooltip, getResourceMemberships } from './core/membership';
import { addItemToSelection, mutateSelectionItemsBatch, removeItemFromSelection, type SelectionItemsMutation } from './core/selectionMutation';
import { removeExactCollectionItem } from './core/selectionRules';
import {
	CONFIG_FILE_PATH,
	type ContextBridgeConfig,
	type ContextBridgeItem,
	type ContextBridgeSelection,
	type ResourceMembershipInfo,
	type SelectionManagementResult,
	type SelectionMutationResult,
	type SelectionBatchMutationResult,
	type SelectionSummary,
} from './core/types';
import { isSafeRelativePath, safeStat, toRelativeWorkspacePath } from './core/pathUtils';

export {
	CONFIG_DIRECTORY_NAME,
	CONFIG_FILE_NAME,
	CONFIG_FILE_PATH,
	type ContextBridgeConfig,
	type ContextBridgeExportFile,
	type ContextBridgeImportSummary,
	type ContextBridgeItem,
	type ContextBridgeItemType,
	type ContextBridgeSelection,
	type ResourceMembershipInfo,
	type ResourceMembershipKind,
	type SelectionManagementResult,
	type SelectionManagementStatus,
	type SelectionMutationResult,
	type SelectionBatchMutationResult,
	type SelectionMutationStatus,
	type SelectionSummary,
} from './core/types';
export { createDefaultConfig, readContextBridgeConfig, writeContextBridgeConfig } from './core/config';
export { formatMembershipKind } from './core/membership';
export { buildExportDocument, collectExportFiles, filterExistingItems } from './core/fileCollection';
export { ContextBridgeImportError, importContextBridgePatch } from './core/patch';
export {
	fileExists,
	getBaseName,
	isSafeRelativePath,
	toJsonBytes,
	toWorkspaceRelativeUri,
} from './core/pathUtils';

interface ResourceDecorationData {
	memberships: ResourceMembershipInfo[];
	exported: boolean;
	ignored: boolean;
}

interface ExportedPaths {
	files: Set<string>;
	folders: Set<string>;
}

export class ContextBridgeSelectionEngine implements vscode.FileDecorationProvider {
	private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	private readonly configCache = new Map<string, Promise<ContextBridgeConfig | undefined>>();
	private readonly exportedPathsCache = new Map<string, Promise<ExportedPaths>>();
	private readonly resourceDecorationCache = new Map<string, Promise<ResourceDecorationData | undefined>>();
	private readonly decorationProviders: vscode.Disposable[] = [];
	private decorationProviderRefreshVersion = 0;
	private registeredSelectionCount = -1;
	private resourceChangeRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	public readonly onDidChangeFileDecorations = this.decorationEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_PATH}`);

		configWatcher.onDidCreate((uri) => this.handleConfigChanged(uri));
		configWatcher.onDidChange((uri) => this.handleConfigChanged(uri));
		configWatcher.onDidDelete((uri) => this.handleConfigChanged(uri));

		const resourceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
		resourceWatcher.onDidCreate(() => this.scheduleResourceRefresh());
		resourceWatcher.onDidDelete(() => this.scheduleResourceRefresh());

		context.subscriptions.push(configWatcher, resourceWatcher);

		context.subscriptions.push(
			vscode.workspace.onDidCreateFiles(() => this.scheduleResourceRefresh()),
			vscode.workspace.onDidDeleteFiles(() => this.scheduleResourceRefresh()),
			vscode.workspace.onDidRenameFiles(() => this.scheduleResourceRefresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.configCache.clear();
				this.refreshDecorations();
				void this.synchronizeDecorationProviders();
			})
		);

		context.subscriptions.push(new vscode.Disposable(() => {
			this.decorationProviderRefreshVersion++;
			if (this.resourceChangeRefreshTimer !== undefined) {
				clearTimeout(this.resourceChangeRefreshTimer);
			}
			this.disposeDecorationProviders();
		}));
		void this.synchronizeDecorationProviders();
	}

	public async getSelectionSummaries(folder: vscode.WorkspaceFolder): Promise<SelectionSummary[]> {
		const config = await this.readConfig(folder);
		if (!config) {
			return [];
		}

		const summaries: SelectionSummary[] = [];

		for (const [selectionIndex, selection] of config.selections.entries()) {
			const existingItems = await filterExistingItems(folder, selection.items);
			const existingExcludeItems = await filterExistingItems(folder, selection.excludeItems);
			const fileCount = await countSelectionFiles(folder, existingItems, existingExcludeItems);

			summaries.push({
				selection,
				selectionIndex,
				fileCount,
			});
		}

		return summaries;
	}

	public async setSelectionActiveState(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number,
		active: boolean
	): Promise<boolean> {
		const config = await this.readConfig(folder);
		if (!config) {
			return false;
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return false;
		}

		if (selection.active === active) {
			return true;
		}

		const nextSelections = config.selections.map((current, index) =>
			index === selectionIndex ? { ...current, active } : current
		);

		await this.persistSelections(folder, config, nextSelections);
		return true;
	}

	public async createSelection(
		folder: vscode.WorkspaceFolder,
		rawName: string
	): Promise<SelectionManagementResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const name = rawName.trim();
		if (name.length === 0) {
			return { status: 'invalidName' };
		}

		if (hasSelectionName(config.selections, name)) {
			return { status: 'duplicateName', selectionName: name };
		}

		await this.persistSelections(folder, config, [
			...config.selections,
			{
				name,
				short: createSelectionShort(name),
				active: true,
				items: [],
				excludeItems: [],
			},
		]);

		return { status: 'created', selectionName: name };
	}

	public async renameSelection(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number,
		rawName: string
	): Promise<SelectionManagementResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		const name = rawName.trim();
		if (name.length === 0) {
			return { status: 'invalidName' };
		}

		if (hasSelectionName(config.selections, name, selectionIndex)) {
			return { status: 'duplicateName', selectionName: name };
		}

		if (selection.name === name) {
			return { status: 'renamed', selectionName: name };
		}

		const nextSelections = config.selections.map((current, index) =>
			index === selectionIndex
				? {
					...current,
					name,
				}
				: current
		);

		await this.persistSelections(folder, config, nextSelections);

		return { status: 'renamed', selectionName: name };
	}

	public async renameSelectionShort(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number,
		rawShort: string
	): Promise<SelectionManagementResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		const trimmed = rawShort.trim();
		if (trimmed.length === 0 || trimmed.length > 2 || isReservedSelectionShort(trimmed)) {
			return { status: 'invalidShort' };
		}

		const short = toShortLabel(trimmed);
		if (selection.short !== short) {
			const nextSelections = config.selections.map((current, index) =>
				index === selectionIndex ? { ...current, short } : current
			);
			await this.persistSelections(folder, config, nextSelections);
		}

		return { status: 'renamed', selectionName: selection.name };
	}

	public async deleteSelection(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number
	): Promise<SelectionManagementResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		await this.persistSelections(
			folder,
			config,
			config.selections.filter((_current, index) => index !== selectionIndex)
		);

		return { status: 'deleted', selectionName: selection.name };
	}

	public async addResourceToSelection(
		resourceUri: vscode.Uri,
		selectionIndex: number
	): Promise<SelectionMutationResult> {
		return this.mutateResourceInSelection(resourceUri, selectionIndex, addItemToSelection);
	}

	public async removeResourceFromSelection(
		resourceUri: vscode.Uri,
		selectionIndex: number
	): Promise<SelectionMutationResult> {
		return this.mutateResourceInSelection(resourceUri, selectionIndex, removeItemFromSelection);
	}

	private async mutateResourceInSelection(
		resourceUri: vscode.Uri,
		selectionIndex: number,
		mutate: typeof addItemToSelection
	): Promise<SelectionMutationResult> {
		const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (!folder) {
			return { status: 'invalidResource' };
		}

		const targetItem = await toContextBridgeItem(folder, resourceUri);
		if (!targetItem) {
			return { status: 'invalidResource' };
		}

		return this.mutateSelection(folder, selectionIndex, (selection) =>
			mutate(selection.items, selection.excludeItems, targetItem)
		);
	}

	public async mutateResourcesInSelection(
		folder: vscode.WorkspaceFolder,
		resourceUris: vscode.Uri[],
		selectionIndex: number,
		mode: 'add' | 'remove'
	): Promise<SelectionBatchMutationResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		const seen = new Set<string>();
		const targets: ContextBridgeItem[] = [];
		let invalidCount = 0;
		for (const uri of resourceUris) {
			const key = uri.toString();
			if (seen.has(key)) {
				invalidCount += 1;
				continue;
			}
			seen.add(key);

			if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
				invalidCount += 1;
				continue;
			}

			const item = await toContextBridgeItem(folder, uri);
			if (item) {
				targets.push(item);
			} else {
				invalidCount += 1;
			}
		}

		const mutation = mutateSelectionItemsBatch(selection.items, selection.excludeItems, targets, mode);
		if (mutation.added + mutation.removed + mutation.excluded > 0) {
			const nextSelections = config.selections.map((current, index) =>
				index === selectionIndex
					? { ...current, items: mutation.items, excludeItems: mutation.excludeItems }
					: current
			);
			await this.persistSelections(folder, config, nextSelections);
		}

		return {
			status: 'completed',
			selectionName: selection.name,
			added: mutation.added,
			removed: mutation.removed,
			excluded: mutation.excluded,
			skipped: mutation.skipped + invalidCount,
		};
	}

	public async removeSelectionItem(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number,
		targetItem: ContextBridgeItem,
		isExclusion: boolean
	): Promise<SelectionMutationResult> {
		return this.mutateSelection(folder, selectionIndex, (selection) => {
			if (!isExclusion) {
				return removeItemFromSelection(selection.items, selection.excludeItems, targetItem);
			}

			const excludeItems = removeExactCollectionItem(selection.excludeItems, targetItem);
			return {
				changed: excludeItems.length !== selection.excludeItems.length,
				status: excludeItems.length !== selection.excludeItems.length ? 'removed' : 'notFound',
				items: selection.items,
				excludeItems,
			};
		});
	}

	public async setFileContentExtensionIgnored(
		resourceUri: vscode.Uri,
		ignored: boolean
	): Promise<'added' | 'removed' | 'unchanged' | 'configMissing' | 'invalidResource'> {
		const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (!folder || resourceUri.scheme !== 'file') {
			return 'invalidResource';
		}

		const stat = await safeStat(resourceUri);
		if (!stat || (stat.type & vscode.FileType.File) === 0) {
			return 'invalidResource';
		}

		const config = await this.readConfig(folder);
		if (!config) {
			return 'configMissing';
		}

		const extension = getFileContentExtension(resourceUri.path);
		const alreadyIgnored = config.ignoreContentExtensions.includes(extension);
		if (alreadyIgnored === ignored) {
			return 'unchanged';
		}

		await writeContextBridgeConfig(folder, {
			...config,
			ignoreContentExtensions: ignored
				? [...config.ignoreContentExtensions, extension]
				: config.ignoreContentExtensions.filter((item) => item !== extension),
		});
		this.invalidateFolderCache(folder);
		this.refreshDecorations();
		return ignored ? 'added' : 'removed';
	}

	public async getMemberships(resourceUri: vscode.Uri): Promise<ResourceMembershipInfo[]> {
		const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (!folder) {
			return [];
		}

		const relativePath = toRelativeWorkspacePath(folder, resourceUri);
		if (!relativePath) {
			return [];
		}

		const stat = await safeStat(resourceUri);
		if (!stat) {
			return [];
		}

		const config = await this.readConfig(folder);
		if (!config) {
			return [];
		}

		const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
		return getResourceMemberships(config.selections, relativePath, isFolder);
	}

	public async provideFileDecoration(
		uri: vscode.Uri,
		_token: vscode.CancellationToken
	): Promise<vscode.FileDecoration | undefined> {
		const data = await this.getDecorationData(uri);
		if (!data?.exported) {
			return undefined;
		}

		const decoration = new vscode.FileDecoration('E', 'Context Bridge: included in export');
		decoration.propagate = false;
		return decoration;
	}

	private async provideIgnoredContentDecoration(
		uri: vscode.Uri
	): Promise<vscode.FileDecoration | undefined> {
		const data = await this.getDecorationData(uri);
		if (!data?.ignored) {
			return undefined;
		}

		const decoration = new vscode.FileDecoration('I', 'Context Bridge: file content ignored during export');
		decoration.propagate = false;
		return decoration;
	}

	private async provideSelectionDecoration(
		uri: vscode.Uri,
		selectionIndex: number
	): Promise<vscode.FileDecoration | undefined> {
		const data = await this.getDecorationData(uri);
		const membership = data?.memberships.find((item) => item.selectionIndex === selectionIndex);
		if (!membership) {
			return undefined;
		}

		const short = membership.selection.short;
		const badge = short.length <= 2 ? short : Array.from(short)[0] ?? '?';
		const decoration = new vscode.FileDecoration(badge, buildDecorationTooltip([membership]));
		decoration.propagate = false;
		return decoration;
	}

	private async getDecorationData(uri: vscode.Uri): Promise<ResourceDecorationData | undefined> {
		if (uri.scheme !== 'file') {
			return undefined;
		}

		const key = uri.toString();
		let pending = this.resourceDecorationCache.get(key);
		if (!pending) {
			pending = this.resolveDecorationData(uri);
			this.resourceDecorationCache.set(key, pending);
		}

		return pending;
	}

	private async resolveDecorationData(uri: vscode.Uri): Promise<ResourceDecorationData | undefined> {
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}

		const relativePath = toRelativeWorkspacePath(folder, uri);
		const isWorkspaceRoot = uri.toString() === folder.uri.toString();
		if (!relativePath && !isWorkspaceRoot) {
			return undefined;
		}

		const [stat, config] = await Promise.all([safeStat(uri), this.readConfig(folder)]);
		if (!stat || !config) {
			return undefined;
		}

		const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
		const ignored = !isFolder && relativePath !== undefined &&
			shouldIgnoreFileContent(relativePath, config.ignoreContentExtensions);
		const memberships = relativePath
			? getResourceMemberships(config.selections, relativePath, isFolder)
			: [];
		if (memberships.length === 0 && !isWorkspaceRoot) {
			return ignored ? { memberships, exported: false, ignored } : undefined;
		}

		const exportedPaths = await this.getExportedPaths(folder, config);
		return {
			memberships,
			ignored,
			exported: isWorkspaceRoot
				? exportedPaths.files.size > 0
				: isFolder
					? exportedPaths.folders.has(relativePath!)
					: exportedPaths.files.has(relativePath!),
		};
	}

	private getExportedPaths(
		folder: vscode.WorkspaceFolder,
		config: ContextBridgeConfig
	): Promise<ExportedPaths> {
		const key = folder.uri.toString();
		let pending = this.exportedPathsCache.get(key);
		if (!pending) {
			pending = collectActiveExportPaths(folder, config).then((files) => {
				const folders = new Set<string>();
				for (const filePath of files) {
					let separator = filePath.lastIndexOf('/');
					while (separator > 0) {
						folders.add(filePath.slice(0, separator));
						separator = filePath.lastIndexOf('/', separator - 1);
					}
				}
				return { files, folders };
			});
			this.exportedPathsCache.set(key, pending);
		}

		return pending;
	}

	private async synchronizeDecorationProviders(): Promise<void> {
		const version = ++this.decorationProviderRefreshVersion;
		const folders = vscode.workspace.workspaceFolders ?? [];
		const configs = await Promise.all(folders.map((folder) => this.readConfig(folder)));
		if (version !== this.decorationProviderRefreshVersion) {
			return;
		}

		const count = configs.reduce((max, config) => Math.max(max, config?.selections.length ?? 0), 0);
		if (count === this.registeredSelectionCount) {
			return;
		}

		this.disposeDecorationProviders();
		this.registeredSelectionCount = count;
		this.decorationProviders.push(vscode.window.registerFileDecorationProvider(this));
		const ignoredContentProvider: vscode.FileDecorationProvider = {
			onDidChangeFileDecorations: this.onDidChangeFileDecorations,
			provideFileDecoration: (uri) => this.provideIgnoredContentDecoration(uri),
		};
		this.decorationProviders.push(vscode.window.registerFileDecorationProvider(ignoredContentProvider));
		for (let index = 0; index < count; index++) {
			const provider: vscode.FileDecorationProvider = {
				onDidChangeFileDecorations: this.onDidChangeFileDecorations,
				provideFileDecoration: (uri) => this.provideSelectionDecoration(uri, index),
			};
			this.decorationProviders.push(vscode.window.registerFileDecorationProvider(provider));
		}
	}

	private disposeDecorationProviders(): void {
		for (const provider of this.decorationProviders) {
			provider.dispose();
		}
		this.decorationProviders.length = 0;
	}

	private readConfig(folder: vscode.WorkspaceFolder): Promise<ContextBridgeConfig | undefined> {
		const cacheKey = folder.uri.toString();
		let pending = this.configCache.get(cacheKey);
		if (!pending) {
			pending = readContextBridgeConfig(folder);
			this.configCache.set(cacheKey, pending);
		}
		return pending;
	}

	private async mutateSelection(
		folder: vscode.WorkspaceFolder,
		selectionIndex: number,
		mutate: (selection: ContextBridgeSelection) => SelectionItemsMutation
	): Promise<SelectionMutationResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		const mutation = mutate(selection);
		if (!mutation.changed) {
			return { status: mutation.status, selectionName: selection.name };
		}

		const nextSelections = config.selections.map((current, index) =>
			index === selectionIndex
				? {
					...current,
					items: mutation.items,
					excludeItems: mutation.excludeItems,
				}
				: current
		);

		await this.persistSelections(folder, config, nextSelections);

		return { status: mutation.status, selectionName: selection.name };
	}

	private async persistSelections(
		folder: vscode.WorkspaceFolder,
		config: ContextBridgeConfig,
		nextSelections: ContextBridgeSelection[]
	): Promise<void> {
		await writeContextBridgeConfig(folder, {
			...config,
			version: Math.max(config.version, 2),
			selections: nextSelections,
		});
		this.invalidateFolderCache(folder);
		this.refreshDecorations();
		void this.synchronizeDecorationProviders();
	}

	private handleConfigChanged(uri: vscode.Uri): void {
		const folder = vscode.workspace.getWorkspaceFolder(uri);

		if (folder) {
			this.invalidateFolderCache(folder);
		} else {
			this.configCache.clear();
		}

		this.refreshDecorations();
		void this.synchronizeDecorationProviders();
	}

	private invalidateFolderCache(folder: vscode.WorkspaceFolder): void {
		this.configCache.delete(folder.uri.toString());
	}

	private scheduleResourceRefresh(): void {
		if (this.resourceChangeRefreshTimer !== undefined) {
			clearTimeout(this.resourceChangeRefreshTimer);
		}
		this.resourceChangeRefreshTimer = setTimeout(() => {
			this.resourceChangeRefreshTimer = undefined;
			this.refreshDecorations();
		}, 100);
	}

	private refreshDecorations(): void {
		this.exportedPathsCache.clear();
		this.resourceDecorationCache.clear();
		this.decorationEmitter.fire(undefined);
	}
}

async function toContextBridgeItem(
	folder: vscode.WorkspaceFolder,
	resourceUri: vscode.Uri
): Promise<ContextBridgeItem | undefined> {
	const relativePath = toRelativeWorkspacePath(folder, resourceUri);
	if (!relativePath || !isSafeRelativePath(relativePath)) {
		return undefined;
	}

	const stat = await safeStat(resourceUri);
	if (!stat) {
		return undefined;
	}

	if ((stat.type & vscode.FileType.Directory) !== 0) {
		return { path: relativePath, type: 'folder' };
	}

	if ((stat.type & vscode.FileType.File) !== 0) {
		return { path: relativePath, type: 'file' };
	}

	return undefined;
}

function hasSelectionName(
	selections: ContextBridgeSelection[],
	name: string,
	exceptIndex?: number
): boolean {
	const normalizedName = name.toLocaleLowerCase();

	return selections.some(
		(selection, index) =>
			index !== exceptIndex && selection.name.trim().toLocaleLowerCase() === normalizedName
	);
}


