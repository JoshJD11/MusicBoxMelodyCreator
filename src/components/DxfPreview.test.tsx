import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import DxfPreview, { DxfDrawingSvg, findHoleAt, HOLE_HIT_MARGIN_MM, HOLE_TOUCH_MARGIN_MM } from './DxfPreview';
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
});

describe('DxfPreview', () => {
    it('draws one sheet per DXF, in a height-limited box only when asked', () => {
        const dxfs = [createDxf(SHEET), createDxf({ ...SHEET, widthMm: 100 })];
        const { container, rerender } = render(
            <DxfPreview files={{ layout: LAYOUT, dxfs }} paperWidthMm={70.1} limitHeight={true} />);
        expect(container.querySelectorAll('.mb-musicBoxSvgPages-limited svg').length).toBe(2);
        expect(Array.from(container.querySelectorAll('.mb-musicBoxSvgWrapper > svg')).map(svg => svg.getAttribute('width')))
            .toEqual(['200mm', '100mm']);

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

describe('findHoleAt', () => {
    const circles = [{ cx: 10, cy: 10, r: 1 }, { cx: 12.5, cy: 10, r: 1 }, { cx: 30, cy: 30, r: 1.1 }];

    it('finds the hole under the point, or near its edge', () => {
        expect(findHoleAt(circles, 10, 10)).toBe(0);
        expect(findHoleAt(circles, 30.5, 29.5)).toBe(2);
        expect(findHoleAt(circles, 30 + 1.1 + HOLE_HIT_MARGIN_MM - 0.01, 30)).toBe(2);
    });

    it('finds nothing farther away', () => {
        expect(findHoleAt(circles, 30 + 1.1 + HOLE_HIT_MARGIN_MM + 0.01, 30)).toBeNull();
        expect(findHoleAt(circles, 50, 50)).toBeNull();
        expect(findHoleAt([], 10, 10)).toBeNull();
    });

    it('picks the nearest of two close holes', () => {
        expect(findHoleAt(circles, 11.1, 10)).toBe(0);
        expect(findHoleAt(circles, 11.4, 10)).toBe(1);
    });
});

describe('DxfDrawingSvg: selecting holes', () => {
    const drawing: IDxfDrawing = parseDxf(createDxf(SHEET)); // holes at (10, 20) and (30, 40), r = 1.1
    const IDS = ['1:0', '1:2'];
    /** jsdom has no layout: the sheet is drawn at 10 px per mm, at the top-left corner. */
    const PX_PER_MM = 10;

    function renderEditable(props: Partial<React.ComponentProps<typeof DxfDrawingSvg>> = {}) {
        const onHoleClick = vi.fn();
        const result = render(<DxfDrawingSvg drawing={drawing} holeIds={IDS} onHoleClick={onHoleClick} {...props} />);
        const svg = result.container.querySelector('svg')!;
        svg.getBoundingClientRect = () => ({
            left: 0, top: 0, x: 0, y: 0, width: 200 * PX_PER_MM, height: 250 * PX_PER_MM,
            right: 200 * PX_PER_MM, bottom: 250 * PX_PER_MM, toJSON: () => ({}),
        });
        return { ...result, svg, onHoleClick };
    }
    const at = (xMm: number, yMm: number, extra: object = {}) => ({ clientX: xMm * PX_PER_MM, clientY: yMm * PX_PER_MM, ...extra });
    const hoverRing = (container: HTMLElement) => container.querySelector('.mb-hole-hover');

    it('rings the hole under the mouse in green, with a pointer cursor, and nothing elsewhere', () => {
        const { container, svg } = renderEditable();
        fireEvent.pointerMove(svg, at(30.6, 39.5, { pointerType: 'mouse' }));
        const ring = hoverRing(container)!;
        expect(ring).not.toBeNull();
        expect([ring.getAttribute('cx'), ring.getAttribute('cy')]).toEqual(['30', '40']);
        expect(Number(ring.getAttribute('r'))).toBeCloseTo(1.8, 6); // 0.7 mm around the hole
        expect(svg.style.cursor).toBe('pointer');

        fireEvent.pointerMove(svg, at(100, 100, { pointerType: 'mouse' }));
        expect(hoverRing(container)).toBeNull();
        expect(svg.style.cursor).toBe('');

        fireEvent.pointerMove(svg, at(10, 20, { pointerType: 'mouse' }));
        expect(hoverRing(container)!.getAttribute('cx')).toBe('10');
        // Leaving the sheet (React 16 derives pointerleave from pointerout, like in a browser).
        fireEvent.pointerOut(svg, { relatedTarget: document.body });
        expect(hoverRing(container)).toBeNull();
    });

    it('does not ring holes on touch screens (no hover there): a tap selects directly', () => {
        const { container, svg, onHoleClick } = renderEditable();
        fireEvent.pointerMove(svg, at(10, 20, { pointerType: 'touch' }));
        expect(hoverRing(container)).toBeNull();
        fireEvent.click(svg, at(10, 20));
        expect(onHoleClick).toHaveBeenCalledWith('1:0');
    });

    it('gives a finger a wider margin than the mouse (still picking the nearest hole)', () => {
        const { svg, onHoleClick } = renderEditable();
        // 3 mm from the center of the hole at (10, 20): beyond the mouse margin, within the finger's.
        const offset = 1.1 + (HOLE_HIT_MARGIN_MM + HOLE_TOUCH_MARGIN_MM) / 2;
        fireEvent.pointerDown(svg, at(10 + offset, 20, { pointerType: 'mouse' }));
        fireEvent.click(svg, at(10 + offset, 20));
        expect(onHoleClick).not.toHaveBeenCalled();
        fireEvent.pointerDown(svg, at(10 + offset, 20, { pointerType: 'touch' }));
        fireEvent.click(svg, at(10 + offset, 20));
        expect(onHoleClick).toHaveBeenCalledWith('1:0');
        fireEvent.pointerDown(svg, at(10 + 1.1 + HOLE_TOUCH_MARGIN_MM + 0.1, 20, { pointerType: 'touch' }));
        fireEvent.click(svg, at(10 + 1.1 + HOLE_TOUCH_MARGIN_MM + 0.1, 20));
        expect(onHoleClick).toHaveBeenCalledTimes(1);
    });

    it('reports the note id of the hole clicked, and nothing when clicking the paper', () => {
        const { svg, onHoleClick } = renderEditable();
        fireEvent.click(svg, at(31, 41));
        expect(onHoleClick).toHaveBeenLastCalledWith('1:2');
        fireEvent.click(svg, at(10.5, 19.5));
        expect(onHoleClick).toHaveBeenLastCalledWith('1:0');
        onHoleClick.mockClear();
        fireEvent.click(svg, at(60, 60));
        expect(onHoleClick).not.toHaveBeenCalled();
    });

    it('fills and rings the selected holes, without changing the drawing of the sheet', () => {
        const { container } = renderEditable({ selectedHoleIds: new Set(['1:2', 'not-on-this-sheet']) });
        const selected = container.querySelectorAll('.mb-hole-selected');
        expect(selected.length).toBe(1);
        expect(selected[0].querySelector('.mb-hole-selectedFill')!.getAttribute('cx')).toBe('30');
        expect(selected[0].querySelector('.mb-hole-ring')).not.toBeNull();
        // The holes of the DXF are still drawn as they are.
        expect(container.querySelectorAll('g:not(.mb-holeHighlights) > circle[stroke="black"]').length).toBe(2);
    });

    it('a hole that is gone (deleted) is no longer ringed', () => {
        const { container, svg, rerender, onHoleClick } = renderEditable();
        fireEvent.pointerMove(svg, at(30, 40, { pointerType: 'mouse' }));
        expect(hoverRing(container)).not.toBeNull();
        const without = parseDxf(createDxf({ ...SHEET, strips: [{ ...SHEET.strips[0], circles: [SHEET.strips[0].circles[0]] }] }));
        rerender(<DxfDrawingSvg drawing={without} holeIds={['1:0']} onHoleClick={onHoleClick} />);
        expect(hoverRing(container)).toBeNull();
    });

    it('is not selectable without a handler, or if the ids do not match the holes', () => {
        const plain = render(<DxfDrawingSvg drawing={drawing} holeIds={IDS} />);
        expect(plain.container.querySelector('.mb-sheetSvg-editable')).toBeNull();
        expect(plain.container.querySelector('.mb-holeHighlights')).toBeNull();

        const { container, svg, onHoleClick } = renderEditable({ holeIds: ['1:0'] });
        fireEvent.click(svg, at(10, 20));
        fireEvent.pointerMove(svg, at(10, 20, { pointerType: 'mouse' }));
        expect(onHoleClick).not.toHaveBeenCalled();
        expect(container.querySelector('.mb-holeHighlights')).toBeNull();
    });
});

describe('DxfPreview: hole editing', () => {
    const NOTES = [{ id: '1:0' }, { id: '1:2' }];

    it('gives every sheet the note ids of its holes and shows the toolbar above the sheets', () => {
        const layout = { ...LAYOUT, holeNotes: [NOTES] } as unknown as IMusicBoxLayout;
        const onHoleClick = vi.fn();
        const { container, getByText } = render(
            <DxfPreview files={{ layout, dxfs: [createDxf(SHEET)] }} paperWidthMm={70.1}
                selectedHoleIds={new Set(['1:0'])} onHoleClick={onHoleClick}
                toolbar={<div className="test-toolbar">toolbar</div>} />);
        expect(container.querySelectorAll('.mb-sheetSvg-editable').length).toBe(1);
        expect(container.querySelectorAll('.mb-hole-selected').length).toBe(1);
        const toolbar = getByText('toolbar');
        const pages = container.querySelector('.mb-musicBoxSvgPages')!;
        expect(toolbar.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the toolbar under the error, so that deletions can be undone', () => {
        const { getByText } = render(
            <DxfPreview files={{ error: 'Every hole was deleted. Use Undo or Restore all to bring them back.' }}
                paperWidthMm={70.1} toolbar={<div>toolbar</div>} />);
        expect(getByText(/Every hole was deleted/)).toBeTruthy();
        expect(getByText('toolbar')).toBeTruthy();
    });
});
