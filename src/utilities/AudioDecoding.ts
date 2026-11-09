import { BASIC_PITCH_SAMPLE_RATE, downmixToMono } from './AudioTranscription';

export interface IDecodedAudio {
    /** Mono audio at `BASIC_PITCH_SAMPLE_RATE`. */
    samples: Float32Array;
    durationSeconds: number;
}

type OfflineAudioContextConstructor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function getOfflineAudioContext(): OfflineAudioContextConstructor | undefined {
    const scope = window as unknown as {
        OfflineAudioContext?: OfflineAudioContextConstructor;
        webkitOfflineAudioContext?: OfflineAudioContextConstructor;
    };
    return scope.OfflineAudioContext || scope.webkitOfflineAudioContext;
}

/** Callback form: older Safari versions don't return a promise. */
function decode(context: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
        const result = context.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
        if (result && typeof result.catch === 'function') {
            result.catch(reject);
        }
    });
}

/**
 * Decodes an audio file (MP3) with the browser and returns it as Basic Pitch needs it: mono, at
 * 22050 Hz. The browser resamples while decoding; if it doesn't, the audio is resampled by
 * rendering it.
 */
export async function decodeAudioFile(data: ArrayBuffer): Promise<IDecodedAudio> {
    const OfflineContext = getOfflineAudioContext();
    if (!OfflineContext) {
        throw new Error('This browser cannot decode audio files.');
    }

    let buffer: AudioBuffer;
    try {
        buffer = await decode(new OfflineContext(1, 1, BASIC_PITCH_SAMPLE_RATE), data);
    } catch {
        throw new Error('The audio could not be decoded. Make sure the file is a valid MP3.');
    }

    if (buffer.length === 0 || !(buffer.duration > 0)) {
        throw new Error('The audio file is empty.');
    }

    if (buffer.sampleRate !== BASIC_PITCH_SAMPLE_RATE) {
        // Rendering into a mono context resamples and down-mixes ((left + right) / 2 for stereo).
        const length = Math.ceil(buffer.duration * BASIC_PITCH_SAMPLE_RATE);
        const context = new OfflineContext(1, length, BASIC_PITCH_SAMPLE_RATE);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.start(0);
        const rendered = await new Promise<AudioBuffer>((resolve, reject) => {
            // Older Safari versions only report the result with this event.
            context.oncomplete = (event) => resolve(event.renderedBuffer);
            const result = context.startRendering() as Promise<AudioBuffer> | undefined;
            if (result && typeof result.then === 'function') {
                result.then(resolve, reject);
            }
        });
        return { samples: rendered.getChannelData(0), durationSeconds: buffer.duration };
    }

    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) {
        channels.push(buffer.getChannelData(i));
    }
    return { samples: downmixToMono(channels), durationSeconds: buffer.duration };
}
