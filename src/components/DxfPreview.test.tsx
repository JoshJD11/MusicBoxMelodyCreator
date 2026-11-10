import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import DxfPreview, {
    DxfDrawingSvg, findHoleAt, HOLE_HIT_MARGIN_MM, HOLE_TOUCH_MARGIN_MM, IPreviewPlayhead, MAX_SCRUB_NOTES, PLAYHEAD_OVERHANG_MM,
} from './DxfPreview';
import { IMusicBoxNote } from '../utilities/MusicBoxNotes';
import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { computeMusicBoxLayout } from '../utilities/MusicBoxLayout';
import { playheadAt } from '../utilities/Playhead';
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

describe('DxfPreview: playback line', () => {
    const PX_PER_MM = 10;
    const SHEET_GAP_PX = 100;

    function loadOde() {
        const b = fs.readFileSync(path.resolve(__dirname, '../../samples/ode_to_joy.mid'));
        const midi = new MidiFile();
        midi.loadFromBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        return midi;
    }

    // Several sheets with several vertical strips each.
    const layout = computeMusicBoxLayout(loadOde(), BuiltInProfiles.thirtyNote, {
        pageWidthMm: 277, pageHeightMm: 190, startPaddingMm: 10, renderBorder: true, omitPageBoundaries: false,
        transposeOutOfRangeNotes: true, jigsawJoiners: false, loopMode: false, stripOrientation: 'vertical',
    });
    const dxfs = layout.drawings.map(createDxf);
    const circlesOf = (sheet: number) => parseDxf(dxfs[sheet]).circles;

    let frames: FrameRequestCallback[];
    beforeEach(() => {
        frames = [];
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.push(callback); return frames.length; });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());
    function runFrame() {
        const pending = frames;
        frames = [];
        pending.forEach(callback => callback(0));
    }

    function playheadProps(overrides: Partial<IPreviewPlayhead> = {}): IPreviewPlayhead {
        return { seconds: 0, playing: false, getSeconds: () => null, onDragStart: vi.fn(), onDrag: vi.fn(), onDragEnd: vi.fn(), ...overrides };
    }

    /** jsdom has no layout: sheet k is drawn at 10 px per mm, one below the other. */
    function placeSheets(container: HTMLElement) {
        let top = 0;
        container.querySelectorAll('.mb-musicBoxSvgWrapper svg').forEach((element, k) => {
            const svg = element as SVGSVGElement;
            const drawing = layout.drawings[k];
            const rect = { left: 0, top, x: 0, y: top, width: drawing.widthMm * PX_PER_MM, height: drawing.heightMm * PX_PER_MM };
            const bottom = top + rect.height;
            svg.getBoundingClientRect = () => ({ ...rect, right: rect.width, bottom, toJSON: () => ({}) }) as DOMRect;
            top += rect.height + SHEET_GAP_PX;
        });
    }
    /** Screen position of a point (mm) of sheet k. */
    function screen(k: number, x: number, y: number) {
        let top = 0;
        for (let i = 0; i < k; i++) {
            top += layout.drawings[i].heightMm * PX_PER_MM + SHEET_GAP_PX;
        }
        return { clientX: x * PX_PER_MM, clientY: top + y * PX_PER_MM };
    }

    function renderPreview(playhead: IPreviewPlayhead, onHoleClick = vi.fn()) {
        const utils = render(<DxfPreview files={{ layout, dxfs }} paperWidthMm={70.1} limitHeight={true}
            onHoleClick={onHoleClick} playhead={playhead} />);
        placeSheets(utils.container);
        return { ...utils, onHoleClick };
    }

    /** The visible line: its sheet and its ends (with the handles). */
    function shownLine(container: HTMLElement) {
        const groups = Array.from(container.querySelectorAll('.mb-playhead')) as SVGGElement[];
        const visible = groups.map((g, i) => [g, i] as const).filter(([g]) => g.style.display !== 'none');
        expect(visible.length).toBe(1);
        const [group, sheet] = visible[0];
        const line = group.querySelector('.mb-playheadLine')!;
        const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => Number(line.getAttribute(a)));
        return { sheet, x1, y1, x2, y2, group };
    }

    it('the test layout has several strips on several sheets', () => {
        expect(layout.drawings.length).toBeGreaterThan(1);
        expect(layout.drawings[0].strips.length).toBeGreaterThan(1);
    });

    it('draws the line of the moment on its sheet only, crossing the hole of each note, with handles beyond the strip', () => {
        const { container, rerender } = renderPreview(playheadProps());
        layout.holeNotes.forEach((notes, sheet) => {
            const circles = circlesOf(sheet);
            notes.forEach((note, j) => {
                if (j % 7 !== 0) {
                    return;
                }
                rerender(<DxfPreview files={{ layout, dxfs }} paperWidthMm={70.1} limitHeight={true}
                    playhead={playheadProps({ seconds: note.timeSeconds })} />);
                const line = shownLine(container);
                expect(line.sheet).toBe(sheet);
                // Vertical strips: a horizontal line, through the center of the hole.
                expect(line.y1).toBe(line.y2);
                expect(Math.abs(line.y1 - circles[j].cy)).toBeLessThan(1e-5);
                expect(Math.min(line.x1, line.x2) - 1e-9).toBeLessThan(circles[j].cx);
                expect(Math.max(line.x1, line.x2) + 1e-9).toBeGreaterThan(circles[j].cx);
                // As wide as the paper, plus a handle on each side.
                expect(Math.abs(line.x2 - line.x1)).toBeCloseTo(70.1 + 2 * PLAYHEAD_OVERHANG_MM, 9);
                const knobs = line.group.querySelectorAll('.mb-playheadKnob');
                expect([knobs[0].getAttribute('cx'), knobs[1].getAttribute('cx')].map(Number)).toEqual([line.x1, line.x2]);
            });
        });
    });

    it('without a playback line nothing is added to the drawing', () => {
        const { container } = render(<DxfPreview files={{ layout, dxfs }} paperWidthMm={70.1} />);
        expect(container.querySelector('.mb-playhead')).toBeNull();
    });

    it('while playing it follows the song on every frame, and the holes it crosses glow (not after a jump)', () => {
        let now = 0;
        const { container } = renderPreview(playheadProps({ playing: true, getSeconds: () => now }));
        const note = layout.holeNotes[0][5];
        now = note.timeSeconds - 0.01;
        runFrame();
        expect(container.querySelectorAll('.mb-playheadFlash').length).toBe(0);
        now = note.timeSeconds + 0.005;
        runFrame();
        const flashes = Array.from(container.querySelectorAll('.mb-playheadFlash'));
        const crossed = layout.holeNotes[0].filter(n => n.timeSeconds > note.timeSeconds - 0.01 && n.timeSeconds <= now);
        expect(flashes.length).toBe(crossed.length);
        expect(Number(flashes[0].getAttribute('cy'))).toBeCloseTo(circlesOf(0)[5].cy, 5);
        expect(shownLine(container).y1).toBeCloseTo(playheadAt(layout, now)!.line.y1, 9);

        // A jump (e.g. the tab was hidden) does not light up everything in between.
        const later = layout.holeNotes[1][3];
        now = later.timeSeconds;
        runFrame();
        expect(container.querySelectorAll('.mb-playheadFlash').length).toBe(flashes.length);
        expect(shownLine(container).sheet).toBe(1);
    });

    it('dragging the line: a press that moves becomes a drag; it reports the time under the pointer and the holes crossed', () => {
        const start = layout.holeNotes[0][2].timeSeconds - 0.05;
        const playhead = playheadProps({ seconds: start });
        const { container, onHoleClick } = renderPreview(playhead);
        const hit = container.querySelector('.mb-playheadHit')!;
        const at = playheadAt(layout, start)!;
        const x = (at.line.x1 + at.line.x2) / 2;

        fireEvent.pointerDown(hit, { pointerId: 1, pointerType: 'mouse', button: 0, ...screen(0, x, at.line.y1) });
        fireEvent.pointerMove(hit, { pointerId: 1, pointerType: 'mouse', ...screen(0, x, at.line.y1 + 0.3) }); // 3 px: still a click
        expect(playhead.onDragStart).not.toHaveBeenCalled();

        const target = layout.holeNotes[0][6].timeSeconds + 0.01;
        const targetLine = playheadAt(layout, target)!.line;
        fireEvent.pointerMove(hit, { pointerId: 1, pointerType: 'mouse', ...screen(0, x, targetLine.y1) });
        expect(playhead.onDragStart).toHaveBeenCalledTimes(1);
        const [seconds, crossed] = (playhead.onDrag as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0];
        expect(seconds).toBeCloseTo(target, 9);
        const expected = layout.holeNotes[0].filter(n => n.timeSeconds > start && n.timeSeconds <= target).slice(-MAX_SCRUB_NOTES);
        expect(crossed.map((n: IMusicBoxNote) => n.id)).toEqual(expected.map(n => n.id));
        expect(shownLine(container).y1).toBeCloseTo(targetLine.y1, 9);

        fireEvent.pointerUp(hit, { pointerId: 1, pointerType: 'mouse', ...screen(0, x, targetLine.y1) });
        expect(playhead.onDragEnd).toHaveBeenCalledTimes(1);
        // The click that ends the drag does not select the hole under the line.
        fireEvent.click(hit, screen(0, x, targetLine.y1));
        expect(onHoleClick).not.toHaveBeenCalled();
    });

    it('a press without moving is a click: the hole under the line is selected and nothing is dragged', () => {
        const note = layout.holeNotes[0][4];
        const playhead = playheadProps({ seconds: note.timeSeconds });
        const { container, onHoleClick } = renderPreview(playhead);
        const hit = container.querySelector('.mb-playheadHit')!;
        const circle = circlesOf(0)[4];
        fireEvent.pointerDown(hit, { pointerId: 2, pointerType: 'touch', button: 0, ...screen(0, circle.cx, circle.cy) });
        // A finger trembles a little: up to 8 px is still a tap.
        fireEvent.pointerMove(hit, { pointerId: 2, pointerType: 'touch', ...screen(0, circle.cx + 0.5, circle.cy + 0.5) });
        fireEvent.pointerUp(hit, { pointerId: 2, pointerType: 'touch', ...screen(0, circle.cx, circle.cy) });
        fireEvent.click(hit, screen(0, circle.cx, circle.cy));
        expect(playhead.onDragStart).not.toHaveBeenCalled();
        expect(playhead.onDrag).not.toHaveBeenCalled();
        expect(onHoleClick).toHaveBeenCalledWith(note.id);
    });

    it('dragged backwards, the crossed holes come in the order the line meets them', () => {
        const start = layout.holeNotes[0][8].timeSeconds + 0.01;
        const playhead = playheadProps({ seconds: start });
        const { container } = renderPreview(playhead);
        const hit = container.querySelector('.mb-playheadHit')!;
        const from = playheadAt(layout, start)!.line;
        const target = layout.holeNotes[0][6].timeSeconds - 0.01;
        const to = playheadAt(layout, target)!.line;
        const middle = (from.x1 + from.x2) / 2;
        fireEvent.pointerDown(hit, { pointerId: 3, pointerType: 'mouse', button: 0, ...screen(0, middle, from.y1) });
        fireEvent.pointerMove(hit, { pointerId: 3, pointerType: 'mouse', ...screen(0, middle, to.y1) });
        const [, crossed] = (playhead.onDrag as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0];
        const expected = layout.holeNotes[0].filter(n => n.timeSeconds >= target && n.timeSeconds < start).reverse();
        expect(crossed.map((n: IMusicBoxNote) => n.id)).toEqual(expected.slice(-MAX_SCRUB_NOTES).map(n => n.id));
        expect(crossed[0].timeSeconds).toBeGreaterThanOrEqual(crossed[crossed.length - 1].timeSeconds);
    });

    it('the line can be dragged to another strip and to another sheet', () => {
        const playhead = playheadProps({ seconds: 0 });
        const { container } = renderPreview(playhead);
        const hit = container.querySelector('.mb-playheadHit')!;
        const zero = playheadAt(layout, 0)!.line;
        fireEvent.pointerDown(hit, { pointerId: 4, pointerType: 'mouse', button: 0, ...screen(0, zero.x1 + 20, zero.y1) });

        // The second strip of the first sheet (its column), 30 mm from its top.
        const second = layout.sheets[0].strips[1];
        const secondX = second.offsetYMm + 35;
        fireEvent.pointerMove(hit, { pointerId: 4, pointerType: 'mouse', ...screen(0, secondX, second.offsetXMm + 30) });
        let [seconds] = (playhead.onDrag as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0];
        expect(seconds).toBeCloseTo(layout.pages[1].startTimeInSeconds + 30 / 20, 9);
        expect(shownLine(container).sheet).toBe(0);

        // The first strip of the second sheet.
        const next = layout.sheets[1].strips[0];
        const firstPageOfSheet2 = layout.sheets[0].strips.length;
        fireEvent.pointerMove(hit, { pointerId: 4, pointerType: 'mouse', ...screen(1, next.offsetYMm + 35, next.offsetXMm + 12) });
        [seconds] = (playhead.onDrag as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0];
        expect(seconds).toBeCloseTo(layout.pages[firstPageOfSheet2].startTimeInSeconds + 12 / 20, 9);
        expect(shownLine(container).sheet).toBe(1);
        fireEvent.pointerUp(hit, { pointerId: 4, pointerType: 'mouse', ...screen(1, next.offsetYMm + 35, next.offsetXMm + 12) });
        expect(playhead.onDragEnd).toHaveBeenCalledTimes(1);
    });

    it('does not follow the song while it is being dragged, and ignores other pointers', () => {
        let now = 1;
        const playhead = playheadProps({ playing: true, getSeconds: () => now });
        const { container } = renderPreview(playhead);
        runFrame();
        const hit = container.querySelector('.mb-playheadHit')!;
        const line = playheadAt(layout, 1)!.line;
        fireEvent.pointerDown(hit, { pointerId: 5, pointerType: 'mouse', button: 0, ...screen(0, line.x1 + 20, line.y1) });
        fireEvent.pointerMove(hit, { pointerId: 6, pointerType: 'mouse', ...screen(0, line.x1 + 20, line.y1 + 40) });
        expect(playhead.onDragStart).not.toHaveBeenCalled();
        fireEvent.pointerMove(hit, { pointerId: 5, pointerType: 'mouse', ...screen(0, line.x1 + 20, line.y1 + 40) });
        expect(playhead.onDragStart).toHaveBeenCalledTimes(1);
        const dragged = shownLine(container).y1;
        now = 3;
        runFrame();
        expect(shownLine(container).y1).toBe(dragged);
    });
    it('while playing only the box of the strips follows the line: the page is never scrolled, and the user\'s scrolling goes to the page', () => {
        let now = 1;
        const playhead = playheadProps({ playing: false, getSeconds: () => now });
        const { container, rerender } = renderPreview(playhead);
        const box = container.querySelector('.mb-musicBoxSvgPages') as HTMLElement;
        const rect = (top: number, height: number) => (() => ({ left: 0, right: 300, x: 0, y: top, top, bottom: top + height, width: 300, height, toJSON: () => ({}) })) as () => DOMRect;
        // The box is partly on screen and the line is below the window.
        box.getBoundingClientRect = rect(500, 600);
        container.querySelectorAll('.mb-playheadLine').forEach(line => { (line as SVGElement).getBoundingClientRect = rect(950, 1); });
        const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
        const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
        expect(box.classList.contains('mb-musicBoxSvgPages-following')).toBe(false);

        rerender(<DxfPreview files={{ layout, dxfs }} paperWidthMm={70.1} limitHeight={true} playhead={{ ...playhead, playing: true }} />);
        // The box keeps the line at a third of its height (vertical strips)...
        expect(box.scrollTop).toBeCloseTo(950.5 - (500 + 600 / 3), 6);
        // ...and doesn't take the wheel or the finger while doing it (they scroll the page).
        expect(box.classList.contains('mb-musicBoxSvgPages-following')).toBe(true);
        now = 2;
        runFrame();
        now = 3;
        runFrame();
        expect(scrollBy).not.toHaveBeenCalled();
        expect(scrollTo).not.toHaveBeenCalled();

        // Paused: the box can be scrolled by hand again.
        rerender(<DxfPreview files={{ layout, dxfs }} paperWidthMm={70.1} limitHeight={true} playhead={{ ...playhead, playing: false }} />);
        expect(box.classList.contains('mb-musicBoxSvgPages-following')).toBe(false);
    });
});
