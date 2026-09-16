import MidiFile, { MidiFileFormat, MidiTrack } from '../model/MidiFile';
import { IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { ChannelMessageType, NoteMidiEvent } from '../model/MidiEvents';
import { MidiNote } from '../model/MidiConstants';

export interface IGeneratedMusicBoxEvent {
    note: MidiNote;
    startTimeSeconds: number;
    durationSeconds: number;
    velocity: number;
}

export function buildGeneratedMusicBoxSequence(
    midiFile: MidiFile,
    musicBoxProfile: IMusicBoxProfile,
    transposeOutOfRangeNotes: boolean = true
): IGeneratedMusicBoxEvent[] {
    const tracks = midiFile.getTracks();
    const header = midiFile.getHeader();
    const musicTrack: MidiTrack = header.fileFormat === MidiFileFormat.multiTrack
        ? (tracks[1] ?? tracks[0])
        : tracks[0];

    if (!musicTrack) {
        return [];
    }

    const supportedNotes = musicBoxProfile.supportedNotes;
    const supportedSet = new Set<MidiNote>(supportedNotes);
    const activeNotes = new Map<string, { note: MidiNote; startTimeSeconds: number; velocity: number; channel: number }>();
    const completedEvents: IGeneratedMusicBoxEvent[] = [];

    for (const event of musicTrack.events) {
        if (!(event instanceof NoteMidiEvent)) {
            continue;
        }

        const key = `${event.channel}:${event.note}`;

        if (event.channelMessageType === ChannelMessageType.NoteOn && event.velocity > 0) {
            activeNotes.set(key, {
                note: event.note,
                startTimeSeconds: event.absTimeSeconds,
                velocity: event.velocity,
                channel: event.channel,
            });
            continue;
        }

        if (
            event.channelMessageType === ChannelMessageType.NoteOff ||
            (event.channelMessageType === ChannelMessageType.NoteOn && event.velocity === 0)
        ) {
            const activeNote = activeNotes.get(key);
            if (activeNote) {
                const resolvedNote = resolveSupportedNote(activeNote.note, supportedSet, transposeOutOfRangeNotes, supportedNotes);
                if (resolvedNote !== null) {
                    completedEvents.push({
                        note: resolvedNote,
                        startTimeSeconds: activeNote.startTimeSeconds,
                        durationSeconds: Math.max(0.12, event.absTimeSeconds - activeNote.startTimeSeconds),
                        velocity: activeNote.velocity,
                    });
                }
                activeNotes.delete(key);
            }
        }
    }

    for (const activeNote of Array.from(activeNotes.values())) {
        const resolvedNote = resolveSupportedNote(activeNote.note, supportedSet, transposeOutOfRangeNotes, supportedNotes);
        if (resolvedNote !== null) {
            completedEvents.push({
                note: resolvedNote,
                startTimeSeconds: activeNote.startTimeSeconds,
                durationSeconds: 0.35,
                velocity: activeNote.velocity,
            });
        }
    }

    return completedEvents.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
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

function resolveSupportedNote(
    note: MidiNote,
    supportedSet: Set<MidiNote>,
    transposeOutOfRangeNotes: boolean,
    supportedNotes: MidiNote[]
): MidiNote | null {
    if (supportedSet.has(note)) {
        return note;
    }

    if (!transposeOutOfRangeNotes) {
        return null;
    }

    const samePitchClass = supportedNotes.filter((candidate) => candidate % 12 === note % 12);
    if (samePitchClass.length > 0) {
        return samePitchClass.reduce((best, candidate) => {
            return Math.abs(candidate - note) < Math.abs(best - note) ? candidate : best;
        }, samePitchClass[0]);
    }

    if (supportedNotes.length > 0) {
        return supportedNotes.reduce((best, candidate) => {
            return Math.abs(candidate - note) < Math.abs(best - note) ? candidate : best;
        }, supportedNotes[0]);
    }

    return null;
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
