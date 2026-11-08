import type { StripOrientation } from '../model/IMusicBoxSvgFormatOptions';
import type { ICircle, ILine, ISheet } from './MusicBoxLayout';

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
 * Places the strips of a sheet in sheet coordinates, with the given orientation.
 *
 * - `horizontal`: strips are moved down to their row. Nothing else changes.
 * - `vertical`: every strip is rotated 90° clockwise and placed in its column, from left to right in
 *   the same order as the rows. A point (x, y) of a strip becomes (column + stripWidth − y, x): the
 *   song runs downwards and the top edge of the strip (highest note) ends up on the right. The
 *   sheet's width and height are swapped.
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
            strips: sheet.strips.map(({ offsetYMm: column, geometry }) => ({
                lines: geometry.lines.map(l => ({
                    x1: column + (w - l.y1), y1: l.x1,
                    x2: column + (w - l.y2), y2: l.x2,
                })),
                circles: geometry.circles.map(c => ({ cx: column + (w - c.cy), cy: c.cx, r: c.r })),
            })),
        };
    }

    return {
        widthMm: sheet.widthMm,
        heightMm: sheet.heightMm,
        strips: sheet.strips.map(({ offsetYMm: row, geometry }) => ({
            lines: geometry.lines.map(l => ({ x1: l.x1, y1: l.y1 + row, x2: l.x2, y2: l.y2 + row })),
            circles: geometry.circles.map(c => ({ cx: c.cx, cy: c.cy + row, r: c.r })),
        })),
    };
}
