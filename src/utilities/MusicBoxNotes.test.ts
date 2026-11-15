import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { NoteMidiEvent } from '../model/MidiEvents';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import {
    ADDED_NOTE_TRACK, addedNoteId, DEFAULT_ADDED_NOTE_VELOCITY, extractMusicBoxNotes, findOctaveTransposition,
    getTrackSummaries, IAddedNote, isAddedNoteId, resolveTrackIndices,
} from './MusicBoxNotes';
import { buildGeneratedMusicBoxSequence } from './MusicBoxMidi';
import { buildMidi, endOfTrack, noteOff, noteOn, runningStatus, trackName } from '../testUtils/midiBuilder';

const THIRTY = BuiltInProfiles['thirtyNote'];
const FIFTEEN = BuiltInProfiles['fifteenNote'];

/** 480 ticks per quarter note at the default 120 bpm: 1 tick = 1/960 s. */
const TICKS_PER_SECOND = 960;

function load(tracks: number[][][], format?: number): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(buildMidi({ format, ppqn: 480, tracks }));
    return midiFile;
}

/** One track with the given notes, each `spacingSeconds` apart. */
function melody(notes: number[], spacingSeconds: number = 0.5, channel: number = 0): number[][] {
    const ticks = Math.round(spacingSeconds * TICKS_PER_SECOND);
    const events: number[][] = [];
    notes.forEach(note => {
        events.push(noteOn(0, note, 100, channel));
        events.push(noteOff(ticks, note, channel));
    });
    events.push(endOfTrack());
    return events;
}

function punched(midiFile: MidiFile, profile = THIRTY, transpose = true) {
    return extractMusicBoxNotes(midiFile, profile, { transposeOutOfRangeNotes: transpose });
}

describe('findOctaveTransposition', () => {
    it('uses the closest octave that the music box supports', () => {
        const supported = THIRTY.supportedNotes; // C3 (48) .. E6 (88)
        expect(findOctaveTransposition(36, supported)).toBe(48);   // C2 -> C3
        expect(findOctaveTransposition(96, supported)).toBe(84);   // C7 -> C6 (not C3)
        expect(findOctaveTransposition(100, supported)).toBe(88);  // E7 -> E6
        expect(findOctaveTransposition(86 + 12, FIFTEEN.supportedNotes)).toBe(74); // D7 -> D5
    });

    it('never moves a note to a different pitch class', () => {
        // The 15 note box has no sharps.
        expect(findOctaveTransposition(61, FIFTEEN.supportedNotes)).toBeNull();
    });

    it('prefers the lower note when two octaves are equally close', () => {
        expect(findOctaveTransposition(60, [48, 72])).toBe(48);
    });
});

describe('extractMusicBoxNotes', () => {
    it('does not punch Note On events with velocity 0 (they end a note)', () => {
        const midiFile = load([[
            noteOn(0, 60, 90),
            runningStatus(960, 60, 0),
            runningStatus(0, 64, 90),
            runningStatus(960, 64, 0),
            endOfTrack(),
        ]]);
        const result = punched(midiFile);
        expect(result.notes.map(n => [n.note, n.timeSeconds])).toEqual([[60, 0], [64, 1]]);
        expect(result.notes[0].durationSeconds).toBe(1);
    });

    it('drops notes that cannot be transposed and reports them', () => {
        const result = punched(load([melody([60, 61, 62])]), FIFTEEN);
        expect(result.notes.map(n => n.note)).toEqual([60, 62]);
        expect(result.unsupportedCount).toBe(1);
        expect(result.transposedCount).toBe(0);
    });

    it('transposes by octaves only when enabled', () => {
        const midiFile = load([melody([36, 96, 60])]);
        const transposed = punched(midiFile, THIRTY, true);
        expect(transposed.notes.map(n => [n.originalNote, n.note])).toEqual([[36, 48], [96, 84], [60, 60]]);
        expect(transposed.transposedCount).toBe(2);

        const plain = punched(midiFile, THIRTY, false);
        expect(plain.notes.map(n => n.note)).toEqual([60]);
        expect(plain.unsupportedCount).toBe(2);
    });

    it('drops a note too close to the previous hole on the same line, even with other notes in between', () => {
        // minNoteGap = 3 mm at 20 mm/s = 0.15 s
        const midiFile = load([[
            noteOn(0, 60), noteOff(48, 60),      // C4 at 0.00 s
            noteOn(0, 64), noteOff(48, 64),      // E4 at 0.05 s
            noteOn(0, 60), noteOff(48, 60),      // C4 at 0.10 s -> too close to the first C4
            noteOn(48, 60), noteOff(48, 60),     // C4 at 0.20 s -> 0.2 s after the first one: kept
            endOfTrack(),
        ]]);
        const result = punched(midiFile);
        expect(result.notes.map(n => [n.note, Number(n.timeSeconds.toFixed(3))])).toEqual([
            [60, 0], [64, 0.05], [60, 0.2],
        ]);
        expect(result.tooCloseCount).toBe(1);
    });

    it('merges a transposed note with the same note already sounding', () => {
        // D6 + D5 chord on the 15 note box: D6 becomes D5, a single hole.
        const midiFile = load([[noteOn(0, 86), noteOn(0, 74), noteOff(480, 86), noteOff(0, 74), endOfTrack()]]);
        const result = punched(midiFile, FIFTEEN);
        expect(result.notes.map(n => n.note)).toEqual([74]);
        expect(result.tooCloseCount).toBe(1);
    });

    it('ignores the percussion channel unless requested', () => {
        const midiFile = load([[...melody([60], 0.5, 9).slice(0, 2), ...melody([62], 0.5, 0)]]);
        const withoutDrums = punched(midiFile);
        expect(withoutDrums.notes.map(n => n.note)).toEqual([62]);
        expect(withoutDrums.percussionCount).toBe(1);

        const withDrums = extractMusicBoxNotes(midiFile, THIRTY, { transposeOutOfRangeNotes: true, includePercussion: true });
        expect(withDrums.notes.map(n => n.note)).toEqual([60, 62]);
    });

    it('keeps the parsed MIDI file untouched', () => {
        const midiFile = load([melody([36, 96])]);
        punched(midiFile);
        const notes = midiFile.getTracks()[0].events
            .filter((e): e is NoteMidiEvent => e instanceof NoteMidiEvent)
            .map(e => e.note);
        expect(notes).toEqual([36, 36, 96, 96]);
    });
});

describe('track selection', () => {
    const tempoTrack = [endOfTrack()];

    it('auto: uses the track after the tempo track in type 1 files', () => {
        const midiFile = load([tempoTrack, melody([60, 62]), melody([72])], 1);
        expect(resolveTrackIndices(midiFile, 'auto')).toEqual([1]);
        expect(punched(midiFile).notes.map(n => n.note)).toEqual([60, 62]);
    });

    it('auto: falls back to the first track with notes', () => {
        const typeOneMelodyFirst = load([melody([60]), [endOfTrack()]], 1);
        expect(resolveTrackIndices(typeOneMelodyFirst, 'auto')).toEqual([0]);

        const onlyTempoTrack = load([[endOfTrack()]], 1);
        expect(resolveTrackIndices(onlyTempoTrack, 'auto')).toEqual([]);
        expect(punched(onlyTempoTrack).notes).toEqual([]);
    });

    it('all: merges every track sorted by time', () => {
        const midiFile = load([tempoTrack, melody([60, 62], 1), [noteOn(480, 64), noteOff(480, 64), endOfTrack()]], 1);
        const result = extractMusicBoxNotes(midiFile, THIRTY, { transposeOutOfRangeNotes: true, trackSelection: 'all' });
        expect(result.notes.map(n => [n.note, n.timeSeconds, n.trackIndex])).toEqual([
            [60, 0, 1], [64, 0.5, 2], [62, 1, 1],
        ]);
    });

    it('a single track by index', () => {
        const midiFile = load([tempoTrack, melody([60]), melody([72])], 1);
        const result = extractMusicBoxNotes(midiFile, THIRTY, { transposeOutOfRangeNotes: true, trackSelection: 2 });
        expect(result.notes.map(n => n.note)).toEqual([72]);
        expect(resolveTrackIndices(midiFile, 7)).toEqual([]);
    });

    it('summarizes tracks with their names and note counts', () => {
        const midiFile = load([[trackName(0, 'Tempo'), endOfTrack()], [trackName(0, 'Piano'), ...melody([60, 62])]], 1);
        expect(getTrackSummaries(midiFile)).toEqual([
            { index: 0, name: 'Tempo', noteCount: 0 },
            { index: 1, name: 'Piano', noteCount: 2 },
        ]);
    });
});

describe('piano preview', () => {
    it('plays exactly the notes punched in the strip', () => {
        const midiFile = load([[
            noteOn(0, 86), noteOn(0, 74), noteOn(0, 61), noteOff(480, 86), noteOff(0, 74), noteOff(0, 61),
            ...melody([36, 60, 60]),
        ]]);
        const options = { transposeOutOfRangeNotes: true };
        [THIRTY, FIFTEEN].forEach(profile => {
            const strip = extractMusicBoxNotes(midiFile, profile, options).notes;
            const piano = buildGeneratedMusicBoxSequence(midiFile, profile, options);
            expect(piano.map(e => [e.note, e.startTimeSeconds])).toEqual(strip.map(n => [n.note, n.timeSeconds]));
            expect(piano.every(e => profile.supportedNotes.includes(e.note))).toBe(true);
        });
    });
});

describe('notes too close on the same line: the main voice wins', () => {
    // minNoteGap = 3 mm at 20 mm/s = 0.15 s; 96 ticks = 0.1 s
    function track(events: Array<[number, number, number]>): number[][] {
        // [ticks since previous, note, velocity]
        const out: number[][] = [];
        events.forEach(([delta, note, velocity]) => out.push(noteOn(delta, note, velocity), noteOff(0, note)));
        out.push(endOfTrack());
        return out;
    }

    it('keeps the louder note even if it comes second', () => {
        const result = punched(load([track([[0, 60, 50], [96, 60, 100]])]));
        expect(result.notes.map(n => [n.note, Number(n.timeSeconds.toFixed(3)), n.velocity])).toEqual([[60, 0.1, 100]]);
        expect(result.tooCloseCount).toBe(1);
    });

    it('keeps the first note when both are equally loud', () => {
        const result = punched(load([track([[0, 60, 80], [96, 60, 80]])]));
        expect(result.notes.map(n => n.timeSeconds)).toEqual([0]);
    });

    it('prefers the main track over a louder note of another track when merging tracks', () => {
        const midiFile = load([
            [endOfTrack()],
            track([[96, 60, 60]]),   // main voice (track 2): C4 at 0.1 s, soft
            track([[0, 60, 120]]),   // accompaniment (track 3): C4 at 0 s, loud
        ], 1);
        const result = extractMusicBoxNotes(midiFile, THIRTY, { transposeOutOfRangeNotes: true, trackSelection: 'all' });
        expect(result.notes.map(n => [n.trackIndex, n.velocity])).toEqual([[1, 60]]);
    });

    it('keeps holes apart when a later note replaces an earlier one', () => {
        // 0.0 s soft, 0.1 s loud (replaces it), 0.2 s soft (too close to the loud one: dropped)
        const result = punched(load([track([[0, 60, 50], [96, 60, 100], [96, 60, 50]])]));
        expect(result.notes.map(n => [Number(n.timeSeconds.toFixed(3)), n.velocity])).toEqual([[0.1, 100]]);
        expect(result.tooCloseCount).toBe(2);
    });

    it('never leaves two holes too close on the same line, in time order (sample songs)', () => {
        ['happy_birthday.mid', 'You are my sunshine.mid', 'ode_to_joy.mid'].forEach(sample => {
            const b = fs.readFileSync(path.resolve(__dirname, '../../samples', sample));
            const midiFile = new MidiFile();
            midiFile.loadFromBuffer(Uint8Array.from(b).buffer);
            [THIRTY, FIFTEEN].forEach(profile => (['auto', 'all'] as const).forEach(trackSelection => {
                const { notes } = extractMusicBoxNotes(midiFile, profile, { transposeOutOfRangeNotes: true, trackSelection });
                const gap = profile.minNoteGapMm / profile.millimetersPerSecond;
                const last = new Map<number, number>();
                notes.forEach((n, i) => {
                    if (i > 0) {
                        expect(n.timeSeconds).toBeGreaterThanOrEqual(notes[i - 1].timeSeconds);
                    }
                    const previous = last.get(n.note);
                    if (previous !== undefined) {
                        expect(n.timeSeconds - previous).toBeGreaterThan(gap);
                    }
                    last.set(n.note, n.timeSeconds);
                });
            }));
        });
    });
});

describe('holes deleted by hand', () => {
    // Track 1 (tempo track) is empty; track 2: C4, E4, G4 at 0, 0.5, 1 s.
    const midiFile = () => load([[endOfTrack()], melody([60, 64, 67])], 1);

    it('identifies every hole by its track and note on event, whatever the profile', () => {
        const file = midiFile();
        const ids30 = punched(file, THIRTY).notes.map(n => n.id);
        // Events of track 2: on, off, on, off, on, off, end of track.
        expect(ids30).toEqual(['1:0', '1:2', '1:4']);
        expect(punched(file, FIFTEEN).notes.map(n => n.id)).toEqual(ids30);
        // A transposed note keeps the id of its MIDI note.
        const transposed = punched(load([melody([36, 60])]), THIRTY).notes;
        expect(transposed.map(n => [n.id, n.note, n.originalNote])).toEqual([['0:0', 48, 36], ['0:2', 60, 60]]);
    });

    it('removes exactly the deleted holes and counts them; the others do not change', () => {
        const file = midiFile();
        const all = punched(file).notes;
        const result = extractMusicBoxNotes(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set(['1:2']) });
        expect(result.notes).toEqual([all[0], all[2]]);
        expect(result.deletedCount).toBe(1);
        expect(punched(file).deletedCount).toBe(0);
        // Ids of notes that are not punched (another track, unknown) change nothing.
        const other = extractMusicBoxNotes(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set(['0:5', 'x']) });
        expect(other.notes).toEqual(all);
        expect(other.deletedCount).toBe(0);
    });

    it('never brings back a note that was skipped for being too close to the deleted one', () => {
        // 0.0 s soft, 0.1 s loud: the loud one is punched, the soft one skipped (too close).
        const file = load([[noteOn(0, 60, 50), noteOff(0, 60), noteOn(96, 60, 100), noteOff(0, 60), endOfTrack()]]);
        const [loud] = punched(file).notes;
        expect(loud.velocity).toBe(100);
        const result = extractMusicBoxNotes(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set([loud.id]) });
        expect(result.notes).toEqual([]);
        expect(result.tooCloseCount).toBe(1);
        expect(result.deletedCount).toBe(1);
    });

    it('the piano does not play the deleted holes', () => {
        const file = midiFile();
        const piano = buildGeneratedMusicBoxSequence(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set(['1:2']) });
        expect(piano.map(e => [e.note, e.startTimeSeconds])).toEqual([[60, 0], [67, 1]]);
    });

    const deleting = (file: MidiFile, ids: string[]) =>
        extractMusicBoxNotes(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set(ids) });

    it('deleting the first holes moves every other hole back by the same time: the song starts at the first hole left', () => {
        const file = load([melody([60, 62, 64, 65, 67])]); // 0, 0.5, 1, 1.5, 2 s
        const all = punched(file).notes;
        expect(punched(file).removedLeadingSeconds).toBe(0);

        const result = deleting(file, [all[0].id, all[1].id]);
        expect(result.removedLeadingSeconds).toBeCloseTo(1, 9);
        expect(result.notes.map(n => n.id)).toEqual([all[2].id, all[3].id, all[4].id]);
        expect(result.notes.map(n => n.timeSeconds)).toEqual(all.slice(2).map(n => n.timeSeconds - result.removedLeadingSeconds));
        expect(result.notes[0].timeSeconds).toBeCloseTo(0, 9);
        // Only the time moves; everything else about the notes is the same.
        result.notes.forEach((note, i) => expect({ ...note, timeSeconds: 0 }).toEqual({ ...all[i + 2], timeSeconds: 0 }));

        // The piano plays the same: the song starts with the first hole left.
        const piano = buildGeneratedMusicBoxSequence(file, THIRTY, { transposeOutOfRangeNotes: true, deletedNoteIds: new Set([all[0].id, all[1].id]) });
        expect(piano.map(e => e.startTimeSeconds)).toEqual(result.notes.map(n => n.timeSeconds));
    });

    it('keeps the silence of the file before its first note: only the room of the deleted holes is removed', () => {
        // 1 s of silence, then C4, E4, G4 every 0.5 s.
        const file = load([[noteOn(TICKS_PER_SECOND, 60, 100), noteOff(240, 60), noteOn(240, 64, 100), noteOff(240, 64),
            noteOn(240, 67, 100), noteOff(240, 67), endOfTrack()]]);
        const all = punched(file).notes;
        expect(all.map(n => n.timeSeconds)).toEqual([1, 1.5, 2]);
        const result = deleting(file, [all[0].id]);
        expect(result.removedLeadingSeconds).toBeCloseTo(0.5, 9);
        expect(result.notes.map(n => n.timeSeconds)).toEqual([1, 1.5]);
    });

    it('moves nothing when a note at the same time as the first one is left, or when only later holes are deleted', () => {
        // A chord at 0 s (C4 + E4), then G4 at 0.5 s.
        const chord = load([[noteOn(0, 60, 100), noteOn(0, 64, 100), noteOff(480, 60), noteOff(0, 64),
            noteOn(0, 67, 100), noteOff(480, 67), endOfTrack()]]);
        const all = punched(chord).notes;
        const withoutC = deleting(chord, [all[0].id]);
        expect(withoutC.removedLeadingSeconds).toBe(0);
        expect(withoutC.notes).toEqual(all.slice(1));

        const file = midiFile();
        const later = deleting(file, ['1:2', '1:4']);
        expect(later.removedLeadingSeconds).toBe(0);
        expect(later.notes).toEqual([punched(file).notes[0]]);
    });

    it('moves nothing when every hole is deleted', () => {
        const file = midiFile();
        const result = deleting(file, ['1:0', '1:2', '1:4']);
        expect(result.notes).toEqual([]);
        expect(result.removedLeadingSeconds).toBe(0);
    });
});

describe('holes added by hand', () => {
    // Track 1 (tempo track) is empty; track 2: C4, E4, G4 at 0, 0.5, 1 s (velocity 100).
    const midiFile = () => load([[endOfTrack()], melody([60, 64, 67])], 1);
    const added = (note: number, timeSeconds: number, n = 1): IAddedNote => ({ id: addedNoteId(n), note, timeSeconds });
    const adding = (file: MidiFile, notes: IAddedNote[], deleted: string[] = [], profile = THIRTY) =>
        extractMusicBoxNotes(file, profile, { transposeOutOfRangeNotes: true, addedNotes: notes, deletedNoteIds: new Set(deleted) });

    it('has ids of its own', () => {
        expect(addedNoteId(3)).toBe('added:3');
        expect(isAddedNoteId('added:3')).toBe(true);
        expect(isAddedNoteId('1:2')).toBe(false);
    });

    it('punches an added hole where it was placed, among the notes of the file, with their typical velocity', () => {
        const file = midiFile();
        const all = punched(file).notes;
        const result = adding(file, [added(72, 0.75)]);
        expect(result.notes.map(n => [n.id, n.note, n.timeSeconds])).toEqual([
            ['1:0', 60, 0], ['1:2', 64, 0.5], ['added:1', 72, 0.75], ['1:4', 67, 1],
        ]);
        expect(result.notes[2]).toEqual({
            id: 'added:1', note: 72, originalNote: 72, timeSeconds: 0.75, velocity: 100,
            durationSeconds: 0.35, channel: 0, trackIndex: ADDED_NOTE_TRACK,
        });
        expect(result.addedCount).toBe(1);
        expect(result.addedSkippedCount).toBe(0);
        expect(result.deletedCount).toBe(0);
        // Nothing else changes: the file's holes are the same objects' values.
        expect(result.notes.filter(n => !isAddedNoteId(n.id))).toEqual(all);
        // Without added holes nothing changes at all.
        expect(adding(file, [])).toEqual(punched(file));
    });

    it('at the same time as a note of the file, the file\'s note comes first; added holes keep their order', () => {
        const file = midiFile();
        const result = adding(file, [added(72, 0.5, 2), added(74, 0.5, 1)]);
        expect(result.notes.map(n => n.id)).toEqual(['1:0', '1:2', 'added:2', 'added:1', '1:4']);
    });

    it('takes the velocity from the file (median), or a default when the file has no notes', () => {
        const soft = load([[noteOn(0, 60, 40), noteOff(480, 60), noteOn(0, 64, 60), noteOff(480, 64), noteOn(0, 67, 120), noteOff(480, 67), endOfTrack()]]);
        expect(adding(soft, [added(72, 0.25)]).notes.find(n => n.id === 'added:1')!.velocity).toBe(60);
        // Only percussion in the file: no note to take it from.
        const drums = load([melody([60], 0.5, 9)]);
        const result = adding(drums, [added(72, 0.25)]);
        expect(result.notes.map(n => [n.id, n.velocity])).toEqual([['added:1', DEFAULT_ADDED_NOTE_VELOCITY]]);
    });

    it('skips (and counts) an added hole of a note the box can\'t play, or before the start of the file', () => {
        const file = midiFile();
        // C#5 on the 15 note box; a time before 0.
        const result = adding(file, [added(73, 0.75, 1), added(72, -0.1, 2), added(72, 0.75, 3)], [], FIFTEEN);
        expect(result.notes.map(n => n.id)).toEqual(['1:0', '1:2', 'added:3', '1:4']);
        expect(result.addedCount).toBe(1);
        expect(result.addedSkippedCount).toBe(2);
        expect(result.unsupportedCount).toBe(0);
    });

    it('skips an added hole too close to a hole on the same line (before or after it), never the file\'s hole', () => {
        const file = midiFile();
        // minNoteGap = 3 mm at 20 mm/s = 0.15 s. E4 is at 0.5 s.
        const result = adding(file, [added(64, 0.6, 1), added(64, 0.4, 2), added(64, 0.66, 3), added(64, 0.34, 4), added(60, 0.6, 5)]);
        expect(result.notes.map(n => [n.id, n.note, n.timeSeconds])).toEqual([
            ['1:0', 60, 0], ['added:4', 64, 0.34], ['1:2', 64, 0.5], ['added:5', 60, 0.6], ['added:3', 64, 0.66], ['1:4', 67, 1],
        ]);
        expect(result.addedSkippedCount).toBe(2);
        expect(result.addedCount).toBe(3);
        expect(result.tooCloseCount).toBe(0);
    });

    it('skips an added hole too close to a hole added before it (in time order)', () => {
        const file = midiFile();
        const result = adding(file, [added(72, 0.3, 1), added(72, 0.2, 2), added(72, 0.36, 3)]);
        // 0.2 comes first in time and is kept; 0.3 is within 0.15 s of it; 0.36 is 0.16 s after 0.2.
        expect(result.notes.filter(n => isAddedNoteId(n.id)).map(n => [n.id, n.timeSeconds])).toEqual([['added:2', 0.2], ['added:3', 0.36]]);
        expect(result.addedSkippedCount).toBe(1);
    });

    it('a deleted hole of the file frees its place; restoring it skips the added hole instead', () => {
        const file = midiFile();
        const withDeleted = adding(file, [added(64, 0.55)], ['1:2']);
        expect(withDeleted.notes.map(n => [n.id, n.timeSeconds])).toEqual([['1:0', 0], ['added:1', 0.55], ['1:4', 1]]);
        expect(withDeleted.deletedCount).toBe(1);
        expect(withDeleted.addedCount).toBe(1);
        const restored = adding(file, [added(64, 0.55)], []);
        expect(restored.notes.map(n => n.id)).toEqual(['1:0', '1:2', '1:4']);
        expect(restored.addedSkippedCount).toBe(1);
    });

    it('an added hole can be deleted: it is simply gone, counted nowhere', () => {
        const file = midiFile();
        const result = adding(file, [added(72, 0.75)], ['added:1']);
        expect(result.notes.map(n => n.id)).toEqual(['1:0', '1:2', '1:4']);
        expect(result.addedCount).toBe(0);
        expect(result.addedSkippedCount).toBe(0);
        expect(result.deletedCount).toBe(0);
    });

    it('the piano plays the added holes', () => {
        const piano = buildGeneratedMusicBoxSequence(midiFile(), THIRTY, { transposeOutOfRangeNotes: true, addedNotes: [added(72, 0.75)] });
        expect(piano.map(e => [e.note, e.startTimeSeconds, e.velocity])).toEqual([[60, 0, 100], [64, 0.5, 100], [72, 0.75, 100], [67, 1, 100]]);
    });

    describe('with the first holes of the file deleted (the song moves back)', () => {
        // 1 s of silence, then C4, E4, G4 at 1, 1.5, 2 s.
        const silent = () => load([[noteOn(TICKS_PER_SECOND, 60, 100), noteOff(240, 60), noteOn(240, 64, 100), noteOff(240, 64),
            noteOn(240, 67, 100), noteOff(240, 67), endOfTrack()]]);

        it('an added hole is stored in the file\'s time and moves back with the music', () => {
            const file = silent();
            // Placed between E4 and G4 of the file (1.75 s in the file).
            const result = adding(file, [added(72, 1.75)], ['0:0']);
            expect(result.removedLeadingSeconds).toBeCloseTo(0.5, 9);
            expect(result.notes.map(n => [n.id, Number(n.timeSeconds.toFixed(9))])).toEqual([['0:2', 1], ['added:1', 1.25], ['0:4', 1.5]]);
        });

        it('the song never starts after an added hole: the shift stops at it, so it stays on the paper', () => {
            const file = silent();
            // Added at 1.2 s of the file, between the deleted C4 and E4: the shift is the usual 0.5 s
            // (the added hole is still at 0.7 s of the song, after its start).
            const between = adding(file, [added(72, 1.2)], ['0:0']);
            expect(between.removedLeadingSeconds).toBeCloseTo(0.5, 9);
            expect(between.notes.map(n => [n.id, Number(n.timeSeconds.toFixed(9))])).toEqual([['added:1', 0.7], ['0:2', 1], ['0:4', 1.5]]);

            // Added at 0.2 s of the file, in its leading silence: a shift of 0.5 s would put it before
            // the start of the strip, so the song starts at the added hole instead.
            const early = adding(file, [added(72, 0.2)], ['0:0']);
            expect(early.removedLeadingSeconds).toBeCloseTo(0.2, 9);
            expect(early.notes.map(n => [n.id, Number(n.timeSeconds.toFixed(9))])).toEqual([['added:1', 0], ['0:2', 1.3], ['0:4', 1.8]]);

            // An added hole at the very start of the file: nothing moves.
            const atStart = adding(file, [added(72, 0)], ['0:0']);
            expect(atStart.removedLeadingSeconds).toBe(0);
            expect(atStart.notes.map(n => [n.id, n.timeSeconds])).toEqual([['added:1', 0], ['0:2', 1.5], ['0:4', 2]]);
        });

        it('with every hole of the file deleted, the added holes are the song (no shift)', () => {
            const file = silent();
            const result = adding(file, [added(72, 1.75)], ['0:0', '0:2', '0:4']);
            expect(result.notes.map(n => [n.id, n.timeSeconds])).toEqual([['added:1', 1.75]]);
            expect(result.removedLeadingSeconds).toBe(0);
            expect(result.deletedCount).toBe(3);
        });
    });
});
