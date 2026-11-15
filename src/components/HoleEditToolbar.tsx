import './HoleEditToolbar.css';
import * as React from 'react';
import { Button, Switch } from '@blueprintjs/core';

export interface IHoleEditToolbarProps {
    /** Holes of the file that were deleted by hand. */
    deletedCount: number;
    /** Holes added by hand that are on the strip. */
    addedCount: number;
    canUndo: boolean;
    canRestore: boolean;
    /** Whether the note lines (with the note names) are drawn along the strips. */
    showNoteLines: boolean;
    /** Whether the beats of the file are drawn across the strips. */
    showBeatLines: boolean;
    /** A short message about the last action (e.g. why a hole could not be added). */
    notice?: string;
    onUndo(): void;
    onRestoreAll(): void;
    onToggleNoteLines(show: boolean): void;
    onToggleBeatLines(show: boolean): void;
}

/** "⌘Z" on Apple devices, "Ctrl+Z" elsewhere (both work everywhere). */
function undoShortcut(): string {
    const platform = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
    return /Mac|iPhone|iPad|iPod/.test(platform) ? '⌘Z' : 'Ctrl+Z';
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Undo, back to the holes of the file, and the guides of the preview (holes are added and removed by clicking). */
export function HoleEditToolbar(props: IHoleEditToolbarProps) {
    const { deletedCount, addedCount, canUndo, canRestore, showNoteLines, showBeatLines, notice } = props;
    const shortcut = undoShortcut();
    const changes = [
        deletedCount > 0 ? `${plural(deletedCount, 'hole')} deleted` : null,
        addedCount > 0 ? `${plural(addedCount, 'hole')} added` : null,
    ].filter((text): text is string => text !== null);

    return (
        <div className="mb-holeEditor" role="group" aria-label="Add and delete holes">
            <p className="mb-holeEditor-hint">
                <span className="mb-holeEditor-hintPointer">
                    Click an empty spot of a strip to add a hole on the nearest note line (its note is shown).
                    Click a hole to remove it. {shortcut} undoes.
                </span>
                <span className="mb-holeEditor-hintTouch">
                    Tap an empty spot of a strip to add a hole on the nearest note line. Tap a hole to remove
                    it; Undo brings it back.
                </span>
            </p>
            <div className="mb-holeEditor-row">
                <div className="mb-holeEditor-actions">
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
                        title="Back to the holes of the file: brings back the deleted holes and removes the added ones (can be undone)"
                        onClick={props.onRestoreAll}
                    />
                    <Switch
                        className="mb-holeEditor-switch"
                        checked={showNoteLines}
                        label="Note lines"
                        title="Draw a line per note along the strips, with its name (on screen only, never in the DXF)"
                        onChange={(event) => props.onToggleNoteLines(event.currentTarget.checked)}
                    />
                    <Switch
                        className="mb-holeEditor-switch"
                        checked={showBeatLines}
                        label="Beat lines"
                        title="Draw the beats of the file across the strips (quarter notes dark, eighth notes light, sixteenth notes as short marks), from its tempo (on screen only, never in the DXF)"
                        onChange={(event) => props.onToggleBeatLines(event.currentTarget.checked)}
                    />
                </div>
                <p className="mb-holeEditor-status" aria-live="polite">
                    {changes.length > 0 ? changes.join(' · ') : 'No holes added or deleted'}
                </p>
            </div>
            {notice && (
                <p className="mb-holeEditor-notice" role="status">
                    {notice}
                </p>
            )}
        </div>
    );
}
