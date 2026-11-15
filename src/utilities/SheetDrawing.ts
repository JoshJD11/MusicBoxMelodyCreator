import type { StripOrientation } from '../model/IMusicBoxSvgFormatOptions';
import type { ICircle, ILine, IPlacedStrip, ISheet } from './MusicBoxLayout';

/** The borders and holes of one strip, in sheet coordinates. */
export interface IDrawnStrip {
    lines: ILine[];
    circles: ICircle[];
}

/**
 * A sheet exactly as it is cut: millimeters, origin at the top-left corner of the sheet, y pointing
 * down. Strips keep their order (it is the order of the entities in the DXF file).
 */
export interface ISheetDrawing {
    widthMm: number;
    heightMm: number;
    strips: IDrawnStrip[];
}

/**
 * Places the strips of a sheet in sheet coordinates, with the given orientation. Each strip is at
 * (offsetX, offsetY) in strip coordinates: along the tape, and across it (its row).
 *
 * - `horizontal`: a point (x, y) of a strip becomes (offsetX + x, offsetY + y).
 * - `vertical`: every strip is rotated 90° clockwise and placed in its column, from left to right in
 *   the same order as the rows. A point (x, y) of a strip becomes (offsetY + stripWidth − y,
 *   offsetX + x): the song runs downwards and the top edge of the strip (highest note) ends up on the
 *   right. The sheet's width and height are swapped.
 *
 * Both are rigid motions of each strip: hole sizes, distances to the cuts and positions along the
 * tape don't change.
 */
export function drawSheet(sheet: ISheet, orientation: StripOrientation = 'horizontal'): ISheetDrawing {
    if (orientation === 'vertical') {
        const w = sheet.stripWidthMm;
        return {
            widthMm: sheet.heightMm,
            heightMm: sheet.widthMm,
            strips: sheet.strips.map(({ offsetXMm: along, offsetYMm: column, geometry }) => ({
                lines: geometry.lines.map(l => ({
                    x1: column + (w - l.y1), y1: along + l.x1,
                    x2: column + (w - l.y2), y2: along + l.x2,
                })),
                circles: geometry.circles.map(c => ({ cx: column + (w - c.cy), cy: along + c.cx, r: c.r })),
            })),
        };
    }

    return {
        widthMm: sheet.widthMm,
        heightMm: sheet.heightMm,
        strips: sheet.strips.map(({ offsetXMm: along, offsetYMm: row, geometry }) => ({
            lines: geometry.lines.map(l => ({ x1: along + l.x1, y1: l.y1 + row, x2: along + l.x2, y2: l.y2 + row })),
            circles: geometry.circles.map(c => ({ cx: along + c.cx, cy: c.cy + row, r: c.r })),
        })),
    };
}

/**
 * Places one line of a strip (strip coordinates) on its sheet, exactly like {@link drawSheet} places
 * the strip's borders and holes: same orientation, centering and order of the strips.
 */
export function placeStripLine(sheet: ISheet, placed: IPlacedStrip, line: ILine, orientation: StripOrientation = 'horizontal'): ILine {
    const single: ISheet = { ...sheet, strips: [{ ...placed, geometry: { ...placed.geometry, lines: [line], circles: [] } }] };
    return drawSheet(single, orientation).strips[0].lines[0];
}

/**
 * Inverse of the placement of {@link drawSheet}: a point of the sheet (mm) in the coordinates of
 * the strip itself (x along the tape from its leading edge, y across it from its top edge).
 */
export function sheetPointToStrip(
    sheet: ISheet,
    placed: IPlacedStrip,
    x: number,
    y: number,
    orientation: StripOrientation = 'horizontal'
): { x: number; y: number } {
    if (orientation === 'vertical') {
        // (x, y) of the strip -> (column + width − y, along + x)
        return { x: y - placed.offsetXMm, y: sheet.stripWidthMm - (x - placed.offsetYMm) };
    }
    // (x, y) of the strip -> (along + x, row + y)
    return { x: x - placed.offsetXMm, y: y - placed.offsetYMm };
}
