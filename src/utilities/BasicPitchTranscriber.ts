/**
 * Spotify's Basic Pitch (Apache License 2.0) running with TensorFlow.js in the browser.
 * This module and its dependencies are only downloaded when an audio file is opened: import it
 * dynamically (see `AudioTranscription.ts`).
 */
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import modelUrl from '@spotify/basic-pitch/model/model.json?url';
import weightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url';
import {
    IAudioAnalysis,
    IAudioTranscriptionSettings,
    IDetectedNote,
    BASIC_PITCH_SAMPLE_RATE,
    TranscriptionCancelledError,
} from './AudioTranscription';

/** Frames a note may stay below the confidence threshold and still continue (Basic Pitch's default). */
const ENERGY_TOLERANCE_FRAMES = 11;

/** Length of the model's input window: 2 s minus one hop (Basic Pitch's AUDIO_N_SAMPLES). */
export const MODEL_WINDOW_SAMPLES = 2 * BASIC_PITCH_SAMPLE_RATE - 256;
/** Overlap between consecutive windows: 30 frames (Basic Pitch's OVERLAP_LENGTH_FRAMES). */
const WINDOW_OVERLAP_SAMPLES = 30 * 256;
/** Distance between the starts of two windows (Basic Pitch's HOP_SIZE). */
export const WINDOW_HOP_SAMPLES = MODEL_WINDOW_SAMPLES - WINDOW_OVERLAP_SAMPLES;

/**
 * Frames of the analysis that come from each window: the model gives 172 per window (2 s at 86
 * frames per second) and Basic Pitch drops the 15 at each end, which overlap the neighbours.
 */
export const ANALYSIS_FRAMES_PER_WINDOW = 2 * Math.floor(BASIC_PITCH_SAMPLE_RATE / 256) - 30;

/** Frame differences used to infer onsets: 1 and 2 frames back (Basic Pitch's n_diff). */
const INFERRED_ONSET_LAGS = 2;

/**
 * The model's input, exactly as Basic Pitch's `prepareData` builds it: half an overlap of silence,
 * the audio, cut into windows of {@link MODEL_WINDOW_SAMPLES} every {@link WINDOW_HOP_SAMPLES}, the
 * last one completed with silence. Basic Pitch uses `tf.signal.frame`, whose WebGL version (TFJS
 * 3.21) generates a shader that doesn't compile ("Failed to compile fragment shader") when there
 * are 16·k + 1 windows: 26-28 s, 52-54 s, 79-80 s... of audio, about one length in 16, on any GPU.
 * Copying the samples in JavaScript gives the same windows without that bug.
 */
export function frameAudioForModel(samples: Float32Array): { windows: Float32Array; windowCount: number } {
    const padding = WINDOW_OVERLAP_SAMPLES / 2;
    const paddedLength = padding + samples.length;
    // tf.signal.frame with padEnd: a window starts at every multiple of the hop inside the signal.
    const windowCount = Math.ceil(paddedLength / WINDOW_HOP_SAMPLES);
    const windows = new Float32Array(windowCount * MODEL_WINDOW_SAMPLES);
    for (let w = 0; w < windowCount; w++) {
        // First sample of the window, in the audio (negative: inside the leading silence).
        const start = w * WINDOW_HOP_SAMPLES - padding;
        const from = Math.max(0, start);
        const to = Math.min(samples.length, start + MODEL_WINDOW_SAMPLES);
        if (to > from) {
            windows.set(samples.subarray(from, to), w * MODEL_WINDOW_SAMPLES + (from - start));
        }
    }
    return { windows, windowCount };
}

let modelPromise: Promise<tf.GraphModel> | undefined;

/** Loads the model once (about 900 kB); a failed load is retried the next time. */
export function loadBasicPitchModel(): Promise<tf.GraphModel> {
    if (!modelPromise) {
        modelPromise = tf.loadGraphModel(modelUrl, {
            // The model description names its weights file; the bundler gives it another URL.
            weightUrlConverter: async () => weightsUrl,
        });
        modelPromise.catch(() => {
            modelPromise = undefined;
        });
    }
    return modelPromise;
}

/** One analysis at a time: TensorFlow's memory scopes must not interleave. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs Basic Pitch on mono audio at 22050 Hz and keeps the note activations (the pitch bend
 * contours are not needed for a music box). The model's memory is released afterwards.
 */
export function analyzeAudio(
    samples: Float32Array,
    onProgress: (fraction: number) => void,
    isCancelled: () => boolean = () => false
): Promise<IAudioAnalysis> {
    const run = queue.then(() => runAnalysis(samples, onProgress, isCancelled));
    queue = run.catch(() => undefined);
    return run;
}

async function runAnalysis(
    samples: Float32Array,
    onProgress: (fraction: number) => void,
    isCancelled: () => boolean
): Promise<IAudioAnalysis> {
    const model = await loadBasicPitchModel();
    const basicPitch = new BasicPitch(Promise.resolve(model));
    basicPitch.prepareData = async (audio: Float32Array) => {
        const { windows, windowCount } = frameAudioForModel(audio);
        return [tf.tensor3d(windows, [windowCount, MODEL_WINDOW_SAMPLES, 1]), audio.length];
    };
    const frames: number[][] = [];
    const onsets: number[][] = [];

    // Basic Pitch doesn't free the tensors it creates for each window: free them all at the end.
    tf.engine().startScope();
    try {
        await basicPitch.evaluateModel(
            samples,
            (windowFrames, windowOnsets) => {
                frames.push(...windowFrames);
                onsets.push(...windowOnsets);
            },
            (fraction) => {
                // Called before each window: stopping here interrupts the analysis.
                if (isCancelled()) {
                    throw new TranscriptionCancelledError();
                }
                onProgress(fraction);
            }
        );
    } finally {
        tf.engine().endScope();
    }

    return { frames, onsets, durationSeconds: samples.length / BASIC_PITCH_SAMPLE_RATE };
}

/**
 * Basic Pitch's inferred onsets (an increase of a note's activation counts as an attack, scaled to
 * the strongest onset), except that an increase across the boundary between two model windows is
 * ignored: each window is analysed (and normalised) on its own, so the activation of a note that
 * is still ringing can jump there without any attack. In a window with only the decaying end of a
 * song, quiet notes jump up and turn into false notes after the end (13 of 24 rendered songs, about
 * 4 cm of paper each; also at the end of real piano recordings). Everything else is exactly Basic
 * Pitch's computation, including its scale, so no other note changes (measured: no real note lost
 * or added in any of 6 settings).
 */
export function inferOnsetsWithinWindows(onsets: number[][], frames: number[][]): number[][] {
    const sameWindow = (a: number, b: number) =>
        Math.floor(a / ANALYSIS_FRAMES_PER_WINDOW) === Math.floor(b / ANALYSIS_FRAMES_PER_WINDOW);
    let onsetMax = 0;
    // Basic Pitch's scale: the largest increase, window boundaries included.
    let increaseMax = 0;
    const increases = frames.map((row, r) => row.map((value, c) => {
        onsetMax = Math.max(onsetMax, onsets[r][c]);
        if (r < INFERRED_ONSET_LAGS) {
            return 0;
        }
        let all = Infinity;
        let withinWindow = Infinity;
        for (let lag = 1; lag <= INFERRED_ONSET_LAGS; lag++) {
            const increase = value - frames[r - lag][c];
            all = Math.min(all, increase);
            if (sameWindow(r, r - lag)) {
                withinWindow = Math.min(withinWindow, increase);
            }
        }
        increaseMax = Math.max(increaseMax, all);
        return withinWindow === Infinity ? 0 : Math.max(0, withinWindow);
    }));
    if (increaseMax <= 0) {
        return onsets.map(row => row.slice());
    }
    return onsets.map((row, r) => row.map((onset, c) => Math.max(onset, (onsetMax * increases[r][c]) / increaseMax)));
}

/**
 * Reads the notes from the activations with the given sensitivity, as Basic Pitch does (onsets
 * also inferred from the activations, see {@link inferOnsetsWithinWindows}; no frequency limits),
 * except for its "melodia trick", which is off: it adds notes where the model saw no attack. A
 * music box plucks every note, and in the measurements (see `DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS`)
 * those notes were false ones: turning it off never lost a real note, removed false ones, and is
 * about 40 times faster (0.2 s instead of 9 s for a 2 minute song), so the sliders respond at once.
 * The analysis is not modified, so it can be read again with other settings.
 */
export function detectNotes(analysis: IAudioAnalysis, settings: IAudioTranscriptionSettings): IDetectedNote[] {
    if (analysis.frames.length < 2) {
        return [];
    }
    const events = outputToNotesPoly(
        analysis.frames.map(row => row.slice()),
        inferOnsetsWithinWindows(analysis.onsets, analysis.frames),
        settings.onsetThreshold,
        settings.frameThreshold,
        settings.minNoteLengthFrames,
        false, // the onsets are already inferred
        null, // no maximum frequency
        null, // no minimum frequency
        false, // melodia trick
        ENERGY_TOLERANCE_FRAMES
    );
    return noteFramesToTime(events)
        .map(note => ({
            pitchMidi: note.pitchMidi,
            startTimeSeconds: note.startTimeSeconds,
            durationSeconds: note.durationSeconds,
            amplitude: note.amplitude,
        }))
        .sort((a, b) => a.startTimeSeconds - b.startTimeSeconds || a.pitchMidi - b.pitchMidi);
}
