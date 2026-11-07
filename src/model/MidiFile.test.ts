import MidiFile, { MidiHeader, MidiFileFormat, MidiTimingScheme, MidiTrack } from './MidiFile';
import { IMidiEvent, MetaMidiEvent, NoteMidiEvent, PitchBendMidiEvent, SysExMidiEvent, ChannelMessageType } from './MidiEvents';
import { MIDIMetaMessageType, MidiNote } from './MidiConstants';
import {
    buildMidi, endOfTrack, noteOff, noteOn, pitchBend, runningStatus, sysEx, tempo, textMeta, trackName,
} from '../testUtils/midiBuilder';

function load(buffer: ArrayBuffer): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(buffer);
    return midiFile;
}

function noteStarts(track: MidiTrack): NoteMidiEvent[] {
    return track.events.filter(e =>
        e instanceof NoteMidiEvent && e.channelMessageType === ChannelMessageType.NoteOn && e.velocity > 0
    ) as NoteMidiEvent[];
}

/**
 * Equivalent of the original `c4-octave.mid` sample: type 1, 192 ticks per quarter note,
 * a tempo track of 20 seconds and a music track with C4, D4, ... C5, 0.5 seconds apart.
 */
function buildC4Octave(): ArrayBuffer {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72];
    const musicTrack: number[][] = [];
    notes.forEach(note => {
        musicTrack.push(noteOn(0, note, 100));
        musicTrack.push(noteOff(192, note));
    });
    musicTrack.push(endOfTrack(6144));

    return buildMidi({
        format: 1,
        ppqn: 192,
        tracks: [
            [tempo(0, 500000), endOfTrack(7680)],
            musicTrack,
        ],
    });
}

describe('Multitrack (type 1) MIDI file', () => {
    it('parses metrically timed file correctly', () => {
        const midiFile = load(buildC4Octave());

        // One header, one tempo track, one music track
        expect(midiFile.chunks.length).toBe(3);

        // Test header properties
        const header = midiFile.chunks[0] as MidiHeader;
        expect(header.fileFormat).toBe(MidiFileFormat.multiTrack);
        expect(header.numTracks).toBe(2);
        expect(header.timingScheme).toBe(MidiTimingScheme.metrical);
        expect(header.pulsesPerQuarterNote).toBe(192);

        // Test timing track properties (second chunk/first track)
        const timingTrack = midiFile.chunks[1] as MidiTrack;

        // Find tempo change event
        const setTempoEvent =
            GetMetaEventsByType(timingTrack, MIDIMetaMessageType.SetTempo)[0] as MetaMidiEvent;

        // Tempo is implicitly tested using "absolute time in seconds" of note events.
        expect(setTempoEvent.deltaTime).toBe(0);
        expect(setTempoEvent.microsecondsPerQuarterNote).toBe(500000);

        const temptTrackEndOfTrack =
            GetMetaEventsByType(timingTrack, MIDIMetaMessageType.EndOfTrack)[0] as MetaMidiEvent;

        // The length of track is 20 seconds.
        expect(temptTrackEndOfTrack.deltaTime).toBe(7680);
        expect(temptTrackEndOfTrack.absTimeSeconds).toBe(20);

        // Test music track properties (third chunk/second track)
        // This file contains notes 8 notes, C4, D4, E4, ... C5, arranged 0.5 seconds apart,
        // without gaps.
        const musicTrack = midiFile.chunks[2] as MidiTrack;
        const noteEvents = musicTrack.events.filter(x => x instanceof NoteMidiEvent);

        const expectedNotes = [
            MidiNote.C4, MidiNote.D4, MidiNote.E4, MidiNote.F4,
            MidiNote.G4, MidiNote.A4, MidiNote.B4, MidiNote.C5,
        ]

        for (let i = 0; i < expectedNotes.length; i++) {
            const expectedNote = expectedNotes[i];
            const expectedNoteStartTimeSeconds = 0.5 * i;

            const noteOnEvent = noteEvents[i * 2] as NoteMidiEvent;
            const noteOffEvent = noteEvents[i * 2 + 1] as NoteMidiEvent;

            expect(noteOnEvent.note).toBe(expectedNote);
            expect(noteOffEvent.note).toBe(expectedNote);

            expect(noteOnEvent.deltaTime).toBe(0);
            expect(noteOffEvent.deltaTime).toBe(192);

            expect(noteOnEvent.absTimeSeconds).toBe(expectedNoteStartTimeSeconds);
            expect(noteOffEvent.absTimeSeconds).toBe(expectedNoteStartTimeSeconds + 0.5);
        }

        const musicTrackEndOfTrack =
            GetMetaEventsByType(musicTrack, MIDIMetaMessageType.EndOfTrack)[0] as MetaMidiEvent;

        // Though the music is 4 seconds long, the track is 20 seconds long.
        expect(musicTrackEndOfTrack.deltaTime).toBe(6144);
        expect(musicTrackEndOfTrack.absTimeSeconds).toBe(20);

        expect(midiFile.midiStats.lowNote).toBe(MidiNote.C4);
        expect(midiFile.midiStats.highNote).toBe(MidiNote.C5);
        expect(midiFile.midiStats.lastNoteOnEventInSeconds).toBe(3.5);
        expect(midiFile.midiStats.tempos).toEqual([120]);
    });
});

describe('MIDI timing', () => {
    it('applies tempo changes of the tempo track to the music track (tempo map)', () => {
        // 480 ticks per quarter. 120 bpm until tick 960 (= 1 s), then 60 bpm.
        const midiFile = load(buildMidi({
            format: 1,
            ppqn: 480,
            tracks: [
                [tempo(0, 500000), tempo(960, 1000000), endOfTrack(0)],
                [
                    noteOn(0, 60), noteOff(240, 60),     // tick 0
                    noteOn(240, 62), noteOff(240, 62),   // tick 480
                    noteOn(240, 64), noteOff(240, 64),   // tick 960
                    noteOn(240, 65), noteOff(240, 65),   // tick 1440
                    noteOn(240, 67), noteOff(240, 67),   // tick 1920
                    endOfTrack(0),
                ],
            ],
        }));

        const times = noteStarts(midiFile.getTracks()[1]).map(e => e.absTimeSeconds);
        expect(times).toEqual([0, 0.5, 1, 2, 3]);
        expect(midiFile.midiStats.tempos).toEqual([120, 60]);
    });

    it('uses 120 bpm when the file has no tempo event', () => {
        const midiFile = load(buildMidi({
            ppqn: 96,
            tracks: [[noteOn(0, 60), noteOff(96, 60), noteOn(96, 62), noteOff(96, 62), endOfTrack()]],
        }));
        expect(noteStarts(midiFile.getTracks()[0]).map(e => e.absTimeSeconds)).toEqual([0, 1]);
    });

    it('supports a tempo change inside a single track (type 0)', () => {
        const midiFile = load(buildMidi({
            ppqn: 100,
            tracks: [[
                tempo(0, 1000000),            // 1 s per quarter note
                noteOn(0, 60), noteOff(100, 60),
                tempo(0, 250000),             // from tick 100 (1 s): 0.25 s per quarter note
                noteOn(100, 62), noteOff(100, 62),
                endOfTrack(),
            ]],
        }));
        expect(noteStarts(midiFile.getTracks()[0]).map(e => e.absTimeSeconds)).toEqual([0, 1.25]);
    });

    it('supports SMPTE timecode division', () => {
        // 0xE7 = -25 fps, 0x28 = 40 sub-frames: 1000 ticks per second.
        const midiFile = load(buildMidi({
            division: 0xE728,
            tracks: [[noteOn(1000, 60), noteOff(500, 60), noteOn(500, 62), endOfTrack()]],
        }));
        const header = midiFile.getHeader();
        expect(header.timingScheme).toBe(MidiTimingScheme.timecode);
        expect(header.framesPerSecond).toBe(25);
        expect(header.subFrameResolution).toBe(40);
        expect(noteStarts(midiFile.getTracks()[0]).map(e => e.absTimeSeconds)).toEqual([1, 2]);
    });
});

describe('MIDI event parsing', () => {
    it('treats Note On with velocity 0 as the end of a note (also with running status)', () => {
        const midiFile = load(buildMidi({
            tracks: [[
                noteOn(0, 60, 90),
                runningStatus(480, 60, 0),   // Note On, velocity 0 = Note Off
                runningStatus(0, 62, 80),    // Note On
                runningStatus(480, 62, 0),   // Note Off
                endOfTrack(),
            ]],
        }));

        const track = midiFile.getTracks()[0];
        const notes = track.events.filter(e => e instanceof NoteMidiEvent) as NoteMidiEvent[];
        expect(notes.map(n => [n.note, n.velocity, n.channelMessageType])).toEqual([
            [60, 90, ChannelMessageType.NoteOn],
            [60, 0, ChannelMessageType.NoteOn],
            [62, 80, ChannelMessageType.NoteOn],
            [62, 0, ChannelMessageType.NoteOn],
        ]);

        // Only real note starts are counted.
        expect(Array.from(midiFile.midiStats.noteHistogram.entries())).toEqual([[60, 1], [62, 1]]);
        expect(midiFile.midiStats.lastNoteOnEventInSeconds).toBe(0.5);
    });

    it('skips SysEx messages instead of failing', () => {
        const midiFile = load(buildMidi({
            tracks: [[
                sysEx(0, [0x7E, 0x7F, 0x09, 0x01, 0xF7]), // GM System On
                noteOn(0, 60), noteOff(480, 60),
                endOfTrack(),
            ]],
        }));
        const events = midiFile.getTracks()[0].events;
        expect(events[0]).toBeInstanceOf(SysExMidiEvent);
        expect((events[0] as SysExMidiEvent).length).toBe(5);
        expect(noteStarts(midiFile.getTracks()[0]).map(e => e.note)).toEqual([60]);
    });

    it('reads meta events longer than 127 bytes (variable length)', () => {
        const longText = 'x'.repeat(300);
        const midiFile = load(buildMidi({
            tracks: [[
                textMeta(0, MIDIMetaMessageType.CopyrightNotice, longText),
                trackName(0, 'Melody'),
                noteOn(0, 64), noteOff(480, 64),
                endOfTrack(),
            ]],
        }));
        const track = midiFile.getTracks()[0];
        expect((track.events[0] as MetaMidiEvent).text).toBe(longText);
        expect(track.name).toBe('Melody');
        expect(noteStarts(track).map(e => e.note)).toEqual([64]);
    });

    it('cancels running status after a meta event', () => {
        const buffer = buildMidi({
            tracks: [[noteOn(0, 60), trackName(0, 'a'), runningStatus(0, 62, 100), endOfTrack()]],
        });
        expect(() => load(buffer)).toThrow(/data byte without a status byte/);
    });

    it('reads pitch bend as a 14-bit value', () => {
        const midiFile = load(buildMidi({ tracks: [[pitchBend(0, 0x2000), pitchBend(0, 0x3FFF), endOfTrack()]] }));
        const values = midiFile.getTracks()[0].events
            .filter(e => e instanceof PitchBendMidiEvent)
            .map(e => (e as PitchBendMidiEvent).value);
        expect(values).toEqual([0x2000, 0x3FFF]);
    });

    it('stores the absolute position in ticks of every event', () => {
        const midiFile = load(buildMidi({ tracks: [[noteOn(10, 60), noteOff(20, 60), endOfTrack(5)]] }));
        expect(midiFile.getTracks()[0].events.map(e => e.absTicks)).toEqual([10, 30, 35]);
    });
});

describe('Invalid MIDI files', () => {
    it('rejects data that is not a MIDI file', () => {
        const text = new Uint8Array('This is not a MIDI file at all'.split('').map(c => c.charCodeAt(0)));
        expect(() => load(text.buffer)).toThrow(/Not a valid MIDI file/);
    });

    it('rejects truncated files with a readable message', () => {
        const full = new Uint8Array(buildC4Octave());
        const truncated = full.slice(0, full.length - 30).buffer;
        expect(() => load(truncated)).toThrow(/truncated or corrupt/);
    });
});

function GetMetaEventsByType(timingTrack: MidiTrack, metaMessageType: MIDIMetaMessageType): IMidiEvent[] {
    return timingTrack.events
        .filter(x => x instanceof MetaMidiEvent && x.metaMessageType === metaMessageType);
}
