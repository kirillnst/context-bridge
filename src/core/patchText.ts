export interface ContextBridgePatchSearchReplace {
	search: string;
	replace: string;
}

interface RelativeIndentationMatch {
	start: number;
	end: number;
	indentation: string;
}

interface TextLine {
	text: string;
	start: number;
	end: number;
}

export function applyPatchModifyOperations(
	value: string,
	operations: ContextBridgePatchSearchReplace[]
): string {
	let nextValue = value;

	for (const [index, operation] of operations.entries()) {
		if (operation.search === '*') {
			nextValue = operation.replace;
			continue;
		}

		if (operation.search.length === 0) {
			throw new Error(`Search block #${index + 1} is empty.`);
		}

		const exactMatches = countExactMatches(nextValue, operation.search);
		if (exactMatches > 1) {
			throw new Error(
				`Search block #${index + 1} was found ${exactMatches} time(s); replacement is ambiguous.`
			);
		}

		if (exactMatches === 1) {
			nextValue = replaceSingleMatch(nextValue, operation.search, operation.replace);
			continue;
		}

		const indentationMatches = findRelativeIndentationMatches(
			nextValue,
			operation.search
		);
		if (indentationMatches.length === 0) {
			throw new Error(
				`Search block #${index + 1} was not found exactly or by relative indentation.`
			);
		}

		if (indentationMatches.length > 1) {
			throw new Error(
				`Search block #${index + 1} was found ${indentationMatches.length} time(s) by relative indentation; replacement is ambiguous.`
			);
		}

		const match = indentationMatches[0];
		const replacement = applyBaseIndentation(operation.replace, match.indentation);
		nextValue = replaceRange(nextValue, match.start, match.end, replacement);
	}

	return nextValue;
}

function findRelativeIndentationMatches(
	value: string,
	search: string
): RelativeIndentationMatch[] {
	const valueLines = splitTextLines(value);
	const searchLines = search.split('\n');
	const normalizedSearch = removeBaseIndentation(searchLines);
	const matches: RelativeIndentationMatch[] = [];

	for (let index = 0; index <= valueLines.length - searchLines.length; index += 1) {
		const candidateLines = valueLines
			.slice(index, index + searchLines.length)
			.map((line) => line.text);
		const indentation = findCommonIndentation(candidateLines);
		const normalizedCandidate = removeIndentation(candidateLines, indentation);

		if (!areLinesEqual(normalizedCandidate, normalizedSearch)) {
			continue;
		}

		const firstLine = valueLines[index];
		const lastLine = valueLines[index + searchLines.length - 1];
		matches.push({
			start: firstLine.start,
			end: lastLine.end,
			indentation,
		});
	}

	return matches;
}

function applyBaseIndentation(value: string, indentation: string): string {
	return removeBaseIndentation(value.split('\n'))
		.map((line) => (line.length === 0 ? '' : indentation + line))
		.join('\n');
}

function removeBaseIndentation(lines: string[]): string[] {
	return removeIndentation(lines, findCommonIndentation(lines));
}

function removeIndentation(lines: string[], indentation: string): string[] {
	return lines.map((line) => {
		if (line.trim().length === 0) {
			return '';
		}

		return line.slice(indentation.length);
	});
}

function findCommonIndentation(lines: string[]): string {
	let commonIndentation: string | undefined;

	for (const line of lines) {
		if (line.trim().length === 0) {
			continue;
		}

		const indentation = line.match(/^[ \t]*/)?.[0] ?? '';
		commonIndentation =
			commonIndentation === undefined
				? indentation
				: commonPrefix(commonIndentation, indentation);

		if (commonIndentation.length === 0) {
			break;
		}
	}

	return commonIndentation ?? '';
}

function commonPrefix(left: string, right: string): string {
	let length = 0;
	while (length < left.length && left[length] === right[length]) {
		length += 1;
	}

	return left.slice(0, length);
}

function areLinesEqual(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

function splitTextLines(value: string): TextLine[] {
	let start = 0;
	return value.split('\n').map((text) => {
		const line = {
			text,
			start,
			end: start + text.length,
		};
		start = line.end + 1;
		return line;
	});
}

function countExactMatches(value: string, search: string): number {
	if (search.length === 0) {
		return 0;
	}

	let count = 0;
	let cursor = 0;

	while (cursor <= value.length) {
		const matchIndex = value.indexOf(search, cursor);
		if (matchIndex < 0) {
			break;
		}

		count += 1;
		cursor = matchIndex + search.length;
	}

	return count;
}

function replaceSingleMatch(value: string, search: string, replace: string): string {
	const matchIndex = value.indexOf(search);
	if (matchIndex < 0) {
		return value;
	}

	return replaceRange(value, matchIndex, matchIndex + search.length, replace);
}

function replaceRange(value: string, start: number, end: number, replace: string): string {
	return value.slice(0, start) + replace + value.slice(end);
}
