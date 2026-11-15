import { addedNoteId, IAddedNote } from './MusicBoxNotes';
import { MidiNote } from '../model/MidiConstants';

/**
 * Holes deleted and added by hand in the preview, with the history needed to undo every change. A
 * hole is identified by its note's id (`IMusicBoxNote.id`), so the edits survive changes of the
 * settings (profile, paper, track...) for as long as the same file is loaded.
 *
 * Every function returns a new object (or the same one when nothing changes), never modifies its
 * arguments.
 */
export interface IHoleEditsSnapshot {
    /** Ids of the deleted holes (of the file or added by hand). */
    readonly deleted: ReadonlySet<string>;
    /** Holes added by hand, in the order they were added (times in the file's timeline). */
    readonly added: ReadonlyArray<IAddedNote>;
}

export interface IHoleEdits extends IHoleEditsSnapshot {
    /** The previous states, oldest first: undo restores the last one. */
    readonly history: ReadonlyArray<IHoleEditsSnapshot>;
    /** Number of the next hole added by hand: ids are never reused, not even after undo. */
    readonly nextAddedNumber: number;
}

export const NO_HOLE_EDITS: IHoleEdits = Object.freeze({
    deleted: new Set<string>(),
    added: [] as ReadonlyArray<IAddedNote>,
    history: [],
    nextAddedNumber: 1,
});

/** `edits` changed to `next` (one undo step). */
function step(edits: IHoleEdits, next: IHoleEditsSnapshot, nextAddedNumber = edits.nextAddedNumber): IHoleEdits {
    return {
        deleted: next.deleted,
        added: next.added,
        history: [...edits.history, { deleted: edits.deleted, added: edits.added }],
        nextAddedNumber,
    };
}

/** Whether any hole was deleted or added (compared to the file). */
export function hasHoleEdits(edits: IHoleEditsSnapshot): boolean {
    return edits.deleted.size > 0 || edits.added.length > 0;
}

/** Deletes the given holes (one undo step). Holes that are already deleted are ignored. */
export function deleteHoles(edits: IHoleEdits, ids: Iterable<string>): IHoleEdits {
    const deleted = new Set(edits.deleted);
    for (const id of ids) {
        deleted.add(id);
    }
    if (deleted.size === edits.deleted.size) {
        return edits;
    }
    return step(edits, { deleted, added: edits.added });
}

/**
 * Adds a hole of `note` at `timeSeconds` of the file's timeline (one undo step). A time that is not
 * a number of at least 0 is ignored (nothing changes).
 */
export function addHole(edits: IHoleEdits, note: MidiNote, timeSeconds: number): IHoleEdits {
    if (!Number.isFinite(timeSeconds) || timeSeconds < 0) {
        return edits;
    }
    const added: IAddedNote = { id: addedNoteId(edits.nextAddedNumber), note, timeSeconds };
    return step(edits, { deleted: edits.deleted, added: [...edits.added, added] }, edits.nextAddedNumber + 1);
}

/**
 * Back to the holes of the file: brings back every deleted hole and removes every added one. It is
 * one more step, so it can be undone too.
 */
export function restoreAllHoles(edits: IHoleEdits): IHoleEdits {
    if (!hasHoleEdits(edits)) {
        return edits;
    }
    return step(edits, { deleted: new Set<string>(), added: [] });
}

export function canUndoHoleEdit(edits: IHoleEdits): boolean {
    return edits.history.length > 0;
}

/** Goes back to the state before the last deletion, addition or "restore all". */
export function undoHoleEdit(edits: IHoleEdits): IHoleEdits {
    if (!canUndoHoleEdit(edits)) {
        return edits;
    }
    const previous = edits.history[edits.history.length - 1];
    return {
        deleted: previous.deleted,
        added: previous.added,
        history: edits.history.slice(0, -1),
        nextAddedNumber: edits.nextAddedNumber,
    };
}
