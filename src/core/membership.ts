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

export function buildDecorationBadge(memberships: ResourceMembershipInfo[]): string {
	if (memberships.length === 1) {
		return memberships[0].selection.short;
	}

	return memberships.length < 10 ? String(memberships.length) : '+';
}

export function buildDecorationTooltip(memberships: ResourceMembershipInfo[]): string {
	const lines = memberships.map((membership) => {
		const state = membership.selection.active ? 'active' : 'inactive';
		const mode =
			membership.kind === 'direct'
				? 'directly'
				: membership.kind === 'insideSelectedFolder'
					? 'through selected folder'
					: 'contains selected items';

		return `${membership.selection.name} [${membership.selection.short}] (${state}) — ${mode}`;
	});

	return `Context Bridge\n${lines.join('\n')}`;
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

