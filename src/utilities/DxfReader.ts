import { ICircle, ILine } from './MusicBoxLayout';

/** The content of a DXF file as written by {@link createDxf}, ready to be drawn on screen. */
export interface IDxfDrawing {
    widthMm: number;
    heightMm: number;
    /** Coordinates with the y axis pointing down (screen/SVG convention). */
    lines: ILine[];
    circles: ICircle[];
}

/**
 * Reads a DXF document produced by `createDxf` (header extents, LINE and CIRCLE entities) so
 * that the preview shows exactly what the downloaded file contains. DXF's y axis points up, so
 * y is flipped back around the sheet height.
 *
 * Throws if the document contains anything unexpected, instead of drawing something different
 * from what would be cut.
 */
export function parseDxf(text: string): IDxfDrawing {
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    if (lines.length % 2 !== 0) {
        throw new Error('Invalid DXF: group codes and values are not paired.');
    }

    const pairs: Array<[number, string]> = [];
    for (let i = 0; i < lines.length; i += 2) {
        pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
    }

    let widthMm: number | undefined;
    let heightMm: number | undefined;
    const rawLines: ILine[] = [];
    const rawCircles: ICircle[] = [];

    let i = 0;
    const number = (code: number, entity: Map<number, string>) => {
        const value = entity.get(code);
        const parsed = value === undefined ? NaN : Number(value);
        if (!Number.isFinite(parsed)) {
            throw new Error(`Invalid DXF: missing or invalid group code ${code}.`);
        }
        return parsed;
    };

    while (i < pairs.length) {
        const [code, value] = pairs[i];

        if (code === 9 && value === '$EXTMAX') {
            widthMm = Number(pairs[i + 1][1]);
            heightMm = Number(pairs[i + 2][1]);
            i += 3;
            continue;
        }

        if (code === 0 && (value === 'LINE' || value === 'CIRCLE')) {
            // Collect the entity's group codes until the next entity (code 0).
            const entity = new Map<number, string>();
            i++;
            while (i < pairs.length && pairs[i][0] !== 0) {
                entity.set(pairs[i][0], pairs[i][1]);
                i++;
            }
            if (value === 'LINE') {
                rawLines.push({ x1: number(10, entity), y1: number(20, entity), x2: number(11, entity), y2: number(21, entity) });
            } else {
                rawCircles.push({ cx: number(10, entity), cy: number(20, entity), r: number(40, entity) });
            }
            continue;
        }

        if (code === 0 && !['SECTION', 'ENDSEC', 'EOF'].includes(value)) {
            throw new Error(`Invalid DXF: unexpected entity ${value}.`);
        }
        i++;
    }

    if (widthMm === undefined || heightMm === undefined || !Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
        throw new Error('Invalid DXF: missing $EXTMAX.');
    }

    const h = heightMm;
    return {
        widthMm,
        heightMm,
        lines: rawLines.map(l => ({ x1: l.x1, y1: h - l.y1, x2: l.x2, y2: h - l.y2 })),
        circles: rawCircles.map(c => ({ cx: c.cx, cy: h - c.cy, r: c.r })),
    };
}
