import MidiFile, { MidiTimingScheme, MidiFileFormat } from '../model/MidiFile';
import { ChannelMessageType } from '../model/MidiEvents';
import { MidiNote } from '../model/MidiConstants';

export default class MidiJsonConverter {
    public static GetJson(midiFile: MidiFile): string {
        return JSON.stringify(midiFile, prettyPrintReplacer, 4);
    }
}

/**
 * Used to hide some properties, and to make others more readable (e.g., enums as strings)
 */
function prettyPrintReplacer(key: string, value: unknown) {
    switch (key) {
        // Timing data is exposed as parsed properties, no need to output raw ArrayBuffer
        case 'rawTimingData':
            return undefined;

        // Avoid serializing header references for now. More interested in tracks
        case 'header':
            return undefined;

        case 'chunks':
            return undefined;

        case 'timingScheme':
            return MidiTimingScheme[value as MidiTimingScheme];

        case 'fileFormat':
            return MidiFileFormat[value as MidiFileFormat];

        case 'channelMessageType':
            return ChannelMessageType[value as ChannelMessageType];

        case 'note':
            return MidiNote[value as MidiNote];

        // Maps are not serialized by JSON.stringify: show them as { note: count }
        case 'noteHistogram':
            return Array.from((value as Map<MidiNote, number>).entries())
                .reduce((obj, [note, count]) => ({ ...obj, [MidiNote[note]]: count }), {});

        case 'highNote':
        case 'lowNote':
            return MidiNote[value as MidiNote];

        default:
            return value;
    }
}