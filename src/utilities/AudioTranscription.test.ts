import MidiFile, { isNoteEnd, isNoteStart } from '../model/MidiFile';
import { MidiFileFormat } from '../model/MidiFile';
import {
    analysisToMidiFile,
    analyzeAudioFile,
    AUDIO_TRANSCRIPTION_LIMITS,
    DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
    detectedNotesToMidi,
    downmixToMono,
    formatDuration,
    IAudioAnalysis,
    IAudioTranscriber,
    IDetectedNote,
    isAudioFile,
    isDefaultTranscriptionSettings,
    MAX_AUDIO_DURATION_SECONDS,
    minNoteLengthMs,
    TranscriptionCancelledError,
    TranscriptionProgress,
    TRANSCRIPTION_TICKS_PER_QUARTER,
    trimLeadingSilence,
} from './AudioTranscription';

function parse(buffer: ArrayBuffer): MidiFile {
    const midiFile = new MidiFile();
    midiFile.loadFromBuffer(buffer);
    return midiFile;
}

function note(pitchMidi: number, startTimeSeconds: number, durationSeconds = 0.3, amplitude = 0.5): IDetectedNote {
    return { pitchMidi, startTimeSeconds, durationSeconds, amplitude };
}

/** Note on / note off events of the only track, as [time, on/off, note, velocity]. */
function events(midiFile: MidiFile) {
    return midiFile.getTracks()[0].events
        .filter(e => isNoteStart(e) || isNoteEnd(e))
        .map(e => {
            const n = e as unknown as { absTimeSeconds: number; note: number; velocity: number };
            return [Number(n.absTimeSeconds.toFixed(4)), isNoteStart(e) ? 'on' : 'off', n.note, isNoteStart(e) ? n.velocity : 0];
        });
}

describe('detectedNotesToMidi', () => {
    it('writes a format 0 MIDI file at 120 bpm that the parser reads back exactly', () => {
        const midiFile = parse(detectedNotesToMidi([note(60, 0.5, 0.25, 1), note(64, 1.0005, 0.5, 0.5)]));
        expect(midiFile.getHeader().fileFormat).toBe(MidiFileFormat.singleTrack);
        expect(midiFile.getHeader().pulsesPerQuarterNote).toBe(TRANSCRIPTION_TICKS_PER_QUARTER);
        expect(midiFile.getTracks().length).toBe(1);
        expect(midiFile.midiStats.tempos).toEqual([120]);
        expect(events(midiFile)).toEqual([
            [0.5, 'on', 60, 127],
            [0.75, 'off', 60, 0],
            [1.0005, 'on', 64, 64],
            [1.5005, 'off', 64, 0],
        ]);
    });

    it('keeps note times to the nearest 0.5 ms (0.01 mm of strip at 20 mm/s)', () => {
        const times = [0, 0.0123, 1.23456, 61.98765, 299.99999];
        const midiFile = parse(detectedNotesToMidi(times.map(t => note(70, t, 0.1))));
        const starts = midiFile.getTracks()[0].events.filter(isNoteStart).map(e => e.absTimeSeconds);
        starts.forEach((start, i) => expect(Math.abs(start - times[i])).toBeLessThanOrEqual(0.00025 + 1e-9));
    });

    it('writes chords at the same time, with note offs before note ons at the same tick', () => {
        const midiFile = parse(detectedNotesToMidi([
            note(67, 0.5, 0.5), note(60, 0.5, 0.5), note(64, 0.5, 0.5),
            note(60, 1.0, 0.5), // struck again just as it ends
        ]));
        expect(events(midiFile)).toEqual([
            [0.5, 'on', 60, 64], [0.5, 'on', 64, 64], [0.5, 'on', 67, 64],
            [1, 'off', 60, 0], [1, 'off', 64, 0], [1, 'off', 67, 0],
            [1, 'on', 60, 64],
            [1.5, 'off', 60, 0],
        ]);
    });

    it('shortens a note that overlaps the next one of the same key, and merges two that start together', () => {
        const midiFile = parse(detectedNotesToMidi([
            note(62, 0.0, 1.0, 0.2),
            note(62, 0.4, 0.2, 0.6),
            note(62, 0.4, 0.5, 0.9), // same key, same start: one note, the loudest
        ]));
        expect(events(midiFile)).toEqual([
            [0, 'on', 62, 25],
            [0.4, 'off', 62, 0],
            [0.4, 'on', 62, 114],
            [0.9, 'off', 62, 0],
        ]);
    });

    it('never writes a velocity of 0 (that would be a note off), and keeps notes at least one tick long', () => {
        const midiFile = parse(detectedNotesToMidi([note(72, 0.2, 0, 0), note(73, 0.3, 0.1, 2)]));
        expect(events(midiFile)).toEqual([
            [0.2, 'on', 72, 1],
            [0.2005, 'off', 72, 0],
            [0.3, 'on', 73, 127],
            [0.4, 'off', 73, 0],
        ]);
    });

    it('ignores notes outside the MIDI range and clamps negative times to 0', () => {
        const midiFile = parse(detectedNotesToMidi([note(-1, 0.1), note(128, 0.1), note(48, -0.01, 0.2)]));
        expect(events(midiFile)).toEqual([[0, 'on', 48, 64], [0.19, 'off', 48, 0]]);
    });

    it('writes long gaps with multi-byte delta times', () => {
        const midiFile = parse(detectedNotesToMidi([note(60, 0), note(60, 250)]));
        expect(midiFile.getTracks()[0].events.filter(isNoteStart).map(e => e.absTimeSeconds)).toEqual([0, 250]);
    });

    it('writes a valid file without notes', () => {
        const midiFile = parse(detectedNotesToMidi([]));
        expect(midiFile.getTracks()[0].events.filter(isNoteStart)).toEqual([]);
    });
});

describe('trimLeadingSilence', () => {
    it('moves every note by the silence before the first one, keeping the distances between them', () => {
        const { notes, trimmedSeconds } = trimLeadingSilence([note(64, 1.75, 0.2, 0.3), note(60, 0.5, 0.4, 0.9), note(67, 0.5)]);
        expect(trimmedSeconds).toBe(0.5);
        expect(notes).toEqual([note(64, 1.25, 0.2, 0.3), note(60, 0, 0.4, 0.9), note(67, 0)]);
    });

    it('leaves songs that already start at 0, and empty ones, as they are', () => {
        expect(trimLeadingSilence([note(60, 0), note(62, 1)])).toEqual({ notes: [note(60, 0), note(62, 1)], trimmedSeconds: 0 });
        expect(trimLeadingSilence([])).toEqual({ notes: [], trimmedSeconds: 0 });
    });
});

describe('settings', () => {
    it('defaults are inside the slider ranges and on their steps', () => {
        (Object.keys(AUDIO_TRANSCRIPTION_LIMITS) as (keyof typeof AUDIO_TRANSCRIPTION_LIMITS)[]).forEach(key => {
            const { min, max, step } = AUDIO_TRANSCRIPTION_LIMITS[key];
            const value = DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS[key];
            expect(value).toBeGreaterThanOrEqual(min);
            expect(value).toBeLessThanOrEqual(max);
            const steps = (value - min) / step;
            expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
        });
        expect(isDefaultTranscriptionSettings({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS })).toBe(true);
        expect(isDefaultTranscriptionSettings({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, onsetThreshold: 0.95 })).toBe(false);
        expect(isDefaultTranscriptionSettings({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, frameThreshold: 0.95 })).toBe(false);
        expect(isDefaultTranscriptionSettings({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, minNoteLengthFrames: 43 })).toBe(false);
    });

    it('converts the minimum note length from frames to ms like Basic Pitch (11 frames = 127.7 ms)', () => {
        expect(minNoteLengthMs(11)).toBeCloseTo(127.7, 1);
        expect(minNoteLengthMs(1)).toBeCloseTo(11.61, 2);
    });

    it('formats durations as minutes and seconds', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(65.4)).toBe('1:05');
        expect(formatDuration(MAX_AUDIO_DURATION_SECONDS)).toBe('6:00');
    });
});

describe('isAudioFile', () => {
    it('recognizes MP3 files by extension or type, and not MIDI files', () => {
        expect(isAudioFile({ name: 'song.mp3', type: '' })).toBe(true);
        expect(isAudioFile({ name: 'SONG.MP3', type: '' })).toBe(true);
        expect(isAudioFile({ name: 'download', type: 'audio/mpeg' })).toBe(true);
        expect(isAudioFile({ name: 'download', type: 'audio/MP3' })).toBe(true);
        expect(isAudioFile({ name: 'song.mid', type: 'audio/midi' })).toBe(false);
        expect(isAudioFile({ name: 'song.midi', type: 'audio/x-midi' })).toBe(false);
        expect(isAudioFile({ name: 'song.mp3.mid', type: '' })).toBe(false);
    });
});

describe('downmixToMono', () => {
    it('averages the channels', () => {
        expect(Array.from(downmixToMono([Float32Array.from([1, 0.5, -1]), Float32Array.from([0, 0.5, 1, 9])])))
            .toEqual([0.5, 0.5, 0]);
        const mono = Float32Array.from([0.25]);
        expect(downmixToMono([mono])).toBe(mono);
        expect(downmixToMono([]).length).toBe(0);
    });
});

describe('analyzeAudioFile / analysisToMidiFile', () => {
    const analysis: IAudioAnalysis = { frames: [[0]], onsets: [[0]], durationSeconds: 2 };

    function transcriber(overrides: Partial<IAudioTranscriber> = {}): IAudioTranscriber {
        return {
            loadBasicPitchModel: vi.fn(async () => undefined),
            analyzeAudio: vi.fn(async (_samples, onProgress) => {
                onProgress(0.5);
                return analysis;
            }),
            detectNotes: vi.fn(() => [note(64, 0.5), note(60, 0.25)]),
            ...overrides,
        };
    }

    it('decodes the audio while the model loads, then runs the model and reports progress', async () => {
        const t = transcriber();
        const samples = new Float32Array(10);
        const decodeAudio = vi.fn(async () => ({ samples, durationSeconds: 2 }));
        const progress: TranscriptionProgress[] = [];
        const data = new ArrayBuffer(4);
        const isCancelled = () => false;
        const result = await analyzeAudioFile(data, p => progress.push(p), isCancelled,
            { decodeAudio, loadTranscriber: async () => t });
        expect(result).toBe(analysis);
        expect(decodeAudio).toHaveBeenCalledWith(data);
        expect(t.loadBasicPitchModel).toHaveBeenCalledTimes(1);
        expect(t.analyzeAudio).toHaveBeenCalledWith(samples, expect.any(Function), isCancelled);
        expect(progress).toEqual([
            { stage: 'preparing' },
            { stage: 'transcribing', fraction: 0 },
            { stage: 'transcribing', fraction: 0.5 },
        ]);
    });

    it('rejects audio that is too long, before running the model', async () => {
        const t = transcriber();
        await expect(analyzeAudioFile(new ArrayBuffer(4), () => undefined, () => false, {
            decodeAudio: async () => ({ samples: new Float32Array(1), durationSeconds: MAX_AUDIO_DURATION_SECONDS + 1 }),
            loadTranscriber: async () => t,
        })).rejects.toThrow('The audio is 6:01 long. Audio files up to 6:00 are supported');
        expect(t.analyzeAudio).not.toHaveBeenCalled();
    });

    it('reports decoding errors, and a readable error if the model cannot be downloaded', async () => {
        await expect(analyzeAudioFile(new ArrayBuffer(4), () => undefined, () => false, {
            decodeAudio: async () => { throw new Error('The audio could not be decoded.'); },
            loadTranscriber: async () => { throw new Error('network'); },
        })).rejects.toThrow('The audio could not be decoded.');

        await expect(analyzeAudioFile(new ArrayBuffer(4), () => undefined, () => false, {
            decodeAudio: async () => ({ samples: new Float32Array(1), durationSeconds: 1 }),
            loadTranscriber: async () => transcriber({ loadBasicPitchModel: async () => { throw new Error('404'); } }),
        })).rejects.toThrow('The note detection model could not be loaded. Check your internet connection');
    });

    it('stops before running the model if cancelled meanwhile', async () => {
        const t = transcriber();
        await expect(analyzeAudioFile(new ArrayBuffer(4), () => undefined, () => true, {
            decodeAudio: async () => ({ samples: new Float32Array(1), durationSeconds: 1 }),
            loadTranscriber: async () => t,
        })).rejects.toBeInstanceOf(TranscriptionCancelledError);
        expect(t.analyzeAudio).not.toHaveBeenCalled();
    });

    it('turns the detected notes into a parsed MIDI file, without the silence before the first note', async () => {
        const t = transcriber();
        const settings = { ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS, onsetThreshold: 0.7 };
        const { midiFile, noteCount, trimmedSeconds } = await analysisToMidiFile(analysis, settings, async () => t);
        expect(t.detectNotes).toHaveBeenCalledWith(analysis, settings);
        expect(noteCount).toBe(2);
        expect(trimmedSeconds).toBe(0.25);
        expect(midiFile.getTracks()[0].events.filter(isNoteStart).map(e => [e.note, e.absTimeSeconds]))
            .toEqual([[60, 0], [64, 0.25]]);
    });
});
