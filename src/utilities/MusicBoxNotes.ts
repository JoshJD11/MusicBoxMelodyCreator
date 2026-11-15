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

    /**
     * Holes added by hand ({@link IAddedNote}): notes the file doesn't have. They are punched as
     * they are (no transposition) if the music box plays that note and nothing else is within
     * `minNoteGapMm` on the same line; otherwise they are skipped and counted. They never move or
     * remove another hole. `deletedNoteIds` applies to them too.
     */
    addedNotes?: ReadonlyArray<IAddedNote>;
}

/**
 * A hole added by hand in the preview (see HoleEdits.ts). Its time is in the file's timeline, like
 * the file's notes (before the blank paper of deleted leading holes is discounted), so that it stays
 * with the music whatever else is deleted or restored.
 */
export interface IAddedNote {
    /** `added:<n>` (see {@link addedNoteId}): never the id of a note of the file (`track:event`). */
    id: string;
    /** The note of the line it was placed on. */
    note: MidiNote;
    /** Time in the file's timeline (seconds, >= 0). */
    timeSeconds: number;
}

/** Track index of the holes added by hand (they come from no track of the file). */
export const ADDED_NOTE_TRACK = -1;

/** Velocity of the holes added by hand when the file has no notes to take it from. */
export const DEFAULT_ADDED_NOTE_VELOCITY = 100;

const ADDED_NOTE_ID_PREFIX = 'added:';

/** The {@link IMusicBoxNote.id} of the n-th hole added by hand. */
export function addedNoteId(n: number): string {
    return ADDED_NOTE_ID_PREFIX + n;
}

export function isAddedNoteId(id: string): boolean {
    return id.startsWith(ADDED_NOTE_ID_PREFIX);
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
    /** Track of the file the note comes from; {@link ADDED_NOTE_TRACK} for a hole added by hand. */
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

    /**
     * Holes of the file deleted by hand (see {@link INoteExtractionOptions.deletedNoteIds}). A hole
     * added and then deleted by hand is not counted anywhere.
     */
    deletedCount: number;

    /** Holes added by hand that are punched (see {@link INoteExtractionOptions.addedNotes}). */
    addedCount: number;

    /**
     * Holes added by hand that are not punched: the music box doesn't play that note (the profile
     * changed), or another hole is too close on the same line (e.g. a deleted one was restored).
     */
    addedSkippedCount: number;

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
        addedCount: 0,
        addedSkippedCount: 0,
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
    const isDeleted = (id: string) => !!deleted && deleted.has(id);
    const punched = kept.filter((note): note is IMusicBoxNote => note !== null);
    const remaining = punched.filter(note => {
        if (isDeleted(note.id)) {
            result.deletedCount++;
            return false;
        }
        return true;
    });

    // 5. Holes added by hand: punched where they were placed if the box plays that note and no
    //    other hole (of the file, left after the deletions, or added before) is too close on the
    //    same line. They never move or remove another hole.
    const added = acceptAddedNotes(options.addedNotes ?? [], remaining, punched, profile, supportedSet, isDeleted, result);
    result.notes = added.length === 0 ? remaining : mergeByTime(remaining, added);

    // 6. If the first holes of the file were deleted, the song starts at the first hole left: every
    //    hole moves back by the same time (decision of the user), so the strip has no blank paper
    //    where the deleted holes were. Distances between holes don't change, and the silence of the
    //    file before its first note is kept (it is part of the music). A hole added before the
    //    first hole left keeps its place: the song never starts after it.
    if (remaining.length > 0 && remaining[0] !== punched[0]) {
        let shift = remaining[0].timeSeconds - punched[0].timeSeconds;
        added.forEach(note => {
            shift = Math.min(shift, note.timeSeconds);
        });
        if (shift > 0) {
            result.removedLeadingSeconds = shift;
            result.notes = result.notes.map(note => ({ ...note, timeSeconds: note.timeSeconds - shift }));
        }
    }
    return result;
}

/**
 * The holes added by hand that can be punched (see {@link INoteExtractionOptions.addedNotes}), as
 * notes of the strip, sorted by time. Counts the punched and the skipped ones in `result`.
 */
function acceptAddedNotes(
    candidates: ReadonlyArray<IAddedNote>,
    remaining: IMusicBoxNote[],
    punched: IMusicBoxNote[],
    profile: IMusicBoxProfile,
    supportedSet: Set<MidiNote>,
    isDeleted: (id: string) => boolean,
    result: INoteExtractionResult
): IMusicBoxNote[] {
    if (candidates.length === 0) {
        return [];
    }
    const minNoteGapSeconds = profile.minNoteGapMm / profile.millimetersPerSecond;
    // As loud as a typical note of the file, so that the preview blends them in.
    const velocity = medianVelocity(punched);
    const accepted: IMusicBoxNote[] = [];
    // Stable: holes added at the same time keep the order they were added in.
    [...candidates].sort((a, b) => a.timeSeconds - b.timeSeconds).forEach(candidate => {
        if (isDeleted(candidate.id)) {
            return;
        }
        if (!supportedSet.has(candidate.note) || !(candidate.timeSeconds >= 0)) {
            result.addedSkippedCount++;
            return;
        }
        const tooClose = (note: IMusicBoxNote) =>
            note.note === candidate.note && Math.abs(note.timeSeconds - candidate.timeSeconds) <= minNoteGapSeconds;
        if (remaining.some(tooClose) || accepted.some(tooClose)) {
            result.addedSkippedCount++;
            return;
        }
        accepted.push({
            id: candidate.id,
            note: candidate.note,
            originalNote: candidate.note,
            timeSeconds: candidate.timeSeconds,
            velocity,
            durationSeconds: UNTERMINATED_NOTE_DURATION_SECONDS,
            channel: 0,
            trackIndex: ADDED_NOTE_TRACK,
        });
        result.addedCount++;
    });
    return accepted;
}

/** The median velocity of the notes ({@link DEFAULT_ADDED_NOTE_VELOCITY} if there are none). */
function medianVelocity(notes: IMusicBoxNote[]): number {
    if (notes.length === 0) {
        return DEFAULT_ADDED_NOTE_VELOCITY;
    }
    const velocities = notes.map(note => note.velocity).sort((a, b) => a - b);
    return velocities[Math.floor(velocities.length / 2)];
}

/** Merges two lists sorted by time; at the same time the notes of the first list come first. */
function mergeByTime(first: IMusicBoxNote[], second: IMusicBoxNote[]): IMusicBoxNote[] {
    const merged: IMusicBoxNote[] = [];
    let i = 0;
    let j = 0;
    while (i < first.length || j < second.length) {
        if (j >= second.length || (i < first.length && first[i].timeSeconds <= second[j].timeSeconds)) {
            merged.push(first[i++]);
        } else {
            merged.push(second[j++]);
        }
    }
    return merged;
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
