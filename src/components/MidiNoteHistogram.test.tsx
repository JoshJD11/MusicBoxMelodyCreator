import React from 'react';
import { render } from '@testing-library/react';
import MidiNoteHistogram from './MidiNoteHistogram';
import { IMidiStats } from '../model/MidiFile';
import { MidiNote } from '../model/MidiConstants';

function statsOf(notes: number[]): IMidiStats {
    const noteHistogram = new Map<MidiNote, number>();
    notes.forEach(note => noteHistogram.set(note, (noteHistogram.get(note) || 0) + 1));
    return {
        lowNote: Math.min(...notes),
        highNote: Math.max(...notes),
        noteHistogram,
    } as IMidiStats;
}

describe('MidiNoteHistogram', () => {
    it('draws one bar per note used, from the lowest to the highest note', () => {
        const { container } = render(<MidiNoteHistogram width={320} height={80} midiStats={statsOf([60, 60, 62, 72])} />);
        const bars = Array.from(container.querySelectorAll('rect'));
        expect(bars.map(bar => bar.textContent)).toEqual(['2', '1', '1']);
        // The highest note ends exactly at the right edge of the drawing.
        const last = bars[bars.length - 1];
        expect(Number(last.getAttribute('x')) + Number(last.getAttribute('width'))).toBeCloseTo(320, 6);
    });

    it('scales with its container: on a narrow screen the whole drawing shrinks instead of being cut off', () => {
        const { container } = render(<MidiNoteHistogram width={320} height={80} midiStats={statsOf([41, 60, 91])} />);
        const svg = container.querySelector('svg') as SVGSVGElement;
        expect(svg.getAttribute('viewBox')).toBe('0 0 320 80');
        expect(svg.getAttribute('width')).toBe('320');
        expect(svg.getAttribute('height')).toBe('80');
    });

    it('draws nothing without notes', () => {
        const empty = { lowNote: MidiNote.None, highNote: MidiNote.None, noteHistogram: new Map() } as IMidiStats;
        expect(render(<MidiNoteHistogram width={320} height={80} midiStats={empty} />).container.querySelector('svg')).toBeNull();
    });
});
