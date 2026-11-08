import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import {
    buildSheets, buildStripGeometry, computeMusicBoxLayout, CUT_CLEARANCE_MM, ISheet, paginateNotes,
} from './MusicBoxLayout';
import { IMusicBoxNote } from './MusicBoxNotes';
import { drawSheet, ISheetDrawing } from './SheetDrawing';

const FORMAT: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
    transposeOutOfRangeNotes: true, jigsawJoiners: false, loopMode: false,
};

const VARIANTS: { [name: string]: IMusicBoxSvgFormatOptions } = {
    default: FORMAT,
    jigsaw: { ...FORMAT, jigsawJoiners: true },
    jigsawLoop: { ...FORMAT, jigsawJoiners: true, loopMode: true },
    omitBoundaries: { ...FORMAT, omitPageBoundaries: true },
    unlimited: { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 },
    letter190x277: { ...FORMAT, pageWidthMm: 190, pageHeightMm: 277 },
    narrow85: { ...FORMAT, pageWidthMm: 85, pageHeightMm: 3000 },
    mirrored: { ...FORMAT, mirrorVertically: true },
    mirroredJigsawLoop: { ...FORMAT, mirrorVertically: true, jigsawJoiners: true, loopMode: true },
};

const SAMPLES = [
    'happy_birthday.mid',
    'The Lonely Man (The Incredible Hulk 1978) Finished Version.mid',
    'You are my sunshine.mid',
];

const EPSILON = 1e-9;

/** A sheet with two strips: 250 mm along the tape, two rows of 70.1 mm paper. */
const SHEET: ISheet = {
    widthMm: 250,
    heightMm: 200,
    stripWidthMm: 70.1,
    strips: [
        {
            offsetYMm: 0,
            geometry: {
                lengthMm: 100, extentMm: 100,
                lines: [{ x1: 10, y1: 0, x2: 100, y2: 0 }],
                circles: [{ cx: 11, cy: 5, r: 1 }],
            },
        },
        {
            offsetYMm: 80.1,
            geometry: {
                lengthMm: 50, extentMm: 50,
                lines: [{ x1: 0, y1: 70.1, x2: 50, y2: 70.1 }],
                circles: [{ cx: 20, cy: 60, r: 1 }],
            },
        },
    ],
};

function loadSample(name: string): MidiFile {
    const b = fs.readFileSync(path.resolve(__dirname, '../../samples', name));
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return midiFile;
}

function note(midiNote: number, timeSeconds: number): IMusicBoxNote {
    return {
        note: midiNote, originalNote: midiNote, timeSeconds, velocity: 100, durationSeconds: 0.5, channel: 0, trackIndex: 0,
    };
}

/** A single vertical strip with the highest note at 0 s and the lowest one at 1 s. */
function drawHighThenLow(format: IMusicBoxSvgFormatOptions): ISheetDrawing {
    const profile = BuiltInProfiles['thirtyNote']; // highest E6 (88), lowest C3 (48)
    const pages = paginateNotes([note(88, 0), note(48, 1)], profile, format);
    const strips = pages.map(page => buildStripGeometry(page, pages.length, profile, format));
    const [sheet] = buildSheets(strips, profile, format);
    return drawSheet(sheet, format.stripOrientation);
}

function expectInsideSheet(drawing: ISheetDrawing) {
    drawing.strips.forEach(strip => {
        strip.lines.forEach(l => {
            [l.x1, l.x2].forEach(x => expect(x).toBeGreaterThanOrEqual(-EPSILON));
            [l.x1, l.x2].forEach(x => expect(x).toBeLessThanOrEqual(drawing.widthMm + EPSILON));
            [l.y1, l.y2].forEach(y => expect(y).toBeGreaterThanOrEqual(-EPSILON));
            [l.y1, l.y2].forEach(y => expect(y).toBeLessThanOrEqual(drawing.heightMm + EPSILON));
        });
        strip.circles.forEach(c => {
            expect(c.cx - c.r).toBeGreaterThan(0);
            expect(c.cx + c.r).toBeLessThan(drawing.widthMm);
            expect(c.cy - c.r).toBeGreaterThan(0);
            expect(c.cy + c.r).toBeLessThan(drawing.heightMm);
        });
    });
}

describe('drawSheet', () => {
    describe('horizontal', () => {
        it('moves every strip down to its row and changes nothing else', () => {
            expect(drawSheet(SHEET, 'horizontal')).toEqual({
                widthMm: 250,
                heightMm: 200,
                strips: [
                    { lines: [{ x1: 10, y1: 0, x2: 100, y2: 0 }], circles: [{ cx: 11, cy: 5, r: 1 }] },
                    { lines: [{ x1: 0, y1: 70.1 + 80.1, x2: 50, y2: 70.1 + 80.1 }], circles: [{ cx: 20, cy: 60 + 80.1, r: 1 }] },
                ],
            });
        });

        it('is the default orientation', () => {
            expect(drawSheet(SHEET)).toEqual(drawSheet(SHEET, 'horizontal'));
        });
    });

    describe('vertical', () => {
        it('rotates every strip 90° clockwise into its column and swaps the sheet size', () => {
            // (x, y) -> (column + 70.1 - y, x)
            expect(drawSheet(SHEET, 'vertical')).toEqual({
                widthMm: 200,
                heightMm: 250,
                strips: [
                    { lines: [{ x1: 70.1, y1: 10, x2: 70.1, y2: 100 }], circles: [{ cx: 65.1, cy: 11, r: 1 }] },
                    { lines: [{ x1: 80.1, y1: 0, x2: 80.1, y2: 50 }], circles: [{ cx: 80.1 + (70.1 - 60), cy: 20, r: 1 }] },
                ],
            });
        });

        it('starts the song at the top, runs downwards and puts the highest note on the right', () => {
            const drawing = drawHighThenLow({ ...FORMAT, stripOrientation: 'vertical' });
            const [strip] = drawing.strips;
            const [high, low] = strip.circles;
            expect(high.cx).toBeGreaterThan(low.cx);      // highest note on the right
            expect(high.cy).toBeLessThan(low.cy);         // earlier note higher up
            expect(high.cy - high.r).toBeCloseTo(FORMAT.startPaddingMm, 12); // start padding from the top

            // The slanted start edge is at the top: it goes from y = 0 to y = start skew (10 mm).
            const startEdge = strip.lines.find(l => l.y1 !== l.y2 && l.x1 !== l.x2);
            expect(startEdge).toBeDefined();
            expect(Math.max(startEdge!.y1, startEdge!.y2)).toBeCloseTo(10, 12);
            expect(Math.min(startEdge!.y1, startEdge!.y2)).toBe(0);
        });

        it('puts the highest note on the left when mirrored', () => {
            const [strip] = drawHighThenLow({ ...FORMAT, stripOrientation: 'vertical', mirrorVertically: true }).strips;
            const [high, low] = strip.circles;
            expect(high.cx).toBeLessThan(low.cx);
            expect(high.cy).toBeLessThan(low.cy);
        });

        it('places the strips from left to right in song order', () => {
            const drawing = drawSheet(SHEET, 'vertical');
            const leftmost = drawing.strips.map(s => Math.min(...s.lines.flatMap(l => [l.x1, l.x2]), ...s.circles.map(c => c.cx - c.r)));
            expect(leftmost[0]).toBeLessThan(leftmost[1]);
        });
    });

    describe('on the sample songs', () => {
        SAMPLES.forEach(sample => Object.keys(BuiltInProfiles).forEach(profileKey => {
            it(`${sample} / ${profileKey}: vertical sheets are the exact clockwise rotation of each strip`, () => {
                const profile = BuiltInProfiles[profileKey];
                const midiFile = loadSample(sample);
                const w = profile.paperWidthMm;
                const radius = profile.holeDiameterMm / 2;

                Object.values(VARIANTS).forEach(format => {
                    const layout = computeMusicBoxLayout(midiFile, profile, { ...format, stripOrientation: 'vertical' });
                    const firstPageStart = layout.pages[0].startTimeInSeconds;
                    let stripStartMm = 0;

                    layout.sheets.forEach((sheet, i) => {
                        const drawing = layout.drawings[i];
                        expect([drawing.widthMm, drawing.heightMm]).toEqual([sheet.heightMm, sheet.widthMm]);
                        expectInsideSheet(drawing);

                        sheet.strips.forEach((placed, j) => {
                            const column = placed.offsetYMm;
                            const drawn = drawing.strips[j];
                            const geometry = placed.geometry;

                            expect(drawn.lines.length).toBe(geometry.lines.length);
                            drawn.lines.forEach((l, k) => {
                                const g = geometry.lines[k];
                                expect(Math.abs(l.x1 - (column + w - g.y1))).toBeLessThan(EPSILON);
                                expect(Math.abs(l.x2 - (column + w - g.y2))).toBeLessThan(EPSILON);
                                expect(l.y1).toBe(g.x1);
                                expect(l.y2).toBe(g.x2);
                            });

                            expect(drawn.circles.length).toBe(geometry.circles.length);
                            drawn.circles.forEach((c, k) => {
                                const g = geometry.circles[k];
                                expect(Math.abs(c.cx - (column + w - g.cy))).toBeLessThan(EPSILON);
                                expect(c.cy).toBe(g.cx);
                                expect(c.r).toBe(radius);

                                // Each hole stays inside its strip's column...
                                expect(c.cx - radius).toBeGreaterThan(column);
                                expect(c.cx + radius).toBeLessThan(column + w);
                                // ... away from the cuts at both ends of the strip...
                                const isFirstStrip = i === 0 && j === 0;
                                expect(c.cy - radius).toBeGreaterThanOrEqual(
                                    (isFirstStrip ? format.startPaddingMm : CUT_CLEARANCE_MM) - EPSILON);
                                expect(c.cy + radius + CUT_CLEARANCE_MM).toBeLessThanOrEqual(geometry.lengthMm + EPSILON);
                            });

                            // ... at the exact position of its note along the whole tape: (t - start) × mm/s.
                            const page = layout.pages[layout.sheets.slice(0, i).reduce((n, s) => n + s.strips.length, 0) + j];
                            drawn.circles.forEach((c, k) => {
                                const expectedMm = (page.notes[k].timeSeconds - firstPageStart) * profile.millimetersPerSecond;
                                expect(Math.abs(stripStartMm + c.cy - expectedMm)).toBeLessThan(1e-6);
                            });
                            stripStartMm += geometry.lengthMm;
                        });
                    });
                });
            });
        }));
    });
});
