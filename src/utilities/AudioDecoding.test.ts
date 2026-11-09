import { decodeAudioFile } from './AudioDecoding';
import { BASIC_PITCH_SAMPLE_RATE } from './AudioTranscription';

function audioBuffer(channels: number[][], sampleRate: number): AudioBuffer {
    const data = channels.map(c => Float32Array.from(c));
    return {
        sampleRate,
        numberOfChannels: data.length,
        length: data[0] ? data[0].length : 0,
        duration: data[0] ? data[0].length / sampleRate : 0,
        getChannelData: (i: number) => data[i],
    } as unknown as AudioBuffer;
}

interface IFakeOptions {
    decoded?: AudioBuffer;
    decodeError?: boolean;
    /** Old Safari: callbacks only, no promise. */
    callbacksOnly?: boolean;
    rendered?: AudioBuffer;
}

/** Records the contexts created and decodes to `decoded`. */
function installOfflineAudioContext(options: IFakeOptions, property = 'OfflineAudioContext') {
    const created: { channels: number; length: number; sampleRate: number; source?: { buffer?: AudioBuffer } }[] = [];
    class FakeOfflineAudioContext {
        oncomplete: ((event: { renderedBuffer: AudioBuffer }) => void) | null = null;
        destination = {};
        private record: (typeof created)[number];
        constructor(channels: number, length: number, sampleRate: number) {
            this.record = { channels, length, sampleRate };
            created.push(this.record);
        }
        decodeAudioData(_data: ArrayBuffer, resolve: (b: AudioBuffer) => void, reject: (e: unknown) => void) {
            if (options.callbacksOnly) {
                setTimeout(() => options.decodeError ? reject(new Error('bad')) : resolve(options.decoded!));
                return undefined;
            }
            const promise = options.decodeError ? Promise.reject(new Error('bad')) : Promise.resolve(options.decoded!);
            promise.then(resolve, reject);
            return promise;
        }
        createBufferSource() {
            const source = { buffer: undefined as AudioBuffer | undefined, connect: vi.fn(), start: vi.fn() };
            this.record.source = source;
            return source;
        }
        startRendering() {
            if (options.callbacksOnly) {
                setTimeout(() => this.oncomplete!({ renderedBuffer: options.rendered! }));
                return undefined;
            }
            return Promise.resolve(options.rendered!);
        }
    }
    vi.stubGlobal(property, FakeOfflineAudioContext);
    return created;
}

describe('decodeAudioFile', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('decodes at 22050 Hz and averages the channels', async () => {
        const created = installOfflineAudioContext({
            decoded: audioBuffer([[1, 0.5, 0], [0, 0.5, -1]], BASIC_PITCH_SAMPLE_RATE),
        });
        const decoded = await decodeAudioFile(new ArrayBuffer(8));
        expect(created[0].sampleRate).toBe(BASIC_PITCH_SAMPLE_RATE);
        expect(Array.from(decoded.samples)).toEqual([0.5, 0.5, -0.5]);
        expect(decoded.durationSeconds).toBeCloseTo(3 / BASIC_PITCH_SAMPLE_RATE, 12);
    });

    it('works with the callback-only API of older Safari versions (webkit prefix)', async () => {
        vi.stubGlobal('OfflineAudioContext', undefined);
        installOfflineAudioContext({ decoded: audioBuffer([[0.25, 0.75]], BASIC_PITCH_SAMPLE_RATE), callbacksOnly: true },
            'webkitOfflineAudioContext');
        const decoded = await decodeAudioFile(new ArrayBuffer(8));
        expect(Array.from(decoded.samples)).toEqual([0.25, 0.75]);
    });

    it('resamples by rendering if the browser decoded at another sample rate', async () => {
        const decoded = audioBuffer([[0, 1, 0, -1], [0, 1, 0, -1]], 44100);
        const rendered = audioBuffer([[0.5, -0.5]], BASIC_PITCH_SAMPLE_RATE);
        for (const callbacksOnly of [false, true]) {
            const created = installOfflineAudioContext({ decoded, rendered, callbacksOnly });
            const result = await decodeAudioFile(new ArrayBuffer(8));
            expect(created[1]).toMatchObject({ channels: 1, length: 2, sampleRate: BASIC_PITCH_SAMPLE_RATE });
            expect(created[1].source!.buffer).toBe(decoded);
            expect(Array.from(result.samples)).toEqual([0.5, -0.5]);
            expect(result.durationSeconds).toBeCloseTo(4 / 44100, 12);
        }
    });

    it('explains what went wrong when the file is not audio, is empty, or the browser cannot decode', async () => {
        installOfflineAudioContext({ decodeError: true });
        await expect(decodeAudioFile(new ArrayBuffer(8))).rejects.toThrow('The audio could not be decoded. Make sure the file is a valid MP3.');

        installOfflineAudioContext({ decodeError: true, callbacksOnly: true });
        await expect(decodeAudioFile(new ArrayBuffer(8))).rejects.toThrow('could not be decoded');

        installOfflineAudioContext({ decoded: audioBuffer([[]], BASIC_PITCH_SAMPLE_RATE) });
        await expect(decodeAudioFile(new ArrayBuffer(8))).rejects.toThrow('The audio file is empty.');

        vi.stubGlobal('OfflineAudioContext', undefined);
        vi.stubGlobal('webkitOfflineAudioContext', undefined);
        await expect(decodeAudioFile(new ArrayBuffer(8))).rejects.toThrow('This browser cannot decode audio files.');
    });
});
