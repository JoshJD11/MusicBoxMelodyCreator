import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { IMusicBoxSvgFormatOptions } from '../model/IMusicBoxSvgFormatOptions';
import { computeMusicBoxLayout, ISheet } from './MusicBoxLayout';
import { createDxf } from './DxfExporter';
import { parseDxf } from './DxfReader';

const FORMAT: IMusicBoxSvgFormatOptions = {
    pageWidthMm: 250, pageHeightMm: 200, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
    transposeOutOfRangeNotes: true, jigsawJoiners: false, loopMode: false,
};
const VARIANTS: IMusicBoxSvgFormatOptions[] = [
    FORMAT,
    { ...FORMAT, mirrorVertically: true },
    { ...FORMAT, jigsawJoiners: true, loopMode: true },
    { ...FORMAT, pageWidthMm: 0, pageHeightMm: 0 },
    { ...FORMAT, pageWidthMm: 190, pageHeightMm: 277 },
];
const SAMPLES = ['happy_birthday.mid', 'You are my sunshine.mid', 'The Lonely Man (The Incredible Hulk 1978) Finished Version.mid'];
const TOLERANCE_MM = 1e-6; // the DXF keeps 6 decimals

function flatten(sheet: ISheet) {
    return {
        lines: sheet.strips.flatMap(s => s.geometry.lines.map(l => ({ ...l, y1: l.y1 + s.offsetYMm, y2: l.y2 + s.offsetYMm }))),
        circles: sheet.strips.flatMap(s => s.geometry.circles.map(c => ({ ...c, cy: c.cy + s.offsetYMm }))),
    };
}

describe('parseDxf', () => {
    SAMPLES.forEach(sample => Object.keys(BuiltInProfiles).forEach(profileKey => {
        it(`reads back exactly what createDxf wrote: ${sample} / ${profileKey}`, () => {
            const b = fs.readFileSync(path.resolve(__dirname, '../../samples', sample));
            const midiFile = new MidiFile();
            midiFile.loadFromBuffer(Uint8Array.from(b).buffer);

            VARIANTS.forEach(format => {
                computeMusicBoxLayout(midiFile, BuiltInProfiles[profileKey], format).sheets.forEach(sheet => {
                    const drawing = parseDxf(createDxf(sheet));
                    const expected = flatten(sheet);
                    expect(drawing.widthMm).toBeCloseTo(sheet.widthMm, 6);
                    expect(drawing.heightMm).toBeCloseTo(sheet.heightMm, 6);
                    expect(drawing.lines.length).toBe(expected.lines.length);
                    expect(drawing.circles.length).toBe(expected.circles.length);
                    drawing.lines.forEach((l, i) => {
                        const e = expected.lines[i];
                        expect(Math.max(Math.abs(l.x1 - e.x1), Math.abs(l.y1 - e.y1), Math.abs(l.x2 - e.x2), Math.abs(l.y2 - e.y2)))
                            .toBeLessThanOrEqual(TOLERANCE_MM);
                    });
                    drawing.circles.forEach((c, i) => {
                        const e = expected.circles[i];
                        expect(Math.max(Math.abs(c.cx - e.cx), Math.abs(c.cy - e.cy), Math.abs(c.r - e.r)))
                            .toBeLessThanOrEqual(TOLERANCE_MM);
                    });
                });
            });
        });
    }));

    it('flips the y axis back to screen coordinates', () => {
        const drawing = parseDxf(createDxf({
            widthMm: 100, heightMm: 50,
            strips: [{ offsetYMm: 0, geometry: { lengthMm: 10, extentMm: 10, lines: [{ x1: 0, y1: 0, x2: 10, y2: 0 }], circles: [{ cx: 5, cy: 20, r: 1 }] } }],
        }));
        expect(drawing.lines).toEqual([{ x1: 0, y1: 0, x2: 10, y2: 0 }]);
        expect(drawing.circles).toEqual([{ cx: 5, cy: 20, r: 1 }]);
    });

    it('rejects unexpected content instead of drawing something different', () => {
        const valid = createDxf({ widthMm: 10, heightMm: 10, strips: [] });
        expect(() => parseDxf(valid.replace('ENTITIES\r\n', 'ENTITIES\r\n0\r\nPOLYLINE\r\n'))).toThrow(/unexpected entity POLYLINE/);
        expect(() => parseDxf(valid.replace('$EXTMAX', '$OTHER'))).toThrow(/missing \$EXTMAX/);
        expect(() => parseDxf('0\r\nSECTION\r\n2')).toThrow(/not paired/);
        const circleWithoutRadius = createDxf({
            widthMm: 10, heightMm: 10,
            strips: [{ offsetYMm: 0, geometry: { lengthMm: 1, extentMm: 1, lines: [], circles: [{ cx: 1, cy: 1, r: 1 }] } }],
        }).replace('40\r\n1\r\n', '');
        expect(() => parseDxf(circleWithoutRadius)).toThrow(/group code 40/);
    });
});
