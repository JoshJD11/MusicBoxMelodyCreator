import { MidiNote, midiNoteName } from '../model/MidiConstants';
import { CUT_CLEARANCE_MM, getNoteLinePositions, ILine, IMusicBoxLayout, MAX_START_SKEW_MM } from './MusicBoxLayout';
import { placeStripLine, sheetPointToStrip } from './SheetDrawing';
import { stripLocations } from './Playhead';

/**
 * Guides drawn over the preview to add holes by hand (like on musicbox.fun): a line per note of the
 * music box along every strip, with the note's name before the strip's leading edge, and the
 * position where a hole would be punched for a point of the sheet. They are only drawn on screen:
 * the DXF files never contain them (see createDxf).
 *
 * The lines are at the exact positions of the holes (`getNoteLinePositions`, through `drawSheet`
 * like the holes themselves), so a hole added on a line is punched where the line is drawn. Nothing
 * about the strips (sizes, margins, cuts) changes because of the guides.
 */

/** A hole placed within this distance along the strip of a hole on another line is put exactly in time with it (a chord). */
export const CHORD_SNAP_MM = 1.2;

/** Gap between the strip's leading edge and the end of its labels (mm). */
export const LABEL_GAP_MM = 1;

/** Font size of the note names (mm, the sheet's units: about 9 px on screen). */
export const LABEL_FONT_MM = 2.4;

/** Width of a character of a name at that size (mm, measured in Chrome: 0.655 em). */
const LABEL_CHAR_MM = 0.655 * LABEL_FONT_MM;

/** Distance between the rows of names above a vertical strip, and between the columns before a horizontal one (mm). */
const LABEL_ROW_PITCH_MM = { vertical: 2.9, horizontal: 0 }; // horizontal: the widest name plus a gap (see labelLayout)
const LABEL_COLUMN_GAP_MM = 0.6;

/**
 * Note lines are only ~2 mm apart and a name is wider (and taller) than that, so the names are
 * spread over several rows above a vertical strip (columns before a horizontal one): the names of
 * consecutive lines go to consecutive rows. Returns how many, and the distance between them.
 */
export function labelLayout(layout: IMusicBoxLayout): { rows: number; rowPitchMm: number } {
    const { profile } = layout;
    const linePitch = profile.contentWidthMm / Math.max(1, profile.supportedNotes.length - 1);
    const widest = Math.max(...profile.supportedNotes.map(note => midiNoteName(note).length)) * LABEL_CHAR_MM;
    if (layout.stripOrientation === 'vertical') {
        // Names side by side across the strip: as many rows as needed for their width.
        return { rows: Math.max(1, Math.ceil(widest / linePitch)), rowPitchMm: LABEL_ROW_PITCH_MM.vertical };
    }
    // Names stacked across the strip: as many columns as needed for their height.
    return { rows: Math.max(1, Math.ceil((LABEL_FONT_MM * 1.05) / linePitch)), rowPitchMm: widest + LABEL_COLUMN_GAP_MM };
}

/** Why a hole can't be punched where the pointer is (shown to the user). */
export const TOO_CLOSE_REASON = 'Too close to another hole on this line: the music box could not play it.';

/** One note line of a strip, on the sheet. */
export interface INoteLineGuide {
    note: MidiNote;
    /** "C4", "F#5"... */
    name: string;
    /** The line along the strip, in sheet coordinates (mm, y down, like the drawings). */
    line: ILine;
    /** Where the name is written (sheet coordinates), before the strip's leading edge. */
    label: { x: number; y: number };
    /** Row (above a vertical strip) or column (before a horizontal one) of the name, 0 nearest the edge (see {@link labelLayout}). */
    row: number;
    /** A C: drawn a little stronger, as a landmark. */
    landmark: boolean;
}

/**
 * A beat line across a strip (like the printed lines of music box paper, and like musicbox.fun):
 * quarter notes and eighth notes, from the first note line to the last one.
 */
export interface IBeatLineGuide {
    kind: 'quarter' | 'eighth';
    /** Song time of the beat (seconds). */
    seconds: number;
    /** The line on the sheet. */
    line: ILine;
}

export interface IStripGuides {
    pageIndex: number;
    stripIndex: number;
    /** From the lowest note to the highest. */
    lines: INoteLineGuide[];
    /** The beats of the song that fall on this strip, in time order. */
    beats: IBeatLineGuide[];
}

/** Where a hole would be punched for a point of the sheet (the "ghost" hole under the pointer). */
export interface INoteSnap {
    note: MidiNote;
    name: string;
    /** Song time of the hole (seconds, like `IMusicBoxNote.timeSeconds` in the layout). */
    seconds: number;
    pageIndex: number;
    stripIndex: number;
    /** Center and radius of the hole on the sheet (mm). */
    cx: number;
    cy: number;
    r: number;
    /** Put in time with a hole of another line (see {@link CHORD_SNAP_MM}). */
    chord: boolean;
    /**
     * Distance along the tape (mm) to the previous and to the next hole on the same line, if there
     * is one (a hole at this very time is not counted: that is the blocked case).
     */
    gapBeforeMm: number | null;
    gapAfterMm: number | null;
    /** Why it can't be punched there, if it can't ({@link TOO_CLOSE_REASON}). */
    blocked?: string;
}

const guidesCache = new WeakMap<IMusicBoxLayout, IStripGuides[][]>();

/** The note lines of every strip of a sheet (cached per layout). Empty for a layout without strips. */
export function sheetNoteGuides(layout: IMusicBoxLayout, sheetIndex: number): IStripGuides[] {
    let sheets = guidesCache.get(layout);
    if (!sheets) {
        sheets = layout.sheets && layout.profile ? layout.sheets.map((_, s) => computeSheetGuides(layout, s)) : [];
        guidesCache.set(layout, sheets);
    }
    return sheets[sheetIndex] || [];
}

function computeSheetGuides(layout: IMusicBoxLayout, sheetIndex: number): IStripGuides[] {
    const { profile } = layout;
    const orientation = layout.stripOrientation;
    const sheet = layout.sheets[sheetIndex];
    const positions = getNoteLinePositions(profile);
    const notes = [...profile.supportedNotes].sort((a, b) => a - b);
    const { rows, rowPitchMm } = labelLayout(layout);

    return stripLocations(layout).filter(location => location.sheetIndex === sheetIndex).map(location => {
        const placed = sheet.strips[location.stripIndex];
        const length = placed.geometry.lengthMm;
        // The first strip starts with a slanted cut (see buildStripGeometry): from (skew, top edge)
        // to (0, bottom edge), before any mirroring. The lines start on it, never outside the paper.
        const skew = location.pageIndex === 0 && !layout.format.loopMode
            ? Math.min(layout.format.startPaddingMm, MAX_START_SKEW_MM)
            : 0;
        const lines = notes.map((note, index) => {
            const lineMm = positions.get(note) as number;
            const across = acrossOf(layout, lineMm);
            const start = skew * (1 - lineMm / profile.paperWidthMm);
            const row = index % rows;
            const labelAlong = -LABEL_GAP_MM - row * rowPitchMm;
            const label = placeStripLine(sheet, placed, { x1: labelAlong, y1: across, x2: labelAlong, y2: across }, orientation);
            return {
                note,
                name: midiNoteName(note),
                line: placeStripLine(sheet, placed, { x1: start, y1: across, x2: length, y2: across }, orientation),
                label: { x: label.x1, y: label.y1 },
                row,
                landmark: note % 12 === 0,
            };
        });
        return { pageIndex: location.pageIndex, stripIndex: location.stripIndex, lines, beats: beatLines(layout, location.pageIndex, sheetIndex) };
    });
}

/** The beat lines of one strip, placed on its sheet like its holes. */
function beatLines(layout: IMusicBoxLayout, pageIndex: number, sheetIndex: number): IBeatLineGuide[] {
    const page = layout.pages[pageIndex];
    const location = stripLocations(layout)[pageIndex];
    const sheet = layout.sheets[sheetIndex];
    const placed = sheet.strips[location.stripIndex];
    // From the first note line to the last one (symmetric: the same when mirrored).
    const outer = (layout.profile.paperWidthMm - layout.profile.contentWidthMm) / 2;
    const mmPerSecond = layout.millimetersPerSecond;
    const place = (along: number, y1: number, y2: number) =>
        placeStripLine(sheet, placed, { x1: along, y1, x2: along, y2 }, layout.stripOrientation);
    const beats: IBeatLineGuide[] = [];
    (layout.beatSixteenthSeconds || []).forEach((seconds, i) => {
        if (i % 2 === 1) {
            return; // Sixteenth notes are not drawn (like musicbox.fun).
        }
        // On this strip: from its leading edge (included) to its cut (excluded; the cut of the last
        // strip is its end, included).
        const isLast = pageIndex === layout.pages.length - 1;
        if (seconds < page.startTimeInSeconds || (isLast ? seconds > page.endTimeInSeconds : seconds >= page.endTimeInSeconds)) {
            return;
        }
        const along = (seconds - page.startTimeInSeconds) * mmPerSecond;
        beats.push({ kind: i % 4 === 0 ? 'quarter' : 'eighth', seconds, line: place(along, outer, sheet.stripWidthMm - outer) });
    });
    return beats;
}

/** Position across the strip of a note line, mirrored like the holes when the strips are mirrored. */
function acrossOf(layout: IMusicBoxLayout, lineMm: number): number {
    return layout.format.mirrorVertically ? layout.profile.paperWidthMm - lineMm : lineMm;
}

/**
 * The hole that a click at the point (x, y) of the sheet (mm) would add: on the nearest note line
 * of the strip under the point, at the song time of the point along that strip (the same formula as
 * the holes, inverted), in time with a hole of another line if one is very close ({@link
 * CHORD_SNAP_MM}), and never before the start of the song or beyond the end of the last strip (the
 * whole hole stays on the paper, {@link CUT_CLEARANCE_MM} from its end). Null when the point is not
 * on a strip.
 *
 * `blocked` says why the hole could not be punched there: another hole is within the minimum gap
 * on the same line.
 */
export function snapToNoteLine(layout: IMusicBoxLayout, sheetIndex: number, x: number, y: number): INoteSnap | null {
    const sheet = layout.sheets && layout.sheets[sheetIndex];
    if (!sheet || !layout.profile) {
        return null;
    }
    const { profile } = layout;
    const orientation = layout.stripOrientation;
    const mmPerSecond = layout.millimetersPerSecond;
    const radius = profile.holeDiameterMm / 2;

    // The strip under the point.
    let found: { pageIndex: number; stripIndex: number; along: number; across: number } | null = null;
    for (const location of stripLocations(layout)) {
        if (location.sheetIndex !== sheetIndex) {
            continue;
        }
        const placed = sheet.strips[location.stripIndex];
        const point = sheetPointToStrip(sheet, placed, x, y, orientation);
        if (point.x >= 0 && point.x <= placed.geometry.lengthMm && point.y >= 0 && point.y <= sheet.stripWidthMm) {
            found = { pageIndex: location.pageIndex, stripIndex: location.stripIndex, along: point.x, across: point.y };
            break;
        }
    }
    if (!found) {
        return null;
    }

    // The nearest note line.
    const positions = getNoteLinePositions(profile);
    let note: MidiNote | null = null;
    let lineAcross = 0;
    positions.forEach((position, candidate) => {
        const across = acrossOf(layout, position);
        if (note === null || Math.abs(across - found!.across) < Math.abs(lineAcross - found!.across)) {
            note = candidate;
            lineAcross = across;
        }
    });
    if (note === null) {
        return null;
    }

    // The song time of the point (inverse of the holes' formula), kept on the paper.
    const page = layout.pages[found.pageIndex];
    const isLastPage = found.pageIndex === layout.pages.length - 1;
    const holeMarginSeconds = (radius + CUT_CLEARANCE_MM) / mmPerSecond;
    let seconds = page.startTimeInSeconds + found.along / mmPerSecond;
    seconds = Math.max(0, seconds);
    if (isLastPage) {
        seconds = Math.min(seconds, page.endTimeInSeconds - holeMarginSeconds);
    }

    // In time with a very close hole of another line (a chord), if that keeps it on this strip.
    let chord = false;
    const snapSeconds = CHORD_SNAP_MM / mmPerSecond;
    let nearest: number | null = null;
    layout.extraction.notes.forEach(hole => {
        const distance = Math.abs(hole.timeSeconds - seconds);
        if (distance <= snapSeconds && (nearest === null || distance < Math.abs(nearest - seconds))) {
            nearest = hole.timeSeconds;
        }
    });
    if (nearest !== null && nearest >= page.startTimeInSeconds && nearest <= page.endTimeInSeconds) {
        chord = nearest !== seconds;
        seconds = nearest;
    }

    const minGapSeconds = profile.minNoteGapMm / mmPerSecond;
    const tooClose = layout.extraction.notes.some(hole =>
        hole.note === note && Math.abs(hole.timeSeconds - seconds) <= minGapSeconds);

    // The neighbours on the same line, to keep an even spacing.
    let gapBeforeMm: number | null = null;
    let gapAfterMm: number | null = null;
    layout.extraction.notes.forEach(hole => {
        if (hole.note !== note) {
            return;
        }
        const gap = (hole.timeSeconds - seconds) * mmPerSecond;
        if (gap < 0 && (gapBeforeMm === null || -gap < gapBeforeMm)) {
            gapBeforeMm = -gap;
        } else if (gap > 0 && (gapAfterMm === null || gap < gapAfterMm)) {
            gapAfterMm = gap;
        }
    });

    const placed = sheet.strips[found.stripIndex];
    const along = (seconds - page.startTimeInSeconds) * mmPerSecond;
    const center = placeStripLine(sheet, placed, { x1: along, y1: lineAcross, x2: along, y2: lineAcross }, orientation);

    return {
        note,
        name: midiNoteName(note),
        seconds,
        pageIndex: found.pageIndex,
        stripIndex: found.stripIndex,
        cx: center.x1,
        cy: center.y1,
        r: radius,
        chord,
        gapBeforeMm,
        gapAfterMm,
        blocked: tooClose ? TOO_CLOSE_REASON : undefined,
    };
}

/** A rectangle on the sheet (mm). */
export interface IBox { x: number; y: number; width: number; height: number; }

/** Gap between the ghost hole and its label, and between the label and other holes (mm). */
export const GHOST_LABEL_GAP_MM = 0.8;

/**
 * Where the label of the ghost hole goes (its top-left corner): the first of 8 positions around
 * the hole (beside it, above or below it, and the diagonals) that doesn't cover any hole of the
 * sheet. With strips running down (vertical), the sides come first, starting with the one nearer
 * to the middle of the strip; with strips running to the right, above / below come first, the same
 * way. If every position covers a hole, the one covering the fewest. Only for the screen.
 */
export function placeGhostLabel(
    hole: { cx: number; cy: number; r: number },
    size: { width: number; height: number },
    circles: ReadonlyArray<{ cx: number; cy: number; r: number }>,
    orientation: 'horizontal' | 'vertical',
    /** The middle of the strip across it: x for vertical strips, y for horizontal ones. */
    stripMiddle: number
): IBox {
    const { cx, cy, r } = hole;
    const { width: w, height: h } = size;
    const d = r + GHOST_LABEL_GAP_MM;
    const right = { x: cx + d, y: cy - h / 2 };
    const left = { x: cx - d - w, y: cy - h / 2 };
    const above = { x: cx - w / 2, y: cy - d - h };
    const below = { x: cx - w / 2, y: cy + d };
    const diagonal = (sx: number, sy: number) => ({ x: sx > 0 ? cx + d * 0.7 : cx - d * 0.7 - w, y: sy > 0 ? cy + d * 0.7 : cy - d * 0.7 - h });
    let candidates;
    if (orientation === 'vertical') {
        const towardsMiddle = cx < stripMiddle ? 1 : -1;
        const [near, far] = towardsMiddle > 0 ? [right, left] : [left, right];
        candidates = [near, far, diagonal(towardsMiddle, 1), diagonal(towardsMiddle, -1), diagonal(-towardsMiddle, 1), diagonal(-towardsMiddle, -1), below, above];
    } else {
        const towardsMiddle = cy < stripMiddle ? 1 : -1;
        const [near, far] = towardsMiddle > 0 ? [below, above] : [above, below];
        candidates = [near, far, diagonal(1, towardsMiddle), diagonal(-1, towardsMiddle), diagonal(1, -towardsMiddle), diagonal(-1, -towardsMiddle), right, left];
    }
    const covered = (box: IBox) => circles.filter(c => {
        if (Math.abs(c.cx - cx) < 1e-6 && Math.abs(c.cy - cy) < 1e-6) {
            return false; // The hole under the ghost itself (blocked case).
        }
        const nx = Math.max(box.x, Math.min(c.cx, box.x + box.width));
        const ny = Math.max(box.y, Math.min(c.cy, box.y + box.height));
        return Math.hypot(c.cx - nx, c.cy - ny) < c.r + GHOST_LABEL_GAP_MM / 2;
    }).length;
    let best: IBox | null = null;
    let bestCount = Infinity;
    for (const position of candidates) {
        const box = { ...position, width: w, height: h };
        const count = covered(box);
        if (count < bestCount) {
            best = box;
            bestCount = count;
            if (count === 0) {
                break;
            }
        }
    }
    return best as IBox;
}
