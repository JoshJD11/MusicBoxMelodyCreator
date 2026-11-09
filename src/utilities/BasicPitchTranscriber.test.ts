import fs from 'fs';
import path from 'path';
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly } from '@spotify/basic-pitch';
import {
    analyzeAudio, ANALYSIS_FRAMES_PER_WINDOW, detectNotes, frameAudioForModel, inferOnsetsWithinWindows,
    loadBasicPitchModel, MODEL_WINDOW_SAMPLES, WINDOW_HOP_SAMPLES,
} from './BasicPitchTranscriber';
import {
    BASIC_PITCH_FRAME_SECONDS,
    BASIC_PITCH_SAMPLE_RATE,
    DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
    IAudioAnalysis,
    TranscriptionCancelledError,
} from './AudioTranscription';

const MODEL_DIR = path.resolve(__dirname, '../../node_modules/@spotify/basic-pitch/model');

/** Serves the model files from node_modules (jsdom can't fetch them). */
function serveModelFiles() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const file = url.includes('model.json') ? 'model.json' : 'group1-shard1of1.bin';
        return new Response(fs.readFileSync(path.join(MODEL_DIR, file)), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/**
 * A plucked tone: a fundamental with two weak harmonics that decay faster. (Strong harmonics make
 * Basic Pitch add notes an octave above, like real instruments sometimes do.)
 */
function addTone(samples: Float32Array, midi: number, startSeconds: number, lengthSeconds: number) {
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const start = Math.round(startSeconds * BASIC_PITCH_SAMPLE_RATE);
    const length = Math.round(lengthSeconds * BASIC_PITCH_SAMPLE_RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
        const t = i / BASIC_PITCH_SAMPLE_RATE;
        let value = 0;
        [1, 0.2, 0.08].forEach((gain, h) => {
            value += gain * Math.exp(-4 * (h + 1) * t) * Math.sin(2 * Math.PI * frequency * (h + 1) * t);
        });
        samples[start + i] += 0.25 * Math.min(1, t / 0.002) * value;
    }
}

const MELODY = [
    { midi: 60, start: 0.5 },
    { midi: 64, start: 1.0 },
    { midi: 67, start: 1.5 },
    { midi: 72, start: 2.0 },
];

function melodyAudio(): Float32Array {
    const samples = new Float32Array(Math.round(3.2 * BASIC_PITCH_SAMPLE_RATE));
    MELODY.forEach(note => addTone(samples, note.midi, note.start, 0.6));
    return samples;
}

describe('BasicPitchTranscriber (real Basic Pitch model)', () => {
    let analysis: IAudioAnalysis;
    const progress: number[] = [];

    beforeAll(async () => {
        // jsdom has no WebGL: use TensorFlow's CPU backend directly (the browser uses WebGL).
        await tf.setBackend('cpu');
        serveModelFiles();
        analysis = await analyzeAudio(melodyAudio(), fraction => progress.push(fraction));
    }, 120000);

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('returns one row of 88 keys per frame for the whole audio and reports progress', () => {
        expect(analysis.durationSeconds).toBeCloseTo(3.2, 6);
        // floor(samples * 86 / 22050), as Basic Pitch trims its output.
        expect(analysis.frames.length).toBe(Math.floor(3.2 * BASIC_PITCH_SAMPLE_RATE * 86 / BASIC_PITCH_SAMPLE_RATE));
        expect(analysis.onsets.length).toBe(analysis.frames.length);
        expect(analysis.frames.every(row => row.length === 88)).toBe(true);
        expect(progress[0]).toBe(0);
        expect(progress[progress.length - 1]).toBe(1);
    });

    it('frees the memory used by the model', async () => {
        const before = tf.memory().numTensors;
        await analyzeAudio(melodyAudio().slice(0, BASIC_PITCH_SAMPLE_RATE), () => undefined);
        expect(tf.memory().numTensors).toBe(before);
    }, 120000);

    it('detects the notes of the melody, at their time, with the default settings', () => {
        const notes = detectNotes(analysis, DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS);
        expect(notes.map(n => n.pitchMidi)).toEqual(MELODY.map(n => n.midi));
        notes.forEach((note, i) => {
            // Within two frames (23 ms, under 0.5 mm of strip at 20 mm/s).
            expect(Math.abs(note.startTimeSeconds - MELODY[i].start)).toBeLessThanOrEqual(2 * BASIC_PITCH_FRAME_SECONDS);
            expect(note.amplitude).toBeGreaterThan(0);
            expect(note.amplitude).toBeLessThanOrEqual(1);
            expect(note.durationSeconds).toBeGreaterThan(0);
        });
    });

    it('can read the same analysis again with other settings without changing it', () => {
        const copy = JSON.stringify(analysis);
        const strict = detectNotes(analysis, { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, onsetThreshold: 0.95, frameThreshold: 0.95 });
        const loose = detectNotes(analysis, { onsetThreshold: 0.05, frameThreshold: 0.05, minNoteLengthFrames: 1 });
        expect(strict.length).toBeLessThan(MELODY.length);
        expect(loose.length).toBeGreaterThanOrEqual(MELODY.length);
        expect(JSON.stringify(analysis)).toBe(copy);
        expect(detectNotes(analysis, DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS).map(n => n.pitchMidi))
            .toEqual(MELODY.map(n => n.midi));
    });

    it('drops notes shorter than the minimum note length', () => {
        const all = detectNotes(analysis, { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, minNoteLengthFrames: 1 });
        const longest = Math.max(...all.map(n => n.durationSeconds));
        const frames = Math.ceil(longest / BASIC_PITCH_FRAME_SECONDS) + 1;
        expect(detectNotes(analysis, { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, minNoteLengthFrames: frames })).toEqual([]);
    });

    it('finds no notes in silence or in audio too short to analyze', async () => {
        const silence = await analyzeAudio(new Float32Array(BASIC_PITCH_SAMPLE_RATE), () => undefined);
        expect(detectNotes(silence, DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS)).toEqual([]);
        expect(detectNotes({ frames: [], onsets: [], durationSeconds: 0 }, DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS)).toEqual([]);
    }, 120000);

    it('stops when cancelled, frees the memory, and can analyze again afterwards', async () => {
        const before = tf.memory().numTensors;
        let windows = 0;
        await expect(analyzeAudio(melodyAudio(), () => { windows++; }, () => windows >= 1))
            .rejects.toBeInstanceOf(TranscriptionCancelledError);
        expect(windows).toBe(1);
        expect(tf.memory().numTensors).toBe(before);
        const again = await analyzeAudio(melodyAudio().slice(0, BASIC_PITCH_SAMPLE_RATE), () => undefined);
        expect(again.frames.length).toBeGreaterThan(0);
    }, 120000);

    it('gives the model exactly the same input and output as Basic Pitch itself', async () => {
        // Basic Pitch's own pipeline (tf.signal.frame), on the CPU backend where it works.
        const samples = melodyAudio();
        const ownFrames: number[][] = [];
        const ownOnsets: number[][] = [];
        const framesPerWindow: number[] = [];
        await new BasicPitch(loadBasicPitchModel()).evaluateModel(samples, (f, o) => {
            ownFrames.push(...f);
            ownOnsets.push(...o);
            framesPerWindow.push(f.length);
        }, () => undefined);
        expect(analysis.frames).toEqual(ownFrames);
        expect(analysis.onsets).toEqual(ownOnsets);
        // Every window but the last (cut at the end of the audio) gives the same number of frames.
        expect(framesPerWindow.length).toBe(2);
        expect(framesPerWindow[0]).toBe(ANALYSIS_FRAMES_PER_WINDOW);
        expect(ANALYSIS_FRAMES_PER_WINDOW).toBe(142);
    }, 120000);

    it('reads the same notes as Basic Pitch (onsets inferred) when no note starts on a window boundary', () => {
        const s = DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS;
        const basicPitch = outputToNotesPoly(analysis.frames.map(r => r.slice()), analysis.onsets.map(r => r.slice()),
            s.onsetThreshold, s.frameThreshold, s.minNoteLengthFrames, true, null, null, false, 11);
        const ours = outputToNotesPoly(analysis.frames.map(r => r.slice()), inferOnsetsWithinWindows(analysis.onsets, analysis.frames),
            s.onsetThreshold, s.frameThreshold, s.minNoteLengthFrames, false, null, null, false, 11);
        expect(basicPitch.length).toBe(MELODY.length);
        expect(ours).toEqual(basicPitch);
    });

    it('loads the model once', async () => {
        const fetchMock = serveModelFiles();
        const first = await loadBasicPitchModel();
        expect(await loadBasicPitchModel()).toBe(first);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('retries the download of the model after a failure (e.g. no connection)', async () => {
        vi.resetModules();
        const fresh = await import('./BasicPitchTranscriber');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
        await expect(fresh.loadBasicPitchModel()).rejects.toThrow();
        const fetchMock = serveModelFiles();
        await expect(fresh.loadBasicPitchModel()).resolves.toBeTruthy();
        expect(fetchMock).toHaveBeenCalled();
    }, 120000);
});

describe('frameAudioForModel', () => {
    beforeAll(async () => {
        await tf.setBackend('cpu');
    });

    /** What Basic Pitch's prepareData builds with tf.signal.frame. */
    function basicPitchWindows(samples: Float32Array): Float32Array {
        return tf.tidy(() => {
            const padded = tf.concat1d([tf.zeros([30 * 256 / 2]), tf.tensor1d(samples)]);
            return tf.signal.frame(padded, MODEL_WINDOW_SAMPLES, WINDOW_HOP_SAMPLES, true, 0).dataSync() as Float32Array;
        });
    }

    it('cuts the audio into the same windows as Basic Pitch, for any length', () => {
        expect([MODEL_WINDOW_SAMPLES, WINDOW_HOP_SAMPLES]).toEqual([43844, 36164]);
        // Lengths: tiny, under one window, exactly one, a window and a sample, and 17 and 33 windows
        // (the WebGL version of tf.signal.frame fails with 16·k + 1 windows).
        const lengths = [1, 1000, 40004, 40005, 76168, 598714, 638681, 1188495];
        lengths.forEach(length => {
            const samples = new Float32Array(length);
            for (let i = 0; i < length; i++) {
                samples[i] = Math.sin(i * 0.37) + (i % 7) / 10;
            }
            const { windows, windowCount } = frameAudioForModel(samples);
            const expected = basicPitchWindows(samples);
            expect(windowCount).toBe(expected.length / MODEL_WINDOW_SAMPLES);
            expect(windows.length).toBe(expected.length);
            // Exactly equal (it is only copying).
            let differences = 0;
            for (let i = 0; i < windows.length; i++) {
                if (windows[i] !== expected[i]) {
                    differences++;
                }
            }
            expect(differences).toBe(0);
        });
        expect(frameAudioForModel(new Float32Array(598714)).windowCount).toBe(17);
        expect(frameAudioForModel(new Float32Array(1188495)).windowCount).toBe(33);
    }, 120000);
});

describe('inferOnsetsWithinWindows (false notes at window boundaries)', () => {
    const PITCH = 60;
    const S = DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS;

    /**
     * A note attacked at frame 10 (a clear onset), ringing and fading; at frame `jumpAt` its
     * activation jumps up without any attack, like when a new window only sees the fading end of
     * a song.
     */
    function ringingNote(jumpAt: number): IAudioAnalysis {
        const n = 300;
        const frames = Array.from({ length: n }, () => new Array<number>(88).fill(0.02));
        const onsets = Array.from({ length: n }, () => new Array<number>(88).fill(0.05));
        const k = PITCH - 21;
        for (let f = 10; f < n; f++) {
            if (f < 13) {
                frames[f][k] = [0.2, 0.5, 0.8][f - 10];
            } else if (f < jumpAt) {
                frames[f][k] = 0.8 - 0.4 * (f - 13) / (jumpAt - 13);
            } else {
                frames[f][k] = 0.79 - 0.69 * (f - jumpAt) / (n - jumpAt);
            }
        }
        onsets[11][k] = 0.9;
        return { frames, onsets, durationSeconds: n * BASIC_PITCH_FRAME_SECONDS };
    }

    const basicPitchStarts = (a: IAudioAnalysis) => outputToNotesPoly(a.frames.map(r => r.slice()), a.onsets.map(r => r.slice()),
        S.onsetThreshold, S.frameThreshold, S.minNoteLengthFrames, true, null, null, false, 11).map(e => e.startFrame).sort((x, y) => x - y);
    const ourStarts = (a: IAudioAnalysis) => detectNotes(a, S).map(n => Math.round(n.startTimeSeconds / BASIC_PITCH_FRAME_SECONDS));

    it('ignores a jump of a ringing note across a window boundary (Basic Pitch makes a false note of it)', () => {
        const analysis = ringingNote(ANALYSIS_FRAMES_PER_WINDOW);
        expect(basicPitchStarts(analysis)).toEqual([11, ANALYSIS_FRAMES_PER_WINDOW]);
        expect(ourStarts(analysis).length).toBe(1);
        expect(Math.abs(ourStarts(analysis)[0] - 11)).toBeLessThanOrEqual(1);
    });

    it('still infers an onset from the same jump inside a window, exactly like Basic Pitch', () => {
        const analysis = ringingNote(100);
        expect(basicPitchStarts(analysis)).toEqual([11, 100]);
        const ours = inferOnsetsWithinWindows(analysis.onsets, analysis.frames);
        const basicPitchLike = outputToNotesPoly(analysis.frames.map(r => r.slice()), ours,
            S.onsetThreshold, S.frameThreshold, S.minNoteLengthFrames, false, null, null, false, 11);
        expect(basicPitchLike.map(e => e.startFrame).sort((x, y) => x - y)).toEqual([11, 100]);
        expect(detectNotes(analysis, S).length).toBe(2);
    });

    it('does not modify the analysis', () => {
        const analysis = ringingNote(ANALYSIS_FRAMES_PER_WINDOW);
        const copy = JSON.stringify(analysis);
        inferOnsetsWithinWindows(analysis.onsets, analysis.frames);
        detectNotes(analysis, S);
        expect(JSON.stringify(analysis)).toBe(copy);
    });
});
