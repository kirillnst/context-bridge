import * as vscode from 'vscode';
import {
	CONFIG_DIRECTORY_NAME,
	CONFIG_FILE_PATH,
	type ContextBridgeConfig,
	type ContextBridgeItem,
	type ContextBridgeSelection,
} from './types';
import {
	isSafeRelativePath,
	normalizeRelativePath,
	toJsonBytes,
	toWorkspaceRelativeUri,
} from './pathUtils';
import { dedupeItems } from './selectionRules';

export async function readContextBridgeConfig(
	folder: vscode.WorkspaceFolder
): Promise<ContextBridgeConfig | undefined> {
	const configUri = toWorkspaceRelativeUri(folder.uri, CONFIG_FILE_PATH);

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
	await vscode.workspace.fs.createDirectory(
		toWorkspaceRelativeUri(folder.uri, CONFIG_DIRECTORY_NAME)
	);

	const configUri = toWorkspaceRelativeUri(folder.uri, CONFIG_FILE_PATH);
	await vscode.workspace.fs.writeFile(configUri, toJsonBytes(config));
}

export function createDefaultConfig(): ContextBridgeConfig {
	return {
		version: 2,
		selections: [],
	};
}

function normalizeConfig(value: unknown): ContextBridgeConfig | undefined {
	if (!isRecord(value) || !Array.isArray(value.selections)) {
		return undefined;
	}

	const selections = value.selections
		.map((selection, index) => normalizeSelection(selection, index))
		.filter((selection): selection is ContextBridgeSelection => selection !== undefined);

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
		typeof value.name === 'string' && value.name.trim().length > 0
			? value.name.trim()
			: fallbackName;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

