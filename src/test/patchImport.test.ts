import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { importContextBridgePatch } from '../core/patch';

suite('Patch import', () => {
	test('validates all modify blocks before writing any files', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'context-bridge-import-'));
		const folder: vscode.WorkspaceFolder = {
			name: 'test',
			index: 0,
			uri: vscode.Uri.file(directory),
		};

		try {
			await fs.writeFile(path.join(directory, 'first.txt'), 'first: old\n');
			await fs.writeFile(path.join(directory, 'second.txt'), 'second: old\n');

			const invalidPatch = [
				'cFILEb first.txt',
				'cACTIONb modify',
				'cSEARCHb',
				'first: old',
				'cREPLACEb',
				'first: new',
				'cFILEb second.txt',
				'cACTIONb modify',
				'cSEARCHb',
				'not present',
				'cREPLACEb',
				'second: new',
			].join('\n');

			await assert.rejects(importContextBridgePatch(folder, invalidPatch), /Search block #1 was not found/);
			assert.strictEqual(await fs.readFile(path.join(directory, 'first.txt'), 'utf8'), 'first: old\n');
			assert.strictEqual(await fs.readFile(path.join(directory, 'second.txt'), 'utf8'), 'second: old\n');

			const validPatch = invalidPatch.replace('not present', 'second: old');
			const result = await importContextBridgePatch(folder, validPatch);
			assert.strictEqual(result.modified, 2);
			assert.strictEqual(await fs.readFile(path.join(directory, 'first.txt'), 'utf8'), 'first: new\n');
			assert.strictEqual(await fs.readFile(path.join(directory, 'second.txt'), 'utf8'), 'second: new\n');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});