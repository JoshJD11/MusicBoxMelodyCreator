import { ILine, IMusicBoxLayout, IPlacedStrip, ISheet } from './MusicBoxLayout';
import { drawSheet } from './SheetDrawing';

/**
 * The playback line drawn on the preview: where the song is, on the strips exactly as they are cut.
 *
 * A hole is at (time − page start) × mm/s along its strip (see `buildStripGeometry`), so the line of
 * a moment of the song is the line across its strip at that same distance: it crosses the center of
 * every hole exactly when its note sounds. The line is placed on the sheet with `drawSheet` itself,
 * like the holes, so it follows the same orientation (horizontal / vertical), mirroring, centering
 * and order of the strips.
 */

/** Where the strip of a page (a part of the song) is: its sheet and its index on that sheet. */
export interface IStripLocation {
    pageIndex: number;
    sheetIndex: number;
    stripIndex: number;
}

export interface IPlayheadPosition extends IStripLocation {
    /**
     * The line across the strip, in sheet coordinates (mm, y down, as in the drawings and the
     * preview): from the strip's top edge (x1, y1) to its bottom edge (x2, y2), in strip terms.
     */
    line: ILine;
    /** The song time shown (the requested time, kept within the strips). */
    seconds: number;
}

const locationCache = new WeakMap<IMusicBoxLayout, IStripLocation[]>();

/**
 * The location of every page's strip, in page order. Pages fill the sheets in order, one strip per
 * page (see `buildSheets`), like `holeNotes`.
 */
export function stripLocations(layout: IMusicBoxLayout): IStripLocation[] {
    let locations = locationCache.get(layout);
    if (!locations) {
        locations = [];
        let pageIndex = 0;
        layout.sheets.forEach((sheet, sheetIndex) => {
            sheet.strips.forEach((_, stripIndex) => {
                locations!.push({ pageIndex: pageIndex++, sheetIndex, stripIndex });
            });
        });
        locationCache.set(layout, locations);
    }
    return locations;
}

/** Song times covered by the strips: from the leading edge of the first one to the end of the last. */
export function songTimeRange(layout: IMusicBoxLayout): { startSeconds: number; endSeconds: number } {
    const pages = layout.pages;
    return {
        startSeconds: pages[0].startTimeInSeconds,
        endSeconds: pages[pages.length - 1].endTimeInSeconds,
    };
}

/**
 * The line of the moment `seconds` of the song. Before the first strip it stays at its leading edge,
 * after the last one at its end. A moment where the strip is cut is shown at the start of the next
 * strip. Null if there are no strips.
 */
export function playheadAt(layout: IMusicBoxLayout, seconds: number): IPlayheadPosition | null {
    const pages = layout.pages;
    const locations = stripLocations(layout);
    if (pages.length === 0 || locations.length !== pages.length) {
        return null;
    }
    const { startSeconds, endSeconds } = songTimeRange(layout);
    const time = Math.min(endSeconds, Math.max(startSeconds, Number.isFinite(seconds) ? seconds : startSeconds));

    let pageIndex = 0;
    while (pageIndex < pages.length - 1 && time >= pages[pageIndex].endTimeInSeconds) {
        pageIndex++;
    }
    const location = locations[pageIndex];
    const sheet = layout.sheets[location.sheetIndex];
    const placed = sheet.strips[location.stripIndex];
    // Same formula as the holes (buildStripGeometry).
    const along = Math.min(placed.geometry.lengthMm,
        Math.max(0, (time - pages[pageIndex].startTimeInSeconds) * layout.millimetersPerSecond));

    return {
        ...location,
        line: placeLine(sheet, placed, { x1: along, y1: 0, x2: along, y2: sheet.stripWidthMm }, layout),
        seconds: time,
    };
}

/**
 * The song time of a point of a sheet (sheet mm): the moment whose line passes through it, on the
 * strip nearest to the point (a point beyond the end of a strip gives its end). Used to drag the
 * line. Null if the sheet has no strips.
 */
export function timeAtPoint(layout: IMusicBoxLayout, sheetIndex: number, x: number, y: number): number | null {
    const sheet = layout.sheets[sheetIndex];
    if (!sheet || sheet.strips.length === 0) {
        return null;
    }
    let best: { distance: number; along: number; pageIndex: number } | null = null;
    for (const location of stripLocations(layout)) {
        if (location.sheetIndex !== sheetIndex) {
            continue;
        }
        const placed = sheet.strips[location.stripIndex];
        const point = toStripCoordinates(sheet, placed, x, y, layout);
        const length = placed.geometry.lengthMm;
        const across = point.y < 0 ? -point.y : Math.max(0, point.y - sheet.stripWidthMm);
        const beyond = point.x < 0 ? -point.x : Math.max(0, point.x - length);
        const distance = Math.hypot(across, beyond);
        if (!best || distance < best.distance) {
            best = { distance, along: Math.min(length, Math.max(0, point.x)), pageIndex: location.pageIndex };
        }
    }
    if (!best) {
        return null;
    }
    return layout.pages[best.pageIndex].startTimeInSeconds + best.along / layout.millimetersPerSecond;
}

/** A line of a strip (strip coordinates) placed on its sheet, exactly like its holes and borders. */
function placeLine(sheet: ISheet, placed: IPlacedStrip, line: ILine, layout: IMusicBoxLayout): ILine {
    const single: ISheet = { ...sheet, strips: [{ ...placed, geometry: { ...placed.geometry, lines: [line], circles: [] } }] };
    return drawSheet(single, layout.stripOrientation).strips[0].lines[0];
}

/** Inverse of the placement of `drawSheet`: a point of the sheet in the strip's own coordinates. */
function toStripCoordinates(sheet: ISheet, placed: IPlacedStrip, x: number, y: number, layout: IMusicBoxLayout): { x: number; y: number } {
    if (layout.stripOrientation === 'vertical') {
        // (x, y) of the strip -> (column + width − y, along + x)
        return { x: y - placed.offsetXMm, y: sheet.stripWidthMm - (x - placed.offsetYMm) };
    }
    // (x, y) of the strip -> (along + x, row + y)
    return { x: x - placed.offsetXMm, y: y - placed.offsetYMm };
}
