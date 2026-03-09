import * as path from 'path';
import * as vscode from 'vscode';
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
	const fencedMatch = normalized.match(/```context-bridge-patch\s*\n([\s\S]*?)\n```/);

	if (fencedMatch) {
		return fencedMatch[1];
	}

	const noChangesMatch = normalized.match(/^\s*NO_CHANGES\s*$/m);
	if (noChangesMatch) {
		return 'NO_CHANGES';
	}

	const firstFileMatch = normalized.match(/^FILE:\s+/m);
	if (typeof firstFileMatch?.index === 'number') {
		return normalized.slice(firstFileMatch.index);
	}

	return normalized.trim();
}

function parseContextBridgePatch(value: string): ParsedContextBridgePatchFile[] {
	const matches = [...value.matchAll(/^FILE:\s+(.+)$/gm)];
	if (matches.length === 0) {
		throw new Error('no FILE blocks were found.');
	}

	return matches.map((match, index) => {
		const filePath = (match[1] ?? '').trim();
		if (filePath.length === 0) {
			throw new Error(`empty path in FILE block #${index + 1}.`);
		}

		const blockStart = (match.index ?? 0) + match[0].length;
		const blockEnd = matches[index + 1]?.index ?? value.length;
		const blockBody = value.slice(blockStart, blockEnd);

		return parseContextBridgePatchFile(filePath, blockBody);
	});
}

function parseContextBridgePatchFile(
	filePath: string,
	blockBody: string
): ParsedContextBridgePatchFile {
	let cursor = blockBody.startsWith('\n') ? 1 : 0;
	const actionLine = readPatchLine(blockBody, cursor);
	const actionPrefix = 'ACTION: ';

	if (!actionLine.line.startsWith(actionPrefix)) {
		throw new Error(`ACTION was not found for "${filePath}".`);
	}

	const action = actionLine.line.slice(actionPrefix.length).trim() as ContextBridgePatchAction;
	cursor = actionLine.next;

	switch (action) {
		case 'modify': {
			cursor = consumeSectionSeparator(blockBody, cursor);
			const operations = parseModifyOperations(blockBody.slice(cursor));

			if (operations.length === 0) {
				throw new Error(`no SEARCH/REPLACE blocks were found for "${filePath}".`);
			}

			return {
				path: filePath,
				action,
				operations,
			};
		}

		case 'add':
			return {
				path: filePath,
				action,
				content: blockBody.slice(consumeSectionSeparator(blockBody, cursor)),
			};

		case 'delete': {
			if (blockBody.slice(cursor).trim().length > 0) {
				throw new Error(`ACTION: delete for "${filePath}" must not contain any extra text.`);
			}

			return {
				path: filePath,
				action,
			};
		}

		case 'move': {
			cursor = consumeSectionSeparator(blockBody, cursor);
			const toLine = readPatchLine(blockBody, cursor);

			if (!toLine.line.startsWith('TO: ')) {
				throw new Error(`TO was not found for "${filePath}".`);
			}

			if (blockBody.slice(toLine.next).trim().length > 0) {
				throw new Error(`ACTION: move for "${filePath}" contains extra text after TO.`);
			}

			const to = toLine.line.slice('TO: '.length).trim();
			if (to.length === 0) {
				throw new Error(`TO destination path is empty for "${filePath}".`);
			}

			return {
				path: filePath,
				action,
				to,
			};
		}

		default:
			throw new Error(
				`unsupported ACTION for "${filePath}": ${actionLine.line.slice(actionPrefix.length).trim()}.`
			);
	}
}

function parseModifyOperations(value: string): ContextBridgePatchSearchReplace[] {
	if (value.length === 0) {
		return [];
	}

	const operations: ContextBridgePatchSearchReplace[] = [];
	let remaining = value;

	while (remaining.length > 0) {
		if (!remaining.startsWith('SEARCH:\n')) {
			throw new Error('expected a SEARCH block.');
		}

		remaining = remaining.slice('SEARCH:\n'.length);

		const replaceMarker = remaining.indexOf('\n\nREPLACE:\n');
		if (replaceMarker < 0) {
			throw new Error('REPLACE block was not found for SEARCH.');
		}

		const search = remaining.slice(0, replaceMarker);
		remaining = remaining.slice(replaceMarker + '\n\nREPLACE:\n'.length);

		const nextSearchMarker = remaining.indexOf('\n\nSEARCH:\n');
		if (nextSearchMarker < 0) {
			operations.push({
				search,
				replace: remaining,
			});
			break;
		}

		operations.push({
			search,
			replace: remaining.slice(0, nextSearchMarker),
		});

		remaining = remaining.slice(nextSearchMarker + 2);
	}

	return operations;
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
			throw new Error(`SEARCH #${index + 1} is empty.`);
		}

		const matches = countExactMatches(nextValue, operation.search);
		if (matches === 0) {
			throw new Error(`SEARCH #${index + 1} was not found exactly.`);
		}

		if (matches > 1) {
			throw new Error(
				`SEARCH #${index + 1} was found ${matches} time(s); replacement is ambiguous.`
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

function consumeSectionSeparator(value: string, startIndex: number): number {
	return value[startIndex] === '\n' ? startIndex + 1 : startIndex;
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