import * as vscode from 'vscode';
import { readContextBridgeConfig } from './config';
import {
	isSafeRelativePath,
	normalizeLineEndings,
	normalizeRelativePath,
	safeStat,
	toWorkspaceRelativeUri,
} from './pathUtils';
import { isExcludedFromFolderSelection } from './selectionRules';
import {
	NO_EXTENSION_MARKER,
	type ContextBridgeConfig,
	type ContextBridgeExportFile,
	type ContextBridgeItem,
} from './types';

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

export async function countSelectionFiles(
	folder: vscode.WorkspaceFolder,
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[]
): Promise<number> {
	const files = await collectSelectionFilePaths(folder, items, excludeItems);
	return files.length;
}

export async function collectActiveExportPaths(
	folder: vscode.WorkspaceFolder,
	config: ContextBridgeConfig
): Promise<Set<string>> {
	const exportedPaths = new Set<string>();

	for (const selection of config.selections) {
		if (!selection.active) {
			continue;
		}

		const existingItems = await filterExistingItems(folder, selection.items);
		const existingExcludeItems = await filterExistingItems(folder, selection.excludeItems);
		const filePaths = await collectSelectionFilePaths(folder, existingItems, existingExcludeItems);
		for (const filePath of filePaths) {
			exportedPaths.add(filePath);
		}
	}

	return exportedPaths;
}

export async function collectExportFiles(
	folder: vscode.WorkspaceFolder,
	config?: ContextBridgeConfig
): Promise<ContextBridgeExportFile[]> {
	config ??= await readContextBridgeConfig(folder);
	if (!config) {
		return [];
	}

	const exportedPaths = await collectActiveExportPaths(folder, config);
	const files: ContextBridgeExportFile[] = [];

	for (const filePath of exportedPaths) {
		if (shouldIgnoreFileContent(filePath, config.ignoreContentExtensions)) {
			files.push({ path: filePath });
			continue;
		}

		const fileUri = toWorkspaceRelativeUri(folder.uri, filePath);
		try {
			const raw = await vscode.workspace.fs.readFile(fileUri);
			files.push({
				path: filePath,
				content: Buffer.from(raw).toString('utf8'),
			});
		} catch {
			files.push({ path: filePath });
		}
	}

	return files;
}

export function buildExportDocument(
	files: ContextBridgeExportFile[],
	prompt?: string
): string {
	const promptSection = normalizeLineEndings(prompt ?? '').trim();
	const fileSections = files.map((file) =>
		file.content === undefined
			? `FILE: ${file.path}`
			: `FILE: ${file.path}\n\nCONTENT:\n${normalizeLineEndings(file.content)}`
	);

	return [promptSection, ...fileSections]
		.filter((section) => section.length > 0)
		.join('\n\n');
}

export function getFileContentExtension(filePath: string): string {
	const fileName = filePath.split('/').pop()?.toLowerCase() ?? '';
	const lastDotIndex = fileName.lastIndexOf('.');
	return lastDotIndex > 0 && lastDotIndex < fileName.length - 1
		? fileName.slice(lastDotIndex)
		: NO_EXTENSION_MARKER;
}

export function shouldIgnoreFileContent(filePath: string, ignoreContentExtensions: string[]): boolean {
	const extension = getFileContentExtension(filePath);
	if (extension === NO_EXTENSION_MARKER) {
		return ignoreContentExtensions.includes(NO_EXTENSION_MARKER);
	}

	const fileName = filePath.split('/').pop()?.toLowerCase() ?? '';
	return ignoreContentExtensions.some(
		(ignoredExtension) => ignoredExtension !== NO_EXTENSION_MARKER && fileName.endsWith(ignoredExtension)
	);
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

