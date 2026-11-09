import MidiFile from '../model/MidiFile';

/**
 * Audio (MP3) to MIDI with Spotify's Basic Pitch, entirely in the browser: the audio is decoded,
 * the model turns it into note activations once (slow), and the notes are read from those
 * activations with the sensitivity settings (fast, so the settings can change without running the
 * model again). The notes are written as a standard MIDI file that follows the normal MIDI flow.
 *
 * The heavy parts (TensorFlow.js and the model) live in `BasicPitchTranscriber.ts`, which is only
 * downloaded when an audio file is opened.
 */

/** Basic Pitch analyzes mono audio at this sample rate. */
export const BASIC_PITCH_SAMPLE_RATE = 22050;

/** Basic Pitch's activations have one frame every 256 samples (about 11.6 ms). */
export const BASIC_PITCH_FRAME_SECONDS = 256 / BASIC_PITCH_SAMPLE_RATE;

/**
 * Longest audio accepted. Basic Pitch keeps its activations in memory (and the note detection
 * copies them a few times), which is too much for phones with long songs. A music box strip of
 * this length is already several meters long.
 */
export const MAX_AUDIO_DURATION_SECONDS = 6 * 60;

/** How sensitive the note detection is. */
export interface IAudioTranscriptionSettings {
    /**
     * Basic Pitch's "note segmentation" (onset threshold, 0 - 1): how clear the attack of a note
     * must be to start a note. Higher: fewer notes. Lower: more notes, and more false ones.
     */
    onsetThreshold: number;

    /**
     * Basic Pitch's "model confidence threshold" (frame threshold, 0 - 1): how sure the model must
     * be that a note keeps sounding. Higher: fewer, surer notes. Lower: more notes, and more false
     * ones.
     */
    frameThreshold: number;

    /** Notes shorter than this number of frames (see `BASIC_PITCH_FRAME_SECONDS`) are dropped. */
    minNoteLengthFrames: number;
}

/**
 * Chosen by measuring the punched holes against the original MIDI files of the samples (rendered
 * to MP3 with the app's piano, 15 and 30 note boxes): onset 0.7 and frame 0.4 punched 98.5 - 100%
 * of the real notes with 79 - 94% of the holes correct. Basic Pitch's own defaults (onset 0.5,
 * frame 0.3) punched as many real notes, but only 63 - 72% of the holes were correct; an onset of
 * 0.8 or more drops real notes of chords. The minimum note length is Basic Pitch's (127.7 ms,
 * 11 frames).
 */
export const DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS: Readonly<IAudioTranscriptionSettings> = {
    onsetThreshold: 0.7,
    frameThreshold: 0.4,
    minNoteLengthFrames: 11,
};

/** Range of each setting, as offered by the sliders. */
export const AUDIO_TRANSCRIPTION_LIMITS: Readonly<Record<keyof IAudioTranscriptionSettings,
    { min: number; max: number; step: number }>> = {
    onsetThreshold: { min: 0.05, max: 0.95, step: 0.05 },
    frameThreshold: { min: 0.05, max: 0.95, step: 0.05 },
    // 12 ms to 499 ms.
    minNoteLengthFrames: { min: 1, max: 43, step: 1 },
};

export function minNoteLengthMs(frames: number): number {
    return frames * BASIC_PITCH_FRAME_SECONDS * 1000;
}

export function isDefaultTranscriptionSettings(settings: IAudioTranscriptionSettings): boolean {
    return settings.onsetThreshold === DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS.onsetThreshold &&
        settings.frameThreshold === DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS.frameThreshold &&
        settings.minNoteLengthFrames === DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS.minNoteLengthFrames;
}

/** Basic Pitch's output for a whole audio file: one row per frame, one column per piano key. */
export interface IAudioAnalysis {
    /** Probability that each key is sounding, per frame (88 columns, A0 to C8). */
    frames: number[][];
    /** Probability that each key starts a note, per frame (88 columns, A0 to C8). */
    onsets: number[][];
    durationSeconds: number;
}

/** A note found in the audio. */
export interface IDetectedNote {
    /** MIDI note number (21 - 108). */
    pitchMidi: number;
    startTimeSeconds: number;
    durationSeconds: number;
    /** Loudness, 0 - 1. */
    amplitude: number;
}

const AUDIO_EXTENSIONS = /\.mp3$/i;
const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/mp3'];

/** Accepted by the file picker, besides MIDI files. */
export const ACCEPTED_AUDIO_FILES = '.mp3,audio/mpeg,audio/mp3';

/** Whether a picked file is audio to transcribe (MP3), rather than a MIDI file. */
export function isAudioFile(file: { name: string; type: string }): boolean {
    return AUDIO_EXTENSIONS.test(file.name) || AUDIO_MIME_TYPES.includes(file.type.toLowerCase());
}

/** Averages the channels of the audio (the same down-mix Basic Pitch's reference implementation uses). */
export function downmixToMono(channels: Float32Array[]): Float32Array {
    if (channels.length === 0) {
        return new Float32Array(0);
    }
    if (channels.length === 1) {
        return channels[0];
    }
    const length = Math.min(...channels.map(channel => channel.length));
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        let sum = 0;
        for (const channel of channels) {
            sum += channel[i];
        }
        mono[i] = sum / channels.length;
    }
    return mono;
}

/** Ticks per quarter note of the generated MIDI files. */
export const TRANSCRIPTION_TICKS_PER_QUARTER = 1000;
/** 120 bpm: with 1000 ticks per quarter note, one tick is 0.5 ms. */
const TRANSCRIPTION_MICROSECONDS_PER_QUARTER = 500000;
const TICKS_PER_SECOND = TRANSCRIPTION_TICKS_PER_QUARTER * 1000000 / TRANSCRIPTION_MICROSECONDS_PER_QUARTER;

interface IMidiWriterEvent {
    tick: number;
    on: boolean;
    pitch: number;
    velocity: number;
}

/**
 * Writes the notes as a standard MIDI file (format 0, one track, channel 1, 120 bpm, 0.5 ms per
 * tick). The loudness of each note becomes its velocity (1 - 127), which decides which note wins
 * when two notes end up too close on the same line of the strip.
 * Overlapping notes of the same key are shortened so that each one has its own note off.
 */
export function detectedNotesToMidi(notes: IDetectedNote[]): ArrayBuffer {
    const events: IMidiWriterEvent[] = [];

    const byPitch = new Map<number, { start: number; end: number; velocity: number }[]>();
    notes.forEach(note => {
        const pitch = Math.round(note.pitchMidi);
        if (pitch < 0 || pitch > 127) {
            return;
        }
        const start = Math.max(0, Math.round(note.startTimeSeconds * TICKS_PER_SECOND));
        const end = Math.max(start + 1,
            Math.round((note.startTimeSeconds + note.durationSeconds) * TICKS_PER_SECOND));
        const velocity = Math.max(1, Math.min(127, Math.round(note.amplitude * 127)));
        const list = byPitch.get(pitch) || [];
        list.push({ start, end, velocity });
        byPitch.set(pitch, list);
    });

    byPitch.forEach((list, pitch) => {
        list.sort((a, b) => a.start - b.start || b.velocity - a.velocity);
        list.forEach((note, i) => {
            if (i > 0 && list[i - 1].start === note.start) {
                // The same key started twice at once: one note (the loudest, sorted first).
                return;
            }
            let end = note.end;
            for (let j = i + 1; j < list.length; j++) {
                if (list[j].start !== note.start) {
                    end = Math.min(end, list[j].start);
                    break;
                }
            }
            events.push({ tick: note.start, on: true, pitch, velocity: note.velocity });
            events.push({ tick: end, on: false, pitch, velocity: 0 });
        });
    });

    // In time order; at the same tick, note offs first (a key released and struck again).
    events.sort((a, b) => a.tick - b.tick || Number(a.on) - Number(b.on) || a.pitch - b.pitch);

    const track: number[] = [
        // Tempo: 120 bpm.
        0x00, 0xFF, 0x51, 0x03,
        (TRANSCRIPTION_MICROSECONDS_PER_QUARTER >> 16) & 0xFF,
        (TRANSCRIPTION_MICROSECONDS_PER_QUARTER >> 8) & 0xFF,
        TRANSCRIPTION_MICROSECONDS_PER_QUARTER & 0xFF,
    ];
    let previousTick = 0;
    events.forEach(event => {
        track.push(...variableLength(event.tick - previousTick));
        track.push(event.on ? 0x90 : 0x80, event.pitch, event.velocity);
        previousTick = event.tick;
    });
    track.push(0x00, 0xFF, 0x2F, 0x00);

    const bytes = [
        0x4D, 0x54, 0x68, 0x64, ...uint32(6),
        0x00, 0x00, // format 0
        0x00, 0x01, // one track
        (TRANSCRIPTION_TICKS_PER_QUARTER >> 8) & 0xFF, TRANSCRIPTION_TICKS_PER_QUARTER & 0xFF,
        0x4D, 0x54, 0x72, 0x6B, ...uint32(track.length), ...track,
    ];
    return new Uint8Array(bytes).buffer;
}

function variableLength(value: number): number[] {
    const bytes = [value & 0x7F];
    let working = Math.floor(value / 128);
    while (working > 0) {
        bytes.unshift((working & 0x7F) | 0x80);
        working = Math.floor(working / 128);
    }
    return bytes;
}

function uint32(value: number): number[] {
    return [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF];
}

/** What the conversion is doing, for the progress bar. */
export type TranscriptionProgress =
    | { stage: 'preparing' }
    | { stage: 'transcribing'; fraction: number };

/** Thrown when a conversion is cancelled because another file was picked. */
export class TranscriptionCancelledError extends Error {
    constructor() {
        super('The conversion was cancelled.');
        this.name = 'TranscriptionCancelledError';
    }
}

export interface ITranscriptionDependencies {
    decodeAudio(data: ArrayBuffer): Promise<{ samples: Float32Array; durationSeconds: number }>;
    loadTranscriber(): Promise<IAudioTranscriber>;
}

/** The part of `BasicPitchTranscriber.ts` used here. */
export interface IAudioTranscriber {
    loadBasicPitchModel(): Promise<unknown>;
    analyzeAudio(samples: Float32Array, onProgress: (fraction: number) => void,
        isCancelled: () => boolean): Promise<IAudioAnalysis>;
    detectNotes(analysis: IAudioAnalysis, settings: IAudioTranscriptionSettings): IDetectedNote[];
}

const defaultDependencies: ITranscriptionDependencies = {
    decodeAudio: async (data) => (await import('./AudioDecoding')).decodeAudioFile(data),
    loadTranscriber: () => import('./BasicPitchTranscriber'),
};

/**
 * Runs Basic Pitch on an audio file (the slow part, done once per file). The audio is decoded
 * while the model downloads.
 * @param isCancelled checked while the model runs; if it returns true the analysis stops with a
 *      `TranscriptionCancelledError`.
 */
export async function analyzeAudioFile(
    data: ArrayBuffer,
    onProgress: (progress: TranscriptionProgress) => void,
    isCancelled: () => boolean = () => false,
    dependencies: ITranscriptionDependencies = defaultDependencies
): Promise<IAudioAnalysis> {
    onProgress({ stage: 'preparing' });
    const transcriberPromise = dependencies.loadTranscriber().then(async transcriber => {
        await transcriber.loadBasicPitchModel();
        return transcriber;
    });
    // Both run at once; if decoding fails, the model keeps loading (cached for the next file).
    transcriberPromise.catch(() => undefined);
    const decoded = await dependencies.decodeAudio(data);
    if (decoded.durationSeconds > MAX_AUDIO_DURATION_SECONDS) {
        throw new Error(`The audio is ${formatDuration(decoded.durationSeconds)} long. ` +
            `Audio files up to ${formatDuration(MAX_AUDIO_DURATION_SECONDS)} are supported: ` +
            'trim it to the part you want on the strip.');
    }
    let transcriber: IAudioTranscriber;
    try {
        transcriber = await transcriberPromise;
    } catch {
        throw new Error('The note detection model could not be loaded. Check your internet connection and try again.');
    }
    if (isCancelled()) {
        throw new TranscriptionCancelledError();
    }
    onProgress({ stage: 'transcribing', fraction: 0 });
    return transcriber.analyzeAudio(decoded.samples,
        fraction => onProgress({ stage: 'transcribing', fraction }), isCancelled);
}

export interface IAudioMidi {
    midiFile: MidiFile;
    /** Notes detected in the audio (before the music box drops or transposes any). */
    noteCount: number;
    /** Silence removed before the first note (see `trimLeadingSilence`). */
    trimmedSeconds: number;
}

/**
 * Moves the notes so that the first one starts at 0: the silence an audio file usually has before
 * the music would otherwise become blank paper. Every note moves by the same amount, so the
 * distances between holes don't change. (MIDI files are not trimmed: a rest at their start is
 * part of the music.)
 */
export function trimLeadingSilence(notes: IDetectedNote[]): { notes: IDetectedNote[]; trimmedSeconds: number } {
    if (notes.length === 0) {
        return { notes, trimmedSeconds: 0 };
    }
    const first = Math.max(0, Math.min(...notes.map(note => note.startTimeSeconds)));
    return {
        notes: notes.map(note => ({ ...note, startTimeSeconds: note.startTimeSeconds - first })),
        trimmedSeconds: first,
    };
}

/**
 * Reads the notes from Basic Pitch's analysis with the given settings (fast), removes the silence
 * before the first note and writes them as a MIDI file, parsed like any other MIDI file.
 */
export async function analysisToMidiFile(
    analysis: IAudioAnalysis,
    settings: IAudioTranscriptionSettings,
    loadTranscriber: () => Promise<IAudioTranscriber> = defaultDependencies.loadTranscriber
): Promise<IAudioMidi> {
    const transcriber = await loadTranscriber();
    const { notes, trimmedSeconds } = trimLeadingSilence(transcriber.detectNotes(analysis, settings));
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(detectedNotesToMidi(notes));
    return { midiFile, noteCount: notes.length, trimmedSeconds };
}

/** "4:05" */
export function formatDuration(seconds: number): string {
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
