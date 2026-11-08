import React from 'react';
import { cleanup, render } from '@testing-library/react';
import DxfPreview, { DxfDrawingSvg } from './DxfPreview';
import { IDxfDrawing, parseDxf } from '../utilities/DxfReader';
import { createDxf } from '../utilities/DxfExporter';
import { ISheetDrawing } from '../utilities/SheetDrawing';
import { IMusicBoxLayout } from '../utilities/MusicBoxLayout';

const SHEET: ISheetDrawing = {
    widthMm: 200,
    heightMm: 250,
    strips: [{
        lines: [{ x1: 0, y1: 0, x2: 70.1, y2: 0 }, { x1: 0, y1: 0, x2: 0, y2: 201 }],
        circles: [{ cx: 10, cy: 20, r: 1.1 }, { cx: 30, cy: 40, r: 1.1 }],
    }],
};

const LAYOUT = { messages: [], totalPaperLengthMm: 201 } as unknown as IMusicBoxLayout;

afterEach(cleanup);

describe('DxfDrawingSvg', () => {
    const drawing: IDxfDrawing = parseDxf(createDxf(SHEET));

    it('draws exactly the lines and holes of the DXF, in millimeters', () => {
        const { container } = render(<DxfDrawingSvg drawing={drawing} />);
        const svg = container.querySelector('svg')!;
        expect(svg.getAttribute('width')).toBe('200mm');
        expect(svg.getAttribute('height')).toBe('250mm');
        expect(svg.getAttribute('viewBox')).toBe('0 0 200 250');
        expect(container.querySelectorAll('line').length).toBe(2);
        expect(container.querySelectorAll('circle').length).toBe(2);
        expect(container.querySelector('circle')!.getAttribute('r')).toBe('1.1');
    });

    it('outlines the whole sheet faintly, behind the cut lines', () => {
        const { container } = render(<DxfDrawingSvg drawing={drawing} />);
        const outlines = container.querySelectorAll('rect.mb-sheetOutline');
        expect(outlines.length).toBe(1);
        const outline = outlines[0];
        expect([outline.getAttribute('x'), outline.getAttribute('y')]).toEqual(['0', '0']);
        expect([outline.getAttribute('width'), outline.getAttribute('height')]).toEqual(['200', '250']);
        expect(outline.getAttribute('fill')).toBe('none');
        expect(outline.getAttribute('stroke')).not.toBe('black');
        expect(outline.getAttribute('stroke-dasharray')).toBeTruthy();
        // Drawn first, so that the cut lines are on top of it.
        expect(container.querySelector('svg')!.firstElementChild).toBe(outline);
    });

    it('is not part of the downloaded file', () => {
        expect(createDxf(SHEET)).not.toMatch(/LWPOLYLINE|POLYLINE|SOLID|outline/i);
        expect(drawing.lines.length).toBe(2);
    });
});

describe('DxfPreview', () => {
    it('draws one outlined sheet per DXF, in a height-limited box only when asked', () => {
        const dxfs = [createDxf(SHEET), createDxf({ ...SHEET, widthMm: 100 })];
        const { container, rerender } = render(
            <DxfPreview files={{ layout: LAYOUT, dxfs }} paperWidthMm={70.1} limitHeight={true} />);
        expect(container.querySelectorAll('.mb-musicBoxSvgPages-limited svg').length).toBe(2);
        expect(Array.from(container.querySelectorAll('rect.mb-sheetOutline')).map(r => r.getAttribute('width')))
            .toEqual(['200', '100']);

        rerender(<DxfPreview files={{ layout: LAYOUT, dxfs }} paperWidthMm={70.1} />);
        expect(container.querySelector('.mb-musicBoxSvgPages-limited')).toBeNull();
        expect(container.querySelectorAll('.mb-musicBoxSvgPages svg').length).toBe(2);
    });

    it('shows the error instead of a drawing when the strips cannot be generated', () => {
        const { container, getByText } = render(
            <DxfPreview files={{ error: 'Sheet width must be at least 70.10 mm to fit one strip.' }} paperWidthMm={70.1} />);
        expect(getByText(/Sheet width must be at least 70.10 mm/)).toBeTruthy();
        expect(container.querySelector('.mb-musicBoxSvgWrapper')).toBeNull();
    });

    it('shows a readable error for a sheet whose DXF cannot be read', () => {
        const { getByText } = render(
            <DxfPreview files={{ layout: LAYOUT, dxfs: ['0\r\nSECTION\r\n2'] }} paperWidthMm={70.1} />);
        expect(getByText(/Sheet 1: Invalid DXF/)).toBeTruthy();
    });
});
