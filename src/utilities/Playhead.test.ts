import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import { computeMusicBoxLayout, ILine, IMusicBoxLayout } from './MusicBoxLayout';
import { createDxf } from './DxfExporter';
import { parseDxf } from './DxfReader';
import { playheadAt, songTimeRange, stripLocations, timeAtPoint } from './Playhead';

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

// Every case where the strips move on the sheet: several strips per sheet and several sheets, both
// orientations, mirrored, centered on big sheets, jigsaw tabs, loop, and a single strip.
const FORMAT_VARIANTS: { [name: string]: IMusicBoxSvgFormatOptions } = {
    horizontal: FORMAT,
    horizontalMirrored: { ...FORMAT, mirrorVertically: true },
    horizontalJigsawLoop: { ...FORMAT, jigsawJoiners: true, loopMode: true },
    horizontalOmitBoundaries: { ...FORMAT, omitPageBoundaries: true },
    horizontalUnlimited: { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 },
    horizontalNarrowTall: { ...FORMAT, pageWidthMm: 85, pageHeightMm: 3000 },
    horizontalCenteredBig: { ...FORMAT, pageWidthMm: 400, pageHeightMm: 500 },
    vertical: { ...FORMAT, stripOrientation: 'vertical' },
    verticalMirrored: { ...FORMAT, stripOrientation: 'vertical', mirrorVertically: true },
    verticalJigsawLoop: { ...FORMAT, stripOrientation: 'vertical', jigsawJoiners: true, loopMode: true },
    verticalUnlimited: { ...FORMAT, stripOrientation: 'vertical', pageWidthMm: 0, pageHeightMm: 0 },
    vertical277x190: { ...FORMAT, stripOrientation: 'vertical', pageWidthMm: 277, pageHeightMm: 190 },
    verticalMirroredCenteredBig: { ...FORMAT, stripOrientation: 'vertical', mirrorVertically: true, pageWidthMm: 400, pageHeightMm: 500 },
};

const SAMPLES = ['happy_birthday.mid', 'ode_to_joy.mid', 'You are my sunshine.mid'];

function loadSample(name: string): MidiFile {
    const b = fs.readFileSync(path.resolve(__dirname, '../../samples', name));
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    return midiFile;
}

/** Distance from a point to a segment. */
function distanceToSegment(px: number, py: number, line: ILine): number {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    const t = Math.max(0, Math.min(1, ((px - line.x1) * dx + (py - line.y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (line.x1 + t * dx), py - (line.y1 + t * dy));
}

/** Position of the line along the song's direction on the sheet (down when vertical, right when horizontal). */
function alongOf(layout: IMusicBoxLayout, line: ILine): number {
    return layout.stripOrientation === 'vertical' ? line.y1 : line.x1;
}

describe('playback line on the sample songs', () => {
    SAMPLES.forEach(sample => {
        Object.keys(BuiltInProfiles).forEach(profileKey => {
            Object.keys(FORMAT_VARIANTS).forEach(formatKey => {
                const profile = BuiltInProfiles[profileKey];
                const format = FORMAT_VARIANTS[formatKey];
                const layout = computeMusicBoxLayout(loadSample(sample), profile, format);

                it(`${sample} / ${profileKey} / ${formatKey}: crosses the center of every hole (in the DXF) exactly when its note sounds`, () => {
                    layout.drawings.forEach((drawing, s) => {
                        // The circles of the file that is downloaded (and drawn in the preview).
                        const circles = parseDxf(createDxf(drawing)).circles;
                        layout.holeNotes[s].forEach((note, j) => {
                            const position = playheadAt(layout, note.timeSeconds)!;
                            expect(position.sheetIndex).toBe(s);
                            expect(distanceToSegment(circles[j].cx, circles[j].cy, position.line)).toBeLessThan(1e-5);
                        });
                    });
                });

                it(`${sample} / ${profileKey} / ${formatKey}: spans its strip exactly, across the song direction, inside the sheet`, () => {
                    const { startSeconds, endSeconds } = songTimeRange(layout);
                    const width = profile.paperWidthMm;
                    for (let t = startSeconds; t <= endSeconds; t += 0.37) {
                        const { line, sheetIndex } = playheadAt(layout, t)!;
                        const drawing = layout.drawings[sheetIndex];
                        expect(Math.hypot(line.x2 - line.x1, line.y2 - line.y1)).toBeCloseTo(width, 9);
                        if (format.stripOrientation === 'vertical') {
                            expect(line.y1).toBe(line.y2);
                        } else {
                            expect(line.x1).toBe(line.x2);
                        }
                        for (const [x, y] of [[line.x1, line.y1], [line.x2, line.y2]]) {
                            expect(x).toBeGreaterThanOrEqual(-1e-9);
                            expect(x).toBeLessThanOrEqual(drawing.widthMm + 1e-9);
                            expect(y).toBeGreaterThanOrEqual(-1e-9);
                            expect(y).toBeLessThanOrEqual(drawing.heightMm + 1e-9);
                        }
                    }
                });

                it(`${sample} / ${profileKey} / ${formatKey}: moves at the paper speed along each strip, then jumps to the start of the next`, () => {
                    const mmPerSecond = profile.millimetersPerSecond;
                    let absoluteBefore = 0; // position on the whole tape at the start of the current strip
                    layout.pages.forEach((page, p) => {
                        const location = stripLocations(layout)[p];
                        const placed = layout.sheets[location.sheetIndex].strips[location.stripIndex];
                        const start = playheadAt(layout, page.startTimeInSeconds)!;
                        // A cut is shown at the start of the next strip, at its leading edge.
                        expect(start.pageIndex).toBe(p);
                        expect(alongOf(layout, start.line)).toBeCloseTo(placed.offsetXMm, 9);

                        const steps = 5;
                        let previous = alongOf(layout, start.line);
                        for (let i = 1; i <= steps; i++) {
                            const t = page.startTimeInSeconds + (page.endTimeInSeconds - page.startTimeInSeconds) * i / steps * 0.999;
                            const position = playheadAt(layout, t)!;
                            expect(position.pageIndex).toBe(p);
                            expect(position.sheetIndex).toBe(location.sheetIndex);
                            const along = alongOf(layout, position.line);
                            expect(along).toBeGreaterThan(previous);
                            // The absolute position on the whole tape is (t − start) × mm/s.
                            const absolute = absoluteBefore + (along - placed.offsetXMm);
                            expect(absolute).toBeCloseTo((t - layout.pages[0].startTimeInSeconds) * mmPerSecond, 6);
                            previous = along;
                        }
                        absoluteBefore += placed.geometry.lengthMm;
                    });
                });

                it(`${sample} / ${profileKey} / ${formatKey}: a point of the strip gives back its time (to drag the line)`, () => {
                    const { startSeconds, endSeconds } = songTimeRange(layout);
                    for (let t = startSeconds; t <= endSeconds; t += 0.29) {
                        const { line, sheetIndex, seconds } = playheadAt(layout, t)!;
                        // Anywhere along the line: the middle, near each edge.
                        for (const f of [0.5, 0.05, 0.95]) {
                            const x = line.x1 + (line.x2 - line.x1) * f;
                            const y = line.y1 + (line.y2 - line.y1) * f;
                            expect(timeAtPoint(layout, sheetIndex, x, y)).toBeCloseTo(seconds, 9);
                        }
                    }
                });
            });
        });
    });
});

describe('playback line limits', () => {
    const profile = BuiltInProfiles.thirtyNote;
    const layout = computeMusicBoxLayout(loadSample('ode_to_joy.mid'), profile, { ...FORMAT, stripOrientation: 'vertical', pageWidthMm: 277, pageHeightMm: 190 });

    it('the test layout has several strips on several sheets', () => {
        expect(layout.sheets.length).toBeGreaterThan(1);
        expect(layout.sheets[0].strips.length).toBeGreaterThan(1);
    });

    it('stays at the leading edge before the song and at the end after it', () => {
        const { startSeconds, endSeconds } = songTimeRange(layout);
        expect(playheadAt(layout, startSeconds - 5)).toEqual(playheadAt(layout, startSeconds));
        expect(playheadAt(layout, endSeconds + 5)).toEqual(playheadAt(layout, endSeconds));
        expect(playheadAt(layout, NaN)).toEqual(playheadAt(layout, startSeconds));
        expect(playheadAt(layout, endSeconds)!.pageIndex).toBe(layout.pages.length - 1);
        expect(playheadAt(layout, startSeconds - 5)!.seconds).toBe(startSeconds);
    });

    it('song time 0 (where Play starts) is the start padding plus the hole radius after the leading edge', () => {
        const zero = playheadAt(layout, 0)!;
        const leading = playheadAt(layout, songTimeRange(layout).startSeconds)!;
        expect(zero.line.y1 - leading.line.y1).toBeCloseTo(FORMAT.startPaddingMm + profile.holeDiameterMm / 2, 9);
    });

    it('a point between two strips belongs to the nearest one; beyond the end of a strip, to its end', () => {
        const sheet = layout.sheets[0];
        const [first, second] = sheet.strips;
        const page0 = layout.pages[0];
        const page1 = layout.pages[1];
        const time = page0.startTimeInSeconds + 2; // 2 s into the first strip
        const { line } = playheadAt(layout, time)!;
        // Vertical strips: columns from left to right, the gap between them is 10 mm wide.
        const gapLeft = first.offsetYMm + profile.paperWidthMm;
        const gapRight = second.offsetYMm;
        expect(timeAtPoint(layout, 0, gapLeft + 2, line.y1)).toBeCloseTo(time, 9);
        expect(timeAtPoint(layout, 0, gapRight - 2, line.y1)).toBeCloseTo(page1.startTimeInSeconds + 2, 9);
        // Below the bottom of the sheet: the end of the strip.
        expect(timeAtPoint(layout, 0, gapLeft - 5, layout.drawings[0].heightMm + 50)).toBeCloseTo(page0.endTimeInSeconds, 9);
        // Above the top: its leading edge.
        expect(timeAtPoint(layout, 0, gapLeft - 5, -50)).toBeCloseTo(page0.startTimeInSeconds, 9);
        expect(timeAtPoint(layout, 99, 0, 0)).toBeNull();
    });
});
