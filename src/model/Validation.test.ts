import { BuiltInProfiles, validateMusicBoxProfile } from './IMusicBoxProfile';
import { isStripOrientation, sheetDimensionNames, validateFormatOptions } from './IMusicBoxSvgFormatOptions';

describe('validateMusicBoxProfile', () => {
    it('uses holes 0.2 mm larger than the original musicbox-svg profiles by default', () => {
        expect(BuiltInProfiles['fifteenNote'].holeDiameterMm).toBe(2.0); // was 1.8
        expect(BuiltInProfiles['thirtyNote'].holeDiameterMm).toBe(2.2);  // was 2.0
    });

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
        const base = { ...BuiltInProfiles['thirtyNote'], holeDiameterMm: 2 }; // 70.1 mm paper, 2 mm holes
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

    it('names the sheet dimensions as they are with the chosen orientation', () => {
        expect(validateFormatOptions({ ...options, pageWidthMm: -1, pageHeightMm: -1 }))
            .toEqual(['Sheet width must be a number of at least 0.', 'Sheet height must be a number of at least 0.']);
        // Vertical strips: the strip length is the sheet height and the strips are side by side.
        expect(validateFormatOptions({ ...options, pageWidthMm: -1, pageHeightMm: -1, stripOrientation: 'vertical' }))
            .toEqual(['Sheet height must be a number of at least 0.', 'Sheet width must be a number of at least 0.']);
    });
});

describe('strip orientation', () => {
    it('recognizes only the supported orientations', () => {
        expect(isStripOrientation('horizontal')).toBe(true);
        expect(isStripOrientation('vertical')).toBe(true);
        expect(isStripOrientation('diagonal')).toBe(false);
        expect(isStripOrientation(undefined)).toBe(false);
    });

    it('swaps the dimension names for vertical strips', () => {
        expect(sheetDimensionNames()).toEqual({ alongStrips: 'Sheet width', acrossStrips: 'Sheet height' });
        expect(sheetDimensionNames('vertical')).toEqual({ alongStrips: 'Sheet height', acrossStrips: 'Sheet width' });
    });
});
