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
 * Reads the notes from the activations with the given sensitivity, as Basic Pitch does (onsets
 * also inferred from the activations, no frequency limits), except for its "melodia trick", which
 * is off: it adds notes where the model saw no attack. A music box plucks every note, and in the
 * measurements (see `DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS`) those notes were false ones: turning
 * it off never lost a real note, removed false ones, and is about 40 times faster (0.2 s instead
 * of 9 s for a 2 minute song), so the sliders respond at once.
 * The analysis is not modified, so it can be read again with other settings.
 */
export function detectNotes(analysis: IAudioAnalysis, settings: IAudioTranscriptionSettings): IDetectedNote[] {
    if (analysis.frames.length < 2) {
        return [];
    }
    const events = outputToNotesPoly(
        analysis.frames.map(row => row.slice()),
        analysis.onsets.map(row => row.slice()),
        settings.onsetThreshold,
        settings.frameThreshold,
        settings.minNoteLengthFrames,
        true, // infer onsets
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
