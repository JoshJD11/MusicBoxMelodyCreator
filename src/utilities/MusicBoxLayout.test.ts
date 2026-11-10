import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles, IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import {
    buildSheets, buildStripGeometry, computeMusicBoxLayout, CUT_CLEARANCE_MM, getNoteLinePositions, IMusicBoxLayout,
    fitSingleStrip, JIGSAW_WIDTH_MM, paginateNotes, STRIP_SPACING_MM,
} from './MusicBoxLayout';
import { extractMusicBoxNotes, IMusicBoxNote } from './MusicBoxNotes';
import { createDxf } from './DxfExporter';
import { parseDxf } from './DxfReader';

const FORMAT: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250,
    pageHeightMm: 200,
    startPaddingMm: 10,
    renderBorder: true,
    omitPageBoundaries: false,
    transposeOutOfRangeNotes: true,
    jigsawJoiners: false,
    loopMode: false,
};

const FORMAT_VARIANTS: { [name: string]: IMusicBoxSvgFormatOptions } = {
    default: FORMAT,
    jigsaw: { ...FORMAT, jigsawJoiners: true },
    jigsawLoop: { ...FORMAT, jigsawJoiners: true, loopMode: true },
    omitBoundaries: { ...FORMAT, omitPageBoundaries: true },
    noTranspose: { ...FORMAT, transposeOutOfRangeNotes: false },
    unlimited: { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 },
    letter190x277: { ...FORMAT, pageWidthMm: 190, pageHeightMm: 277 },
    narrow85: { ...FORMAT, pageWidthMm: 85, pageHeightMm: 3000 },
    smallPadding: { ...FORMAT, startPaddingMm: 3 },
    mirrored: { ...FORMAT, mirrorVertically: true },
    mirroredJigsawLoop: { ...FORMAT, mirrorVertically: true, jigsawJoiners: true, loopMode: true },
    vertical: { ...FORMAT, stripOrientation: 'vertical' },
    verticalJigsawLoop: { ...FORMAT, stripOrientation: 'vertical', jigsawJoiners: true, loopMode: true },
    verticalUnlimited: { ...FORMAT, stripOrientation: 'vertical', pageWidthMm: 0, pageHeightMm: 0 },
    vertical277x190: { ...FORMAT, stripOrientation: 'vertical', pageWidthMm: 277, pageHeightMm: 190 },
    verticalMirrored: { ...FORMAT, stripOrientation: 'vertical', mirrorVertically: true },
};

const SAMPLES = [
    'happy_birthday.mid',
    'ode_to_joy.mid',
    'You are my sunshine.mid',
];

const EPSILON = 1e-9;

function loadSample(name: string): MidiFile {
    const b = fs.readFileSync(path.resolve(__dirname, '../../samples', name));
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return midiFile;
}

function notesAt(times: number[], note = 60): IMusicBoxNote[] {
    return times.map((t, i) => ({
        id: '0:' + i, note, originalNote: note, timeSeconds: t, velocity: 100, durationSeconds: 0.5, channel: 0, trackIndex: 0,
    }));
}

/** Checks every physical guarantee of a layout. */
function expectPhysicallyValid(layout: IMusicBoxLayout, profile: IMusicBoxProfile, format: IMusicBoxSvgFormatOptions) {
    const mmPerSecond = profile.millimetersPerSecond;
    const radius = profile.holeDiameterMm / 2;
    const firstPageStart = layout.pages[0].startTimeInSeconds;

    // Every punched note is on exactly one page, in order, and pages are contiguous.
    expect(layout.pages.flatMap(p => p.notes)).toEqual(layout.extraction.notes);
    for (let i = 1; i < layout.pages.length; i++) {
        expect(layout.pages[i].startTimeInSeconds).toBe(layout.pages[i - 1].endTimeInSeconds);
    }

    const strips = layout.sheets.flatMap(sheet => sheet.strips.map(strip => ({ sheet, strip })));
    expect(strips.length).toBe(layout.pages.length);

    let stripStartMm = 0;
    strips.forEach(({ sheet, strip }, i) => {
        const geometry = strip.geometry;
        const page = layout.pages[i];

        geometry.circles.forEach((circle, j) => {
            // The hole is at the exact position of its note on the whole tape.
            const absoluteMm = stripStartMm + circle.cx;
            expect(Math.abs(absoluteMm - (page.notes[j].timeSeconds - firstPageStart) * mmPerSecond)).toBeLessThan(1e-6);

            // The hole is completely inside the strip, away from the cuts.
            const leadingLimit = i === 0 ? format.startPaddingMm : CUT_CLEARANCE_MM;
            expect(circle.cx - radius).toBeGreaterThanOrEqual(leadingLimit - EPSILON);
            expect(circle.cx + radius + CUT_CLEARANCE_MM).toBeLessThanOrEqual(geometry.lengthMm + EPSILON);

            // ... and inside the paper width.
            expect(circle.cy - radius).toBeGreaterThan(0);
            expect(circle.cy + radius).toBeLessThan(profile.paperWidthMm);
            expect(circle.r).toBe(radius);
        });

        // Nothing goes outside the sheet.
        const maxX = Math.max(0, ...geometry.lines.map(l => Math.max(l.x1, l.x2)), ...geometry.circles.map(c => c.cx + c.r));
        expect(strip.offsetXMm).toBeGreaterThanOrEqual(0);
        expect(strip.offsetYMm).toBeGreaterThanOrEqual(0);
        expect(strip.offsetXMm + maxX).toBeLessThanOrEqual(sheet.widthMm + EPSILON);
        expect(strip.offsetXMm + geometry.extentMm).toBeLessThanOrEqual(sheet.widthMm + EPSILON);
        expect(strip.offsetYMm + profile.paperWidthMm).toBeLessThanOrEqual(sheet.heightMm + EPSILON);

        stripStartMm += geometry.lengthMm;
    });

    expect(Math.abs(layout.totalPaperLengthMm - stripStartMm)).toBeLessThan(1e-6);

    // Every sheet's block of strips is centered (same margin on both sides, in both axes), the rows
    // never overlap (at least STRIP_SPACING_MM apart) and all strips of a sheet start aligned.
    layout.sheets.forEach(sheet => {
        const first = sheet.strips[0];
        const last = sheet.strips[sheet.strips.length - 1];
        const longest = Math.max(...sheet.strips.map(s => s.geometry.extentMm));
        sheet.strips.forEach(s => expect(s.offsetXMm).toBe(first.offsetXMm));
        expect(Math.abs(first.offsetXMm - (sheet.widthMm - first.offsetXMm - longest))).toBeLessThan(1e-9);
        expect(Math.abs(first.offsetYMm - (sheet.heightMm - last.offsetYMm - profile.paperWidthMm))).toBeLessThan(1e-9);
        for (let j = 1; j < sheet.strips.length; j++) {
            const gap = sheet.strips[j].offsetYMm - (sheet.strips[j - 1].offsetYMm + profile.paperWidthMm);
            expect(gap).toBeGreaterThanOrEqual(STRIP_SPACING_MM - 1e-9);
        }
    });

    // The preview knows the note of every hole: holeNotes[s][j] is the note of the j-th circle of
    // sheet s, in the DXF file itself (checked by position: where that note must be drawn).
    const notePositions = getNoteLinePositions(profile);
    const pageOfNote = new Map<IMusicBoxNote, number>();
    layout.pages.forEach((page, p) => page.notes.forEach(note => pageOfNote.set(note, p)));
    expect(layout.holeNotes.length).toBe(layout.drawings.length);
    expect(layout.holeNotes.flat().length).toBe(layout.extraction.notes.length);
    layout.drawings.forEach((drawing, s) => {
        const circles = parseDxf(createDxf(drawing)).circles;
        expect(circles.length).toBe(layout.holeNotes[s].length);
        layout.holeNotes[s].forEach((note, j) => {
            const p = pageOfNote.get(note) as number;
            const { sheet, strip } = strips[p];
            expect(sheet).toBe(layout.sheets[s]);
            const along = strip.offsetXMm + (note.timeSeconds - layout.pages[p].startTimeInSeconds) * mmPerSecond;
            const line = notePositions.get(note.note) as number;
            const across = format.mirrorVertically ? profile.paperWidthMm - line : line;
            const [x, y] = format.stripOrientation === 'vertical'
                ? [strip.offsetYMm + profile.paperWidthMm - across, along]
                : [along, strip.offsetYMm + across];
            expect(Math.abs(circles[j].cx - x)).toBeLessThan(1e-5);
            expect(Math.abs(circles[j].cy - y)).toBeLessThan(1e-5);
        });
    });

    // What is cut (with the configured orientation) stays inside the sheet, jigsaw tabs included.
    expect(layout.drawings.length).toBe(layout.sheets.length);
    layout.drawings.forEach(drawing => drawing.strips.forEach(strip => {
        const xs = [...strip.lines.flatMap(l => [l.x1, l.x2]), ...strip.circles.flatMap(c => [c.cx - c.r, c.cx + c.r])];
        const ys = [...strip.lines.flatMap(l => [l.y1, l.y2]), ...strip.circles.flatMap(c => [c.cy - c.r, c.cy + c.r])];
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(-EPSILON);
        expect(Math.max(...xs)).toBeLessThanOrEqual(drawing.widthMm + EPSILON);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(-EPSILON);
        expect(Math.max(...ys)).toBeLessThanOrEqual(drawing.heightMm + EPSILON);
    }));
}

describe('layout of the sample songs', () => {
    SAMPLES.forEach(sample => {
        Object.keys(BuiltInProfiles).forEach(profileKey => {
            Object.keys(FORMAT_VARIANTS).forEach(formatKey => {
                it(`${sample} / ${profileKey} / ${formatKey} is physically valid`, () => {
                    const profile = BuiltInProfiles[profileKey];
                    const format = FORMAT_VARIANTS[formatKey];
                    const layout = computeMusicBoxLayout(loadSample(sample), profile, format);
                    expect(layout.extraction.notes.length).toBeGreaterThan(0);
                    expectPhysicallyValid(layout, profile, format);
                });
            });
        });
    });

    it('is deterministic and leaves the MIDI file untouched', () => {
        const midiFile = loadSample(SAMPLES[1]);
        const before = JSON.stringify(midiFile.getTracks());
        const first = computeMusicBoxLayout(midiFile, BuiltInProfiles['fifteenNote'], FORMAT);
        const second = computeMusicBoxLayout(midiFile, BuiltInProfiles['fifteenNote'], FORMAT);
        expect(second).toEqual(first);
        expect(JSON.stringify(midiFile.getTracks())).toBe(before);
    });
});

describe('paginateNotes', () => {
    // The arithmetic below assumes 2 mm holes (independent of the default hole size).
    const profile: IMusicBoxProfile = { ...BuiltInProfiles['thirtyNote'], holeDiameterMm: 2 }; // 20 mm/s
    const format: IMusicBoxSvgFormatOptions = { ...FORMAT, pageWidthMm: 100, startPaddingMm: 10 };
    // First page starts at -(10 + 1) / 20 s = -0.55 s and can hold 100 mm = 5 s, i.e. until 4.45 s.

    it('starts the first hole exactly at the start padding', () => {
        const [page] = paginateNotes(notesAt([0, 1]), profile, format);
        expect(page.startTimeInSeconds).toBe(-0.55);
    });

    it('cuts in the middle between two notes when there is room', () => {
        // The hole at 4.3 s ends at 4.35 s, + 0.5 mm clearance (0.025 s) = 4.375 s <= 4.45 s: it fits.
        // The note at 6 s doesn't. The middle (5.15 s) is past the end of the page, so the cut
        // goes at the end of the page (4.45 s).
        const pages = paginateNotes(notesAt([0, 4.3, 6]), profile, format);
        expect(pages.map(p => p.notes.length)).toEqual([2, 1]);
        expect(pages[0].endTimeInSeconds).toBeCloseTo(4.45, 12);

        // With notes closer to each other, the cut is exactly in the middle.
        const centered = paginateNotes(notesAt([0, 3, 5]), profile, format);
        expect(centered[0].endTimeInSeconds).toBeCloseTo(4, 12);
    });

    it('never cuts closer than the clearance to a hole', () => {
        // A hole at 4.40 s needs until 4.40 + 0.05 + 0.025 = 4.475 s > 4.45 s: it goes to the next page,
        // and the cut must leave room before it: at most 4.40 - 0.075 = 4.325 s.
        const pages = paginateNotes(notesAt([0, 4.4]), profile, format);
        expect(pages.map(p => p.notes.length)).toEqual([1, 1]);
        expect(pages[0].endTimeInSeconds).toBeCloseTo(2.2, 12); // the middle between 0 and 4.4
    });

    it('moves a whole chord to the next page instead of cutting through it', () => {
        // The note at 4.36 s fits (until 4.435 s), the one at 4.39 s doesn't (4.465 s). They are only
        // 0.03 s (0.6 mm) apart: any cut between them would cut through a hole. Both go to the next page.
        const notes = notesAt([0, 4.36, 4.39]);
        notes[2].note = 64;
        const pages = paginateNotes(notes, profile, format);
        expect(pages.map(p => p.notes.map(n => n.timeSeconds))).toEqual([[0], [4.36, 4.39]]);
        expect(pages[0].endTimeInSeconds).toBeCloseTo(2.18, 12);
    });

    it('fails with a clear error when no cut is possible', () => {
        // Notes every 0.05 s (1 mm) on different lines: no gap of 2 * (1 + 0.5) mm anywhere.
        const times = Array.from({ length: 200 }, (_, i) => i * 0.05);
        const notes = notesAt(times).map((n, i) => ({ ...n, note: profile.supportedNotes[i % 30] }));
        expect(() => paginateNotes(notes, profile, format)).toThrow(/Page size too small/);
    });

    it('reserves room for the jigsaw tab', () => {
        const pages = paginateNotes(notesAt([0, 4.3, 6]), profile, { ...format, jigsawJoiners: true });
        // 98 mm usable = 4.9 s: until 4.35 s. The hole at 4.3 s (+ 0.075 s) doesn't fit anymore.
        expect(pages.map(p => p.notes.length)).toEqual([1, 2]);
        expect(pages[0].endTimeInSeconds - pages[0].startTimeInSeconds).toBeLessThanOrEqual((100 - JIGSAW_WIDTH_MM) / 20);
    });

    it('adds 0.5 s of blank paper after the last note when there is room', () => {
        const [page] = paginateNotes(notesAt([0, 1]), profile, format);
        expect(page.endTimeInSeconds).toBe(1.5);
        const [unlimited] = paginateNotes(notesAt([0, 100]), profile, { ...format, pageWidthMm: 0 });
        expect(unlimited.endTimeInSeconds).toBe(100.5);
    });

    it('requires at least one note', () => {
        expect(() => paginateNotes([], profile, format)).toThrow(/No supported MIDI notes/);
    });
});

describe('buildSheets', () => {
    function stripsOf(count: number, lengthMm = 100) {
        return Array.from({ length: count }, () => ({ lengthMm, extentMm: lengthMm, lines: [], circles: [] }));
    }

    it('fits as many strips as possible: spacing is only needed between strips', () => {
        const fifteen = BuiltInProfiles['fifteenNote']; // 41 mm: 4 * 41 + 3 * 10 = 194 <= 200
        const sheets = buildSheets(stripsOf(5), fifteen, FORMAT);
        expect(sheets.map(s => s.strips.length)).toEqual([4, 1]);
        // Centered as a block: (200 - 194) / 2 = 3 mm above and below; (250 - 100) / 2 = 75 mm on each side.
        expect(sheets[0].strips.map(s => s.offsetYMm)).toEqual([3, 54, 105, 156]);
        expect(sheets[0].strips.map(s => s.offsetXMm)).toEqual([75, 75, 75, 75]);
        // The single strip of the last sheet: (200 - 41) / 2.
        expect(sheets[1].strips.map(s => s.offsetYMm)).toEqual([79.5]);

        const thirty = BuiltInProfiles['thirtyNote']; // 70.1 mm: 2 strips need 150.2 mm
        expect(buildSheets(stripsOf(3), thirty, { ...FORMAT, pageHeightMm: 150.2 }).map(s => s.strips.length)).toEqual([2, 1]);
        expect(buildSheets(stripsOf(3), thirty, { ...FORMAT, pageHeightMm: 150.1 }).map(s => s.strips.length)).toEqual([1, 1, 1]);
    });

    it('rejects sheets lower than one strip', () => {
        expect(() => buildSheets(stripsOf(1), BuiltInProfiles['thirtyNote'], { ...FORMAT, pageHeightMm: 70 }))
            .toThrow(/^Sheet height must be at least 70.10 mm/);
        // With vertical strips, they are placed side by side: it's the sheet width.
        expect(() => buildSheets(stripsOf(1), BuiltInProfiles['thirtyNote'],
            { ...FORMAT, pageHeightMm: 70, stripOrientation: 'vertical' }))
            .toThrow(/^Sheet width must be at least 70.10 mm/);
    });

    it('sizes unlimited sheets to their content', () => {
        const thirty = BuiltInProfiles['thirtyNote'];
        const [sheet] = buildSheets(
            [{ lengthMm: 2700, extentMm: 2702, lines: [], circles: [] }, ...stripsOf(1)],
            thirty, { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 });
        expect(sheet.widthMm).toBe(2702);
        expect(sheet.heightMm).toBeCloseTo(2 * 70.1 + STRIP_SPACING_MM, 12);
        // A sheet sized to its content has no margin at all.
        expect(sheet.strips.map(s => [s.offsetXMm, s.offsetYMm])).toEqual([[0, 0], [0, 70.1 + STRIP_SPACING_MM]]);
    });

    it('centers the block, keeping the strips aligned to each other by their start', () => {
        const thirty = BuiltInProfiles['thirtyNote'];
        const strips = [...stripsOf(1, 200), { lengthMm: 120, extentMm: 120, lines: [], circles: [] }];
        const [sheet] = buildSheets(strips, thirty, { ...FORMAT, pageWidthMm: 250, pageHeightMm: 200 });
        // Longest strip 200 mm: (250 - 200) / 2 = 25 mm for both, even the shorter one.
        expect(sheet.strips.map(s => s.offsetXMm)).toEqual([25, 25]);
        // Two rows: 2 * 70.1 + 10 = 150.2 mm, (200 - 150.2) / 2 = 24.9 mm.
        expect(sheet.strips[0].offsetYMm).toBeCloseTo(24.9, 12);
        expect(sheet.strips[1].offsetYMm - sheet.strips[0].offsetYMm).toBeCloseTo(70.1 + STRIP_SPACING_MM, 12);
    });

    it('centers the block including a protruding jigsaw tab', () => {
        const thirty = BuiltInProfiles['thirtyNote'];
        const [sheet] = buildSheets([{ lengthMm: 200, extentMm: 202, lines: [], circles: [] }], thirty, FORMAT);
        expect(sheet.strips[0].offsetXMm).toBe(24); // (250 - 202) / 2
    });
});

describe('note lines', () => {
    it('places the highest note at the top and the lowest at the bottom of the content area', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const positions = getNoteLinePositions(profile);
        const offset = (profile.paperWidthMm - profile.contentWidthMm) / 2;
        expect(positions.get(88)).toBeCloseTo(offset, 12);                          // E6
        expect(positions.get(48)).toBeCloseTo(offset + profile.contentWidthMm, 12); // C3
        expect(positions.size).toBe(30);
    });

    it('sorts notes numerically, not alphabetically', () => {
        const profile: IMusicBoxProfile = { ...BuiltInProfiles['fifteenNote'], supportedNotes: [96, 100, 101, 98] };
        const positions = getNoteLinePositions(profile);
        const order = [96, 98, 100, 101].map(n => positions.get(n) as number);
        expect(order).toEqual([...order].sort((a, b) => b - a));
    });
});

describe('vertical mirror', () => {
    SAMPLES.forEach(sample => {
        Object.keys(BuiltInProfiles).forEach(profileKey => {
            it(`${sample} / ${profileKey}: is the exact top-bottom reflection of each strip`, () => {
                const profile = BuiltInProfiles[profileKey];
                const midiFile = loadSample(sample);
                const normal = computeMusicBoxLayout(midiFile, profile, { ...FORMAT, jigsawJoiners: true });
                const mirrored = computeMusicBoxLayout(midiFile, profile, { ...FORMAT, jigsawJoiners: true, mirrorVertically: true });

                // Same pages, sheets and strip positions: only y inside each strip changes.
                expect(mirrored.pages).toEqual(normal.pages);
                expect(mirrored.sheets.map(s => [s.widthMm, s.heightMm, s.strips.map(p => p.offsetYMm)]))
                    .toEqual(normal.sheets.map(s => [s.widthMm, s.heightMm, s.strips.map(p => p.offsetYMm)]));

                const w = profile.paperWidthMm;
                normal.sheets.forEach((sheet, i) => sheet.strips.forEach((strip, j) => {
                    const m = mirrored.sheets[i].strips[j].geometry;
                    expect(m.lengthMm).toBe(strip.geometry.lengthMm);
                    expect(m.circles).toEqual(strip.geometry.circles.map(c => ({ cx: c.cx, cy: w - c.cy, r: c.r })));
                    expect(m.lines).toEqual(strip.geometry.lines.map(l => ({ x1: l.x1, y1: w - l.y1, x2: l.x2, y2: w - l.y2 })));
                }));
            });
        });
    });

    it('puts the lowest note at the top', () => {
        const profile = BuiltInProfiles['thirtyNote'];
        const offset = (profile.paperWidthMm - profile.contentWidthMm) / 2;
        const notes = [{ id: '0:0', note: 48, originalNote: 48, timeSeconds: 0, velocity: 100, durationSeconds: 1, channel: 0, trackIndex: 0 }];
        const [page] = paginateNotes(notes, profile, FORMAT);
        const normal = buildStripGeometry(page, 1, profile, FORMAT);
        const mirrored = buildStripGeometry(page, 1, profile, { ...FORMAT, mirrorVertically: true });
        expect(normal.circles[0].cy).toBeCloseTo(profile.paperWidthMm - offset, 12); // C3 at the bottom
        expect(mirrored.circles[0].cy).toBeCloseTo(offset, 12);                       // C3 at the top
    });

    it('changes nothing when disabled', () => {
        const midiFile = loadSample(SAMPLES[2]);
        const profile = BuiltInProfiles['fifteenNote'];
        expect(computeMusicBoxLayout(midiFile, profile, { ...FORMAT, mirrorVertically: false }))
            .toEqual(computeMusicBoxLayout(midiFile, profile, FORMAT));
    });
});

describe('strip orientation', () => {
    it('is horizontal by default', () => {
        const midiFile = loadSample(SAMPLES[2]);
        const profile = BuiltInProfiles['thirtyNote'];
        expect(computeMusicBoxLayout(midiFile, profile, { ...FORMAT, stripOrientation: 'horizontal' }))
            .toEqual(computeMusicBoxLayout(midiFile, profile, FORMAT));
    });

    it('only changes the drawings: pages, strips and sheets in strip coordinates stay the same', () => {
        const midiFile = loadSample(SAMPLES[1]);
        const profile = BuiltInProfiles['fifteenNote'];
        const horizontal = computeMusicBoxLayout(midiFile, profile, FORMAT);
        const vertical = computeMusicBoxLayout(midiFile, profile, { ...FORMAT, stripOrientation: 'vertical' });
        expect(vertical.pages).toEqual(horizontal.pages);
        expect(vertical.sheets).toEqual(horizontal.sheets);
        expect(vertical.totalPaperLengthMm).toBe(horizontal.totalPaperLengthMm);
        expect(vertical.drawings.map(d => [d.widthMm, d.heightMm]))
            .toEqual(horizontal.drawings.map(d => [d.heightMm, d.widthMm]));
    });
});

describe('fitSingleStrip', () => {
    const variants: { [name: string]: IMusicBoxSvgFormatOptions } = {
        ...FORMAT_VARIANTS,
        noBorder: { ...FORMAT, renderBorder: false },
        jigsawOnly: { ...FORMAT, jigsawJoiners: true },
        verticalJigsaw: { ...FORMAT, stripOrientation: 'vertical', jigsawJoiners: true },
    };

    SAMPLES.forEach(sample => Object.keys(BuiltInProfiles).forEach(profileKey => {
        it(`${sample} / ${profileKey}: puts the whole song on one strip, on a sheet of its size`, () => {
            const profile = BuiltInProfiles[profileKey];
            const midiFile = loadSample(sample);

            Object.values(variants).forEach(format => {
                const fitted = fitSingleStrip(midiFile, profile, format);
                const unlimited = computeMusicBoxLayout(midiFile, profile, { ...format, pageWidthMm: 0, pageHeightMm: 0 });
                const layout = computeMusicBoxLayout(midiFile, profile, fitted);

                // Only the sizes change: every other option (border included) is kept.
                expect(fitted).toEqual({ ...format, pageWidthMm: fitted.pageWidthMm, pageHeightMm: profile.paperWidthMm });
                expect(Number.isInteger(fitted.pageWidthMm)).toBe(true);
                expect(fitted.pageWidthMm - unlimited.sheets[0].widthMm).toBeGreaterThanOrEqual(0);
                expect(fitted.pageWidthMm - unlimited.sheets[0].widthMm).toBeLessThan(1 + JIGSAW_WIDTH_MM);

                // One strip on one sheet, with the same holes as without any size limit.
                expect(layout.pages.length).toBe(1);
                expect(layout.sheets.length).toBe(1);
                expect(unlimited.pages.length).toBe(1);
                expect(layout.pages[0].notes).toEqual(unlimited.pages[0].notes);
                expect(layout.pages[0].startTimeInSeconds).toBe(unlimited.pages[0].startTimeInSeconds);
                // The end is min(last note + padding, sheet end). When the song is an exact number of
                // millimeters long, both are the same length computed two ways: they may differ by one
                // floating-point step (~1e-14 s, ~1e-13 mm; the DXF keeps 6 decimals).
                expect(Math.abs(layout.pages[0].endTimeInSeconds - unlimited.pages[0].endTimeInSeconds)).toBeLessThan(EPSILON);
                expect(layout.sheets[0].strips[0].geometry.circles).toEqual(unlimited.sheets[0].strips[0].geometry.circles);
                expectPhysicallyValid(layout, profile, fitted);
            });
        });
    }));

    it('rounds the length up to the next whole millimeter and uses the paper width', () => {
        const profile = BuiltInProfiles['thirtyNote']; // 20 mm/s, 2.2 mm holes
        const midiFile = loadSample('happy_birthday.mid');
        const unlimited = computeMusicBoxLayout(midiFile, profile, { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 });
        const fitted = fitSingleStrip(midiFile, profile, FORMAT);
        expect(fitted.pageWidthMm).toBe(Math.ceil(unlimited.totalPaperLengthMm));
        expect(fitted.pageHeightMm).toBe(70.1);
    });
});

describe('holes deleted by hand', () => {
    const profile = BuiltInProfiles['thirtyNote'];
    const unlimited = FORMAT_VARIANTS.unlimited;
    const circlesOf = (layout: IMusicBoxLayout) => layout.drawings.map(d => parseDxf(createDxf(d)).circles);

    SAMPLES.forEach(sample => {
        it(`${sample}: removes exactly the deleted holes; every other hole and cut stays where it was`, () => {
            const midiFile = loadSample(sample);
            const before = computeMusicBoxLayout(midiFile, profile, unlimited);
            const notes = before.extraction.notes;
            // The second hole, one in the middle and one near the end (not the first or the last: the
            // start and the length stay).
            const deleted = new Set([notes[1].id, notes[Math.floor(notes.length / 2)].id, notes[notes.length - 2].id]);
            const after = computeMusicBoxLayout(midiFile, profile, unlimited, 'auto', deleted);

            expect(after.extraction.deletedCount).toBe(3);
            expect(after.extraction.removedLeadingSeconds).toBe(0);
            expect(after.extraction.notes).toEqual(notes.filter(n => !deleted.has(n.id)));
            const expected = before.holeNotes[0]
                .map((note, j) => ({ note, circle: circlesOf(before)[0][j] }))
                .filter(({ note }) => !deleted.has(note.id))
                .map(({ circle }) => circle);
            expect(circlesOf(after)[0]).toEqual(expected);
            expect(after.drawings[0].strips[0].lines).toEqual(before.drawings[0].strips[0].lines);
            expect(after.totalPaperLengthMm).toBe(before.totalPaperLengthMm);
        });
    });

    SAMPLES.forEach(sample => {
        it(`${sample}: deleting the first holes moves every other hole back as a block, so the strip has no blank paper at the start`, () => {
            const midiFile = loadSample(sample);
            const before = computeMusicBoxLayout(midiFile, profile, unlimited);
            const notes = before.extraction.notes;
            // Every hole at the first two times of the song.
            const times = [...new Set(notes.map(n => n.timeSeconds))];
            const deleted = new Set(notes.filter(n => n.timeSeconds <= times[1]).map(n => n.id));
            const after = computeMusicBoxLayout(midiFile, profile, unlimited, 'auto', deleted);

            const shiftMm = (times[2] - times[0]) * profile.millimetersPerSecond;
            expect(after.extraction.removedLeadingSeconds).toBeCloseTo(times[2] - times[0], 9);
            const holesBefore = before.holeNotes[0]
                .map((note, j) => ({ note, circle: circlesOf(before)[0][j] }))
                .filter(({ note }) => !deleted.has(note.id));
            const holesAfter = circlesOf(after)[0];
            expect(after.holeNotes[0].map(n => n.id)).toEqual(holesBefore.map(({ note }) => note.id));
            // Same line, same size; along the strip every hole moves back by the same distance.
            holesAfter.forEach((circle, j) => {
                const old = holesBefore[j].circle;
                expect(circle.cx).toBeCloseTo(old.cx - shiftMm, 6);
                expect(circle.cy).toBe(old.cy);
                expect(circle.r).toBe(old.r);
            });
            // The first hole left is exactly where the first hole was: the start padding is the same.
            expect(Math.min(...holesAfter.map(c => c.cx))).toBeCloseTo(Math.min(...circlesOf(before)[0].map(c => c.cx)), 6);
            expect(after.totalPaperLengthMm).toBeCloseTo(before.totalPaperLengthMm - shiftMm, 6);
            expectPhysicallyValid(after, profile, unlimited);

            // A sheet fitted to the song gets shorter by the same length (rounded up to the mm).
            const fitted = fitSingleStrip(midiFile, profile, FORMAT);
            const shorter = fitSingleStrip(midiFile, profile, FORMAT, 'auto', deleted);
            expect(shorter.pageWidthMm).toBe(Math.ceil(after.totalPaperLengthMm));
            expect(fitted.pageWidthMm - shorter.pageWidthMm).toBeGreaterThanOrEqual(Math.floor(shiftMm));
        });
    });

    it('stays physically valid with deleted holes, also on several strips and sheets', () => {
        const midiFile = loadSample('ode_to_joy.mid');
        const all = extractMusicBoxNotes(midiFile, profile, { transposeOutOfRangeNotes: true }).notes;
        // Also the first holes (the song starts later).
        const deleted = new Set(all.filter((_, i) => i < 5 || i % 7 === 3).map(n => n.id));
        ['default', 'letter190x277', 'narrow85', 'jigsaw', 'vertical277x190', 'verticalMirrored'].forEach(key => {
            const format = FORMAT_VARIANTS[key];
            const layout = computeMusicBoxLayout(midiFile, profile, format, 'auto', deleted);
            expect(layout.extraction.deletedCount).toBe(deleted.size);
            expect(layout.extraction.removedLeadingSeconds).toBeGreaterThan(0);
            expectPhysicallyValid(layout, profile, format);
        });
    });

    it('a shorter song (last holes deleted) fits a shorter sheet', () => {
        const midiFile = loadSample('happy_birthday.mid');
        const notes = extractMusicBoxNotes(midiFile, profile, { transposeOutOfRangeNotes: true }).notes;
        const lastTime = notes[notes.length - 1].timeSeconds;
        const deleted = new Set(notes.filter(n => n.timeSeconds === lastTime).map(n => n.id));
        const remainingLast = notes.filter(n => !deleted.has(n.id)).slice(-1)[0].timeSeconds;

        const full = fitSingleStrip(midiFile, profile, FORMAT);
        const shorter = fitSingleStrip(midiFile, profile, FORMAT, 'auto', deleted);
        const expectedShortening = (lastTime - remainingLast) * profile.millimetersPerSecond;
        expect(full.pageWidthMm - shorter.pageWidthMm).toBeGreaterThanOrEqual(Math.floor(expectedShortening));
        expect(full.pageWidthMm - shorter.pageWidthMm).toBeLessThanOrEqual(Math.ceil(expectedShortening));
        expect(shorter.pageHeightMm).toBe(profile.paperWidthMm);
    });

    it('explains how to get the holes back when every hole was deleted', () => {
        const midiFile = loadSample('happy_birthday.mid');
        const ids = new Set(extractMusicBoxNotes(midiFile, profile, { transposeOutOfRangeNotes: true }).notes.map(n => n.id));
        expect(() => computeMusicBoxLayout(midiFile, profile, FORMAT, 'auto', ids))
            .toThrow('Every hole was deleted. Use Undo or Restore all to bring them back.');
    });
});
