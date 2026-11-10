import * as React from 'react';
import { IMidiStats } from '../model/MidiFile';
import { MidiNote } from '../model/MidiConstants';
import { Colors } from "@blueprintjs/core";

export interface IMidiNoteHistogramProps {
    midiStats: IMidiStats;
    width: number;
    height: number;
}

export default function MidiNoteHistogram(props: IMidiNoteHistogramProps) {
    const stats = props.midiStats;
    const noteRange = stats.highNote - stats.lowNote + 1;
    if (stats.lowNote === MidiNote.None || noteRange <= 0) {
        return null;
    }

    const noteWidth = props.width / noteRange;

    const bars: JSX.Element[] = [];
    const noteAxis: JSX.Element[] = [];

    // This will help scale the bars
    let maxNoteCount = 0;

    const sparseAxis = noteRange > 30;

    for (let note = stats.lowNote; note <= stats.highNote; note++) {
        const friendlyNote = MidiNote[note].replace('s', '#');

        const xPosition = (note - stats.lowNote) * noteWidth;

        const noteCount = stats.noteHistogram.get(note);
        if (noteCount) {
            bars.push(
                <rect key={note} x={xPosition} width={noteWidth} y={0} height={noteCount} fill={Colors.BLUE1} >
                    <title>{noteCount}</title>
                </rect>
            );

            if (noteCount > maxNoteCount) { maxNoteCount = noteCount; }
        }

        if (sparseAxis && shouldSkipNoteInAxis(note, stats)) {
            continue;
        } else {
            const textX = xPosition + noteWidth;
            noteAxis.push(
                <text
                    key={note}
                    transform={`rotate(-90,${textX},0)`}
                    x={textX}
                    y={0}
                    fontSize='10'>
                    {friendlyNote}
                </text>
            );
        }
    }

    if (maxNoteCount === 0) {
        // No notes: nothing to draw.
        return null;
    }

    // 20 px reserved for axis
    const yScale = (props.height - 20) / maxNoteCount;

    return (
        // The viewBox makes the drawing shrink with the svg on narrow screens (without it, the right
        // side, i.e. the highest notes, was cut off).
        <svg width={props.width} height={props.height} viewBox={`0 0 ${props.width} ${props.height}`}>
            <g transform={'translate(0 20) scale(1 ' + yScale + ')'}>
                {bars}
            </g>
            <g transform={'translate(0 20)'}>
                {noteAxis}
            </g>
        </svg>
    );
}

function shouldSkipNoteInAxis(note: MidiNote, stats: IMidiStats) {
    if (note > stats.lowNote && note < stats.highNote) {
        // Low and high not always visible in axis
        // If in sparse axis mode, skip every other note, and skip the ones
        // next to the end labels.
        if (note === stats.lowNote + 1 || note === stats.highNote - 1) {
            return true;
        }

        // Skip every second axis laber otherwise
        return (note - stats.lowNote) % 2 === 0;
    }
    return false;
}