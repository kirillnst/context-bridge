import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createDefaultConfig, createSelectionShort, isReservedSelectionShort, readContextBridgeConfig, writeContextBridgeConfig } from '../core/config';
import { collectActiveExportPaths, collectExportFiles, getFileContentExtension, shouldIgnoreFileContent } from '../core/fileCollection';
import type { ContextBridgeConfig } from '../core/types';

suite('Export selection paths', () => {
	test('initial configuration has no ignored extensions', () => {
		assert.deepStrictEqual(createDefaultConfig().ignoreContentExtensions, []);
	});

	test('detects extensions and extensionless files', () => {
		assert.strictEqual(getFileContentExtension('src/code.TS'), '.ts');
		assert.strictEqual(getFileContentExtension('src/README'), '<no-extension>');
		assert.strictEqual(getFileContentExtension('src/.env'), '<no-extension>');
		assert.strictEqual(getFileContentExtension('src/archive.tar.gz'), '.gz');
		assert.strictEqual(shouldIgnoreFileContent('src/.env', ['<no-extension>']), true);
		assert.strictEqual(shouldIgnoreFileContent('src/README', ['<no-extension>']), true);
		assert.strictEqual(shouldIgnoreFileContent('src/code.TS', ['.ts']), true);
		assert.strictEqual(shouldIgnoreFileContent('src/archive.tar.gz', ['.tar.gz']), true);
		assert.strictEqual(shouldIgnoreFileContent('src/code.TS', []), false);
	});

	test('reserves E and I short names', () => {
		assert.strictEqual(isReservedSelectionShort('e'), true);
		assert.strictEqual(isReservedSelectionShort('I'), true);
		assert.strictEqual(isReservedSelectionShort('EI'), false);
		assert.strictEqual(createSelectionShort('E'), 'ES');
		assert.strictEqual(createSelectionShort('I'), 'IS');
		assert.strictEqual(createSelectionShort('Import'), 'IM');
	});

	test('normalizes existing reserved short names', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-shorts-'));
		const folder: vscode.WorkspaceFolder = {
			name: 'test',
			index: 0,
			uri: vscode.Uri.file(directory),
		};
		try {
			const config = createDefaultConfig();
			config.selections = [
				{ name: 'Export', short: 'e', active: true, items: [], excludeItems: [] },
				{ name: 'Ignore', short: 'I', active: true, items: [], excludeItems: [] },
			];
			await writeContextBridgeConfig(folder, config);
			const loaded = await readContextBridgeConfig(folder);
			assert.deepStrictEqual(loaded?.selections.map((selection) => selection.short), ['EX', 'IG']);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('exports ignored file paths without content', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-ignore-'));
		const folder: vscode.WorkspaceFolder = {
			name: 'test',
			index: 0,
			uri: vscode.Uri.file(directory),
		};
		try {
			await fs.writeFile(path.join(directory, 'code.ts'), 'typescript content');
			await fs.writeFile(path.join(directory, 'README'), 'readme content');
			await fs.writeFile(path.join(directory, 'notes.md'), 'markdown content');
			const config: ContextBridgeConfig = {
				version: 2,
				prompt: '',
				ignoreContentExtensions: ['.ts', '<no-extension>'],
				selections: [{
					name: 'Main', short: 'MA', active: true,
					items: [
						{ path: 'code.ts', type: 'file' },
						{ path: 'README', type: 'file' },
						{ path: 'notes.md', type: 'file' },
					],
					excludeItems: [],
				}],
			};
			assert.deepStrictEqual(await collectExportFiles(folder, config), [
				{ path: 'code.ts' },
				{ path: 'README' },
				{ path: 'notes.md', content: 'markdown content' },
			]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	test('respects inactive selections and folder exclusions', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-export-'));
		const folder: vscode.WorkspaceFolder = {
			name: 'test',
			index: 0,
			uri: vscode.Uri.file(directory),
		};

		try {
			await fs.mkdir(path.join(directory, 'src'));
			await fs.mkdir(path.join(directory, 'other'));
			await fs.writeFile(path.join(directory, 'src', 'included.ts'), 'included');
			await fs.writeFile(path.join(directory, 'src', 'excluded.ts'), 'excluded');
			await fs.writeFile(path.join(directory, 'other', 'inactive.ts'), 'inactive');

			const config: ContextBridgeConfig = {
				version: 2,
				prompt: '',
				ignoreContentExtensions: [],
				selections: [
					{
						name: 'main',
						short: 'MA',
						active: true,
						items: [{ path: 'src', type: 'folder' }],
						excludeItems: [{ path: 'src/excluded.ts', type: 'file' }],
					},
					{
						name: 'test',
						short: 'TE',
						active: false,
						items: [{ path: 'other', type: 'folder' }],
						excludeItems: [],
					},
				],
			};
			await writeContextBridgeConfig(folder, config);

			const paths = await collectActiveExportPaths(folder, config);
			assert.deepStrictEqual([...paths], ['src/included.ts']);
			const files = await collectExportFiles(folder);
			assert.deepStrictEqual(files.map((file) => file.path), [...paths]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});