import MidiFile, { isNoteEnd, isNoteStart, MidiFileFormat } from '../model/MidiFile';
import { IMusicBoxProfile } from '../model/IMusicBoxProfile';
import { MidiNote } from '../model/MidiConstants';

/**
 * Which tracks of the MIDI file are used:
 * - `'auto'`: for type 1 files the first track after the tempo track (if it has notes),
 *   otherwise the first track that has notes.
 * - `'all'`: every track, merged.
 * - a number: the index of a single track.
 */
export type TrackSelection = 'auto' | 'all' | number;

/** MIDI channel 10 (index 9) is reserved for percussion in General MIDI. */
export const PERCUSSION_CHANNEL = 9;

export interface INoteExtractionOptions {
    /** Transpose notes that the music box can't play by whole octaves, if possible. */
    transposeOutOfRangeNotes: boolean;

    /** Defaults to `'auto'`. */
    trackSelection?: TrackSelection;

    /** Include notes of the percussion channel (MIDI channel 10). Defaults to `false`. */
    includePercussion?: boolean;

    /**
     * Holes deleted by hand ({@link IMusicBoxNote.id}). They are removed after every other step, so
     * that deleting a hole never makes another one appear (e.g. a note that was skipped for being
     * too close to it stays skipped). Deleting the first holes moves all the others back by the same
     * time (see {@link INoteExtractionResult.removedLeadingSeconds}); nothing else moves.
     */
    deletedNoteIds?: ReadonlySet<string>;
}

/** A note that will be punched in the music box strip. */
export interface IMusicBoxNote {
    /**
     * Identifies the MIDI note the hole comes from (its track and the index of its note on event in
     * that track, see {@link musicBoxNoteId}). It doesn't depend on the profile or the layout, so it
     * survives any change of the settings.
     */
    id: string;

    /** The note punched (after transposition). Always one of the profile's supported notes. */
    note: MidiNote;

    /** The note as it is in the MIDI file. */
    originalNote: MidiNote;

    /** Time in seconds since the start of the song. */
    timeSeconds: number;

    /** Velocity of the MIDI note (1 - 127). */
    velocity: number;

    /**
     * Duration of the MIDI note, from its note on to its note off. A music box can't hold
     * notes; this is only kept for exporting MIDI.
     */
    durationSeconds: number;

    channel: number;
    trackIndex: number;
}

export interface INoteExtractionResult {
    /** The notes to punch, sorted by time. */
    notes: IMusicBoxNote[];

    /** Tracks the notes were taken from. */
    trackIndices: number[];

    /** Notes moved by one or more octaves to fit the music box. */
    transposedCount: number;

    /** Notes dropped because the music box can't play them (not even transposed). */
    unsupportedCount: number;

    /** Notes dropped because they are too close to the previous hole on the same line. */
    tooCloseCount: number;

    /** Percussion notes that were ignored. */
    percussionCount: number;

    /** Holes deleted by hand (see {@link INoteExtractionOptions.deletedNoteIds}). */
    deletedCount: number;

    /**
     * Time removed from the start of the song because its first holes were deleted by hand: every
     * note left is this much earlier than in the file (0 when the first hole is still there).
     */
    removedLeadingSeconds: number;
}

export interface ITrackSummary {
    index: number;
    name?: string;
    /** Number of notes in the track (excluding percussion, unless included). */
    noteCount: number;
}

/** The {@link IMusicBoxNote.id} of the note on event at `eventIndex` in the track `trackIndex`. */
export function musicBoxNoteId(trackIndex: number, eventIndex: number): string {
    return trackIndex + ':' + eventIndex;
}

/** Duration assumed for notes that never receive a note off. */
const UNTERMINATED_NOTE_DURATION_SECONDS = 0.35;

/** Shortest duration reported for a note (for MIDI export). */
const MIN_NOTE_DURATION_SECONDS = 0.12;

export function getTrackSummaries(midiFile: MidiFile, includePercussion: boolean = false): ITrackSummary[] {
    return midiFile.getTracks().map((track, index) => ({
        index,
        name: track.name,
        noteCount: track.events.filter(e =>
            isNoteStart(e) && (includePercussion || e.channel !== PERCUSSION_CHANNEL)).length,
    }));
}

/** Resolves a track selection to the indices of the tracks to use. */
export function resolveTrackIndices(
    midiFile: MidiFile,
    selection: TrackSelection,
    includePercussion: boolean = false
): number[] {
    const summaries = getTrackSummaries(midiFile, includePercussion);

    if (selection === 'all') {
        return summaries.map(s => s.index);
    }

    if (typeof selection === 'number') {
        return selection >= 0 && selection < summaries.length ? [selection] : [];
    }

    // 'auto'
    const header = midiFile.getHeader();
    if (header.fileFormat === MidiFileFormat.multiTrack && summaries.length > 1 && summaries[1].noteCount > 0) {
        // First track is the tempo track for type 1 MIDI files
        return [1];
    }
    const firstWithNotes = summaries.find(s => s.noteCount > 0);
    return firstWithNotes ? [firstWithNotes.index] : [];
}

/**
 * Finds the supported note closest to `note` that is a whole number of octaves away from it.
 * When two candidates are equally close, the lower one is used.
 * Returns `null` if no supported note has the same pitch class.
 */
export function findOctaveTransposition(note: MidiNote, supportedNotes: MidiNote[]): MidiNote | null {
    const ascending = [...supportedNotes].sort((a, b) => a - b);
    let best: MidiNote | null = null;
    for (const candidate of ascending) {
        if ((candidate - note) % 12 === 0 &&
            (best === null || Math.abs(candidate - note) < Math.abs(best - note))) {
            best = candidate;
        }
    }
    return best;
}

/**
 * Computes the notes that will be punched in the strip for the given MIDI file and music box.
 * The strip, its preview and the piano playback all use this result, so what is heard is
 * exactly what is punched.
 */
export function extractMusicBoxNotes(
    midiFile: MidiFile,
    profile: IMusicBoxProfile,
    options: INoteExtractionOptions
): INoteExtractionResult {
    const includePercussion = !!options.includePercussion;
    const trackIndices = resolveTrackIndices(midiFile, options.trackSelection ?? 'auto', includePercussion);
    const tracks = midiFile.getTracks();
    const supportedSet = new Set<MidiNote>(profile.supportedNotes);

    const result: INoteExtractionResult = {
        notes: [],
        trackIndices,
        transposedCount: 0,
        unsupportedCount: 0,
        tooCloseCount: 0,
        percussionCount: 0,
        deletedCount: 0,
        removedLeadingSeconds: 0,
    };

    // 1. Collect note starts (with their durations) of the selected tracks.
    const candidates: IMusicBoxNote[] = [];
    trackIndices.forEach(trackIndex => {
        // Pending note starts per channel/note, to find their note off (first in, first out).
        const pending = new Map<string, IMusicBoxNote[]>();

        tracks[trackIndex].events.forEach((event, eventIndex) => {
            if (isNoteStart(event)) {
                if (!includePercussion && event.channel === PERCUSSION_CHANNEL) {
                    result.percussionCount++;
                    return;
                }
                const note: IMusicBoxNote = {
                    id: musicBoxNoteId(trackIndex, eventIndex),
                    note: event.note,
                    originalNote: event.note,
                    timeSeconds: event.absTimeSeconds,
                    velocity: event.velocity,
                    durationSeconds: UNTERMINATED_NOTE_DURATION_SECONDS,
                    channel: event.channel,
                    trackIndex,
                };
                candidates.push(note);

                const key = event.channel + ':' + event.note;
                const list = pending.get(key) || [];
                list.push(note);
                pending.set(key, list);
            } else if (isNoteEnd(event)) {
                const list = pending.get(event.channel + ':' + event.note);
                const started = list && list.shift();
                if (started) {
                    started.durationSeconds = Math.max(
                        MIN_NOTE_DURATION_SECONDS, event.absTimeSeconds - started.timeSeconds);
                }
            }
        });
    });

    // Stable sort: notes at the same time keep the track/event order.
    const sorted = candidates
        .map((note, order) => ({ note, order }))
        .sort((a, b) => (a.note.timeSeconds - b.note.timeSeconds) || (a.order - b.order))
        .map(x => x.note);

    // 2. Map every note to a supported note, transposing by octaves if allowed.
    const transposeMemo = new Map<MidiNote, MidiNote | null>();
    const playable: IMusicBoxNote[] = [];
    sorted.forEach(note => {
        if (supportedSet.has(note.originalNote)) {
            playable.push(note);
            return;
        }

        if (options.transposeOutOfRangeNotes) {
            if (!transposeMemo.has(note.originalNote)) {
                transposeMemo.set(note.originalNote, findOctaveTransposition(note.originalNote, profile.supportedNotes));
            }
            const transposed = transposeMemo.get(note.originalNote);
            if (transposed !== null && transposed !== undefined) {
                result.transposedCount++;
                playable.push({ ...note, note: transposed });
                return;
            }
        }

        result.unsupportedCount++;
    });

    // 3. Two notes too close on the same line can't both be punched: the comb can't play them
    //    and the holes would merge. The most important one is kept (see `outranks`).
    //    When a later note wins, it takes the place of the earlier one; since it is later, it
    //    stays far enough from the hole before.
    const minNoteGapSeconds = profile.minNoteGapMm / profile.millimetersPerSecond;
    // The main voice when tracks are merged: the track that 'auto' would pick.
    const mainTrack = trackIndices.length > 1
        ? resolveTrackIndices(midiFile, 'auto', includePercussion)[0]
        : undefined;

    const kept: Array<IMusicBoxNote | null> = [];
    const lastHoleIndex = new Map<MidiNote, number>();
    playable.forEach(note => {
        const previousIndex = lastHoleIndex.get(note.note);
        const previous = previousIndex !== undefined ? kept[previousIndex] : null;
        if (previous && note.timeSeconds <= previous.timeSeconds + minNoteGapSeconds) {
            result.tooCloseCount++;
            if (!outranks(note, previous, mainTrack)) {
                return;
            }
            kept[previousIndex as number] = null;
        }
        lastHoleIndex.set(note.note, kept.length);
        kept.push(note);
    });

    // 4. Holes deleted by hand, last: nothing else changes because of them.
    const deleted = options.deletedNoteIds;
    const punched = kept.filter((note): note is IMusicBoxNote => note !== null);
    result.notes = punched.filter(note => {
        if (deleted && deleted.has(note.id)) {
            result.deletedCount++;
            return false;
        }
        return true;
    });

    // 5. If the first holes were deleted, the song starts at the first hole left: every hole moves
    //    back by the same time (decision of the user), so the strip has no blank paper where the
    //    deleted holes were. Distances between holes don't change, and the silence of the file
    //    before its first note is kept (it is part of the music).
    if (result.notes.length > 0 && result.notes[0] !== punched[0]) {
        const shift = result.notes[0].timeSeconds - punched[0].timeSeconds;
        if (shift > 0) {
            result.removedLeadingSeconds = shift;
            result.notes = result.notes.map(note => ({ ...note, timeSeconds: note.timeSeconds - shift }));
        }
    }
    return result;
}

/**
 * Whether `candidate` is more important than `current` (an earlier note on the same line):
 * 1. a note of the main track wins over the other tracks;
 * 2. otherwise the louder note (higher velocity) wins: melodies are usually played louder;
 * 3. on a tie the earlier note (`current`) is kept.
 */
function outranks(candidate: IMusicBoxNote, current: IMusicBoxNote, mainTrack: number | undefined): boolean {
    const candidateIsMain = candidate.trackIndex === mainTrack;
    const currentIsMain = current.trackIndex === mainTrack;
    if (candidateIsMain !== currentIsMain) {
        return candidateIsMain;
    }
    return candidate.velocity > current.velocity;
}
