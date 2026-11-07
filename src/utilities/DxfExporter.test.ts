import { createDxf, formatDxfNumber } from './DxfExporter';
import { ISheet } from './MusicBoxLayout';

const SHEET: ISheet = {
    widthMm: 250,
    heightMm: 200,
    strips: [
        {
            offsetYMm: 0,
            geometry: {
                lengthMm: 100, extentMm: 100,
                lines: [{ x1: 0, y1: 0, x2: 100, y2: 0 }],
                circles: [{ cx: 11, cy: 5.925, r: 1 }],
            },
        },
        {
            offsetYMm: 80.1,
            geometry: {
                lengthMm: 50, extentMm: 50,
                lines: [{ x1: 0, y1: 70.1, x2: 50, y2: 70.1 }],
                circles: [],
            },
        },
    ],
};

describe('createDxf', () => {
    it('writes an R12 DXF in millimeters, flipped vertically', () => {
        expect(createDxf(SHEET).split('\r\n')).toEqual([
            '0', 'SECTION', '2', 'HEADER',
            '9', '$ACADVER', '1', 'AC1009',
            '9', '$INSUNITS', '70', '4',
            '9', '$EXTMIN', '10', '0', '20', '0',
            '9', '$EXTMAX', '10', '250', '20', '200',
            '0', 'ENDSEC',
            '0', 'SECTION', '2', 'ENTITIES',
            '0', 'LINE', '8', 'CUT', '10', '0', '20', '200', '30', '0', '11', '100', '21', '200', '31', '0',
            '0', 'CIRCLE', '8', 'HOLES', '10', '11', '20', '194.075', '30', '0', '40', '1',
            // Second strip: 200 - (70.1 + 80.1) = 49.8
            '0', 'LINE', '8', 'CUT', '10', '0', '20', '49.8', '30', '0', '11', '50', '21', '49.8', '31', '0',
            '0', 'ENDSEC',
            '0', 'EOF',
            '',
        ]);
    });
});

describe('formatDxfNumber', () => {
    it('keeps up to 6 decimals without trailing zeros', () => {
        expect(formatDxfNumber(10)).toBe('10');
        expect(formatDxfNumber(100)).toBe('100');
        expect(formatDxfNumber(0.5)).toBe('0.5');
        expect(formatDxfNumber(1.23456789)).toBe('1.234568');
        expect(formatDxfNumber(-2.25)).toBe('-2.25');
        expect(formatDxfNumber(0.0000004)).toBe('0');
        expect(formatDxfNumber(-0.0000004)).toBe('0');
    });
});
