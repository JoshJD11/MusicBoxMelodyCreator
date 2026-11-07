import { ISheet } from './MusicBoxLayout';

/** Layer of the strip borders (cut lines). */
export const DXF_CUT_LAYER = 'CUT';

/** Layer of the note holes. */
export const DXF_HOLES_LAYER = 'HOLES';

/**
 * Creates an ASCII DXF (AutoCAD R12) document with the borders (LINE entities, layer CUT) and
 * holes (CIRCLE entities, layer HOLES) of a sheet, in millimeters.
 *
 * DXF uses a y axis pointing up, so the sheet is flipped vertically around its height: the
 * result looks exactly like the SVG preview.
 */
export function createDxf(sheet: ISheet): string {
    const heightMm = sheet.heightMm;
    const entities: string[] = [];

    sheet.strips.forEach(strip => {
        const offsetY = strip.offsetYMm;

        strip.geometry.lines.forEach(line => {
            entities.push(
                '0', 'LINE',
                '8', DXF_CUT_LAYER,
                '10', formatDxfNumber(line.x1),
                '20', formatDxfNumber(heightMm - (line.y1 + offsetY)),
                '30', '0',
                '11', formatDxfNumber(line.x2),
                '21', formatDxfNumber(heightMm - (line.y2 + offsetY)),
                '31', '0'
            );
        });

        strip.geometry.circles.forEach(circle => {
            entities.push(
                '0', 'CIRCLE',
                '8', DXF_HOLES_LAYER,
                '10', formatDxfNumber(circle.cx),
                '20', formatDxfNumber(heightMm - (circle.cy + offsetY)),
                '30', '0',
                '40', formatDxfNumber(circle.r)
            );
        });
    });

    const dxf = [
        '0', 'SECTION',
        '2', 'HEADER',
        '9', '$ACADVER',
        '1', 'AC1009',
        // Not part of R12, but kept: it tells newer readers (e.g. Silhouette Studio) that units are mm.
        '9', '$INSUNITS',
        '70', '4',
        '9', '$EXTMIN',
        '10', '0',
        '20', '0',
        '9', '$EXTMAX',
        '10', formatDxfNumber(sheet.widthMm),
        '20', formatDxfNumber(sheet.heightMm),
        '0', 'ENDSEC',
        '0', 'SECTION',
        '2', 'ENTITIES',
        ...entities,
        '0', 'ENDSEC',
        '0', 'EOF',
    ];

    return dxf.join('\r\n') + '\r\n';
}

/** Formats a number with at most 6 decimals (0.001 µm), without trailing zeros. */
export function formatDxfNumber(value: number): string {
    const rounded = Math.abs(value) < 0.000001 ? 0 : value;
    return rounded.toFixed(6).replace(/\.?(0+)$/, '');
}
