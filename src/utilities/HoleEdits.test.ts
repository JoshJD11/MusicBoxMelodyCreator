import {
    addHole,
    canUndoHoleEdit,
    deleteHoles,
    hasHoleEdits,
    IHoleEdits,
    NO_HOLE_EDITS,
    restoreAllHoles,
    undoHoleEdit,
} from './HoleEdits';

const ids = (edits: IHoleEdits) => [...edits.deleted].sort();

describe('HoleEdits', () => {
    it('starts with nothing deleted, nothing added and nothing to undo', () => {
        expect(ids(NO_HOLE_EDITS)).toEqual([]);
        expect(NO_HOLE_EDITS.added).toEqual([]);
        expect(hasHoleEdits(NO_HOLE_EDITS)).toBe(false);
        expect(canUndoHoleEdit(NO_HOLE_EDITS)).toBe(false);
        expect(undoHoleEdit(NO_HOLE_EDITS)).toBe(NO_HOLE_EDITS);
        expect(restoreAllHoles(NO_HOLE_EDITS)).toBe(NO_HOLE_EDITS);
    });

    it('deletes holes in steps that are undone one by one, in reverse order', () => {
        const one = deleteHoles(NO_HOLE_EDITS, ['0:3']);
        const two = deleteHoles(one, ['0:7', '1:2']);
        expect(ids(one)).toEqual(['0:3']);
        expect(ids(two)).toEqual(['0:3', '0:7', '1:2']);
        expect(canUndoHoleEdit(two)).toBe(true);

        const undoneOnce = undoHoleEdit(two);
        expect(ids(undoneOnce)).toEqual(['0:3']);
        const undoneTwice = undoHoleEdit(undoneOnce);
        expect(ids(undoneTwice)).toEqual([]);
        expect(canUndoHoleEdit(undoneTwice)).toBe(false);
    });

    it('ignores holes that are already deleted (no empty undo steps)', () => {
        const one = deleteHoles(NO_HOLE_EDITS, ['0:3']);
        expect(deleteHoles(one, ['0:3'])).toBe(one);
        expect(deleteHoles(one, [])).toBe(one);
        const two = deleteHoles(one, ['0:3', '0:4']);
        expect(two.history.length).toBe(2);
        expect(ids(undoHoleEdit(two))).toEqual(['0:3']);
    });

    it('restores every hole in one step, which can be undone', () => {
        const edits = deleteHoles(deleteHoles(NO_HOLE_EDITS, ['0:1']), ['0:2', '0:3']);
        const restored = restoreAllHoles(edits);
        expect(ids(restored)).toEqual([]);
        expect(canUndoHoleEdit(restored)).toBe(true);

        const undone = undoHoleEdit(restored);
        expect(ids(undone)).toEqual(['0:1', '0:2', '0:3']);
        // The earlier steps are still there.
        expect(ids(undoHoleEdit(undone))).toEqual(['0:1']);
    });

    it('never modifies the objects it receives', () => {
        const one = deleteHoles(NO_HOLE_EDITS, ['0:1']);
        const snapshot = ids(one);
        deleteHoles(one, ['0:2']);
        restoreAllHoles(one);
        undoHoleEdit(one);
        expect(ids(one)).toEqual(snapshot);
        expect(ids(NO_HOLE_EDITS)).toEqual([]);
        expect(NO_HOLE_EDITS.history.length).toBe(0);
    });

    it('adds holes with ids of their own (never a note of the file), one undo step each', () => {
        const one = addHole(NO_HOLE_EDITS, 72, 1.5);
        const two = addHole(one, 60, 0.25);
        expect(one.added).toEqual([{ id: 'added:1', note: 72, timeSeconds: 1.5 }]);
        expect(two.added).toEqual([{ id: 'added:1', note: 72, timeSeconds: 1.5 }, { id: 'added:2', note: 60, timeSeconds: 0.25 }]);
        expect(hasHoleEdits(one)).toBe(true);
        expect(ids(two)).toEqual([]);

        const undone = undoHoleEdit(two);
        expect(undone.added).toEqual(one.added);
        expect(undoHoleEdit(undone).added).toEqual([]);
        // The number of a hole that was undone is never used again.
        expect(addHole(undone, 64, 2).added.slice(-1)[0].id).toBe('added:3');
    });

    it('ignores a time that is not a number of at least 0 (nothing changes)', () => {
        expect(addHole(NO_HOLE_EDITS, 60, -0.1)).toBe(NO_HOLE_EDITS);
        expect(addHole(NO_HOLE_EDITS, 60, NaN)).toBe(NO_HOLE_EDITS);
        expect(addHole(NO_HOLE_EDITS, 60, Infinity)).toBe(NO_HOLE_EDITS);
        expect(addHole(NO_HOLE_EDITS, 60, 0).added.length).toBe(1);
    });

    it('an added hole can be deleted like any other, and deletions keep the added holes', () => {
        const added = addHole(NO_HOLE_EDITS, 72, 1.5);
        const deleted = deleteHoles(added, ['added:1', '0:3']);
        expect(ids(deleted)).toEqual(['0:3', 'added:1']);
        expect(deleted.added).toEqual(added.added);
        expect(ids(undoHoleEdit(deleted))).toEqual([]);
    });

    it('restore all goes back to the holes of the file: removes the added holes too, in one undoable step', () => {
        const edits = deleteHoles(addHole(NO_HOLE_EDITS, 72, 1.5), ['0:1']);
        const restored = restoreAllHoles(edits);
        expect(ids(restored)).toEqual([]);
        expect(restored.added).toEqual([]);
        expect(hasHoleEdits(restored)).toBe(false);
        const undone = undoHoleEdit(restored);
        expect(ids(undone)).toEqual(['0:1']);
        expect(undone.added).toEqual(edits.added);
        // Only added holes: restore all still has something to do.
        expect(restoreAllHoles(addHole(NO_HOLE_EDITS, 60, 0)).added).toEqual([]);
    });
});
