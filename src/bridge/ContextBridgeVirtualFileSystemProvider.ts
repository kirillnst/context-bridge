import * as vscode from 'vscode';
import { BRIDGE_DOCUMENT_URI } from '../constants';

export class ContextBridgeVirtualFileSystemProvider implements vscode.FileSystemProvider {
	private readonly fileChangeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private content = new Uint8Array();
	private modifiedAt = Date.now();

	public readonly onDidChangeFile = this.fileChangeEmitter.event;

	public watch(
		_uri: vscode.Uri,
		_options: { recursive: boolean; excludes: string[] }
	): vscode.Disposable {
		return new vscode.Disposable(() => undefined);
	}

	public stat(uri: vscode.Uri): vscode.FileStat {
		this.ensureBridgeUri(uri);

		return {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: this.modifiedAt,
			size: this.content.byteLength,
		};
	}

	public readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
		return [];
	}

	public createDirectory(_uri: vscode.Uri): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document does not support directories.'
		);
	}

	public readFile(uri: vscode.Uri): Uint8Array {
		this.ensureBridgeUri(uri);
		return this.content;
	}

	public writeFile(
		uri: vscode.Uri,
		content: Uint8Array,
		_options: { create: boolean; overwrite: boolean }
	): void {
		this.ensureBridgeUri(uri);
		this.content = Uint8Array.from(content);
		this.modifiedAt = Date.now();
		this.emitChanged();
	}

	public delete(_uri: vscode.Uri, _options: { recursive: boolean }): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document cannot be deleted.'
		);
	}

	public rename(
		_oldUri: vscode.Uri,
		_newUri: vscode.Uri,
		_options: { overwrite: boolean }
	): void {
		throw vscode.FileSystemError.NoPermissions(
			'Context Bridge virtual document cannot be renamed.'
		);
	}

	public async replaceContent(content: string): Promise<void> {
		const document = this.getOpenDocument();

		if (document) {
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			const fullRange = new vscode.Range(
				document.positionAt(0),
				document.positionAt(document.getText().length)
			);

			await editor.edit((editBuilder) => {
				editBuilder.replace(fullRange, content);
			});
			await document.save();
			return;
		}

		this.content = Buffer.from(content, 'utf8');
		this.modifiedAt = Date.now();
		this.emitChanged();
	}

	public async getContent(): Promise<string> {
		const document = this.getOpenDocument();
		if (document) {
			return document.getText();
		}

		const raw = await vscode.workspace.fs.readFile(BRIDGE_DOCUMENT_URI);
		return Buffer.from(raw).toString('utf8');
	}

	private getOpenDocument(): vscode.TextDocument | undefined {
		return vscode.workspace.textDocuments.find((document) => this.isBridgeUri(document.uri));
	}

	private ensureBridgeUri(uri: vscode.Uri): void {
		if (!this.isBridgeUri(uri)) {
			throw vscode.FileSystemError.FileNotFound(uri);
		}
	}

	private isBridgeUri(uri: vscode.Uri): boolean {
		return uri.scheme === BRIDGE_DOCUMENT_URI.scheme && uri.path === BRIDGE_DOCUMENT_URI.path;
	}

	private emitChanged(): void {
		this.fileChangeEmitter.fire([
			{
				type: vscode.FileChangeType.Changed,
				uri: BRIDGE_DOCUMENT_URI,
			},
		]);
	}
}

export async function openBridgeDocument(): Promise<void> {
	const document = await vscode.workspace.openTextDocument(BRIDGE_DOCUMENT_URI);
	await vscode.window.showTextDocument(document, { preview: false });
}

