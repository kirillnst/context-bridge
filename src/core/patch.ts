import * as path from 'path';import * as vscode from 'vscode';
import type { ContextBridgeImportSummary } from './types';
import {
	fileExists,
	isSafeRelativePath,
	normalizeRelativePath,
	toWorkspaceRelativeUri,
} from './pathUtils';

type ContextBridgePatchAction = 'modify' | 'add' | 'delete' | 'move';

interface ContextBridgePatchSearchReplace {
	search: string;
	replace: string;
}

interface ParsedContextBridgePatchFile {
	path: string;
	action: ContextBridgePatchAction;
	operations?: ContextBridgePatchSearchReplace[];
	content?: string;
	to?: string;
}

interface ContextBridgePatchSyntax {
	file: string;
	action: string;
	search: string;
	replace: string;
	to: string;
}

const PATCH_SYNTAX: ContextBridgePatchSyntax = {
	file: 'cFILEb',
	action: 'cACTIONb',
	search: 'cSEARCHb',
	replace: 'cREPLACEb',
	to: 'cTOb',
};

export class ContextBridgeImportError extends Error {
	constructor(
		message: string,
		public readonly summary: ContextBridgeImportSummary
	) {
		super(message);
		this.name = 'ContextBridgeImportError';
	}
}

export async function importContextBridgePatch(
	folder: vscode.WorkspaceFolder,
	rawPatchDocument: string
): Promise<ContextBridgeImportSummary> {
	const patchContent = extractPatchContent(rawPatchDocument);
	const summary = createEmptyImportSummary();

	if (patchContent.trim() === 'NO_CHANGES') {
		return summary;
	}

	const patchFiles = parseContextBridgePatch(patchContent);

	try {
		for (const patchFile of patchFiles) {
			await applyContextBridgePatchFile(folder, patchFile, summary);
		}

		return summary;
	} catch (error) {
		if (error instanceof ContextBridgeImportError) {
			throw error;
		}

		throw new ContextBridgeImportError(toImportErrorMessage(error), summary);
	}
}

function createEmptyImportSummary(): ContextBridgeImportSummary {
	return {
		added: 0,
		modified: 0,
		deleted: 0,
		moved: 0,
	};
}

function extractPatchContent(value: string): string {
	const normalized = normalizeExportText(value);
	const fencedMatch = normalized.match(
		/^(`{3,})context-bridge-patch(?:[^\n]*)\n([\s\S]*?)^\1\s*$/m
	);

	if (fencedMatch) {
		return fencedMatch[2];
	}

	const trimmed = normalized.trim();
	if (trimmed === 'NO_CHANGES') {
		return 'NO_CHANGES';
	}

	const firstFileMatch = findFileMatches(normalized, PATCH_SYNTAX)[0];
	if (typeof firstFileMatch?.index === 'number') {
		return normalized.slice(firstFileMatch.index);
	}

	return trimmed;
}

function parseContextBridgePatch(value: string): ParsedContextBridgePatchFile[] {
	const matches = findFileMatches(value, PATCH_SYNTAX);
	if (matches.length === 0) {
		throw new Error(`no ${PATCH_SYNTAX.file} blocks were found.`);
	}

	return matches.map((match, index) => {
		const filePath = (match[1] ?? '').trim();
		if (filePath.length === 0) {
			throw new Error(`empty path in ${PATCH_SYNTAX.file} block #${index + 1}.`);
		}

		const blockStart = (match.index ?? 0) + match[0].length;
		const blockEnd = matches[index + 1]?.index ?? value.length;
		const blockBody = value.slice(blockStart, blockEnd);

		return parseContextBridgePatchFile(
			filePath,
			blockBody,
			PATCH_SYNTAX,
			index < matches.length - 1
		);
	});
}

function parseContextBridgePatchFile(
	filePath: string,
	blockBody: string,
	syntax: ContextBridgePatchSyntax,
	hasFollowingFile: boolean
): ParsedContextBridgePatchFile {
	let cursor = consumeBlankLines(blockBody, 0);
	const actionLine = readPatchLine(blockBody, cursor);
	const actionValue = readCommandValue(actionLine.line, syntax.action);

	if (actionValue === undefined) {
		throw new Error(`${syntax.action} was not found for "${filePath}".`);
	}

	const action = actionValue as ContextBridgePatchAction;
	cursor = actionLine.next;

	switch (action) {
		case 'modify': {
			const operations = parseModifyOperations(
				blockBody.slice(cursor),
				syntax,
				hasFollowingFile
			);

			if (operations.length === 0) {
				throw new Error(
					`no ${syntax.search}/${syntax.replace} blocks were found for "${filePath}".`
				);
			}

			return {
				path: filePath,
				action,
				operations,
			};
		}

		case 'add': {
			const contentStart = consumeOptionalBlankLine(blockBody, cursor);
			const content = blockBody.slice(contentStart);

			return {
				path: filePath,
				action,
				content: hasFollowingFile ? trimCommandGap(content) : content,
			};
		}

		case 'delete': {
			if (blockBody.slice(cursor).trim().length > 0) {
				throw new Error(
					`${syntax.action} delete for "${filePath}" must not contain any extra text.`
				);
			}

			return {
				path: filePath,
				action,
			};
		}

		case 'move': {
			cursor = consumeBlankLines(blockBody, cursor);
			const toLine = readPatchLine(blockBody, cursor);
			const to = readCommandValue(toLine.line, syntax.to);

			if (to === undefined) {
				throw new Error(`${syntax.to} was not found for "${filePath}".`);
			}

			if (blockBody.slice(toLine.next).trim().length > 0) {
				throw new Error(
					`${syntax.action} move for "${filePath}" contains extra text after ${syntax.to}.`
				);
			}

			if (to.length === 0) {
				throw new Error(`${syntax.to} destination path is empty for "${filePath}".`);
			}

			return {
				path: filePath,
				action,
				to,
			};
		}

		default:
			throw new Error(`unsupported ${syntax.action} for "${filePath}": ${actionValue}.`);
	}
}

function parseModifyOperations(
	value: string,
	syntax: ContextBridgePatchSyntax,
	trimTrailingFileGap: boolean
): ContextBridgePatchSearchReplace[] {
	const operations: ContextBridgePatchSearchReplace[] = [];
	let cursor = consumeBlankLines(value, 0);

	while (cursor < value.length) {
		const searchLine = readPatchLine(value, cursor);
		if (searchLine.line.trimEnd() !== syntax.search) {
			throw new Error(`expected a ${syntax.search} block.`);
		}

		const searchStart = consumeOptionalBlankLine(value, searchLine.next);
		const replaceCommand = findCommandLine(value, syntax.replace, searchStart);
		if (!replaceCommand) {
			throw new Error(`${syntax.replace} block was not found for ${syntax.search}.`);
		}

		const search = trimCommandGap(value.slice(searchStart, replaceCommand.index));
		const replaceStart = consumeOptionalBlankLine(value, replaceCommand.next);
		const nextSearchCommand = findCommandLine(value, syntax.search, replaceStart);

		if (!nextSearchCommand) {
			const replace = value.slice(replaceStart);
			operations.push({
				search,
				replace: trimTrailingFileGap ? trimCommandGap(replace) : replace,
			});
			break;
		}

		operations.push({
			search,
			replace: trimCommandGap(value.slice(replaceStart, nextSearchCommand.index)),
		});
		cursor = nextSearchCommand.index;
	}

	return operations;
}



function findFileMatches(value: string, syntax: ContextBridgePatchSyntax): RegExpMatchArray[] {
	const pattern = new RegExp(`^${escapeRegExp(syntax.file)}[ \\t]+(.+)$`, 'gm');
	return [...value.matchAll(pattern)];
}

function findCommandLine(
	value: string,
	command: string,
	startIndex: number
): { index: number; next: number } | undefined {
	const pattern = new RegExp(`^${escapeRegExp(command)}[ \\t]*$`, 'gm');
	pattern.lastIndex = startIndex;
	const match = pattern.exec(value);

	if (!match || typeof match.index !== 'number') {
		return undefined;
	}

	const lineEnd = match.index + match[0].length;
	return {
		index: match.index,
		next: value[lineEnd] === '\n' ? lineEnd + 1 : lineEnd,
	};
}

function readCommandValue(line: string, command: string): string | undefined {
	if (!line.startsWith(command)) {
		return undefined;
	}

	const rest = line.slice(command.length);
	if (!/^[ \t]+/.test(rest)) {
		return undefined;
	}

	return rest.trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyPatchModifyOperations(
	value: string,
	operations: ContextBridgePatchSearchReplace[]
): string {
	let nextValue = value;

	for (const [index, operation] of operations.entries()) {
		if (operation.search === '*') {
			nextValue = operation.replace;
			continue;
		}

		if (operation.search.length === 0) {
			throw new Error(`Search block #${index + 1} is empty.`);
		}

		const matches = countExactMatches(nextValue, operation.search);
		if (matches === 0) {
			throw new Error(`Search block #${index + 1} was not found exactly.`);
		}

		if (matches > 1) {
			throw new Error(
				`Search block #${index + 1} was found ${matches} time(s); replacement is ambiguous.`
			);
		}

		nextValue = replaceSingleMatch(nextValue, operation.search, operation.replace);
	}

	return nextValue;
}

async function applyContextBridgePatchFile(
	folder: vscode.WorkspaceFolder,
	patchFile: ParsedContextBridgePatchFile,
	summary: ContextBridgeImportSummary
): Promise<void> {
	const sourcePath = normalizeRelativePath(patchFile.path);
	if (!isSafeRelativePath(sourcePath)) {
		throw new Error(`invalid path "${patchFile.path}".`);
	}

	try {
		switch (patchFile.action) {
			case 'modify': {
				const targetUri = toWorkspaceRelativeUri(folder.uri, sourcePath);
				ensureDocumentNotDirty(targetUri, sourcePath);

				const stat = await safeFileStat(targetUri);
				if (!stat || (stat.type & vscode.FileType.File) === 0) {
					throw new Error(`file "${sourcePath}" for modify was not found.`);
				}

				const currentContent = await readTextFile(targetUri);
				if (currentContent === undefined) {
					throw new Error(`failed to read "${sourcePath}".`);
				}

				const nextContent = applyPatchModifyOperations(
					normalizeExportText(currentContent),
					patchFile.operations ?? []
				);
				const eol = detectLineEnding(currentContent);

				await vscode.workspace.fs.writeFile(
					targetUri,
					Buffer.from(applyLineEnding(nextContent, eol), 'utf8')
				);

				summary.modified += 1;
				return;
			}

			case 'add': {
				const targetUri = toWorkspaceRelativeUri(folder.uri, sourcePath);
				ensureDocumentNotDirty(targetUri, sourcePath);

				if (await fileExists(targetUri)) {
					throw new Error(`file "${sourcePath}" already exists.`);
				}

				await ensureParentDirectory(folder.uri, sourcePath);
				await vscode.workspace.fs.writeFile(
					targetUri,
					Buffer.from(patchFile.content ?? '', 'utf8')
				);

				summary.added += 1;
				return;
			}

			case 'delete': {
				const targetUri = toWorkspaceRelativeUri(folder.uri, sourcePath);
				ensureDocumentNotDirty(targetUri, sourcePath);

				const stat = await safeFileStat(targetUri);
				if (!stat) {
					throw new Error(`path "${sourcePath}" for delete was not found.`);
				}

				await vscode.workspace.fs.delete(targetUri, {
					recursive: (stat.type & vscode.FileType.Directory) !== 0,
					useTrash: false,
				});

				summary.deleted += 1;
				return;
			}

			case 'move': {
				const destinationPath = normalizeRelativePath(patchFile.to ?? '');
				if (!isSafeRelativePath(destinationPath)) {
					throw new Error(`invalid destination path "${patchFile.to ?? ''}".`);
				}

				if (destinationPath === sourcePath) {
					throw new Error(
						`source and destination paths are the same: "${sourcePath}".`
					);
				}

				const sourceUri = toWorkspaceRelativeUri(folder.uri, sourcePath);
				const destinationUri = toWorkspaceRelativeUri(folder.uri, destinationPath);

				ensureDocumentNotDirty(sourceUri, sourcePath);
				ensureDocumentNotDirty(destinationUri, destinationPath);

				if (!(await fileExists(sourceUri))) {
					throw new Error(`path "${sourcePath}" for move was not found.`);
				}

				if (await fileExists(destinationUri)) {
					throw new Error(`destination path "${destinationPath}" already exists.`);
				}

				await ensureParentDirectory(folder.uri, destinationPath);
				await vscode.workspace.fs.rename(sourceUri, destinationUri, { overwrite: false });

				summary.moved += 1;
				return;
			}
		}
	} catch (error) {
		throw new Error(`"${sourcePath}": ${toImportErrorMessage(error)}`);
	}
}

function countExactMatches(value: string, search: string): number {
	if (search.length === 0) {
		return 0;
	}

	let count = 0;
	let cursor = 0;

	while (cursor <= value.length) {
		const matchIndex = value.indexOf(search, cursor);
		if (matchIndex < 0) {
			break;
		}

		count += 1;
		cursor = matchIndex + search.length;
	}

	return count;
}

function replaceSingleMatch(value: string, search: string, replace: string): string {
	const matchIndex = value.indexOf(search);
	if (matchIndex < 0) {
		return value;
	}

	return value.slice(0, matchIndex) + replace + value.slice(matchIndex + search.length);
}

function readPatchLine(value: string, startIndex: number): { line: string; next: number } {
	if (startIndex >= value.length) {
		return {
			line: '',
			next: value.length,
		};
	}

	const lineEnd = value.indexOf('\n', startIndex);
	if (lineEnd < 0) {
		return {
			line: value.slice(startIndex),
			next: value.length,
		};
	}

	return {
		line: value.slice(startIndex, lineEnd),
		next: lineEnd + 1,
	};
}

function consumeBlankLines(value: string, startIndex: number): number {
	let cursor = startIndex;

	while (cursor < value.length) {
		const line = readPatchLine(value, cursor);
		if (line.line.trim().length > 0) {
			break;
		}

		cursor = line.next;
	}

	return cursor;
}

function consumeOptionalBlankLine(value: string, startIndex: number): number {
	const line = readPatchLine(value, startIndex);
	return line.line.trim().length === 0 ? line.next : startIndex;
}

function trimCommandGap(value: string): string {
	let end = value.length;

	if (end > 0 && value[end - 1] === '\n') {
		end -= 1;
	}

	const withoutLineBreak = value.slice(0, end);
	const lastLineStart = withoutLineBreak.lastIndexOf('\n') + 1;
	if (withoutLineBreak.slice(lastLineStart).trim().length === 0) {
		return withoutLineBreak.slice(0, Math.max(0, lastLineStart - 1));
	}

	return withoutLineBreak;
}

function ensureDocumentNotDirty(uri: vscode.Uri, relativePath: string): void {
	const document = vscode.workspace.textDocuments.find(
		(candidate) => candidate.uri.toString() === uri.toString()
	);

	if (document?.isDirty) {
		throw new Error(`save or revert unsaved changes in "${relativePath}".`);
	}
}

async function readTextFile(uri: vscode.Uri): Promise<string | undefined> {
	const openDocument = vscode.workspace.textDocuments.find(
		(candidate) => candidate.uri.toString() === uri.toString()
	);

	if (openDocument) {
		return openDocument.getText();
	}

	try {
		const raw = await vscode.workspace.fs.readFile(uri);
		return Buffer.from(raw).toString('utf8');
	} catch {
		return undefined;
	}
}

async function ensureParentDirectory(
	baseUri: vscode.Uri,
	relativePath: string
): Promise<void> {
	const parentPath = path.posix.dirname(relativePath);
	if (parentPath === '.' || parentPath.length === 0) {
		return;
	}

	await vscode.workspace.fs.createDirectory(toWorkspaceRelativeUri(baseUri, parentPath));
}

function detectLineEnding(value: string): '\n' | '\r\n' {
	return value.includes('\r\n') ? '\r\n' : '\n';
}

function applyLineEnding(value: string, lineEnding: '\n' | '\r\n'): string {
	return lineEnding === '\n' ? value : value.replace(/\n/g, '\r\n');
}

function normalizeExportText(value: string): string {
	return value.replace(/\r\n/g, '\n');
}

function toImportErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'unknown error.';
}

async function safeFileStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}