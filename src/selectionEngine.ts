import * as path from 'path';
import * as vscode from 'vscode';

export const CONFIG_FILE_NAME = 'context-bridge.json';
export const EXPORT_FILE_NAME = 'export.json';
export const IMPORT_FILE_NAME = 'import.json';

export type ContextBridgeItemType = 'file' | 'folder';

export interface ContextBridgeItem {
	path: string;
	type: ContextBridgeItemType;
}

export interface ContextBridgeSelection {
	id: string;
	name: string;
	active: boolean;
	items: ContextBridgeItem[];
}

export interface ContextBridgeConfig {
	version: number;
	selections: ContextBridgeSelection[];
}

export interface SelectionSummary {
	selection: ContextBridgeSelection;
	fileCount: number;
}

export type SelectionMutationStatus =
	| 'added'
	| 'removed'
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
			const fileCount = await countSelectionFiles(folder, existingItems);

			summaries.push({
				selection: { ...selection, items: existingItems },
				fileCount,
			});
		}

		return summaries;
	}

	public async setSelectionActiveState(
		folder: vscode.WorkspaceFolder,
		selectionId: string,
		active: boolean
	): Promise<boolean> {
		const config = await this.readConfig(folder);
		if (!config) {
			return false;
		}

		let changed = false;
		const nextSelections = config.selections.map((selection) => {
			if (selection.id !== selectionId) {
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

		return this.mutateSelection(folder, selectionIndex, (items) => addItemToSelection(items, targetItem));
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

		return this.mutateSelection(folder, selectionIndex, (items) => removeItemFromSelection(items, targetItem));
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
			buildDecorationTooltip(memberships),
			new vscode.ThemeColor(
				activeMemberships.length > 0 ? 'list.highlightForeground' : 'disabledForeground'
			)
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
		mutate: (items: ContextBridgeItem[]) => SelectionItemsMutation
	): Promise<SelectionMutationResult> {
		const config = await this.readConfig(folder);
		if (!config) {
			return { status: 'configMissing' };
		}

		const selection = config.selections[selectionIndex];
		if (!selection) {
			return { status: 'selectionNotFound' };
		}

		const mutation = mutate(selection.items);
		if (!mutation.changed) {
			return { status: mutation.status, selectionName: selection.name };
		}

		const nextSelections = config.selections.map((current, index) =>
			index === selectionIndex ? { ...current, items: mutation.items } : current
		);

		await this.persistSelections(folder, config, nextSelections);

		return { status: mutation.status, selectionName: selection.name };
	}

	private async persistSelections(
		folder: vscode.WorkspaceFolder,
		config: ContextBridgeConfig,
		nextSelections: ContextBridgeSelection[]
	): Promise<void> {
		await writeContextBridgeConfig(folder, { ...config, selections: nextSelections });
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

function addItemToSelection(items: ContextBridgeItem[], target: ContextBridgeItem): SelectionItemsMutation {
	if (target.type === 'file') {
		if (items.some((item) => item.type === 'file' && item.path === target.path)) {
			return { changed: false, status: 'alreadySelected', items };
		}

		if (items.some((item) => item.type === 'folder' && isSameOrDescendantPath(target.path, item.path))) {
			return { changed: false, status: 'coveredByFolder', items };
		}

		return { changed: true, status: 'added', items: [...items, target] };
	}

	if (items.some((item) => item.type === 'folder' && isSameOrDescendantPath(target.path, item.path))) {
		return { changed: false, status: 'coveredByFolder', items };
	}

	const prunedItems = items.filter((item) => !isSameOrDescendantPath(item.path, target.path));
	return { changed: true, status: 'added', items: [...prunedItems, target] };
}

function removeItemFromSelection(items: ContextBridgeItem[], target: ContextBridgeItem): SelectionItemsMutation {
	const nextItems = items.filter((item) => !(item.type === target.type && item.path === target.path));

	if (nextItems.length !== items.length) {
		return { changed: true, status: 'removed', items: nextItems };
	}

	const coveredByFolder = items.some(
		(item) => item.type === 'folder' && isDescendantPath(target.path, item.path)
	);
	if (coveredByFolder) {
		return { changed: false, status: 'notDirectItem', items };
	}

	return { changed: false, status: 'notFound', items };
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
	let containsSelectedDescendant = false;

	for (const item of selection.items) {
		if (item.type === 'file') {
			if (!isFolder && item.path === resourcePath) {
				return 'direct';
			}

			if (isFolder && isDescendantPath(item.path, resourcePath)) {
				containsSelectedDescendant = true;
			}

			continue;
		}

		if (item.path === resourcePath) {
			return 'direct';
		}

		if (isSameOrDescendantPath(resourcePath, item.path)) {
			return 'insideSelectedFolder';
		}

		if (isFolder && isDescendantPath(item.path, resourcePath)) {
			containsSelectedDescendant = true;
		}
	}

	return containsSelectedDescendant ? 'containsSelectedDescendant' : undefined;
}

function buildDecorationBadge(memberships: ResourceMembershipInfo[]): string {
	if (memberships.length === 1) {
		return getSelectionBadge(memberships[0].selectionIndex);
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

		return `${membership.selection.name} (${state}) — ${mode}`;
	});

	return `Context Bridge\n${lines.join('\n')}`;
}

function getSelectionBadge(selectionIndex: number): string {
	const value = selectionIndex + 1;
	return value < 10 ? String(value) : '+';
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
		version: 1,
		selections: [1, 2, 3].map((index) => ({
			id: `selection-${index}`,
			name: `Выборка ${index}`,
			active: true,
			items: [],
		})),
	};
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

	return {
		id: typeof value.id === 'string' && value.id.trim().length > 0 ? value.id : `selection-${index + 1}`,
		name: typeof value.name === 'string' && value.name.trim().length > 0 ? value.name : `Выборка ${index + 1}`,
		active: typeof value.active === 'boolean' ? value.active : true,
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
		path: normalizeRelativePath(value.path),
		type: value.type,
	};
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

async function countSelectionFiles(folder: vscode.WorkspaceFolder, items: ContextBridgeItem[]): Promise<number> {
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

		await collectFilesRecursively(folder.uri, item.path, files);
	}

	return files.size;
}

async function collectFilesRecursively(
	baseUri: vscode.Uri,
	relativeFolderPath: string,
	output: Set<string>
): Promise<void> {
	const folderUri = toWorkspaceRelativeUri(baseUri, relativeFolderPath);

	try {
		const entries = await vscode.workspace.fs.readDirectory(folderUri);

		for (const [name, type] of entries) {
			const childRelativePath = normalizeRelativePath(
				relativeFolderPath.length > 0 ? `${relativeFolderPath}/${name}` : name
			);

			if ((type & vscode.FileType.File) !== 0) {
				output.add(childRelativePath);
				continue;
			}

			if ((type & vscode.FileType.Directory) !== 0) {
				await collectFilesRecursively(baseUri, childRelativePath, output);
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