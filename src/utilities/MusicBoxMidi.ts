import MidiFile from '../model/MidiFile';
import { IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { MidiNote } from '../model/MidiConstants';
import { extractMusicBoxNotes, INoteExtractionOptions } from './MusicBoxNotes';

export interface IGeneratedMusicBoxEvent {
    note: MidiNote;
    startTimeSeconds: number;
    durationSeconds: number;
    velocity: number;
}

/**
 * The sequence of notes that the music box will play: exactly the holes punched in the strip
 * (same tracks, transpositions and dropped notes), so that the preview matches the strip.
 */
export function buildGeneratedMusicBoxSequence(
    midiFile: MidiFile,
    musicBoxProfile: IMusicBoxProfile,
    options: INoteExtractionOptions
): IGeneratedMusicBoxEvent[] {
    return extractMusicBoxNotes(midiFile, musicBoxProfile, options).notes.map(note => ({
        note: note.note,
        startTimeSeconds: note.timeSeconds,
        durationSeconds: note.durationSeconds,
        velocity: note.velocity,
    }));
}

export function exportGeneratedMusicBoxMidi(
    sequence: IGeneratedMusicBoxEvent[],
    options: { tempoBpm?: number; channel?: number; velocity?: number } = {}
): Blob {
    const tempoBpm = options.tempoBpm ?? 120;
    const channel = options.channel ?? 0;
    const defaultVelocity = options.velocity ?? 90;
    const ppqn = 480;
    const ticksPerSecond = (ppqn * tempoBpm) / 60;
    const microsecondsPerQuarter = Math.round(60000000 / tempoBpm);

    const trackBytes: number[] = [];

    trackBytes.push(0x00, 0xff, 0x51, 0x03,
        (microsecondsPerQuarter >> 16) & 0xff,
        (microsecondsPerQuarter >> 8) & 0xff,
        microsecondsPerQuarter & 0xff
    );

    let previousTick = 0;
    for (const event of sequence) {
        const startTick = Math.max(0, Math.round(event.startTimeSeconds * ticksPerSecond));
        const endTick = Math.max(startTick + 1, Math.round((event.startTimeSeconds + event.durationSeconds) * ticksPerSecond));

        const onDelta = startTick - previousTick;
        trackBytes.push(...encodeVariableLength(onDelta));
        trackBytes.push(0x90 | channel, Math.max(0, Math.min(127, event.note)), Math.max(1, Math.min(127, event.velocity || defaultVelocity)));

        const offDelta = endTick - startTick;
        trackBytes.push(...encodeVariableLength(offDelta));
        trackBytes.push(0x80 | channel, Math.max(0, Math.min(127, event.note)), 0);

        previousTick = endTick;
    }

    trackBytes.push(0x00, 0xff, 0x2f, 0x00);

    const header = new Uint8Array([
        0x4d, 0x54, 0x68, 0x64,
        0x00, 0x00, 0x00, 0x06,
        0x00, 0x00,
        0x00, 0x01,
        0x01, 0xe0,
    ]);

    const trackLength = trackBytes.length;
    const trackLengthBytes = [
        (trackLength >> 24) & 0xff,
        (trackLength >> 16) & 0xff,
        (trackLength >> 8) & 0xff,
        trackLength & 0xff,
    ];

    const fileTrack = new Uint8Array([
        0x4d, 0x54, 0x72, 0x6b,
        ...trackLengthBytes,
        ...trackBytes,
    ]);

    return new Blob([header, fileTrack], { type: 'audio/midi' });
}

function encodeVariableLength(value: number): number[] {
    const bytes: number[] = [];
    let working = Math.max(0, value);

    if (working === 0) {
        return [0];
    }

    do {
        const byte = working & 0x7f;
        working = Math.floor(working / 0x80);
        if (working > 0) {
            bytes.push(byte | 0x80);
        } else {
            bytes.push(byte);
        }
    } while (working > 0);

    return bytes.reverse();
}
