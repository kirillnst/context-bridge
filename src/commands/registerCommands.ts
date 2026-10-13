import * as vscode from 'vscode';
import {
	ContextBridgeImportError,
	type ContextBridgeImportSummary,
	type ResourceMembershipInfo,
	type SelectionManagementResult,
	type SelectionMutationResult,
	type SelectionBatchMutationResult,
	buildExportDocument,
	collectExportFiles,
	createDefaultConfig,
	fileExists,
	formatMembershipKind,
	importContextBridgePatch,
	readContextBridgeConfig,
	toWorkspaceRelativeUri,
	writeContextBridgeConfig,
	CONFIG_FILE_PATH,
	ContextBridgeSelectionEngine,
} from '../selectionEngine';
import { openBridgeDocument, type ContextBridgeVirtualFileSystemProvider } from '../bridge/ContextBridgeVirtualFileSystemProvider';
import { COMMANDS } from '../constants';
import type { ContextBridgeExplorerProvider } from '../explorer/ContextBridgeExplorerProvider';
import type { ContextBridgeNode } from '../explorer/types';

const MANAGED_FILE_PATHS = [CONFIG_FILE_PATH] as const;

type ManagedFilePath = (typeof MANAGED_FILE_PATHS)[number];

interface WorkspaceFolderQuickPickItem extends vscode.QuickPickItem {
	folder: vscode.WorkspaceFolder;
}

export function registerCommands(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine,
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable[] {
	return [
		registerInitializeWorkspaceFilesCommand(explorerProvider),
		registerCreateSelectionCommand(explorerProvider, selectionEngine),
		registerExportCommand(bridgeDocumentProvider),
		registerImportCommand(explorerProvider, bridgeDocumentProvider),
		registerSetSelectionActiveStateCommand(
			COMMANDS.activateSelection,
			true,
			explorerProvider,
			selectionEngine
		),
		registerSetSelectionActiveStateCommand(
			COMMANDS.deactivateSelection,
			false,
			explorerProvider,
			selectionEngine
		),
		registerRenameSelectionCommand(explorerProvider, selectionEngine),
		registerRenameSelectionShortCommand(explorerProvider, selectionEngine),
		registerDeleteSelectionCommand(explorerProvider, selectionEngine),
		registerAddToSelectionCommand(explorerProvider, selectionEngine),
		registerRemoveFromSelectionCommand(explorerProvider, selectionEngine),
		registerIgnoredContentExtensionCommand(COMMANDS.addIgnoredContentExtension, true, explorerProvider, selectionEngine),
		registerIgnoredContentExtensionCommand(COMMANDS.removeIgnoredContentExtension, false, explorerProvider, selectionEngine),
		registerRemoveSelectionItemCommand(COMMANDS.removeSelectionItem, false, explorerProvider, selectionEngine),
		registerRemoveSelectionItemCommand(COMMANDS.removeExclusionItem, true, explorerProvider, selectionEngine),
	];
}

function registerInitializeWorkspaceFilesCommand(
	explorerProvider: ContextBridgeExplorerProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.initializeWorkspaceFiles,
		async (targetFolder?: unknown) => {
			const folder = getFolderFromCommandTarget(targetFolder) ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			await initializeWorkspaceFiles(folder);
			explorerProvider.refresh();
		}
	);
}

function registerExportCommand(
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.exportSelection,
		async () => {
			const folder = await getTargetWorkspaceFolder();
			if (!folder) {
				return;
			}

			const config = await readContextBridgeConfig(folder);
			if (!config) {
				void vscode.window.showErrorMessage(
					'Context Bridge: valid .vscode/context-bridge.json was not found.'
				);
				return;
			}

			const exportFiles = await collectExportFiles(folder, config);
			const exportContent = buildExportDocument(exportFiles, config.prompt);

			if (await bridgeDocumentProvider.replaceContent(exportContent)) {
				await openBridgeDocument();
			}
		}
	);
}

function registerImportCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	bridgeDocumentProvider: ContextBridgeVirtualFileSystemProvider
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.importSelection,
		async () => {
			const patchText = await bridgeDocumentProvider.getContent();
			if (patchText.trim().length === 0) {
				void vscode.window.showErrorMessage(
					'Context Bridge: the context-bridge://bridge document is empty.'
				);
				return;
			}

			const folder = await getTargetWorkspaceFolder();
			if (!folder) {
				return;
			}

			try {
				const summary = await importContextBridgePatch(folder, patchText);

				explorerProvider.refresh();

				const appliedCount =
					summary.added + summary.modified + summary.deleted + summary.moved;

				void vscode.window.showInformationMessage(
					appliedCount === 0
						? 'Context Bridge: import completed, no changes.'
						: `Context Bridge: import completed (${formatImportSummary(summary)}).`
				);
			} catch (error) {
				explorerProvider.refresh();

				if (error instanceof ContextBridgeImportError) {
					const appliedCount =
						error.summary.added +
						error.summary.modified +
						error.summary.deleted +
						error.summary.moved;
					const partialSuffix =
						appliedCount > 0
							? ` Already applied: ${formatImportSummary(error.summary)}.`
							: '';

					void vscode.window.showErrorMessage(
						`Context Bridge: import did not finish. ${error.message}${partialSuffix}`
					);
					return;
				}

				const message = error instanceof Error ? error.message : 'unknown error.';
				void vscode.window.showErrorMessage(`Context Bridge: import failed. ${message}`);
			}
		}
	);
}

function registerCreateSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.createSelection,
		async (target?: unknown) => {
			const folder = getFolderFromCommandTarget(target) ?? (await getTargetWorkspaceFolder());
			if (!folder) {
				return;
			}

			const selectionName = await vscode.window.showInputBox({
				title: 'Create Context Bridge Selection',
				prompt: 'Enter selection name.',
				placeHolder: 'Selection name',
				validateInput: (value) =>
					value.trim().length === 0 ? 'Selection name is required.' : undefined,
			});

			if (selectionName === undefined) {
				return;
			}

			const result = await selectionEngine.createSelection(folder, selectionName);

			if (result.status === 'created') {
				explorerProvider.refresh();
				return;
			}

			handleSelectionManagementFailure(result);
		}
	);
}

function registerRenameSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(COMMANDS.renameSelection, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selection') {
			return;
		}

		const selectionName = await vscode.window.showInputBox({
			title: 'Rename Context Bridge Selection',
			prompt: 'Enter new selection name.',
			value: node.selection.name,
			validateInput: (value) =>
				value.trim().length === 0 ? 'Selection name is required.' : undefined,
		});

		if (selectionName === undefined) {
			return;
		}

		const result = await selectionEngine.renameSelection(
			node.folder,
			node.selectionIndex,
			selectionName
		);

		if (result.status === 'renamed') {
			explorerProvider.refresh();
			return;
		}

		handleSelectionManagementFailure(result);
	});
}

function registerRenameSelectionShortCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(COMMANDS.renameSelectionShort, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selection') {
			return;
		}

		const short = await vscode.window.showInputBox({
			title: 'Rename Context Bridge Selection Short Name',
			prompt: 'Enter a new short label (1–2 characters).',
			value: node.selection.short,
			validateInput: (value) =>
				value.trim().length === 0 || value.trim().length > 2
					? 'Short name must be 1–2 characters.'
					: /^(E|I)$/i.test(value.trim())
						? 'E and I are reserved decoration labels.'
						: undefined,
		});

		if (short === undefined) {
			return;
		}

		const result = await selectionEngine.renameSelectionShort(node.folder, node.selectionIndex, short);
		if (result.status === 'renamed') {
			explorerProvider.refresh();
			return;
		}

		handleSelectionManagementFailure(result);
	});
}

function registerDeleteSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(COMMANDS.deleteSelection, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selection') {
			return;
		}

		const deleteAction = 'Delete';
		const selectedAction = await vscode.window.showWarningMessage(
			`Delete selection "${node.selection.name}"? This only changes ${CONFIG_FILE_PATH}; project files will not be deleted.`,
			{ modal: true },
			deleteAction
		);

		if (selectedAction !== deleteAction) {
			return;
		}

		const result = await selectionEngine.deleteSelection(node.folder, node.selectionIndex);

		if (result.status === 'deleted') {
			explorerProvider.refresh();
			return;
		}

		handleSelectionManagementFailure(result);
	});
}

function registerSetSelectionActiveStateCommand(
	command: typeof COMMANDS.activateSelection | typeof COMMANDS.deactivateSelection,
	active: boolean,
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selection') {
			return;
		}

		const ok = await selectionEngine.setSelectionActiveState(
			node.folder,
			node.selectionIndex,
			active
		);
		if (!ok) {
			void vscode.window.showErrorMessage(
				`Context Bridge: could not ${active ? 'activate' : 'deactivate'} selection "${node.selection.name}".`
			);
			return;
		}

		explorerProvider.refresh();
	});
}

function registerAddToSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.addToSelection,
		async (resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
			if (!resourceUri) {
				return;
			}

			const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
			if (!folder) {
				return;
			}

			const resources = getSelectedExplorerResources(resourceUri, selectedUris);
			const summaries = await selectionEngine.getSelectionSummaries(folder);
			if (summaries.length === 0) {
				void vscode.window.showErrorMessage(
					'Context Bridge: create a selection before adding resources.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				summaries.map((summary) => ({
					label: summary.selection.name,
					description: `${summary.selection.short} • ${summary.selection.active ? 'active' : 'inactive'} • ${formatFileCount(summary.fileCount)}`,
					index: summary.selectionIndex,
				})),
				{ placeHolder: resources.length === 1
					? 'Which selection should this resource be added to?'
					: `Add ${resources.length} selected resources to which selection?` }
			);

			if (!picked) {
				return;
			}

			if (resources.length === 1) {
				const result = await selectionEngine.addResourceToSelection(resourceUri, picked.index);
				if (result.status === 'added') {
					explorerProvider.refresh();
					return;
				}

				handleSelectionMutationFailure(result, picked.index, picked.label);
				return;
			}

			const result = await selectionEngine.mutateResourcesInSelection(folder, resources, picked.index, 'add');
			if (result.status !== 'completed') {
				handleSelectionMutationFailure(result, picked.index, picked.label);
				return;
			}

			explorerProvider.refresh();
			showBatchMutationSummary(result, 'add');
		}
	);
}

function registerRemoveFromSelectionCommand(
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(
		COMMANDS.removeFromSelection,
		async (resourceUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
			if (!resourceUri) {
				return;
			}

			const folder = vscode.workspace.getWorkspaceFolder(resourceUri);
			if (!folder) {
				return;
			}

			const resources = getSelectedExplorerResources(resourceUri, selectedUris);
			const membershipsBySelection = new Map<number, { membership: ResourceMembershipInfo; count: number }>();
			for (const uri of resources) {
				if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) {
					continue;
				}
				for (const membership of await selectionEngine.getMemberships(uri)) {
					const entry = membershipsBySelection.get(membership.selectionIndex);
					if (entry) {
						entry.count += 1;
					} else {
						membershipsBySelection.set(membership.selectionIndex, { membership, count: 1 });
					}
				}
			}

			if (membershipsBySelection.size === 0) {
				void vscode.window.showInformationMessage(
					'Context Bridge: none of the selected resources are part of a selection.'
				);
				return;
			}

			const picked = await vscode.window.showQuickPick(
				[...membershipsBySelection.values()]
					.sort((left, right) => left.membership.selectionIndex - right.membership.selectionIndex)
					.map(({ membership, count }) => ({
						label: membership.selection.name,
						description: resources.length === 1
							? `${membership.selection.short} • ${formatMembershipKind(membership.kind)}`
							: `${membership.selection.short} • ${count} of ${resources.length} selected`,
						index: membership.selectionIndex,
					})),
				{ placeHolder: resources.length === 1
					? 'Remove this resource from which selection?'
					: 'Remove selected resources from which selection?' }
			);

			if (!picked) {
				return;
			}

			if (resources.length === 1) {
				const result = await selectionEngine.removeResourceFromSelection(resourceUri, picked.index);
				if (result.status === 'removed' || result.status === 'excluded') {
					explorerProvider.refresh();
					return;
				}

				handleSelectionMutationFailure(result, picked.index, picked.label);
				return;
			}

			const result = await selectionEngine.mutateResourcesInSelection(folder, resources, picked.index, 'remove');
			if (result.status !== 'completed') {
				handleSelectionMutationFailure(result, picked.index, picked.label);
				return;
			}

			explorerProvider.refresh();
			showBatchMutationSummary(result, 'remove');
		}
	);
}

function registerIgnoredContentExtensionCommand(
	command: typeof COMMANDS.addIgnoredContentExtension | typeof COMMANDS.removeIgnoredContentExtension,
	ignored: boolean,
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (resourceUri?: vscode.Uri) => {
		if (!resourceUri) {
			return;
		}

		const result = await selectionEngine.setFileContentExtensionIgnored(resourceUri, ignored);
		if (result === 'configMissing') {
			void vscode.window.showErrorMessage(
				'Context Bridge: initialize .vscode/context-bridge.json first.'
			);
			return;
		}

		if (result === 'invalidResource') {
			void vscode.window.showErrorMessage('Context Bridge: select a file in Explorer.');
			return;
		}

		if (result === 'added' || result === 'removed') {
			explorerProvider.refresh();
		}
	});
}

function getSelectedExplorerResources(resourceUri: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
	const selected = selectedUris?.length ? selectedUris : [resourceUri];
	return [...new Map(selected.map((uri) => [uri.toString(), uri])).values()];
}

function showBatchMutationSummary(
	result: Extract<SelectionBatchMutationResult, { status: 'completed' }>,
	mode: 'add' | 'remove'
): void {
	const changed = mode === 'add'
		? `${result.added} added`
		: `${result.removed} removed, ${result.excluded} excluded`;
	const skipped = result.skipped > 0 ? `, ${result.skipped} skipped` : '';
	void vscode.window.showInformationMessage(
		`Context Bridge: ${changed} in "${result.selectionName}"${skipped}.`
	);
}

function registerRemoveSelectionItemCommand(
	command: typeof COMMANDS.removeSelectionItem | typeof COMMANDS.removeExclusionItem,
	isExclusion: boolean,
	explorerProvider: ContextBridgeExplorerProvider,
	selectionEngine: ContextBridgeSelectionEngine
): vscode.Disposable {
	return vscode.commands.registerCommand(command, async (node?: ContextBridgeNode) => {
		if (!node || node.kind !== 'selectionItem' || (node.source === 'excludeItem') !== isExclusion) {
			return;
		}

		const result = await selectionEngine.removeSelectionItem(
			node.folder,
			node.selectionIndex,
			node.item,
			isExclusion
		);
		if (result.status === 'removed' || result.status === 'excluded') {
			explorerProvider.refresh();
			return;
		}

		handleSelectionMutationFailure(result, node.selectionIndex);
	});
}

function handleSelectionManagementFailure(result: SelectionManagementResult): void {
	switch (result.status) {
		case 'duplicateName':
			void vscode.window.showErrorMessage(
				`Context Bridge: selection "${result.selectionName ?? 'selection'}" already exists.`
			);
			return;

		case 'selectionNotFound':
			void vscode.window.showErrorMessage('Context Bridge: selection not found.');
			return;

		case 'invalidName':
			void vscode.window.showErrorMessage('Context Bridge: selection name is required.');
			return;

		case 'invalidShort':
			void vscode.window.showErrorMessage('Context Bridge: short name must be 1–2 characters and cannot be E or I.');
			return;

		case 'configMissing':
			void vscode.window.showErrorMessage(
				'Context Bridge: initialize .vscode/context-bridge.json first.'
			);
			return;

		default:
			void vscode.window.showErrorMessage('Context Bridge: operation failed.');
	}
}

function handleSelectionMutationFailure(
	result: SelectionMutationResult,
	selectionIndex: number,
	fallbackSelectionName?: string
): void {
	const selectionLabel =
		result.selectionName ?? fallbackSelectionName ?? `Selection #${selectionIndex + 1}`;

	switch (result.status) {
		case 'alreadySelected':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource is already added to "${selectionLabel}".`
			);
			return;

		case 'coveredByFolder':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource is already included in "${selectionLabel}" through a selected folder.`
			);
			return;

		case 'notDirectItem':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource in "${selectionLabel}" is not selected directly and is not covered by a selected folder. Remove nested items separately.`
			);
			return;

		case 'notFound':
			void vscode.window.showInformationMessage(
				`Context Bridge: resource was not found in "${selectionLabel}" as a direct item.`
			);
			return;

		case 'selectionNotFound':
			void vscode.window.showErrorMessage(
				`Context Bridge: selection not found (index=${selectionIndex}).`
			);
			return;

		case 'invalidResource':
			void vscode.window.showErrorMessage(
				'Context Bridge: could not determine the file or folder resource.'
			);
			return;

		case 'configMissing':
			void vscode.window.showErrorMessage(
				'Context Bridge: initialize .vscode/context-bridge.json first.'
			);
			return;

		default:
			void vscode.window.showErrorMessage('Context Bridge: operation failed.');
	}
}

function formatFileCount(fileCount: number): string {
	return `${fileCount} file(s)`;
}

function formatImportSummary(summary: ContextBridgeImportSummary): string {
	const parts: string[] = [];

	if (summary.modified > 0) {
		parts.push(`modified ${summary.modified}`);
	}

	if (summary.added > 0) {
		parts.push(`added ${summary.added}`);
	}

	if (summary.deleted > 0) {
		parts.push(`deleted ${summary.deleted}`);
	}

	if (summary.moved > 0) {
		parts.push(`moved ${summary.moved}`);
	}

	return parts.length > 0 ? parts.join(', ') : 'no changes';
}



function getFolderFromCommandTarget(target: unknown): vscode.WorkspaceFolder | undefined {
	if (!target || typeof target !== 'object') {
		return undefined;
	}

	const candidate = 'kind' in target && 'folder' in target ? target.folder : target;
	if (!candidate || typeof candidate !== 'object') {
		return undefined;
	}

	const uri = candidate instanceof vscode.Uri
		? candidate
		: 'uri' in candidate && candidate.uri instanceof vscode.Uri
			? candidate.uri
			: undefined;
	if (!uri) {
		return undefined;
	}

	return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.toString() === uri.toString())
		?? vscode.workspace.getWorkspaceFolder(uri);
}

async function getTargetWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {


	const folders = vscode.workspace.workspaceFolders;

	if (!folders || folders.length === 0) {
		void vscode.window.showErrorMessage(
			'Context Bridge: first open a folder or workspace in VS Code.'
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
			placeHolder: 'Select a folder for Context Bridge',
		}
	);

	return picked?.folder;
}

async function initializeWorkspaceFiles(folder: vscode.WorkspaceFolder): Promise<void> {
	const existingFiles = await getExistingManagedFiles(folder);

	if (existingFiles.length > 0) {
		const overwriteAction = 'Overwrite';
		const selectedAction = await vscode.window.showWarningMessage(
			`The following files already exist in "${folder.name}": ${existingFiles.join(', ')}.`,
			{ modal: true },
			overwriteAction
		);

		if (selectedAction !== overwriteAction) {
			return;
		}
	}

	await writeContextBridgeConfig(folder, createDefaultConfig());

	const document = await vscode.workspace.openTextDocument(
		toWorkspaceRelativeUri(folder.uri, CONFIG_FILE_PATH)
	);
	await vscode.window.showTextDocument(document);
}

async function getExistingManagedFiles(folder: vscode.WorkspaceFolder): Promise<ManagedFilePath[]> {
	const existingFiles: ManagedFilePath[] = [];

	for (const filePath of MANAGED_FILE_PATHS) {
		if (await fileExists(toWorkspaceRelativeUri(folder.uri, filePath))) {
			existingFiles.push(filePath);
		}
	}

	return existingFiles;
}

