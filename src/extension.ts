import * as vscode from 'vscode';

const INITIALIZE_WORKSPACE_FILES_COMMAND = 'context-bridge.initializeWorkspaceFiles';

type ContextBridgeItemType = 'file' | 'folder';

interface ContextBridgeItem {
	path: string;
	type: ContextBridgeItemType;
}

interface ContextBridgeSelection {
	id: string;
	name: string;
	items: ContextBridgeItem[];
}

interface ContextBridgeConfig {
	version: number;
	selections: ContextBridgeSelection[];
}

interface WorkspaceFolderQuickPickItem extends vscode.QuickPickItem {
	folder: vscode.WorkspaceFolder;
}

export function activate(context: vscode.ExtensionContext): void {
	const initializeWorkspaceFilesDisposable = vscode.commands.registerCommand(
		INITIALIZE_WORKSPACE_FILES_COMMAND,
		async () => {
			const folder = await getTargetWorkspaceFolder();
			if (!folder) {
				return;
			}

			await initializeWorkspaceFiles(folder);
		}
	);

	context.subscriptions.push(initializeWorkspaceFilesDisposable);
}

async function getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders;

	if (!folders || folders.length === 0) {
		void vscode.window.showErrorMessage(
			'Context Bridge: сначала откройте папку или workspace в VS Code.'
		);
		return undefined;
	}

	if (folders.length === 1) {
		return folders[0];
	}

	const picked = await vscode.window.showQuickPick<WorkspaceFolderQuickPickItem>(
		folders.map((folder) => ({
			label: folder.name,
			description: folder.uri.fsPath,
			folder,
		})),
		{
			placeHolder: 'Выберите папку для инициализации файлов Context Bridge',
		}
	);

	return picked?.folder;
}

async function initializeWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
	const configUri = vscode.Uri.joinPath(folder.uri, 'context-bridge.json');
	const exportUri = vscode.Uri.joinPath(folder.uri, 'export.json');
	const importUri = vscode.Uri.joinPath(folder.uri, 'import.json');

	const existingFiles: string[] = [];

	if (await fileExists(configUri)) {
		existingFiles.push('context-bridge.json');
	}

	if (await fileExists(exportUri)) {
		existingFiles.push('export.json');
	}

	if (await fileExists(importUri)) {
		existingFiles.push('import.json');
	}

	if (existingFiles.length > 0) {
		const overwriteAction = 'Перезаписать';

		const selectedAction = await vscode.window.showWarningMessage(
			`В папке "${folder.name}" уже существуют файлы: ${existingFiles.join(', ')}.`,
			{ modal: true },
			overwriteAction
		);

		if (selectedAction !== overwriteAction) {
			return;
		}
	}

	const defaultConfig = createDefaultConfig();

	await vscode.workspace.fs.writeFile(configUri, toJsonBytes(defaultConfig));
	await vscode.workspace.fs.writeFile(exportUri, toJsonBytes({}));
	await vscode.workspace.fs.writeFile(importUri, toJsonBytes({}));

	const document = await vscode.workspace.openTextDocument(configUri);
	await vscode.window.showTextDocument(document);

	void vscode.window.showInformationMessage(
		`Context Bridge: файлы инициализированы в "${folder.name}".`
	);
}

function createDefaultConfig(): ContextBridgeConfig {
	return {
		version: 1,
		selections: [1, 2, 3].map((index) => ({
			id: `selection-${index}`,
			name: `Выборка ${index}`,
			items: [],
		})),
	};
}

function toJsonBytes(value: unknown): Uint8Array {
	const json = `${JSON.stringify(value, null, 2)}\n`;
	return new TextEncoder().encode(json);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export function deactivate(): void {}