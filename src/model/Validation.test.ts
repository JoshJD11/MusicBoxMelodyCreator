import { BuiltInProfiles, validateMusicBoxProfile } from './IMusicBoxProfile';
import { validateFormatOptions } from './IMusicBoxSvgFormatOptions';

describe('validateMusicBoxProfile', () => {
    it('accepts the built-in profiles', () => {
        Object.keys(BuiltInProfiles).forEach(key => {
            expect(validateMusicBoxProfile(BuiltInProfiles[key])).toEqual([]);
        });
    });

    it('rejects empty, zero and negative values', () => {
        const base = BuiltInProfiles['thirtyNote'];
        expect(validateMusicBoxProfile({ ...base, millimetersPerSecond: 0 })).toHaveLength(1);
        expect(validateMusicBoxProfile({ ...base, holeDiameterMm: NaN })).toHaveLength(1);
        expect(validateMusicBoxProfile({ ...base, paperWidthMm: -1 })).toHaveLength(1);
        expect(validateMusicBoxProfile({ ...base, minNoteGapMm: -0.1 })).toHaveLength(1);
        expect(validateMusicBoxProfile({ ...base, minNoteGapMm: 0 })).toEqual([]);
    });

    it('rejects a content area whose outer holes would not fit in the paper', () => {
        const base = BuiltInProfiles['thirtyNote']; // 70.1 mm paper, 2 mm holes
        expect(validateMusicBoxProfile({ ...base, contentWidthMm: 68.1 })).toEqual([]);
        expect(validateMusicBoxProfile({ ...base, contentWidthMm: 68.2 })).toHaveLength(1);
    });
});

describe('validateFormatOptions', () => {
    const options = {
        pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true,
        omitPageBoundaries: false, transposeOutOfRangeNotes: true, jigsawJoiners: false, loopMode: false,
    };

    it('accepts 0 (no limit) and positive sizes', () => {
        expect(validateFormatOptions(options)).toEqual([]);
        expect(validateFormatOptions({ ...options, pageWidthMm: 0, pageHeightMm: 0, startPaddingMm: 0 })).toEqual([]);
    });

    it('rejects negative or empty values', () => {
        expect(validateFormatOptions({ ...options, pageWidthMm: -1 })).toHaveLength(1);
        expect(validateFormatOptions({ ...options, startPaddingMm: NaN })).toHaveLength(1);
    });
});
