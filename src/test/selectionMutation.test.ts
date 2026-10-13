import * as assert from 'assert';
import { mutateSelectionItemsBatch } from '../core/selectionMutation';

suite('Selection batch mutations', () => {
	test('adds a parent folder before its selected files', () => {
		const result = mutateSelectionItemsBatch([], [], [
			{ path: 'src/app.ts', type: 'file' },
			{ path: 'src', type: 'folder' },
		], 'add');

		assert.deepStrictEqual(result.items, [{ path: 'src', type: 'folder' }]);
		assert.strictEqual(result.added, 1);
		assert.strictEqual(result.skipped, 1);
	});

	test('removes a selected folder before its selected descendants', () => {
		const result = mutateSelectionItemsBatch([
			{ path: 'src', type: 'folder' },
			{ path: 'src/app.ts', type: 'file' },
		], [], [
			{ path: 'src/app.ts', type: 'file' },
			{ path: 'src', type: 'folder' },
		], 'remove');

		assert.deepStrictEqual(result.items, []);
		assert.deepStrictEqual(result.excludeItems, []);
		assert.strictEqual(result.removed, 2);
	});

	test('excludes a file included through a folder', () => {
		const result = mutateSelectionItemsBatch([
			{ path: 'src', type: 'folder' },
		], [], [{ path: 'src/app.ts', type: 'file' }], 'remove');

		assert.deepStrictEqual(result.excludeItems, [{ path: 'src/app.ts', type: 'file' }]);
		assert.strictEqual(result.excluded, 1);
	});

	test('skips resources that are already added or absent', () => {
		const selected = [{ path: 'src/app.ts', type: 'file' as const }];
		const add = mutateSelectionItemsBatch(selected, [], selected, 'add');
		const remove = mutateSelectionItemsBatch(selected, [], [
			{ path: 'src/other.ts', type: 'file' },
		], 'remove');

		assert.strictEqual(add.added, 0);
		assert.strictEqual(add.skipped, 1);
		assert.strictEqual(remove.removed, 0);
		assert.strictEqual(remove.skipped, 1);
	});
});
