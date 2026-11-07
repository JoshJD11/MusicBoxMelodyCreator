import { IMidiEvent, ChannelMessageType, NoteMidiEvent, ControllerMidiEvent as ControllerChangeMidiEvent, ProgramChangeMidiEvent, ChannelPressureMidiEvent, PitchBendMidiEvent, MetaMidiEvent, SysExMidiEvent } from "./MidiEvents";
import { MIDIMetaMessageType, MidiNote } from "./MidiConstants";

/**
 * A valid MIDI file will contain a single Header chunk followed by one or more Track chunks.
 * Each chunk has an 8 byte header that identifies which type it is, and gives the size of its associated data :
 * bytes 0 - 3 : identifier (either 'MThd' or 'MTrk')
 * bytes 4 - 7 : chunklen (the number of bytes comprising the following data)
 * Chunks with unrecognized identifier should be skipped (anything other than 'MThd' or 'MTrk').
 *
 * All multi-byte data is big-endian.
 */
export interface IMidiChunk {
    /**
     * Parses out the chunk from a raw MIDI buffer given the start offset and length in bytes.
     * @param dataView The raw MIDI data buffer
     * @param dataStartOffset The byte position within `dataView`, where the chunk data (after the
     *      8-byte header) starts.
     * @param chunkLength Total byte length of the chunk
     */
    parseFromRawData(dataView: DataView, dataStartOffset: number, chunkLength: number): void;
}

export enum MidiFileFormat {
    /**
     * The MIDI file contains just a single MTrk chunk, that can potentially contain multi-channel
     * MIDI data.
     */
    singleTrack = 0,

    /**
     * The file contains two or more MTrk chunks (as specified by the following parameter, ntracks)
     * that are to be played simultaneously, i.e. analogous to a mulitrack tape recorder. The first
     * track is a tempo track that should only contain tempo related Meta events (i.e. no actual
     * MIDI data). This is the most commonly used format, as the various instrumental parts within a
     * composition can be stored in separate tracks, allowing for easier editing. It is possible to
     * store multi-channel data in a track, though it is more usual to keep data relevant to a
     * single MIDI channel in each track.
     */
    multiTrack = 1,

    /**
     * Not very popular, don't care.
     */
    Type2 = 2,
}

export enum MidiTimingScheme {
    /** Timing of events is determined by beats per minute/pulses per quarter note, etc. */
    metrical = 0,

    /** Absolute time is used in Midi events. */
    timecode = 1,
}

/**
 * The Header chunk (identifier = MThd) has a fixed length and contains a few global properties
 * pertaining to the file as a whole. It should be the first chunk in the file, and this should be
 * the only occurrence. Although the Header chunk currently always contains 6 bytes of data
 * (i.e., chunklen = 6), this should not be assumed (i.e., the chunklen value should always be read
 * and acted upon, to allow for possible future extension to the standard).
 */
export class MidiHeader implements IMidiChunk {
    /** Format of the MIDI file (type 0, 1, 2). Corresponds to first 16 bits of the header data. */
    public fileFormat: MidiFileFormat = MidiFileFormat.multiTrack;

    /**
     * The number of MTrk chunks following this MThd chunk.
     * For a format 0 MIDI file, ntracks can only be '1'.
     * Second 16-bits of the header data.
     */
    public numTracks: number = 0;

    /**
     * Specifies the timing interval to be used, and whether timecode (Hrs.Mins.Secs.Frames) or
     * metrical (Bar.Beat) timing is to be used. With metrical timing, the timing interval is tempo
     * related, whereas with timecode the timing interval is in absolute time, and hence not related
     * to tempo. This is the third 16 bytes of the header data.
     */
    public rawTimingData: number = 0;

    /** Parsed from bit 15 of rawTimingDivision, 0 = Metrical, 1 = timecode. @see rawTimingDivision */
    public timingScheme: MidiTimingScheme = MidiTimingScheme.metrical;

    /**
     * If @see timingScheme is @see MidiTimingScheme.Metrical, bits 0-14 of @see rawTimingDivision
     * are a 15-bit number indicating the number of sub-divisions of a quarter note (a.k.a. pulses
     * per quarter note, ppqn). A common value is 96, which would be represented in hex as `00 60`.
     * You will notice that 96 is a nice number for dividing by 2 or 3 (with further repeated
     * halving), so using this value for tickdiv allows triplets and dotted notes right down to
     * hemi-demi-semiquavers to be represented.
     */
    public pulsesPerQuarterNote?: number;

    /**
     * If @see timingScheme is @see MidiTimingScheme.TimeCode, bits 8-15 of @see rawTimingDivision
     * (i.e., the first byte) specify the number of frames per second (fps), and will be one of the
     * four SMPTE standards: 24, 25, 29 or 30, though expressed as a negative value using 2's
     * complement notation. (e.g, 24 is represented as `E8`)
     */
    public framesPerSecond?: number;

    /**
     * If @see timingScheme is @see MidiTimingScheme.TimeCode, bits 0 - 7 of @see rawTimingDivision
     * (second byte) specify the sub-frame resolution (i.e.,  number of sub-divisions of a frame).
     * Typical values are 4 (corresponding to MIDI Time Code), 8, 10, 80(corresponding to SMPTE bit
     * resolution), or 100. A timing resolution of 1 ms can be achieved by specifying 25 fps and 40
     * sub-frames, which would be encoded in hex as `E7 28`.
     */
    public subFrameResolution?: number;

    constructor(dataView: DataView, startOffset: number, chunkLength: number) {
        this.parseFromRawData(dataView, startOffset, chunkLength);
    }

    public parseFromRawData(dataView: DataView, startOffset: number, chunkLength: number) {
        if (chunkLength < 6) {
            throw new Error('Invalid MIDI header: expected at least 6 bytes, found ' + chunkLength + '.');
        }

        // First 16 bits
        const format: MidiFileFormat =
            dataView.getUint16(startOffset, /* littleEndian: */ false) as MidiFileFormat;

        // Second 16 bits
        const numTracks: number =
            dataView.getUint16(startOffset + 2,  /* littleEndian: */ false);

        // Third 16 bits
        const rawTimingData = dataView.getUint16(startOffset + 4, /* littleEndian: */ false);

        // Bit 15 selects the timing scheme: 0 = metrical, 1 = timecode.
        const timingScheme = (rawTimingData & 0x8000) !== 0
            ? MidiTimingScheme.timecode
            : MidiTimingScheme.metrical;

        this.fileFormat = format;
        this.rawTimingData = rawTimingData;
        this.numTracks = numTracks;
        this.timingScheme = timingScheme;

        if (timingScheme === MidiTimingScheme.metrical) {
            // Bits 0-14
            this.pulsesPerQuarterNote = 0x7FFF & rawTimingData;
        } else {
            // Timing scheme is timecode.
            // Bits 8 - 15: frames per second, stored as a negative 8-bit 2's complement number.
            this.framesPerSecond = 256 - (rawTimingData >> 8);

            // Bits 0 - 7
            this.subFrameResolution = 0x00FF & rawTimingData;
        }
    }
}

/** Useful information gathered while parsing a MIDI file. */
export interface IMidiStats {
    /** Tempos corresponding to all tempo change events encountered in all tracks. */
    tempos: number[];

    /** Raw representation of tempo for maximal accuracy */
    secondsPerTickValues: number[];

    /** Count of all notes encountered. */
    noteHistogram: Map<MidiNote, number>;

    /** Time in seconds for the last note on/off event. */
    lastNoteOnEventInSeconds: number;

    /** The lowest note encountered */
    lowNote: MidiNote;

    /** The highest note encountered */
    highNote: MidiNote;
}

/**
 * Track chunks (identifier = MTrk) contain a sequence of time-ordered events (MIDI and/or sequencer
 * specific data), each of which has a delta time value associated with it - i.e. the amount of time
 * (specified in tickdiv units) since the previous event.
 * i.e., a track is sequence of 'delta-time / event' pairs
 * 
 * Single track files (type 0) only have one track.
 * Multi-track files (type 1) contain multiple tracks, where the first track is a global tempo track
 * and subsequent tracks contain the actual note data but not timing events. All trasks are played
 * together and they all follow the tempo track.
 * Type 2 midi files allow timing events in any track.
 */
export class MidiTrack implements IMidiChunk {
    public events: IMidiEvent[] = [];

    /** Name of the track, from its Track Name meta event (if present). */
    public name?: string;

    constructor(dataView: DataView, dataStartOffset: number, chunkLength: number) {
        this.parseFromRawData(dataView, dataStartOffset, chunkLength);
    }

    /**
     * Parses the events of the track. Only the position in ticks (`absTicks`) is resolved
     * here; times in seconds depend on the tempo map of the whole file and are resolved by
     * {@link MidiFile} once every track has been read.
     */
    public parseFromRawData(dataView: DataView, dataStartOffset: number, chunkLength: number): void {
        const reader = new ByteReader(dataView, dataStartOffset);
        const chunkEnd = dataStartOffset + chunkLength;

        let absTicks = 0;

        // Running status: a channel message may omit its status byte when it is the same as
        // the previous one. Meta and SysEx events cancel running status.
        let runningStatus = 0;

        while (reader.offset < chunkEnd) {
            // Delta time since the previous event (variable length quantity)
            const deltaTime = reader.readVariableLength();
            absTicks += deltaTime;

            // Read status byte to find event type
            let statusByte = reader.peekUint8();
            if (statusByte < 0x80) {
                // Data byte: running status is in effect
                if (runningStatus === 0) {
                    throw new Error(
                        'Corrupt MIDI track: data byte without a status byte at offset ' + reader.offset + '.');
                }
                statusByte = runningStatus;
            } else {
                reader.offset++;
            }

            if (statusByte >= 0x80 && statusByte <= 0xEF) {
                // This is a channel message
                runningStatus = statusByte;
                const midiEvent = parseChannelMessage(reader, statusByte, deltaTime);
                midiEvent.absTicks = absTicks;
                this.events.push(midiEvent);
            } else if (statusByte === 0xF0 || statusByte === 0xF7) {
                // SysEx messages: `F0 length data` or `F7 length data`. The payload is skipped.
                runningStatus = 0;
                const sysExEvent = new SysExMidiEvent(deltaTime);
                sysExEvent.length = reader.readVariableLength();
                sysExEvent.absTicks = absTicks;
                reader.skip(sysExEvent.length);
                this.events.push(sysExEvent);
            } else if (statusByte === 0xFF) {
                // Meta messages: with the general format `FF type length data`
                runningStatus = 0;
                const metaEvent = new MetaMidiEvent(deltaTime);
                metaEvent.absTicks = absTicks;
                metaEvent.metaMessageType = reader.readUint8();
                const length = reader.readVariableLength();
                const dataOffset = reader.offset;

                if (metaEvent.metaMessageType === MIDIMetaMessageType.SetTempo && length === 3) {
                    metaEvent.microsecondsPerQuarterNote =
                        (dataView.getUint8(dataOffset) << 16) +
                        (dataView.getUint8(dataOffset + 1) << 8) +
                        dataView.getUint8(dataOffset + 2);
                } else if (metaEvent.metaMessageType >= 0x01 && metaEvent.metaMessageType <= 0x0F) {
                    metaEvent.text = reader.readLatin1String(length);
                    if (metaEvent.metaMessageType === MIDIMetaMessageType.TrackName && this.name === undefined) {
                        this.name = metaEvent.text;
                    }
                }

                reader.offset = dataOffset;
                reader.skip(length);
                this.events.push(metaEvent);

                if (metaEvent.metaMessageType === MIDIMetaMessageType.EndOfTrack) {
                    // This is the end of track marker.
                    break;
                }
            } else {
                // 0xF1 - 0xF6 and 0xF8 - 0xFE are real-time/common messages, which are not
                // allowed in MIDI files.
                throw new Error(
                    'Unsupported status byte 0x' + statusByte.toString(16).toUpperCase() +
                    ' at offset ' + (reader.offset - 1) + '.');
            }
        }
    }
}

function parseChannelMessage(reader: ByteReader, statusByte: number, deltaTime: number) {
    const messageType = (statusByte & 0b11110000) >> 4;
    const channelNumber = (statusByte & 0b00001111);

    let midiEvent;
    switch (messageType) {
        case ChannelMessageType.NoteOff:
        case ChannelMessageType.NoteOn:
        case ChannelMessageType.PolyphonicPressure: {
            const noteEvent = new NoteMidiEvent(deltaTime);
            noteEvent.note = reader.readUint8();
            noteEvent.velocity = reader.readUint8();
            midiEvent = noteEvent;
            break;
        }

        case ChannelMessageType.Controller: {
            const controllerEvent = new ControllerChangeMidiEvent(deltaTime);
            controllerEvent.controller = reader.readUint8();
            controllerEvent.value = reader.readUint8();
            midiEvent = controllerEvent;
            break;
        }

        case ChannelMessageType.ProgramChange: {
            const programEvent = new ProgramChangeMidiEvent(deltaTime);
            programEvent.program = reader.readUint8();
            midiEvent = programEvent;
            break;
        }

        case ChannelMessageType.ChannelPressure: {
            const pressureEvent = new ChannelPressureMidiEvent(deltaTime);
            pressureEvent.velocity = reader.readUint8();
            midiEvent = pressureEvent;
            break;
        }

        case ChannelMessageType.PitchBend: {
            const pitchBendEvent = new PitchBendMidiEvent(deltaTime);
            // 14-bit value, least significant 7 bits first. 0x2000 = no bend.
            const lsb = reader.readUint8();
            const msb = reader.readUint8();
            pitchBendEvent.value = lsb | (msb << 7);
            midiEvent = pitchBendEvent;
            break;
        }

        default:
            throw new Error('Unrecognized status byte: ' + statusByte);
    }

    midiEvent.channelMessageType = messageType;
    midiEvent.channel = channelNumber;
    return midiEvent;
}

/** Sequential big-endian reader over a DataView. */
class ByteReader {
    constructor(private dataView: DataView, public offset: number) { }

    public peekUint8(): number {
        return this.dataView.getUint8(this.offset);
    }

    public readUint8(): number {
        return this.dataView.getUint8(this.offset++);
    }

    public skip(length: number) {
        if (this.offset + length > this.dataView.byteLength) {
            throw new RangeError('Unexpected end of data.');
        }
        this.offset += length;
    }

    /**
     * Reads a variable length quantity (big-endian sequence of 7-bit numbers, where the top
     * bit being set indicates that another byte follows). At most 4 bytes are allowed.
     */
    public readVariableLength(): number {
        let value = 0;
        for (let i = 0; i < 4; i++) {
            const byte = this.readUint8();
            value = value * 128 + (byte & 0x7F);
            if ((byte & 0x80) === 0) {
                return value;
            }
        }
        throw new Error('Corrupt MIDI data: variable length quantity longer than 4 bytes.');
    }

    public readLatin1String(length: number): string {
        let text = '';
        for (let i = 0; i < length; i++) {
            text += String.fromCharCode(this.dataView.getUint8(this.offset + i));
        }
        return text;
    }
}

/** Default tempo when a file does not specify one: 120 bpm. */
const DEFAULT_MICROSECONDS_PER_QUARTER_NOTE = 500000;

interface ITempoSegment {
    /** Tick at which this tempo starts. */
    startTick: number;
    /** Time in seconds at `startTick`. */
    startSeconds: number;
    secondsPerTick: number;
}

/**
 * Builds the tempo map (tick -> seconds) from the given tempo events. Times are computed
 * per segment from integer tick counts, so that rounding errors do not accumulate.
 */
function buildTempoMap(tempoEvents: MetaMidiEvent[], pulsesPerQuarterNote: number): ITempoSegment[] {
    const sorted = tempoEvents
        .map((event, index) => ({ event, index }))
        .sort((a, b) => (a.event.absTicks - b.event.absTicks) || (a.index - b.index))
        .map(x => x.event);

    const segments: ITempoSegment[] = [{
        startTick: 0,
        startSeconds: 0,
        secondsPerTick: DEFAULT_MICROSECONDS_PER_QUARTER_NOTE / (1000000 * pulsesPerQuarterNote),
    }];

    for (const event of sorted) {
        const previous = segments[segments.length - 1];
        const secondsPerTick = (event.microsecondsPerQuarterNote as number) / (1000000 * pulsesPerQuarterNote);
        const startSeconds = previous.startSeconds + (event.absTicks - previous.startTick) * previous.secondsPerTick;

        if (event.absTicks === previous.startTick) {
            // Several tempo events on the same tick: the last one wins.
            previous.secondsPerTick = secondsPerTick;
        } else {
            segments.push({ startTick: event.absTicks, startSeconds, secondsPerTick });
        }
    }

    return segments;
}

function ticksToSeconds(ticks: number, tempoMap: ITempoSegment[]): number {
    // Tempo maps are small; find the last segment starting at or before `ticks`.
    let segment = tempoMap[0];
    for (let i = 1; i < tempoMap.length && tempoMap[i].startTick <= ticks; i++) {
        segment = tempoMap[i];
    }
    return segment.startSeconds + (ticks - segment.startTick) * segment.secondsPerTick;
}

function isTempoEvent(event: IMidiEvent): event is MetaMidiEvent {
    return event instanceof MetaMidiEvent && event.microsecondsPerQuarterNote !== undefined;
}

/**
 * Basic MIDI file parser based on http://www.somascape.org/midi/tech/mfile.html
 */
export default class MidiFile {
    public chunks: IMidiChunk[] = [];

    public header?: MidiHeader;
    public tracks: MidiTrack[] = []

    public midiStats: IMidiStats;

    constructor() {
        this.midiStats = this.getInitialMidiStats();
    }

    /**
     * Parses a MIDI file. Throws an `Error` with a readable message if the data is not a
     * valid (or supported) MIDI file.
     */
    public loadFromBuffer(buffer: ArrayBuffer) {
        this.chunks = [];
        this.tracks = [];
        this.header = undefined;
        this.midiStats = this.getInitialMidiStats();

        const dataView = new DataView(buffer);

        if (buffer.byteLength < 14 || getStringFromBuffer(buffer, 0, 4) !== 'MThd') {
            throw new Error('Not a valid MIDI file (missing "MThd" header).');
        }

        try {
            let currentPos: number = 0;

            // Every chunk starts with an 8 byte header; trailing bytes shorter than that are ignored.
            while (currentPos + 8 <= buffer.byteLength) {
                // Read chunk type (4 bytes);
                const chunkType = getStringFromBuffer(buffer, currentPos, currentPos + 4);
                currentPos += 4;

                // Read length of chunk (4 bytes, big-endian)
                const declaredLength = dataView.getUint32(currentPos, /* littleEndian: */ false);
                currentPos += 4;

                const chunkDataStartOffset = currentPos;
                const chunkLength = declaredLength;
                if (chunkDataStartOffset + chunkLength > buffer.byteLength) {
                    // Never parse a partial chunk: the end of the song would be silently lost.
                    throw new RangeError('Chunk ' + chunkType + ' exceeds the file size.');
                }

                switch (chunkType) {
                    case 'MThd': {
                        if (!this.header) {
                            const header = new MidiHeader(dataView, chunkDataStartOffset, chunkLength);
                            this.header = header;
                            this.chunks.push(header);
                        }
                        break;
                    }

                    case 'MTrk': {
                        const track = new MidiTrack(dataView, chunkDataStartOffset, chunkLength);
                        this.tracks.push(track);
                        this.chunks.push(track);
                        break;
                    }

                    default:
                        // Unrecognized chunk, skip
                        break;
                }
                currentPos += chunkLength;
            }
        } catch (error) {
            if (error instanceof RangeError) {
                throw new Error('The MIDI file is truncated or corrupt.', { cause: error });
            }
            throw error;
        }

        this.resolveEventTimes();
        this.midiStats = this.collectStats();
    }

    /** Converts the tick position of every event to seconds, using the file's tempo map. */
    private resolveEventTimes() {
        const header = this.getHeader();

        if (header.timingScheme === MidiTimingScheme.timecode) {
            // Ticks have a fixed duration; tempo events do not apply. 29 means 29.97 (drop frame).
            const fps = header.framesPerSecond === 29 ? 29.97 : (header.framesPerSecond || 0);
            const ticksPerSecond = fps * (header.subFrameResolution || 0);
            if (ticksPerSecond <= 0) {
                throw new Error('Invalid MIDI timecode division.');
            }
            this.tracks.forEach(track => track.events.forEach(event => {
                event.absTimeSeconds = event.absTicks / ticksPerSecond;
            }));
            return;
        }

        const ppqn = header.pulsesPerQuarterNote || 0;
        if (ppqn <= 0) {
            throw new Error('Invalid MIDI division: 0 ticks per quarter note.');
        }

        if (header.fileFormat === MidiFileFormat.Type2) {
            // Type 2: every track is an independent sequence with its own tempo.
            this.tracks.forEach(track => {
                const tempoMap = buildTempoMap(track.events.filter(isTempoEvent), ppqn);
                track.events.forEach(event => {
                    event.absTimeSeconds = ticksToSeconds(event.absTicks, tempoMap);
                });
            });
            return;
        }

        // Type 0/1: tempo events (normally in the first track) apply to every track.
        const tempoEvents: MetaMidiEvent[] = [];
        this.tracks.forEach(track => tempoEvents.push(...track.events.filter(isTempoEvent)));
        const tempoMap = buildTempoMap(tempoEvents, ppqn);

        this.tracks.forEach(track => track.events.forEach(event => {
            event.absTimeSeconds = ticksToSeconds(event.absTicks, tempoMap);
        }));
    }

    private collectStats(): IMidiStats {
        const stats = this.getInitialMidiStats();
        const ppqn = this.header && this.header.pulsesPerQuarterNote;

        this.tracks.forEach(track => track.events.forEach(event => {
            if (isTempoEvent(event) && ppqn) {
                const secondsPerTick = (event.microsecondsPerQuarterNote as number) / (1000000 * ppqn);
                stats.tempos.push(60 / (secondsPerTick * ppqn));
                stats.secondsPerTickValues.push(secondsPerTick);
            }

            if (isNoteStart(event)) {
                const currentCount = stats.noteHistogram.get(event.note) || 0;
                stats.noteHistogram.set(event.note, currentCount + 1);

                if (event.absTimeSeconds > stats.lastNoteOnEventInSeconds) {
                    stats.lastNoteOnEventInSeconds = event.absTimeSeconds;
                }

                if (event.note > stats.highNote || stats.highNote === MidiNote.None) {
                    stats.highNote = event.note;
                }

                if (event.note < stats.lowNote || stats.lowNote === MidiNote.None) {
                    stats.lowNote = event.note;
                }
            }
        }));

        return stats;
    }

    public getHeader(): MidiHeader {
        // TODO clean up public props
        if (this.header) {
            return this.header;
        }

        throw new Error('No header found!');
    }

    public getTracks(): MidiTrack[] {
        // TODO clean up public props
        return this.tracks;
    }

    private getInitialMidiStats(): IMidiStats {
        return {
            noteHistogram: new Map<MidiNote, number>(),
            highNote: MidiNote.None,
            lowNote: MidiNote.None,
            lastNoteOnEventInSeconds: 0,
            tempos: [],
            secondsPerTickValues: []
        };
    }
}

/**
 * True for events that start a note: Note On with a velocity above 0.
 * (A Note On with velocity 0 is, by the MIDI standard, a Note Off.)
 */
export function isNoteStart(event: IMidiEvent): event is NoteMidiEvent {
    return event instanceof NoteMidiEvent
        && event.channelMessageType === ChannelMessageType.NoteOn
        && event.velocity > 0;
}

/** True for events that end a note: Note Off, or Note On with velocity 0. */
export function isNoteEnd(event: IMidiEvent): event is NoteMidiEvent {
    return event instanceof NoteMidiEvent && (
        event.channelMessageType === ChannelMessageType.NoteOff ||
        (event.channelMessageType === ChannelMessageType.NoteOn && event.velocity === 0));
}

function getStringFromBuffer(buffer: ArrayBuffer, start: number, end: number): string {
    const slice = buffer.slice(start, end);
    return String.fromCharCode.apply(null, Array.from(new Uint8Array(slice)));
}