/**
 * Helpers to build MIDI files byte by byte in tests.
 * Every helper returns the bytes of one track event, including its delta time.
 */

export function variableLength(value: number): number[] {
    const bytes = [value & 0x7F];
    let working = Math.floor(value / 128);
    while (working > 0) {
        bytes.unshift((working & 0x7F) | 0x80);
        working = Math.floor(working / 128);
    }
    return bytes;
}

export function noteOn(delta: number, note: number, velocity: number = 100, channel: number = 0): number[] {
    return [...variableLength(delta), 0x90 | channel, note, velocity];
}

export function noteOff(delta: number, note: number, channel: number = 0): number[] {
    return [...variableLength(delta), 0x80 | channel, note, 0];
}

/** A channel message without status byte (running status). */
export function runningStatus(delta: number, data1: number, data2: number): number[] {
    return [...variableLength(delta), data1, data2];
}

export function tempo(delta: number, microsecondsPerQuarterNote: number): number[] {
    return [
        ...variableLength(delta), 0xFF, 0x51, 0x03,
        (microsecondsPerQuarterNote >> 16) & 0xFF,
        (microsecondsPerQuarterNote >> 8) & 0xFF,
        microsecondsPerQuarterNote & 0xFF,
    ];
}

export function textMeta(delta: number, type: number, text: string): number[] {
    const bytes = text.split('').map(c => c.charCodeAt(0) & 0xFF);
    return [...variableLength(delta), 0xFF, type, ...variableLength(bytes.length), ...bytes];
}

export function trackName(delta: number, name: string): number[] {
    return textMeta(delta, 0x03, name);
}

export function sysEx(delta: number, payload: number[]): number[] {
    return [...variableLength(delta), 0xF0, ...variableLength(payload.length), ...payload];
}

export function pitchBend(delta: number, value: number, channel: number = 0): number[] {
    return [...variableLength(delta), 0xE0 | channel, value & 0x7F, (value >> 7) & 0x7F];
}

export function endOfTrack(delta: number = 0): number[] {
    return [...variableLength(delta), 0xFF, 0x2F, 0x00];
}

function uint32(value: number): number[] {
    return [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF];
}

export interface IMidiBuildOptions {
    format?: number;
    /** Ticks per quarter note (metrical timing). Ignored if `division` is given. */
    ppqn?: number;
    /** Raw 16-bit division field (e.g. for SMPTE timecode). */
    division?: number;
    /** Each track is a list of events (as returned by the helpers above). */
    tracks: number[][][];
}

export function buildMidi(options: IMidiBuildOptions): ArrayBuffer {
    const division = options.division !== undefined ? options.division : (options.ppqn || 480);
    const format = options.format !== undefined ? options.format : (options.tracks.length > 1 ? 1 : 0);

    const bytes: number[] = [
        0x4D, 0x54, 0x68, 0x64, ...uint32(6),
        (format >> 8) & 0xFF, format & 0xFF,
        (options.tracks.length >> 8) & 0xFF, options.tracks.length & 0xFF,
        (division >> 8) & 0xFF, division & 0xFF,
    ];

    options.tracks.forEach(events => {
        const data: number[] = [];
        events.forEach(event => data.push(...event));
        bytes.push(0x4D, 0x54, 0x72, 0x6B, ...uint32(data.length), ...data);
    });

    return new Uint8Array(bytes).buffer;
}
