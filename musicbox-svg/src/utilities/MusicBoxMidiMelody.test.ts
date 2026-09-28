import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { buildGeneratedMusicBoxSequence } from '../utilities/MusicBoxMidi';

const TPQN = 480;
const SECONDS_PER_TICK = 0.25 / TPQN;

/** 30 notas graves, 15 notas agudas: rangos disjuntos para poder distinguirlas. */
const LOW_NOTES: number[] = Array.from({ length: 30 }, (_, i) => [48, 50, 55, 57, 59][i % 5]);
const HIGH_NOTES: number[] = Array.from({ length: 15 }, (_, i) => [72, 74, 76, 77, 79][i % 5]);

function writeVariableLength(value: number): number[] {
    const bytes = [value & 0x7F];
    let working = value >> 7;
    while (working > 0) {
        bytes.unshift((working & 0x7F) | 0x80);
        working >>= 7;
    }
    return bytes;
}

function buildMidiBuffer(pitches: number[]): ArrayBuffer {
    const track: number[] = [];
    track.push(0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20);
    pitches.forEach((pitch) => {
        const onTicks = Math.max(1, Math.round(0.5 / SECONDS_PER_TICK));
        track.push(...writeVariableLength(0), 0x90, pitch, 100);
        track.push(...writeVariableLength(onTicks), 0x80, pitch, 0);
    });
    track.push(0x00, 0xFF, 0x2F, 0x00);

    const header = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPQN >> 8) & 0xFF, TPQN & 0xFF];
    const length = track.length;
    const trackHeader = [
        0x4D, 0x54, 0x72, 0x6B,
        (length >> 24) & 0xFF, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF,
    ];

    return new Uint8Array([...header, ...trackHeader, ...track]).buffer;
}

function load(pitches: number[]): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(buildMidiBuffer(pitches));
    return midiFile;
}

function notesOf(midiFile: MidiFile): number[] {
    return buildGeneratedMusicBoxSequence(midiFile, BuiltInProfiles['thirtyNote'], true).map(
        (event) => event.note
    );
}

describe('generated piano melody', () => {
    it('builds the melody from the file that is currently loaded', () => {
        const low = load(LOW_NOTES);
        const high = load(HIGH_NOTES);

        expect(notesOf(low)).toHaveLength(30);
        expect(notesOf(high)).toHaveLength(15);
    });

    it('plays the new melody after switching back and forth between files', () => {
        const lowFile = load(LOW_NOTES);
        const highFile = load(HIGH_NOTES);
        const lowPitches = new Set(LOW_NOTES);
        const highPitches = new Set(HIGH_NOTES);

        // 30 -> 15 -> 30 -> 15, in the same order the app would load them.
        [highFile, lowFile, highFile, lowFile].forEach((file, round) => {
            const expected = file === lowFile ? lowPitches : highPitches;
            const notes = notesOf(file);

            expect(notes.length).toBeGreaterThan(0);
            notes.forEach((note) => {
                expect(expected.has(note)).toBe(true);
            });

            // Going back to a file must give the very same melody, not a blend.
            expect(notes).toEqual(notesOf(file));
            if (round === 1 || round === 3) {
                expect(notes).toHaveLength(30);
            } else {
                expect(notes).toHaveLength(15);
            }
        });
    });
});
