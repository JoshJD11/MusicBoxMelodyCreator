import './HoleEditToolbar.css';
import * as React from 'react';
import { Button, Intent } from '@blueprintjs/core';

export interface IHoleEditToolbarProps {
    /** Selected holes that are on the strip. */
    selectedCount: number;
    /** Holes of the strip that were deleted by hand. */
    deletedCount: number;
    canUndo: boolean;
    canRestore: boolean;
    onDelete(): void;
    onClearSelection(): void;
    onUndo(): void;
    onRestoreAll(): void;
}

/** "⌘Z" on Apple devices, "Ctrl+Z" elsewhere (both work everywhere). */
function undoShortcut(): string {
    const platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
    return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘Z' : 'Ctrl+Z';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Buttons to delete the selected holes of the preview, undo and bring every hole back. */
export function HoleEditToolbar(props: IHoleEditToolbarProps) {
    const { selectedCount, deletedCount, canUndo, canRestore } = props;
    const shortcut = undoShortcut();

    return (
        <div className="mb-holeEditor" role="group" aria-label="Delete holes">
            <p className="mb-holeEditor-hint">
                <span className="mb-holeEditor-hintPointer">
                    Click a hole to select it (click again to unselect). Delete the selected holes with the
                    button or the Backspace / Delete key; {shortcut} undoes.
                </span>
                <span className="mb-holeEditor-hintTouch">
                    Tap a hole to select it (tap again to unselect), then press Delete.
                </span>
            </p>
            <div className="mb-holeEditor-row">
                <div className="mb-holeEditor-actions">
                    <Button
                        icon="trash"
                        intent={selectedCount > 0 ? Intent.DANGER : Intent.NONE}
                        text={selectedCount > 0 ? `Delete ${plural(selectedCount, 'hole')}` : 'Delete'}
                        disabled={selectedCount === 0}
                        title="Delete the selected holes (Backspace or Delete key)"
                        onClick={props.onDelete}
                    />
                    {selectedCount > 0 && (
                        <Button
                            minimal={true}
                            icon="cross"
                            text="Unselect"
                            title="Unselect every hole (Esc)"
                            onClick={props.onClearSelection}
                        />
                    )}
                    <Button
                        icon="undo"
                        text="Undo"
                        disabled={!canUndo}
                        title={`Undo the last change (${shortcut})`}
                        onClick={props.onUndo}
                    />
                    <Button
                        icon="reset"
                        text="Restore all"
                        disabled={!canRestore}
                        title="Bring back every deleted hole (can be undone)"
                        onClick={props.onRestoreAll}
                    />
                </div>
                <p className="mb-holeEditor-status" aria-live="polite">
                    {deletedCount > 0 ? `${plural(deletedCount, 'hole')} deleted` : 'No holes deleted'}
                    {selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
                </p>
            </div>
        </div>
    );
}
