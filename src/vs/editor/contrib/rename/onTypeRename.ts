/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./onTypeRename';
import { registerEditorContribution, registerModelAndPositionCommand } from 'vs/editor/browser/editorExtensions';
import * as arrays from 'vs/base/common/arrays';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { Disposable } from 'vs/base/common/lifecycle';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { EditorOption } from 'vs/editor/common/config/editorOptions';
import { Position } from 'vs/editor/common/core/position';
import { ITextModel, IModelDeltaDecoration, TrackedRangeStickiness } from 'vs/editor/common/model';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IRange, Range } from 'vs/editor/common/core/range';
import { OnTypeRenameProviderRegistry } from 'vs/editor/common/modes';
import { first, createCancelablePromise, CancelablePromise } from 'vs/base/common/async';
import { onUnexpectedExternalError, onUnexpectedError } from 'vs/base/common/errors';
import { ModelDecorationOptions } from 'vs/editor/common/model/textModel';

function isWithin(inner: IRange, outer: IRange) {
	return outer.startLineNumber <= inner.startLineNumber &&
		outer.endLineNumber >= inner.endLineNumber &&
		outer.startColumn <= inner.startColumn &&
		outer.endColumn >= inner.endColumn;
}

class OnTypeRenameContribution extends Disposable implements IEditorContribution {

	public static readonly ID = 'editor.contrib.onTypeRename';

	private static readonly DECORATION = ModelDecorationOptions.register({
		stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
		className: 'on-type-rename-decoration'
	});

	private readonly _editor: ICodeEditor;
	private _enabled: boolean;

	private _currentRequest: CancelablePromise<IRange[] | null | undefined> | null;
	private _currentDecorations: string[];

	private _syncedRanges: IRange[] | null | undefined;

	constructor(
		editor: ICodeEditor,
	) {
		super();
		this._editor = editor;
		this._enabled = this._editor.getOption(EditorOption.autoRename);
		this._currentRequest = null;
		this._currentDecorations = [];

		this._register(this._editor.onDidChangeModel((e) => {
			this._stopAll();
			this._run();
		}));

		this._register(this._editor.onDidChangeConfiguration((e) => {
			if (e.hasChanged(EditorOption.autoRename)) {
				this._enabled = this._editor.getOption(EditorOption.autoRename);
				this._stopAll();
				this._run();
			}
		}));

		this._register(this._editor.onDidChangeCursorPosition((e) => {
			this._run(e.position);
		}));

		this._register(OnTypeRenameProviderRegistry.onDidChange(() => {
			this._run();
		}));

		this._register(this._editor.onDidChangeModelContent((e) => {
			if (!this._editor.hasModel()) {
				return;
			}
			const model = this._editor.getModel();
			// TODO
			console.log(`buffer changed!`);

			if (e.changes.length === 1) {
				const change = e.changes[0];
				if (change.rangeLength === 0) {
					if (this._syncedRanges && this._syncedRanges.length > 0) {
						if (isWithin(change.range, this._syncedRanges[0])) {
							const firstStartOffset = this._editor.getModel().getOffsetAt(new Position(this._syncedRanges[0].startLineNumber, this._syncedRanges[0].startColumn));
							// const secondEndOffset = this._editor.getModel().getOffsetAt(new Position(this._syncedRanges[1].endLineNumber, this._syncedRanges[1].endColumn));
							// console.log(secondEndOffset);

							const targetRange = new Range(
								this._syncedRanges[1].startLineNumber,
								this._syncedRanges[1].startColumn + (change.rangeOffset - firstStartOffset),
								this._syncedRanges[1].startLineNumber,
								this._syncedRanges[1].startColumn + (change.rangeOffset - firstStartOffset)
							);

							this._editor.executeEdits('foo', [
								{
									range: targetRange,
									text: change.text
								}
							]);
						}
					}
				}

			}

			console.log(this._currentDecorations.map(id => model.getDecorationRange(id)));
		}));
	}

	public dispose(): void {
		super.dispose();
		this._stopAll();
	}

	private _stopAll(): void {
		this._currentDecorations = this._editor.deltaDecorations(this._currentDecorations, []);
	}

	private _run(position: Position | null = this._editor.getPosition()): void {
		if (!this._enabled || !position) {
			return;
		}
		if (!this._editor.hasModel()) {
			return;
		}

		if (this._currentRequest) {
			this._currentRequest.cancel();
			this._currentRequest = null;
		}

		const model = this._editor.getModel();

		this._currentRequest = createCancelablePromise(token => getOnTypeRenameRanges(model, position, token));

		this._currentRequest.then((value) => {
			if (!value) {
				value = [];
			}
			const decorations: IModelDeltaDecoration[] = value.map(range => ({ range: range, options: OnTypeRenameContribution.DECORATION }));
			this._syncedRanges = value;
			this._currentDecorations = this._editor.deltaDecorations(this._currentDecorations, decorations);
		}, err => onUnexpectedError(err));
	}
}

export function getOnTypeRenameRanges(model: ITextModel, position: Position, token: CancellationToken): Promise<IRange[] | null | undefined> {

	const orderedByScore = OnTypeRenameProviderRegistry.ordered(model);

	// in order of score ask the occurrences provider
	// until someone response with a good result
	// (good = none empty array)
	return first<IRange[] | null | undefined>(orderedByScore.map(provider => () => {
		return Promise.resolve(provider.provideOnTypeRenameRanges(model, position, token))
			.then(undefined, onUnexpectedExternalError);
	}), arrays.isNonEmptyArray);
}

registerModelAndPositionCommand('_executeRenameOnTypeProvider', (model, position) => getOnTypeRenameRanges(model, position, CancellationToken.None));

registerEditorContribution(OnTypeRenameContribution.ID, OnTypeRenameContribution);
