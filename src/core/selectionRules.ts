import type { ContextBridgeItem } from './types';
import { isDescendantPath, isSameOrDescendantPath } from './pathUtils';

export function hasExactCollectionItem(items: ContextBridgeItem[], target: ContextBridgeItem): boolean {
	return items.some((item) => item.type === target.type && item.path === target.path);
}

export function hasExactPathItem(items: ContextBridgeItem[], targetPath: string): boolean {
	return items.some((item) => item.path === targetPath);
}

export function removeExactCollectionItem(
	items: ContextBridgeItem[],
	target: ContextBridgeItem
): ContextBridgeItem[] {
	return items.filter((item) => !(item.type === target.type && item.path === target.path));
}

export function addExcludeItem(
	excludeItems: ContextBridgeItem[],
	target: ContextBridgeItem
): ContextBridgeItem[] {
	let nextExcludeItems = removeExactCollectionItem(excludeItems, target);

	if (target.type === 'folder') {
		nextExcludeItems = nextExcludeItems.filter(
			(item) => !isDescendantPath(item.path, target.path)
		);
	}

	return dedupeItems([...nextExcludeItems, target]);
}

export function isIncludedViaFolder(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	resourcePath: string
): boolean {
	const includedByFolder = items.some(
		(item) => item.type === 'folder' && isSameOrDescendantPath(resourcePath, item.path)
	);

	return includedByFolder && !isExcludedFromFolderSelection(excludeItems, resourcePath);
}

export function isExcludedFromFolderSelection(
	excludeItems: ContextBridgeItem[],
	resourcePath: string
): boolean {
	return excludeItems.some((item) => {
		if (item.type === 'file') {
			return item.path === resourcePath;
		}

		return isSameOrDescendantPath(resourcePath, item.path);
	});
}

export function hasDirectDescendantItem(
	items: ContextBridgeItem[],
	resourcePath: string
): boolean {
	return items.some((item) => isDescendantPath(item.path, resourcePath));
}

export function dedupeItems(items: ContextBridgeItem[]): ContextBridgeItem[] {
	const seen = new Set<string>();
	const uniqueItems: ContextBridgeItem[] = [];

	for (const item of items) {
		const key = `${item.type}:${item.path}`;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		uniqueItems.push(item);
	}

	return uniqueItems;
}

