import * as path from 'path';
import * as vscode from 'vscode';

export function normalizeRelativePath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
}

export function toRelativeWorkspacePath(
	folder: vscode.WorkspaceFolder,
	uri: vscode.Uri
): string | undefined {
	if (folder.uri.scheme !== 'file' || uri.scheme !== 'file') {
		return undefined;
	}

	const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
	const normalized = normalizeRelativePath(relativePath);
	return normalized.length > 0 ? normalized : undefined;
}

export function isDescendantPath(candidatePath: string, parentPath: string): boolean {
	return candidatePath.startsWith(`${parentPath}/`);
}

export function isSameOrDescendantPath(candidatePath: string, parentPath: string): boolean {
	return candidatePath === parentPath || isDescendantPath(candidatePath, parentPath);
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

export async function safeStat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
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

