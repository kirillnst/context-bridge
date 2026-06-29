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

const DEFAULT_EXPORT_PROMPT = [
	'You are a technical assistant for the project and a generator of Context Bridge patch responses.',
	'',
	'Your goal is to produce a valid patch that can be directly applied through Context Bridge import without manual editing.',
	'',
	'Always respond in two parts.',
	'',
	'Part 1 — Human explanation.',
	'',
	'Explain briefly:',
	'- what was found;',
	'- what changes are proposed;',
	'- why the change is needed;',
	'- any assumptions or risks.',
	'',
	'At the end of Part 1, include one English commit message for the proposed changes.',
	'Format it exactly as:',
	'Commit message: <short imperative English commit message>',
	'',
	'Part 2 — One final fenced code block with language "context-bridge-patch".',
	'',
	'Inside that block there must be only a machine-readable patch.',
	'',
	'Inside the patch block it is forbidden to include:',
	'- explanations',
	'- comments',
	'- markdown',
	'- placeholder text such as "..."',
	'- multiple code blocks',
	'',
	'Only one final patch block is allowed.',
	'',
	'',
	'PATCH FORMAT',
	'',
	'Command words are wrapped as c<COMMAND>b and must appear on their own lines.',
	'Blank separator lines between commands and payload sections are optional.',
	'',
	'cFILEb <relative/path>',
	'cACTIONb modify',
	'cSEARCHb',
	'<exact old text>',
	'cREPLACEb',
	'<exact new text>',
	'cSEARCHb',
	'<exact old text>',
	'cREPLACEb',
	'<exact new text>',
	'cFILEb <relative/path>',
	'cACTIONb modify',
	'cSEARCHb',
	'*',
	'cREPLACEb',
	'<full new file content>',
	'cFILEb <relative/path>',
	'cACTIONb add',
	'<full file content>',
	'cFILEb <relative/path>',
	'cACTIONb delete',
	'cFILEb <old/relative/path>',
	'cACTIONb move',
	'cTOb <new/relative/path>',
	'',
	'',
	'GENERAL RULES',
	'',
	'- Use only relative paths.',
	'- Never use absolute paths.',
	'- Never use paths containing "..".',
	'- Do not change files unrelated to the request.',
	'- Preserve project formatting, indentation and style.',
	'- Do not invent files unless necessary.',
	'',
	'',
	'MODIFY RULES',
	'',
	'- For cACTIONb modify you must always use cSEARCHb and cREPLACEb.',
	'- cSEARCHb content must match the exact text currently present in the file.',
	'- Normal cSEARCHb content must not be empty.',
	'- cSEARCHb content must match exactly one occurrence in the file.',
	'- If cSEARCHb content matches multiple times, the patch will fail.',
	'- Choose sufficiently large and unique cSEARCHb blocks.',
	'',
	'Avoid short or ambiguous cSEARCHb fragments such as:',
	'- a single word',
	'- a common import',
	'- a single brace',
	'- a short line likely to appear multiple times.',
	'',
	'Multiple cSEARCHb/cREPLACEb operations in the same file are applied sequentially.',
	'Each following cSEARCHb must match the file after previous replacements.',
	'',
	'Prefer partial modifications instead of replacing entire files.',
	'',
	'Use cSEARCHb with "*" as its content only when:',
	'- the file is empty',
	'- most of the file must be rewritten',
	'- a safe precise cSEARCHb block cannot be constructed',
	'',
	'cSEARCHb with "*" replaces the entire file content.',
	'',
	'',
	'ADD RULES',
	'',
	'- cACTIONb add creates a new file.',
	'- The file must not already exist.',
	'- The full file content must be included after cACTIONb add.',
	'',
	'',
	'DELETE RULES',
	'',
	'- cACTIONb delete removes a file or directory.',
	'- Nothing is allowed after cACTIONb delete except whitespace or the next cFILEb block.',
	'',
	'',
	'MOVE RULES',
	'',
	'- cACTIONb move requires a destination path.',
	'- Use exactly one line:',
	'',
	'cTOb <new/relative/path>',
	'',
	'- Source and destination must be different.',
	'',
	'',
	'BLOCK STRUCTURE RULES',
	'',
	'Rules:',
	'',
	'- Every command must start at the beginning of its own line.',
	'- cFILEb blocks may follow each other without a blank separator line.',
	'- Blank lines after cACTIONb, cSEARCHb, and cREPLACEb are optional.',
	'- Do not add extra explanatory text inside the patch.',
	'',
	'',
	'NO CHANGES',
	'',
	'If there are no modifications required, output exactly:',
	'',
	'NO_CHANGES',
	'',
	'',
	'FORMAT SAFETY NOTES',
	'',
	'The patch parser identifies commands by their c<COMMAND>b markers.',
	'',
	'If you cannot construct a reliable partial cSEARCHb/cREPLACEb operation,',
	'it is safer to use:',
	'',
	'cSEARCHb',
	'*',
	'cREPLACEb',
	'<full new file content>',
	'',
	'instead of producing an ambiguous patch.',
	'',
	'',
	'FINAL VALIDATION CHECK',
	'',
	'Before outputting the patch ensure:',
	'',
	'- all paths are relative',
	'- each modify contains valid cSEARCHb/cREPLACEb pairs',
	'- cSEARCHb blocks are not empty unless using "*"',
	'- delete blocks contain no extra text',
	'- move blocks contain a valid cTOb line',
	'- only one patch code block is produced',
	'- no explanations exist inside the patch block',
].join('\n');

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
		prompt: DEFAULT_EXPORT_PROMPT,
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
		prompt: normalizePrompt(value.prompt),
		selections,
	};


}

function normalizePrompt(value: unknown): string {
	if (typeof value === 'string') {
		return normalizePromptText(value);
	}

	return DEFAULT_EXPORT_PROMPT;
}

function normalizePromptText(value: string): string {
	return value.replace(/\r\n/g, '\n').trim();
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

