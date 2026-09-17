import * as vscode from 'vscode';
import {
	CONFIG_DIRECTORY_NAME,
	CONFIG_FILE_PATH,
	NO_EXTENSION_MARKER,
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

const DEFAULT_IGNORE_CONTENT_EXTENSIONS = [
	NO_EXTENSION_MARKER,
	'.3ds',
	'.7z',
	'.a',
	'.apk',
	'.avi',
	'.bin',
	'.blend',
	'.bmp',
	'.bz2',
	'.cab',
	'.class',
	'.db',
	'.deb',
	'.dll',
	'.dmg',
	'.doc',
	'.docx',
	'.eot',
	'.exe',
	'.fbx',
	'.flac',
	'.gif',
	'.glb',
	'.gz',
	'.ico',
	'.iso',
	'.jar',
	'.jpeg',
	'.jpg',
	'.lib',
	'.m4a',
	'.mkv',
	'.mov',
	'.mp3',
	'.mp4',
	'.msi',
	'.node',
	'.o',
	'.ogg',
	'.otf',
	'.pak',
	'.pdf',
	'.png',
	'.ppt',
	'.pptx',
	'.psd',
	'.pyc',
	'.pyd',
	'.rar',
	'.rpm',
	'.so',
	'.sqlite',
	'.tar',
	'.tgz',
	'.tif',
	'.tiff',
	'.ttf',
	'.wav',
	'.wasm',
	'.webm',
	'.webp',
	'.woff',
	'.woff2',
	'.xls',
	'.xlsx',
	'.xz',
	'.zip',
] as const;

const DEFAULT_EXPORT_PROMPT = [
	'You are a technical assistant for the project and a generator of Context Bridge patch responses.',
	'',
	'Your goal is to produce a valid patch that can be directly applied through Context Bridge import without manual editing.',
	'',
	'Correctness has higher priority than producing a patch.',
	'Do not commit to the first plausible solution. Investigate, compare, challenge, then patch.',
	'',
	'Perform the following execution harness silently before producing the final response.',
	'Do not expose internal reasoning, scratch work, hidden analysis, or step-by-step thought process.',
	'Only expose the concise conclusions required by Part 1 and the final machine-readable patch.',
	'',
	'SILENT MULTI-PASS REVIEW',
	'',
	'The first plausible solution is never considered final for a non-trivial task.',
	'',
	'For every non-trivial task:',
	'- perform at least one independent review after constructing the proposed solution;',
	'- review the solution from a different perspective than the one primarily used to create it;',
	'- actively search for evidence, edge cases, dependencies, or assumptions that could make the chosen solution wrong;',
	'- consider whether an alternative implementation would be simpler, safer, or more consistent with the existing architecture;',
	'- revise the solution whenever the review identifies a material weakness or a stronger implementation;',
	'- repeat verification after every material revision before producing the final response.',
	'',
	'All review passes are internal and silent.',
	'Do not describe the review process, hidden alternatives, or internal deliberation in the final response.',
	'Report only conclusions, relevant assumptions or risks, and the final patch.',
	'',
	'PASS 1 — INVESTIGATE',
	'',
	'- Identify the actual requested behavior, not only the literal wording.',
	'- Determine which provided files are relevant before deciding what to change.',
	'- Separate required changes from optional improvements.',
	'- Do not solve unrelated problems unless doing so is necessary for correctness.',
	'- Read all relevant provided code before committing to an implementation.',
	'- Trace related types, callers, imports, data flow, state transitions, and invariants when they can affect the requested change.',
	'- Prefer evidence from the supplied project context over assumptions.',
	'- Do not assume an API, function, file, dependency, symbol, or behavior exists unless the supplied context supports it.',
	'',
	'PASS 2 — IMPLEMENT',
	'',
	'- For a non-trivial task, consider at least two plausible implementation approaches before choosing one.',
	'- Compare plausible approaches for correctness, simplicity, consistency with the existing architecture, regression risk, amount of unrelated code touched, maintainability, and patch reliability.',
	'- Choose the smallest approach that fully satisfies the request without creating avoidable technical debt.',
	'- Preserve existing project conventions and reuse existing abstractions when appropriate.',
	'- Construct the patch only after the implementation approach has been selected and challenged.',
	'- Make every proposed change traceable to the requested behavior or to a requirement necessary for correctness.',
	'',
	'PASS 3 — VERIFY',
	'',
	'- Review the chosen implementation adversarially rather than trying to justify it.',
	'- Look for incorrect assumptions, missed callers or dependencies, edge cases, inconsistent state, partial updates, ordering problems, error-handling regressions, unintended behavior changes, duplicated logic, unnecessary abstractions, and convention mismatches.',
	'- Treat implementation correctness and patch applicability as two independent requirements.',
	'- For implementation correctness, verify that the resulting project state satisfies the original request and that all changed files remain mutually consistent.',
	'- For patch applicability, verify every target path, action, cSEARCHb block, cREPLACEb block, and operation ordering against the supplied project state.',
	'- Verify that each normal cSEARCHb is exact and matches exactly one occurrence at the moment that operation will be applied.',
	'- Account for earlier replacements in the same file before validating later cSEARCHb blocks.',
	'- Mentally simulate all patch operations in their exact order.',
	'- Review the complete resulting project state after the simulated patch, not only each edit in isolation.',
	'- Check for stale references, missing imports, incompatible types, obvious syntax problems, obvious compile-time problems, and obvious runtime regressions that can be inferred from the supplied context.',
	'- Check whether every changed file is necessary and whether a smaller safe patch could achieve the same result.',
	'- If verification reveals a problem, revise the implementation or patch and run the verification pass again before responding.',
	'',
	'If the provided context is insufficient for a safe requested change, do not invent the missing context.',
	'Make only changes that can be justified from the supplied project context and state the limitation briefly in Part 1.',
	'If no code change is actually required, use NO_CHANGES according to the rules below.',
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
	'- the original requested behavior is fully addressed',
	'- the first plausible solution was not accepted without an independent review for non-trivial tasks',
	'- the solution was challenged from at least one different perspective before finalization',
	'- any material revision was followed by another verification pass',
	'- the implementation is supported by the supplied project context rather than invented assumptions',
	'- every changed file is necessary for the requested behavior or correctness',
	'- the resulting code is internally consistent across affected files',
	'- obvious stale references, missing imports, type inconsistencies, syntax problems, ordering issues, and regression risks have been checked',
	'- implementation correctness and patch applicability have been checked independently',
	'- all patch operations have been mentally simulated in their exact application order',
	'- all paths are relative',
	'- each modify contains valid cSEARCHb/cREPLACEb pairs',
	'- every normal cSEARCHb is exact and matches exactly one occurrence at the moment it is applied',
	'- later cSEARCHb blocks account for all earlier replacements in the same file',
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
		ignoreContentExtensions: [...DEFAULT_IGNORE_CONTENT_EXTENSIONS],
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
		ignoreContentExtensions: normalizeIgnoreContentExtensions(value.ignoreContentExtensions),
		selections,
	};
}

function normalizeIgnoreContentExtensions(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [...DEFAULT_IGNORE_CONTENT_EXTENSIONS];
	}

	const normalized = value
		.filter((extension): extension is string => typeof extension === 'string')
		.map((extension) => normalizeIgnoreContentExtension(extension))
		.filter((extension): extension is string => extension !== undefined);

	return [...new Set(normalized)];
}

function normalizeIgnoreContentExtension(value: string): string | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) {
		return undefined;
	}

	if (normalized === NO_EXTENSION_MARKER) {
		return NO_EXTENSION_MARKER;
	}

	if (normalized.includes('/') || normalized.includes('\\')) {
		return undefined;
	}

	const extension = normalized.startsWith('.') ? normalized : `.${normalized}`;
	return extension === '.' ? undefined : extension;
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

