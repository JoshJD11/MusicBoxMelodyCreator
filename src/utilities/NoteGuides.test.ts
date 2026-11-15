import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { midiNoteName } from '../model/MidiConstants';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import { computeMusicBoxLayout, CUT_CLEARANCE_MM, getNoteLinePositions, ILine, IMusicBoxLayout, MAX_START_SKEW_MM } from './MusicBoxLayout';
import { createDxf } from './DxfExporter';
import { parseDxf } from './DxfReader';
import { sheetPointToStrip } from './SheetDrawing';
import { stripLocations } from './Playhead';
import { CHORD_SNAP_MM, GHOST_LABEL_GAP_MM, IBox, LABEL_GAP_MM, labelLayout, placeGhostLabel, sheetNoteGuides, snapToNoteLine, TOO_CLOSE_REASON } from './NoteGuides';

const FORMAT: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
    transposeOutOfRangeNotes: true, jigsawJoiners: false, loopMode: false,
};

// Every case where the strips move on the sheet (as in Playhead.test.ts).
const FORMAT_VARIANTS: { [name: string]: IMusicBoxSvgFormatOptions } = {
    horizontal: FORMAT,
    horizontalMirrored: { ...FORMAT, mirrorVertically: true },
    horizontalJigsawLoop: { ...FORMAT, jigsawJoiners: true, loopMode: true },
    horizontalUnlimited: { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 },
    horizontalCenteredBig: { ...FORMAT, pageWidthMm: 400, pageHeightMm: 500 },
    vertical: { ...FORMAT, stripOrientation: 'vertical' },
    verticalMirrored: { ...FORMAT, stripOrientation: 'vertical', mirrorVertically: true },
    verticalJigsawLoop: { ...FORMAT, stripOrientation: 'vertical', jigsawJoiners: true, loopMode: true },
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

function distanceToLine(px: number, py: number, line: ILine): number {
    const dx = line.x2 - line.x1;
    const dy = line.y2 - line.y1;
    return Math.abs((px - line.x1) * dy - (py - line.y1) * dx) / Math.hypot(dx, dy);
}

/** A point of the sheet in the coordinates of a strip (along, across). */
function onStrip(layout: IMusicBoxLayout, sheetIndex: number, stripIndex: number, x: number, y: number) {
    const sheet = layout.sheets[sheetIndex];
    return sheetPointToStrip(sheet, sheet.strips[stripIndex], x, y, layout.stripOrientation);
}

/** The sheet point of a point of a strip (along, across). */
function onSheet(layout: IMusicBoxLayout, sheetIndex: number, stripIndex: number, along: number, across: number) {
    const sheet = layout.sheets[sheetIndex];
    const placed = sheet.strips[stripIndex];
    if (layout.stripOrientation === 'vertical') {
        return { x: placed.offsetYMm + sheet.stripWidthMm - across, y: placed.offsetXMm + along };
    }
    return { x: placed.offsetXMm + along, y: placed.offsetYMm + across };
}

describe('note lines on the sample songs', () => {
    SAMPLES.forEach(sample => {
        Object.keys(BuiltInProfiles).forEach(profileKey => {
            Object.keys(FORMAT_VARIANTS).forEach(formatKey => {
                const profile = BuiltInProfiles[profileKey];
                const format = FORMAT_VARIANTS[formatKey];
                const layout = computeMusicBoxLayout(loadSample(sample), profile, format);

                it(`${sample} / ${profileKey} / ${formatKey}: every line passes through the center of the holes of its note (in the DXF) and spans its strip`, () => {
                    layout.drawings.forEach((drawing, s) => {
                        const strips = sheetNoteGuides(layout, s);
                        expect(strips.length).toBe(layout.sheets[s].strips.length);
                        const circles = parseDxf(createDxf(drawing)).circles;
                        const pageOf = new Map(layout.pages.map((page, p) => [page, p]));
                        layout.holeNotes[s].forEach((note, j) => {
                            const page = layout.pages.find(pg => pg.notes.includes(note))!;
                            const strip = strips.find(st => st.pageIndex === pageOf.get(page))!;
                            const guide = strip.lines.find(line => line.note === note.note)!;
                            expect(distanceToLine(circles[j].cx, circles[j].cy, guide.line)).toBeLessThan(1e-6);
                        });
                        strips.forEach(strip => {
                            const placed = layout.sheets[s].strips[strip.stripIndex];
                            // One line per note of the box, lowest first, from the leading edge to the end.
                            expect(strip.lines.map(line => line.note)).toEqual([...profile.supportedNotes].sort((a, b) => a - b));
                            strip.lines.forEach((guide, index) => {
                                const start = onStrip(layout, s, strip.stripIndex, guide.line.x1, guide.line.y1);
                                const end = onStrip(layout, s, strip.stripIndex, guide.line.x2, guide.line.y2);
                                // The first strip: on its slanted leading cut (never outside the paper); the others: at the edge.
                                const skew = strip.pageIndex === 0 && !format.loopMode ? Math.min(format.startPaddingMm, MAX_START_SKEW_MM) : 0;
                                const lineMm = getNoteLinePositions(profile).get(guide.note)!;
                                expect(start.x).toBeCloseTo(skew * (1 - lineMm / profile.paperWidthMm), 9);
                                expect(end.x).toBeCloseTo(placed.geometry.lengthMm, 9);
                                expect(start.y).toBeCloseTo(end.y, 9);
                                // The name is before the leading edge, on the line, in staggered rows / columns.
                                const label = onStrip(layout, s, strip.stripIndex, guide.label.x, guide.label.y);
                                const { rows, rowPitchMm } = labelLayout(layout);
                                expect(label.x).toBeCloseTo(-LABEL_GAP_MM - (index % rows) * rowPitchMm, 9);
                                expect(label.y).toBeCloseTo(start.y, 9);
                                expect(guide.row).toBe(index % rows);
                                expect(guide.name).toBe(midiNoteName(guide.note));
                                expect(guide.landmark).toBe(guide.note % 12 === 0);
                            });
                        });
                    });
                });

                it(`${sample} / ${profileKey} / ${formatKey}: the beat lines cross every strip at the quarter and eighth notes of the file that fall on it`, () => {
                    const mmPerSecond = profile.millimetersPerSecond;
                    // Quarter and eighth notes: every other sixteenth (none of the sixteenth notes are drawn).
                    const beats = layout.beatSixteenthSeconds.filter((_, i) => i % 2 === 0);
                    const outer = (profile.paperWidthMm - profile.contentWidthMm) / 2;
                    expect(beats.length).toBeGreaterThan(8);
                    let total = 0;
                    layout.drawings.forEach((_, s) => {
                        sheetNoteGuides(layout, s).forEach(strip => {
                            const page = layout.pages[strip.pageIndex];
                            const placed = layout.sheets[s].strips[strip.stripIndex];
                            const isLast = strip.pageIndex === layout.pages.length - 1;
                            const expected = beats.filter(t => t >= page.startTimeInSeconds && (isLast ? t <= page.endTimeInSeconds : t < page.endTimeInSeconds));
                            expect(strip.beats.map(b => b.seconds)).toEqual(expected);
                            total += strip.beats.length;
                            strip.beats.forEach(beat => {
                                const index = layout.beatSixteenthSeconds.indexOf(beat.seconds);
                                expect(beat.kind).toBe(index % 4 === 0 ? 'quarter' : 'eighth');
                                const along = (beat.seconds - page.startTimeInSeconds) * mmPerSecond;
                                expect(along).toBeLessThanOrEqual(placed.geometry.lengthMm + 1e-9);
                                const a = onStrip(layout, s, strip.stripIndex, beat.line.x1, beat.line.y1);
                                const b = onStrip(layout, s, strip.stripIndex, beat.line.x2, beat.line.y2);
                                expect(a.x).toBeCloseTo(along, 9);
                                expect(b.x).toBeCloseTo(along, 9);
                                // From the first note line to the last one (like musicbox.fun).
                                expect(Math.min(a.y, b.y)).toBeCloseTo(outer, 9);
                                expect(Math.max(a.y, b.y)).toBeCloseTo(profile.paperWidthMm - outer, 9);
                            });
                        });
                    });
                    // Every beat of the song is on exactly one strip.
                    expect(total).toBe(beats.length);
                });

                it(`${sample} / ${profileKey} / ${formatKey}: snapping at the center of every hole gives its note and time (and is blocked by the hole itself)`, () => {
                    layout.drawings.forEach((drawing, s) => {
                        const circles = parseDxf(createDxf(drawing)).circles;
                        layout.holeNotes[s].forEach((note, j) => {
                            const snap = snapToNoteLine(layout, s, circles[j].cx, circles[j].cy)!;
                            expect(snap).not.toBeNull();
                            expect(snap.note).toBe(note.note);
                            expect(snap.seconds).toBeCloseTo(note.timeSeconds, 9);
                            // (The DXF rounds to 6 decimals.)
                            expect(snap.cx).toBeCloseTo(circles[j].cx, 5);
                            expect(snap.cy).toBeCloseTo(circles[j].cy, 5);
                            expect(snap.r).toBe(circles[j].r);
                            expect(snap.blocked).toBe(TOO_CLOSE_REASON);
                        });
                    });
                });
            });
        });
    });
});

describe('snapToNoteLine', () => {
    const profile = BuiltInProfiles['thirtyNote'];
    const midi = loadSample('ode_to_joy.mid');
    // Several strips per sheet, several sheets.
    const layout = computeMusicBoxLayout(midi, profile, FORMAT_VARIANTS.vertical277x190);
    const mmPerSecond = profile.millimetersPerSecond;
    const noteLines = new Map([...sheetNoteGuides(layout, 0)[0].lines].map(line => [line.note, line]));

    it('the test layout has several strips and sheets', () => {
        expect(layout.sheets.length).toBeGreaterThan(1);
        expect(layout.sheets[0].strips.length).toBeGreaterThan(1);
    });

    it('is null off the strips, and finds the strip under the point on every sheet', () => {
        const sheet = layout.sheets[1];
        expect(snapToNoteLine(layout, 1, 0.5, 0.5)).toBeNull(); // the sheet's margin
        stripLocations(layout).filter(l => l.sheetIndex === 1).forEach(location => {
            const placed = sheet.strips[location.stripIndex];
            const point = onSheet(layout, 1, location.stripIndex, 30, sheet.stripWidthMm / 2);
            const snap = snapToNoteLine(layout, 1, point.x, point.y)!;
            expect(snap.stripIndex).toBe(location.stripIndex);
            expect(snap.pageIndex).toBe(location.pageIndex);
            expect(snap.seconds).toBeCloseTo(layout.pages[location.pageIndex].startTimeInSeconds + 30 / mmPerSecond, 9);
            expect(placed.geometry.lengthMm).toBeGreaterThan(30);
        });
        expect(snapToNoteLine(layout, 99, 10, 10)).toBeNull();
    });

    it('picks the nearest note line and puts the hole exactly on it, at the time of the point along the strip', () => {
        // Between the lines of two notes, nearer to the lower one: on the lower one.
        const lines = [...noteLines.values()].sort((a, b) => a.note - b.note);
        const lower = onStrip(layout, 0, 0, lines[10].line.x1, lines[10].line.y1).y;
        const upper = onStrip(layout, 0, 0, lines[11].line.x1, lines[11].line.y1).y;
        const point = onSheet(layout, 0, 0, 40.4, lower + (upper - lower) * 0.4);
        const snap = snapToNoteLine(layout, 0, point.x, point.y)!;
        expect(snap.note).toBe(lines[10].note);
        expect(snap.name).toBe(midiNoteName(lines[10].note));
        // No hole near that time on any line: the time of the point itself.
        const chord = layout.extraction.notes.some(n => Math.abs((n.timeSeconds - layout.pages[0].startTimeInSeconds) * mmPerSecond - 40.4) <= CHORD_SNAP_MM);
        if (!chord) {
            expect(snap.seconds).toBeCloseTo(layout.pages[0].startTimeInSeconds + 40.4 / mmPerSecond, 9);
            expect(snap.chord).toBe(false);
        }
        expect(distanceToLine(snap.cx, snap.cy, lines[10].line)).toBeLessThan(1e-9);
        expect(snap.blocked).toBeUndefined();
    });

    it('puts a hole in time with a very close hole of another line (a chord), but not with a farther one', () => {
        // The first hole of the song, and a line it is not on.
        const hole = layout.extraction.notes[0];
        const other = [...profile.supportedNotes].sort((a, b) => a - b).find(note =>
            !layout.extraction.notes.some(n => n.note === note && Math.abs(n.timeSeconds - hole.timeSeconds) < 1))!;
        const across = onStrip(layout, 0, 0, noteLines.get(other)!.line.x1, noteLines.get(other)!.line.y1).y;
        const holeAlong = (hole.timeSeconds - layout.pages[0].startTimeInSeconds) * mmPerSecond;

        const near = onSheet(layout, 0, 0, holeAlong + CHORD_SNAP_MM * 0.7, across);
        const snapped = snapToNoteLine(layout, 0, near.x, near.y)!;
        expect(snapped.note).toBe(other);
        expect(snapped.seconds).toBe(hole.timeSeconds);
        expect(snapped.chord).toBe(true);
        expect(snapped.blocked).toBeUndefined();

        const far = onSheet(layout, 0, 0, holeAlong + CHORD_SNAP_MM * 1.5, across);
        const free = snapToNoteLine(layout, 0, far.x, far.y)!;
        expect(free.seconds).toBeCloseTo(hole.timeSeconds + CHORD_SNAP_MM * 1.5 / mmPerSecond, 9);
        expect(free.chord).toBe(false);
    });

    it('never puts a hole before the start of the song (the start padding), nor beyond the end of the last strip', () => {
        const first = layout.pages[0];
        const start = onSheet(layout, 0, 0, 2, 20);
        expect(snapToNoteLine(layout, 0, start.x, start.y)!.seconds).toBe(0);
        expect(snapToNoteLine(layout, 0, start.x, start.y)!.seconds).toBeGreaterThan(first.startTimeInSeconds);

        const lastPage = layout.pages.length - 1;
        const last = stripLocations(layout)[lastPage];
        const length = layout.sheets[last.sheetIndex].strips[last.stripIndex].geometry.lengthMm;
        const end = onSheet(layout, last.sheetIndex, last.stripIndex, length - 0.1, 20);
        const snap = snapToNoteLine(layout, last.sheetIndex, end.x, end.y)!;
        const margin = (profile.holeDiameterMm / 2 + CUT_CLEARANCE_MM) / mmPerSecond;
        expect(snap.seconds).toBeCloseTo(layout.pages[lastPage].endTimeInSeconds - margin, 9);
        // On a strip that is cut, the cut moves instead (pagination): the time of the point is kept.
        const cutAt = onSheet(layout, 0, 0, layout.sheets[0].strips[0].geometry.lengthMm - 0.1, 20);
        expect(snapToNoteLine(layout, 0, cutAt.x, cutAt.y)!.seconds).toBeCloseTo(first.endTimeInSeconds - 0.1 / mmPerSecond, 9);
    });

    it('is blocked within the minimum gap of a hole on the same line, on either side, and free just beyond it', () => {
        const hole = layout.extraction.notes[3];
        const gapMm = profile.minNoteGapMm;
        const across = onStrip(layout, 0, 0, noteLines.get(hole.note)!.line.x1, noteLines.get(hole.note)!.line.y1).y;
        const holeAlong = (hole.timeSeconds - layout.pages[0].startTimeInSeconds) * mmPerSecond;
        const at = (offsetMm: number) => {
            const point = onSheet(layout, 0, 0, holeAlong + offsetMm, across);
            return snapToNoteLine(layout, 0, point.x, point.y)!;
        };
        expect(at(gapMm * 0.8).blocked).toBe(TOO_CLOSE_REASON);
        expect(at(-gapMm * 0.8).blocked).toBe(TOO_CLOSE_REASON);
        const beyond = at(gapMm + 0.2);
        if (!beyond.chord) {
            expect(beyond.blocked).toBeUndefined();
        }
    });

    it('mirrored strips: the lines follow the holes', () => {
        const mirrored = computeMusicBoxLayout(midi, profile, FORMAT_VARIANTS.verticalMirrored);
        const plain = computeMusicBoxLayout(midi, profile, FORMAT_VARIANTS.vertical);
        const highest = Math.max(...profile.supportedNotes);
        const mirroredLine = sheetNoteGuides(mirrored, 0)[0].lines.find(l => l.note === highest)!.line;
        const plainLine = sheetNoteGuides(plain, 0)[0].lines.find(l => l.note === highest)!.line;
        // Vertical strips: the highest note is on the right, mirrored on the left.
        expect(plainLine.x1).toBeGreaterThan(mirroredLine.x1);
        expect(plainLine.x1 - mirrored.sheets[0].strips[0].offsetYMm).toBeCloseTo(
            mirrored.sheets[0].strips[0].offsetYMm + profile.paperWidthMm - mirroredLine.x1, 9);
    });

    it('tells the distance to the previous and next hole on the same line', () => {
        // The holes of one line, in time order.
        const line = [...new Set(layout.extraction.notes.map(n => n.note))]
            .map(note => layout.extraction.notes.filter(n => n.note === note))
            .find(holes => holes.length >= 3)!;
        const [a, b] = line;
        const note = a.note;
        const across = onStrip(layout, 0, 0, noteLines.get(note)!.line.x1, noteLines.get(note)!.line.y1).y;
        const at = (seconds: number) => {
            const point = onSheet(layout, 0, 0, (seconds - layout.pages[0].startTimeInSeconds) * mmPerSecond, across);
            return snapToNoteLine(layout, 0, point.x, point.y)!;
        };
        // Between the first two holes of the line (if that is on the first strip), 40% of the way.
        const seconds = a.timeSeconds + (b.timeSeconds - a.timeSeconds) * 0.4;
        if (seconds < layout.pages[0].endTimeInSeconds) {
            const snap = at(seconds);
            expect(snap.gapBeforeMm).toBeCloseTo((snap.seconds - a.timeSeconds) * mmPerSecond, 6);
            expect(snap.gapAfterMm).toBeCloseTo((b.timeSeconds - snap.seconds) * mmPerSecond, 6);
        }
        // At the first hole of the line: nothing before it, the hole itself is not counted.
        const first = at(a.timeSeconds);
        expect(first.blocked).toBe(TOO_CLOSE_REASON);
        expect(first.gapBeforeMm).toBeNull();
        expect(first.gapAfterMm).toBeCloseTo((b.timeSeconds - a.timeSeconds) * mmPerSecond, 6);
    });

    it('has no beat lines for a file without beats', () => {
        const withoutBeats = { ...layout, beatSixteenthSeconds: [] };
        expect(sheetNoteGuides(withoutBeats, 0).every(strip => strip.beats.length === 0)).toBe(true);
    });

    it('spreads the names over as many rows as their width needs (30 notes: 3 rows above a vertical strip, 2 columns before a horizontal one)', () => {
        expect(labelLayout(layout)).toEqual({ rows: 3, rowPitchMm: 2.9 });
        expect(labelLayout(computeMusicBoxLayout(midi, profile, FORMAT)).rows).toBe(2);
        const fifteen = computeMusicBoxLayout(midi, BuiltInProfiles.fifteenNote, FORMAT_VARIANTS.vertical);
        expect(labelLayout(fifteen)).toEqual({ rows: 2, rowPitchMm: 2.9 });
        expect(labelLayout(computeMusicBoxLayout(midi, BuiltInProfiles.fifteenNote, FORMAT)).rows).toBe(2);
    });

    it('is empty for a layout without strips', () => {
        const empty = { messages: [] } as unknown as IMusicBoxLayout;
        expect(sheetNoteGuides(empty, 0)).toEqual([]);
        expect(snapToNoteLine(empty, 0, 1, 1)).toBeNull();
    });
});

describe('placeGhostLabel', () => {
    const hole = { cx: 30, cy: 50, r: 1.1 };
    const size = { width: 12, height: 6 };
    const touches = (box: IBox, c: { cx: number; cy: number; r: number }) => {
        const nx = Math.max(box.x, Math.min(c.cx, box.x + box.width));
        const ny = Math.max(box.y, Math.min(c.cy, box.y + box.height));
        return Math.hypot(c.cx - nx, c.cy - ny) < c.r + GHOST_LABEL_GAP_MM / 2;
    };

    it('vertical strips: beside the hole, on the side of the middle of the strip, never over the hole itself', () => {
        const right = placeGhostLabel(hole, size, [], 'vertical', 40);
        expect(right.x).toBeCloseTo(hole.cx + hole.r + GHOST_LABEL_GAP_MM, 9);
        expect(right.y + right.height / 2).toBeCloseTo(hole.cy, 9);
        const left = placeGhostLabel(hole, size, [], 'vertical', 20);
        expect(left.x + left.width).toBeCloseTo(hole.cx - hole.r - GHOST_LABEL_GAP_MM, 9);
        expect(touches(right, hole)).toBe(false);
        // The hole under the ghost (blocked case) doesn't count.
        expect(placeGhostLabel(hole, size, [hole], 'vertical', 40)).toEqual(right);
    });

    it('horizontal strips: above or below the hole, on the side of the middle', () => {
        const below = placeGhostLabel(hole, size, [], 'horizontal', 60);
        expect(below.y).toBeCloseTo(hole.cy + hole.r + GHOST_LABEL_GAP_MM, 9);
        const above = placeGhostLabel(hole, size, [], 'horizontal', 40);
        expect(above.y + above.height).toBeCloseTo(hole.cy - hole.r - GHOST_LABEL_GAP_MM, 9);
    });

    it('moves away from the holes next to it, and never covers one when there is room', () => {
        // A hole just right of the ghost, where the label would go.
        const blocker = { cx: hole.cx + 5, cy: hole.cy, r: 1.1 };
        const box = placeGhostLabel(hole, size, [blocker], 'vertical', 40);
        expect(touches(box, blocker)).toBe(false);
        expect(box.x + box.width).toBeLessThanOrEqual(hole.cx);
        // Surrounded on every side but one (up-left): that free spot is found.
        const crowd = [
            { cx: hole.cx + 5, cy: hole.cy, r: 1.1 }, { cx: hole.cx - 5, cy: hole.cy + 1, r: 1.1 },
            { cx: hole.cx + 5, cy: hole.cy + 5, r: 1.1 }, { cx: hole.cx + 5, cy: hole.cy - 5, r: 1.1 },
            { cx: hole.cx - 5, cy: hole.cy + 5, r: 1.1 },
        ];
        const free = placeGhostLabel(hole, size, crowd, 'vertical', 40);
        crowd.forEach(c => expect(touches(free, c)).toBe(false));
        expect(free.x + free.width).toBeLessThan(hole.cx);
        expect(free.y + free.height).toBeLessThan(hole.cy);
        // Nowhere free: the position covering the fewest holes.
        const everywhere = [];
        for (let x = -20; x <= 20; x += 3) {
            for (let y = -12; y <= 12; y += 3) {
                if (Math.hypot(x, y) > 3) {
                    everywhere.push({ cx: hole.cx + x, cy: hole.cy + y, r: 1.1 });
                }
            }
        }
        const fewest = placeGhostLabel(hole, size, everywhere, 'vertical', 40);
        expect(fewest.width).toBe(12);
    });
});
