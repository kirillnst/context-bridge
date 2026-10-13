import type {
	ContextBridgeSelection,
	ResourceMembershipInfo,
	ResourceMembershipKind,
} from './types';
import {
	hasDirectDescendantItem,
	hasExactPathItem,
	isIncludedViaFolder,
} from './selectionRules';

export function getResourceMemberships(
	selections: ContextBridgeSelection[],
	resourcePath: string,
	isFolder: boolean
): ResourceMembershipInfo[] {
	const memberships: ResourceMembershipInfo[] = [];

	for (const [selectionIndex, selection] of selections.entries()) {
		const kind = getSelectionMembershipKind(selection, resourcePath, isFolder);
		if (kind) {
			memberships.push({ selection, selectionIndex, kind });
		}
	}

	return memberships;
}

export function buildDecorationTooltip(memberships: ResourceMembershipInfo[]): string {
	const lines = memberships.map((membership) => {
		const state = membership.selection.active ? 'active' : 'inactive';
		return `${membership.selection.name} [${membership.selection.short}] (${state}) — ${formatMembershipKind(membership.kind)}`;
	});

	return `Context Bridge\n${lines.join('\n')}`;
}

export function formatMembershipKind(kind: ResourceMembershipKind): string {
	switch (kind) {
		case 'direct':
			return 'directly';
		case 'insideSelectedFolder':
			return 'through selected folder';
		case 'containsSelectedDescendant':
			return 'contains selected items';
	}
}

function getSelectionMembershipKind(
	selection: ContextBridgeSelection,
	resourcePath: string,
	isFolder: boolean
): ResourceMembershipKind | undefined {
	if (hasExactPathItem(selection.items, resourcePath)) {
		return 'direct';
	}

	if (isIncludedViaFolder(selection.items, selection.excludeItems, resourcePath)) {
		return 'insideSelectedFolder';
	}

	if (isFolder && hasDirectDescendantItem(selection.items, resourcePath)) {
		return 'containsSelectedDescendant';
	}

	return undefined;
}

