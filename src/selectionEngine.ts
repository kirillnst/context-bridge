import * as path from 'path';
import * as vscode from 'vscode';

export const CONFIG_FILE_NAME = 'context-bridge.json';

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
	fileCount: number;
}

export interface ContextBridgeExportFile {
	path: string;
	content: string;
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

export type ResourceMembershipKind = 'direct' | 'insideSelectedFolder' | 'containsSelectedDescendant';

export interface ResourceMembershipInfo {
	selection: ContextBridgeSelection;
	selectionIndex: number;
	kind: ResourceMembershipKind;
}

interface SelectionItemsMutation {
	changed: boolean;
	status: SelectionMutationStatus;
	items: ContextBridgeItem[];
	excludeItems: ContextBridgeItem[];
}

export class ContextBridgeSelectionEngine implements vscode.FileDecorationProvider {
	private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	private readonly configCache = new Map<string, ContextBridgeConfig | undefined>();

	public readonly onDidChangeFileDecorations = this.decorationEmitter.event;

	constructor(context: vscode.ExtensionContext) {
		const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`);

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

		for (const selection of config.selections) {
			const existingItems = await filterExistingItems(folder, selection.items);
			const existingExcludeItems = await filterExistingItems(folder, selection.excludeItems);
			const fileCount = await countSelectionFiles(folder, existingItems, existingExcludeItems);

			summaries.push({
				selection: {
					...selection,
					items: existingItems,
					excludeItems: existingExcludeItems,
				},
				fileCount,
			});
		}

		return summaries;
	}

	public async setSelectionActiveState(
		folder: vscode.WorkspaceFolder,
		selectionName: string,
		active: boolean
	): Promise<boolean> {
		const config = await this.readConfig(folder);
		if (!config) {
			return false;
		}

		let changed = false;
		const nextSelections = config.selections.map((selection) => {
			if (selection.name !== selectionName) {
				return selection;
			}

			if (selection.active === active) {
				return selection;
			}

			changed = true;
			return { ...selection, active };
		});

		if (!changed) {
			return true;
		}

		await this.persistSelections(folder, config, nextSelections);
		return true;
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

function addItemToSelection(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	target: ContextBridgeItem
): SelectionItemsMutation {
	const nextExcludeItems = removeExactCollectionItem(excludeItems, target);
	const exactItemExists = hasExactCollectionItem(items, target);

	if (exactItemExists) {
		if (nextExcludeItems.length !== excludeItems.length) {
			return { changed: true, status: 'added', items, excludeItems: nextExcludeItems };
		}

		return { changed: false, status: 'alreadySelected', items, excludeItems };
	}

	if (isIncludedViaFolder(items, nextExcludeItems, target.path)) {
		if (nextExcludeItems.length !== excludeItems.length) {
			return { changed: true, status: 'added', items, excludeItems: nextExcludeItems };
		}

		return { changed: false, status: 'coveredByFolder', items, excludeItems };
	}

	return {
		changed: true,
		status: 'added',
		items: dedupeItems([...items, target]),
		excludeItems: nextExcludeItems,
	};
}

function removeItemFromSelection(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	target: ContextBridgeItem
): SelectionItemsMutation {
	if (hasExactCollectionItem(items, target)) {
		const nextItems = removeExactCollectionItem(items, target);

		if (isIncludedViaFolder(nextItems, excludeItems, target.path)) {
			return {
				changed: true,
				status: 'excluded',
				items: nextItems,
				excludeItems: addExcludeItem(excludeItems, target),
			};
		}

		return { changed: true, status: 'removed', items: nextItems, excludeItems };
	}

	if (isIncludedViaFolder(items, excludeItems, target.path)) {
		return {
			changed: true,
			status: 'excluded',
			items,
			excludeItems: addExcludeItem(excludeItems, target),
		};
	}

	if (hasDirectDescendantItem(items, target.path)) {
		return { changed: false, status: 'notDirectItem', items, excludeItems };
	}

	return { changed: false, status: 'notFound', items, excludeItems };
}

function getResourceMemberships(
	selections: ContextBridgeSelection[],
	resourcePath: string,
	isFolder: boolean
): ResourceMembershipInfo[] {
	const memberships: ResourceMembershipInfo[] = [];

	for (const [selectionIndex, selection] of selections.entries()) {
		const kind = getSelectionMembershipKind(selection, resourcePath, isFolder);
		if (kind) {
			memberships.push({ selection, selectionIndex, kind });
		}
	}

	return memberships;
}

function getSelectionMembershipKind(
	selection: ContextBridgeSelection,
	resourcePath: string,
	isFolder: boolean
): ResourceMembershipKind | undefined {
	if (hasExactPathItem(selection.items, resourcePath)) {
		return 'direct';
	}

	if (isIncludedViaFolder(selection.items, selection.excludeItems, resourcePath)) {
		return 'insideSelectedFolder';
	}

	if (isFolder && hasDirectDescendantItem(selection.items, resourcePath)) {
		return 'containsSelectedDescendant';
	}

	return undefined;
}

function buildDecorationBadge(memberships: ResourceMembershipInfo[]): string {
	if (memberships.length === 1) {
		return memberships[0].selection.short;
	}

	return memberships.length < 10 ? String(memberships.length) : '+';
}

function buildDecorationTooltip(memberships: ResourceMembershipInfo[]): string {
	const lines = memberships.map((membership) => {
		const state = membership.selection.active ? 'активна' : 'неактивна';
		const mode =
			membership.kind === 'direct'
				? 'напрямую'
				: membership.kind === 'insideSelectedFolder'
					? 'через выбранную папку'
					: 'содержит выбранные элементы';

		return `${membership.selection.name} [${membership.selection.short}] (${state}) — ${mode}`;
	});

	return `Context Bridge\n${lines.join('\n')}`;
}

export async function readContextBridgeConfig(
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

export async function writeContextBridgeConfig(
	folder: vscode.WorkspaceFolder,
	config: ContextBridgeConfig
): Promise<void> {
	const configUri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE_NAME);
	await vscode.workspace.fs.writeFile(configUri, toJsonBytes(config));
}

export function createDefaultConfig(): ContextBridgeConfig {
	return {
		version: 2,
		selections: [
			{
				name: 'Primary',
				short: 'PR',
				active: true,
				items: [],
				excludeItems: [],
			},
			{
				name: 'Additional',
				short: 'AD',
				active: true,
				items: [],
				excludeItems: [],
			},
		],
	};
}

export async function collectExportFiles(
	folder: vscode.WorkspaceFolder
): Promise<ContextBridgeExportFile[]> {
	const config = await readContextBridgeConfig(folder);
	if (!config) {
		return [];
	}

	const exportedPaths = new Set<string>();
	const files: ContextBridgeExportFile[] = [];

	for (const selection of config.selections) {
		if (!selection.active) {
			continue;
		}

		const existingItems = await filterExistingItems(folder, selection.items);
		const existingExcludeItems = await filterExistingItems(folder, selection.excludeItems);
		const filePaths = await collectSelectionFilePaths(folder, existingItems, existingExcludeItems);

		for (const filePath of filePaths) {
			if (exportedPaths.has(filePath)) {
				continue;
			}

			const fileUri = toWorkspaceRelativeUri(folder.uri, filePath);

			try {
				const raw = await vscode.workspace.fs.readFile(fileUri);
				files.push({
					path: filePath,
					content: Buffer.from(raw).toString('utf8'),
				});
				exportedPaths.add(filePath);
			} catch {
				// ignored
			}
		}
	}

	return files;
}

export function buildExportDocument(files: ContextBridgeExportFile[]): string {
	return files
		.map((file) => `FILE: ${file.path}\n\nCONTENT:\n${normalizeExportText(file.content)}`)
		.join('\n\n');
}

function normalizeExportText(value: string): string {
	return value.replace(/\r\n/g, '\n');
}

function normalizeConfig(value: unknown): ContextBridgeConfig | undefined {
	if (!isRecord(value) || !Array.isArray(value.selections)) {
		return undefined;
	}

	const selections = value.selections
		.map((selection, index) => normalizeSelection(selection, index))
		.filter((selection): selection is ContextBridgeSelection => selection !== undefined);

	if (selections.length === 0) {
		return undefined;
	}

	return {
		version: typeof value.version === 'number' ? value.version : 2,
		selections,
	};
}

function normalizeSelection(value: unknown, index: number): ContextBridgeSelection | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const fallbackName = `Selection ${index + 1}`;
	const name =
		typeof value.name === 'string' && value.name.trim().length > 0 ? value.name.trim() : fallbackName;
	const short = normalizeSelectionShort(value.short, name);
	const itemsSource = Array.isArray(value.items) ? value.items : [];
	const excludeItemsSource = Array.isArray(value.excludeItems) ? value.excludeItems : [];
	const items = dedupeItems(
		itemsSource
			.map((item) => normalizeSelectionItem(item))
			.filter((item): item is ContextBridgeItem => item !== undefined)
	);
	const excludeItems = dedupeItems(
		excludeItemsSource
			.map((item) => normalizeSelectionItem(item))
			.filter((item): item is ContextBridgeItem => item !== undefined)
	);

	return {
		name,
		short,
		active: typeof value.active === 'boolean' ? value.active : true,
		items,
		excludeItems,
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
		path: normalizeRelativePath(value.path),
		type: value.type,
	};
}

function normalizeSelectionShort(value: unknown, fallbackName: string): string {
	if (typeof value === 'string' && value.trim().length > 0) {
		return toShortLabel(value);
	}

	return getSelectionBadgeFromName(fallbackName);
}

function toShortLabel(value: string): string {
	const trimmed = Array.from(value.trim()).slice(0, 2).join('');
	return trimmed.length > 0 ? trimmed.toUpperCase() : '?';
}

function getSelectionBadgeFromName(selectionName: string): string {
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

	const acronym = parts
		.map((part) => Array.from(part)[0] ?? '')
		.join('');

	return toShortLabel(acronym);
}

export async function filterExistingItems(
	folder: vscode.WorkspaceFolder,
	items: ContextBridgeItem[]
): Promise<ContextBridgeItem[]> {
	const checks = await Promise.all(
		items.map(async (item) => {
			if (!isSafeRelativePath(item.path)) {
				return undefined;
			}

			const uri = toWorkspaceRelativeUri(folder.uri, item.path);
			const stat = await safeStat(uri);
			if (!stat) {
				return undefined;
			}

			const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
			const isFile = (stat.type & vscode.FileType.File) !== 0;

			if (item.type === 'folder' && isDirectory) {
				return item;
			}

			if (item.type === 'file' && isFile) {
				return item;
			}

			return undefined;
		})
	);

	return checks.filter((item): item is ContextBridgeItem => item !== undefined);
}

async function countSelectionFiles(
	folder: vscode.WorkspaceFolder,
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[]
): Promise<number> {
	const files = await collectSelectionFilePaths(folder, items, excludeItems);
	return files.length;
}

async function collectSelectionFilePaths(
	folder: vscode.WorkspaceFolder,
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[]
): Promise<string[]> {
	const files = new Set<string>();

	for (const item of items) {
		if (!isSafeRelativePath(item.path)) {
			continue;
		}

		if (item.type === 'file') {
			const fileUri = toWorkspaceRelativeUri(folder.uri, item.path);
			const stat = await safeStat(fileUri);
			if (stat && (stat.type & vscode.FileType.File) !== 0) {
				files.add(item.path);
			}

			continue;
		}

		await collectFilesRecursively(folder.uri, item.path, excludeItems, files);
	}

	return [...files];
}

async function collectFilesRecursively(
	baseUri: vscode.Uri,
	relativeFolderPath: string,
	excludeItems: ContextBridgeItem[],
	output: Set<string>
): Promise<void> {
	const folderUri = toWorkspaceRelativeUri(baseUri, relativeFolderPath);

	try {
		const entries = await vscode.workspace.fs.readDirectory(folderUri);
		const sortedEntries = [...entries].sort(([leftName], [rightName]) =>
			leftName.localeCompare(rightName)
		);

		for (const [name, type] of sortedEntries) {
			const childRelativePath = normalizeRelativePath(
				relativeFolderPath.length > 0 ? `${relativeFolderPath}/${name}` : name
			);

			if (isExcludedFromFolderSelection(excludeItems, childRelativePath)) {
				continue;
			}

			if ((type & vscode.FileType.File) !== 0) {
				output.add(childRelativePath);
				continue;
			}

			if ((type & vscode.FileType.Directory) !== 0) {
				await collectFilesRecursively(baseUri, childRelativePath, excludeItems, output);
			}
		}
	} catch {
		// ignored
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

function toRelativeWorkspacePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string | undefined {
	if (folder.uri.scheme !== 'file' || uri.scheme !== 'file') {
		return undefined;
	}

	const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
	const normalized = normalizeRelativePath(relativePath);
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeRelativePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

function hasExactCollectionItem(items: ContextBridgeItem[], target: ContextBridgeItem): boolean {
	return items.some((item) => item.type === target.type && item.path === target.path);
}

function hasExactPathItem(items: ContextBridgeItem[], targetPath: string): boolean {
	return items.some((item) => item.path === targetPath);
}

function removeExactCollectionItem(items: ContextBridgeItem[], target: ContextBridgeItem): ContextBridgeItem[] {
	return items.filter((item) => !(item.type === target.type && item.path === target.path));
}

function addExcludeItem(excludeItems: ContextBridgeItem[], target: ContextBridgeItem): ContextBridgeItem[] {
	let nextExcludeItems = removeExactCollectionItem(excludeItems, target);

	if (target.type === 'folder') {
		nextExcludeItems = nextExcludeItems.filter((item) => !isDescendantPath(item.path, target.path));
	}

	return dedupeItems([...nextExcludeItems, target]);
}

function isIncludedViaFolder(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	resourcePath: string
): boolean {
	const includedByFolder = items.some(
		(item) => item.type === 'folder' && isSameOrDescendantPath(resourcePath, item.path)
	);

	return includedByFolder && !isExcludedFromFolderSelection(excludeItems, resourcePath);
}

function isExcludedFromFolderSelection(excludeItems: ContextBridgeItem[], resourcePath: string): boolean {
	return excludeItems.some((item) => {
		if (item.type === 'file') {
			return item.path === resourcePath;
		}

		return isSameOrDescendantPath(resourcePath, item.path);
	});
}

function hasDirectDescendantItem(items: ContextBridgeItem[], resourcePath: string): boolean {
	return items.some((item) => isDescendantPath(item.path, resourcePath));
}

function dedupeItems(items: ContextBridgeItem[]): ContextBridgeItem[] {
	const seen = new Set<string>();
	const uniqueItems: ContextBridgeItem[] = [];

	for (const item of items) {
		const key = `${item.type}:${item.path}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		uniqueItems.push(item);
	}

	return uniqueItems;
}

function isSameOrDescendantPath(candidatePath: string, parentPath: string): boolean {
	return candidatePath === parentPath || isDescendantPath(candidatePath, parentPath);
}

function isDescendantPath(candidatePath: string, parentPath: string): boolean {
	return candidatePath.startsWith(`${parentPath}/`);
}

export function isSafeRelativePath(targetPath: string): boolean {
	if (path.isAbsolute(targetPath)) {
		return false;
	}

	const normalized = normalizeRelativePath(targetPath);
	if (normalized.length === 0) {
		return false;
	}

	const segments = normalized.split('/').filter(Boolean);
	return !segments.some((segment) => segment === '..');
}

async function safeStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function getBaseName(targetPath: string): string {
	const normalized = targetPath.replace(/[\\/]+$/, '');
	return path.basename(normalized);
}

export function toWorkspaceRelativeUri(baseUri: vscode.Uri, relativePath: string): vscode.Uri {
	const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
	return vscode.Uri.joinPath(baseUri, ...segments);
}

export function toJsonBytes(value: unknown): Uint8Array {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	return Buffer.from(json, 'utf8');
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export async function isValidJsonFile(uri: vscode.Uri): Promise<boolean> {
	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		JSON.parse(Buffer.from(raw).toString('utf8'));
		return true;
	} catch {
		return false;
	}
}