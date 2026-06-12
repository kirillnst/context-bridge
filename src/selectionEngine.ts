import * as vscode from 'vscode';
import { filterExistingItems, countSelectionFiles } from './core/fileCollection';
import { readContextBridgeConfig, writeContextBridgeConfig } from './core/config';
import { buildDecorationBadge, buildDecorationTooltip, getResourceMemberships } from './core/membership';
import { addItemToSelection, removeItemFromSelection, type SelectionItemsMutation } from './core/selectionMutation';
import {
	CONFIG_FILE_PATH,
	type ContextBridgeConfig,
	type ContextBridgeItem,
	type ContextBridgeSelection,
	type ResourceMembershipInfo,
	type SelectionManagementResult,
	type SelectionMutationResult,
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
	type SelectionMutationStatus,
	type SelectionSummary,
} from './core/types';
export { createDefaultConfig, readContextBridgeConfig, writeContextBridgeConfig } from './core/config';
export { buildExportDocument, collectExportFiles, filterExistingItems } from './core/fileCollection';
export { ContextBridgeImportError, importContextBridgePatch } from './core/patch';
export {
	fileExists,
	getBaseName,
	isSafeRelativePath,
	isValidJsonFile,
	toJsonBytes,
	toWorkspaceRelativeUri,
} from './core/pathUtils';

export class ContextBridgeSelectionEngine implements vscode.FileDecorationProvider {
	private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	private readonly configCache = new Map<string, ContextBridgeConfig | undefined>();

	public readonly onDidChangeFileDecorations = this.decorationEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_PATH}`);

		configWatcher.onDidCreate((uri) => this.handleConfigChanged(uri));
		configWatcher.onDidChange((uri) => this.handleConfigChanged(uri));
		configWatcher.onDidDelete((uri) => this.handleConfigChanged(uri));

		context.subscriptions.push(configWatcher);

		context.subscriptions.push(
			vscode.workspace.onDidCreateFiles(() => this.refreshDecorations()),
			vscode.workspace.onDidDeleteFiles(() => this.refreshDecorations()),
			vscode.workspace.onDidRenameFiles(() => this.refreshDecorations()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.configCache.clear();
				this.refreshDecorations();
			})
		);
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
				selection: {
					...selection,
					items: existingItems,
					excludeItems: existingExcludeItems,
				},
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

		const name = normalizeSelectionName(rawName);
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

		const name = normalizeSelectionName(rawName);
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
					short: createSelectionShort(name),
				}
				: current
		);

		await this.persistSelections(folder, config, nextSelections);

		return { status: 'renamed', selectionName: name };
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
		const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
		if (!folder) {
			return { status: 'invalidResource' };
		}

		const targetItem = await toContextBridgeItem(folder, resourceUri);
		if (!targetItem) {
			return { status: 'invalidResource' };
		}

		return this.mutateSelection(folder, selectionIndex, (selection) =>
			addItemToSelection(selection.items, selection.excludeItems, targetItem)
		);
	}

	public async removeResourceFromSelection(
		resourceUri: vscode.Uri,
		selectionIndex: number
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
			removeItemFromSelection(selection.items, selection.excludeItems, targetItem)
		);
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
		if (uri.scheme !== 'file') {
			return undefined;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}

		const relativePath = toRelativeWorkspacePath(folder, uri);
		if (!relativePath) {
			return undefined;
		}

		const stat = await safeStat(uri);
		if (!stat) {
			return undefined;
		}

		const config = await this.readConfig(folder);
		if (!config) {
			return undefined;
		}

		const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
		const memberships = getResourceMemberships(config.selections, relativePath, isFolder);
		if (memberships.length === 0) {
			return undefined;
		}

		const activeMemberships = memberships.filter((membership) => membership.selection.active);
		const primaryMemberships = activeMemberships.length > 0 ? activeMemberships : memberships;

		const decoration = new vscode.FileDecoration(
			buildDecorationBadge(primaryMemberships),
			buildDecorationTooltip(memberships)
		);

		decoration.propagate = false;
		return decoration;
	}

	private async readConfig(folder: vscode.WorkspaceFolder): Promise<ContextBridgeConfig | undefined> {
		const cacheKey = folder.uri.toString();

		if (this.configCache.has(cacheKey)) {
			return this.configCache.get(cacheKey);
		}

		const config = await readContextBridgeConfig(folder);
		this.configCache.set(cacheKey, config);

		return config;
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
	}

	private handleConfigChanged(uri: vscode.Uri): void {
		const folder = vscode.workspace.getWorkspaceFolder(uri);

		if (folder) {
			this.invalidateFolderCache(folder);
		} else {
			this.configCache.clear();
		}

		this.refreshDecorations();
	}

	private invalidateFolderCache(folder: vscode.WorkspaceFolder): void {
		this.configCache.delete(folder.uri.toString());
	}

	private refreshDecorations(): void {
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

function normalizeSelectionName(value: string): string {
	return value.trim();
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

function createSelectionShort(selectionName: string): string {
	const trimmed = selectionName.trim();
	if (trimmed.length === 0) {
		return '?';
	}

	const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return '?';
	}

	if (parts.length === 1) {
		return toShortLabel(parts[0]);
	}

	return toShortLabel(parts.map((part) => Array.from(part)[0] ?? '').join(''));
}

function toShortLabel(value: string): string {
	const trimmed = Array.from(value.trim()).slice(0, 2).join('');
	return trimmed.length > 0 ? trimmed.toUpperCase() : '?';
}



