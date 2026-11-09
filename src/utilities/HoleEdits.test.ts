import {
    canUndoHoleEdit,
    deleteHoles,
    IHoleEdits,
    NO_HOLE_EDITS,
    restoreAllHoles,
    undoHoleEdit,
} from './HoleEdits';

const ids = (edits: IHoleEdits) => [...edits.deleted].sort();

describe('HoleEdits', () => {
    it('starts with nothing deleted and nothing to undo', () => {
        expect(ids(NO_HOLE_EDITS)).toEqual([]);
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
});
