import { rebaseEdits } from './rebaseEdits';

describe('rebaseEdits', () => {
    const previous = { width: 250, height: 200, padding: 10, border: false };

    it('takes the new value of every field changed from outside', () => {
        const next = { ...previous, width: 555, height: 70.1, border: true };
        expect(rebaseEdits(previous, previous, next)).toEqual(next);
    });

    it('keeps the unapplied edits of the other fields', () => {
        const edited = { ...previous, padding: 3 };
        const next = { ...previous, width: 555 };
        expect(rebaseEdits(edited, previous, next)).toEqual({ ...previous, width: 555, padding: 3 });
    });

    it('lets the outside change win over an unapplied edit of the same field', () => {
        const edited = { ...previous, width: 190 };
        expect(rebaseEdits(edited, previous, { ...previous, width: 555 }).width).toBe(555);
    });

    it('changes nothing when nothing changed from outside', () => {
        const edited = { ...previous, padding: 3 };
        expect(rebaseEdits(edited, previous, { ...previous })).toEqual(edited);
    });

    it('handles optional fields that appear or disappear', () => {
        type Options = { width: number; mirror?: boolean };
        const before: Options = { width: 1 };
        expect(rebaseEdits<Options>(before, before, { width: 1, mirror: true })).toEqual({ width: 1, mirror: true });
        expect(rebaseEdits<Options>({ width: 1, mirror: true }, { width: 1, mirror: true }, { width: 1 }).mirror).toBeUndefined();
    });
});
