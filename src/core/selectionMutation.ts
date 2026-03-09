import type {
	ContextBridgeItem,
	SelectionMutationStatus,
} from './types';
import {
	addExcludeItem,
	dedupeItems,
	hasDirectDescendantItem,
	hasExactCollectionItem,
	isIncludedViaFolder,
	removeExactCollectionItem,
} from './selectionRules';

export interface SelectionItemsMutation {
	changed: boolean;
	status: SelectionMutationStatus;
	items: ContextBridgeItem[];
	excludeItems: ContextBridgeItem[];
}

export function addItemToSelection(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	target: ContextBridgeItem
): SelectionItemsMutation {
	const nextExcludeItems = removeExactCollectionItem(excludeItems, target);
	const exactItemExists = hasExactCollectionItem(items, target);

	if (exactItemExists) {
		if (nextExcludeItems.length !== excludeItems.length) {
			return { changed: true, status: 'added', items, excludeItems: nextExcludeItems };
		}

		return { changed: false, status: 'alreadySelected', items, excludeItems };
	}

	if (isIncludedViaFolder(items, nextExcludeItems, target.path)) {
		if (nextExcludeItems.length !== excludeItems.length) {
			return { changed: true, status: 'added', items, excludeItems: nextExcludeItems };
		}

		return { changed: false, status: 'coveredByFolder', items, excludeItems };
	}

	return {
		changed: true,
		status: 'added',
		items: dedupeItems([...items, target]),
		excludeItems: nextExcludeItems,
	};
}

export function removeItemFromSelection(
	items: ContextBridgeItem[],
	excludeItems: ContextBridgeItem[],
	target: ContextBridgeItem
): SelectionItemsMutation {
	if (hasExactCollectionItem(items, target)) {
		const nextItems = removeExactCollectionItem(items, target);

		if (isIncludedViaFolder(nextItems, excludeItems, target.path)) {
			return {
				changed: true,
				status: 'excluded',
				items: nextItems,
				excludeItems: addExcludeItem(excludeItems, target),
			};
		}

		return { changed: true, status: 'removed', items: nextItems, excludeItems };
	}

	if (isIncludedViaFolder(items, excludeItems, target.path)) {
		return {
			changed: true,
			status: 'excluded',
			items,
			excludeItems: addExcludeItem(excludeItems, target),
		};
	}

	if (hasDirectDescendantItem(items, target.path)) {
		return { changed: false, status: 'notDirectItem', items, excludeItems };
	}

	return { changed: false, status: 'notFound', items, excludeItems };
}

