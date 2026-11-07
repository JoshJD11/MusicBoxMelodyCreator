import { MidiNote } from "./MidiConstants";

/**
 * Properties pertaining to the paper tape's width and supported notes for music box.
 */
export interface IMusicBoxProfile {
    /** Friendly name for the profile (e.g., for display on the UI) */
    name: string;

    /** Total width of the music box's paper tape, in millimeters. */
    paperWidthMm: number;

    /**
     * Total width (mm) of the area within the paper where notes can be drawn/punched.
     * Basically the distance between the first and the last "note line" in the paper tape.
     * */
    contentWidthMm: number;

    /**
     * The list of notes supported by the music box.
     */
    supportedNotes: MidiNote[];

    /**
     * The optimal diameter of punched holes, in millimeters.
     */
    holeDiameterMm: number;

    /**
     * The ideal length in paper for one second of music.
     */
    millimetersPerSecond: number;

    /**
     * The minimum acceptable gap between two notes on the same line.
     */
    minNoteGapMm: number;
}

export const BuiltInProfiles: { [key: string]: IMusicBoxProfile } = {
    'fifteenNote': {
        name: '15 Note',
        paperWidthMm: 41,
        contentWidthMm: 29,
        supportedNotes: [
            MidiNote.C4, MidiNote.D4, MidiNote.E4, MidiNote.F4, MidiNote.G4, MidiNote.A4,
            MidiNote.B4, MidiNote.C5, MidiNote.D5, MidiNote.E5, MidiNote.F5, MidiNote.G5,
            MidiNote.A5, MidiNote.B5, MidiNote.C6
        ],
        holeDiameterMm: 1.8,
        millimetersPerSecond: 20,
        minNoteGapMm: 3
    },

    'thirtyNote': {
        name: '30 Note',
        paperWidthMm: 70.1,
        contentWidthMm: 58.25,
        supportedNotes: [
            MidiNote.C3, MidiNote.D3, MidiNote.G3, MidiNote.A3, MidiNote.B3, MidiNote.C4,
            MidiNote.D4, MidiNote.E4, MidiNote.F4, MidiNote.Fs4, MidiNote.G4, MidiNote.Gs4,
            MidiNote.A4, MidiNote.As4, MidiNote.B4, MidiNote.C5, MidiNote.Cs5, MidiNote.D5,
            MidiNote.Ds5, MidiNote.E5, MidiNote.F5, MidiNote.Fs5, MidiNote.G5, MidiNote.Gs5,
            MidiNote.A5, MidiNote.As5, MidiNote.B5, MidiNote.C6, MidiNote.D6, MidiNote.E6
        ],
        holeDiameterMm: 2,
        millimetersPerSecond: 20,
        minNoteGapMm: 3
    }
}

/**
 * Returns the problems that make a profile unusable (empty if it's valid).
 * Values that are not finite numbers (e.g. an empty input) are rejected.
 */
export function validateMusicBoxProfile(profile: IMusicBoxProfile): string[] {
    const errors: string[] = [];
    const positive = (value: number, label: string) => {
        if (!Number.isFinite(value) || value <= 0) {
            errors.push(`${label} must be a number greater than 0.`);
            return false;
        }
        return true;
    };

    const paperOk = positive(profile.paperWidthMm, 'Paper width');
    const contentOk = positive(profile.contentWidthMm, 'Content width');
    const holeOk = positive(profile.holeDiameterMm, 'Hole diameter');
    positive(profile.millimetersPerSecond, 'Millimeters per second');

    if (!Number.isFinite(profile.minNoteGapMm) || profile.minNoteGapMm < 0) {
        errors.push('Minimum note gap must be a number of at least 0.');
    }

    if (paperOk && contentOk && holeOk && profile.contentWidthMm + profile.holeDiameterMm > profile.paperWidthMm) {
        errors.push('Content width plus hole diameter must not exceed the paper width (the outer holes would not fit).');
    }

    if (profile.supportedNotes.length < 2) {
        errors.push('The music box must support at least 2 notes.');
    }

    return errors;
}
