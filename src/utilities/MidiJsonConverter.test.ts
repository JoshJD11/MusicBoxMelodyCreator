import MidiFile from '../model/MidiFile';
import MidiJsonConverter from './MidiJsonConverter';
import { buildMidi, endOfTrack, noteOff, noteOn } from '../testUtils/midiBuilder';

describe('MidiJsonConverter', () => {
    it('shows enums as names and the note histogram as an object', () => {
        const midiFile = new MidiFile();
        midiFile.loadFromBuffer(buildMidi({ tracks: [[noteOn(0, 60), noteOff(480, 60), noteOn(0, 62), endOfTrack()]] }));
        const json = JSON.parse(MidiJsonConverter.GetJson(midiFile));

        expect(json.midiStats.noteHistogram).toEqual({ C4: 1, D4: 1 });
        expect(json.midiStats.lowNote).toBe('C4');
        expect(json.midiStats.highNote).toBe('D4');
        expect(json.tracks[0].events[0].note).toBe('C4');
        expect(json.tracks[0].events[0].channelMessageType).toBe('NoteOn');
        expect(json.header).toBeUndefined();
    });
});
