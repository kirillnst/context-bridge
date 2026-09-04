import * as assert from 'assert';
import { applyPatchModifyOperations } from '../core/patchText';

suite('Patch text', () => {
	test('uses the file indentation when search and replacement share a wrong base indent', () => {
		const current = [
			'jobs:',
			'  deploy:',
			'    steps:',
			'      - name: Configure Headlamp Helm repository',
			'        shell: powershell',
			'        run: |',
			'          helm repo update headlamp',
			'',
			'      - name: Deploy Headlamp',
			'footer:',
		].join('\n');
		const search = [
			'    - name: Configure Headlamp Helm repository',
			'      shell: powershell',
			'      run: |',
			'        helm repo update headlamp',
			'',
			'    - name: Deploy Headlamp',
		].join('\n');
		const replace = [
			'    - name: Configure platform Helm repositories',
			'      shell: powershell',
			'      run: |',
			'        helm repo update headlamp metrics-server',
			'',
			'    - name: Deploy Metrics Server',
			'      shell: powershell',
			'',
			'    - name: Deploy Headlamp',
		].join('\n');

		const actual = applyPatchModifyOperations(current, [{ search, replace }]);

		assert.strictEqual(
			actual,
			[
				'jobs:',
				'  deploy:',
				'    steps:',
				'      - name: Configure platform Helm repositories',
				'        shell: powershell',
				'        run: |',
				'          helm repo update headlamp metrics-server',
				'',
				'      - name: Deploy Metrics Server',
				'        shell: powershell',
				'',
				'      - name: Deploy Headlamp',
				'footer:',
			].join('\n')
		);
	});

	test('keeps exact-match replacement behavior unchanged', () => {
		const actual = applyPatchModifyOperations('before\n  old\nafter', [
			{ search: '  old', replace: 'new' },
		]);

		assert.strictEqual(actual, 'before\nnew\nafter');
	});

	test('rejects ambiguous relative-indentation matches', () => {
		const current = [
			'first:',
			'    item:',
			'      value: old',
			'second:',
			'      item:',
			'        value: old',
		].join('\n');
		const search = ['item:', '  value: old'].join('\n');

		assert.throws(
			() => applyPatchModifyOperations(current, [{ search, replace: 'item: new' }]),
			/by relative indentation; replacement is ambiguous/
		);
	});

	test('does not ignore differences inside the relative indentation structure', () => {
		const current = ['section:', '    item:', '        value: old'].join('\n');
		const search = ['item:', '  value: old'].join('\n');

		assert.throws(
			() => applyPatchModifyOperations(current, [{ search, replace: 'item: new' }]),
			/not found exactly or by relative indentation/
		);
	});
});
