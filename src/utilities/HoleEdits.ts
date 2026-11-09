/**
 * Holes deleted by hand in the preview, with the history needed to undo every change. A hole is
 * identified by its note's id (`IMusicBoxNote.id`), so the deletions survive changes of the
 * settings (profile, paper, track...) for as long as the same file is loaded.
 *
 * Every function returns a new object (or the same one when nothing changes), never modifies its
 * arguments.
 */
export interface IHoleEdits {
    /** Ids of the deleted holes. */
    readonly deleted: ReadonlySet<string>;
    /** The previous values of `deleted`, oldest first: undo restores the last one. */
    readonly history: ReadonlyArray<ReadonlySet<string>>;
}

export const NO_HOLE_EDITS: IHoleEdits = Object.freeze({ deleted: new Set<string>(), history: [] });

/** Deletes the given holes (one undo step). Holes that are already deleted are ignored. */
export function deleteHoles(edits: IHoleEdits, ids: Iterable<string>): IHoleEdits {
    const deleted = new Set(edits.deleted);
    for (const id of ids) {
        deleted.add(id);
    }
    if (deleted.size === edits.deleted.size) {
        return edits;
    }
    return { deleted, history: [...edits.history, edits.deleted] };
}

/** Brings back every deleted hole. It is one more step, so it can be undone too. */
export function restoreAllHoles(edits: IHoleEdits): IHoleEdits {
    if (edits.deleted.size === 0) {
        return edits;
    }
    return { deleted: new Set<string>(), history: [...edits.history, edits.deleted] };
}

export function canUndoHoleEdit(edits: IHoleEdits): boolean {
    return edits.history.length > 0;
}

/** Goes back to the state before the last deletion or "restore all". */
export function undoHoleEdit(edits: IHoleEdits): IHoleEdits {
    if (!canUndoHoleEdit(edits)) {
        return edits;
    }
    return {
        deleted: edits.history[edits.history.length - 1],
        history: edits.history.slice(0, -1),
    };
}
