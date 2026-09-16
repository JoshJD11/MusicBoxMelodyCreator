import fs from 'fs';
import path from 'path';
import MidiFile from '../model/MidiFile';
import { BuiltInProfiles } from '../model/IMusicBoxProfile';
import { buildGeneratedMusicBoxSequence, exportGeneratedMusicBoxMidi } from './MusicBoxMidi';

describe('music box MIDI generation', () => {
    it('builds a piano-friendly sequence for the selected profile and exports MIDI data', async () => {
        const buffer = fs.readFileSync(path.resolve(__dirname, '../../samples/c4-octave.mid'));
        const midiFile = new MidiFile();
        midiFile.loadFromBuffer(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

        const profile = BuiltInProfiles['thirtyNote'];
        const sequence = buildGeneratedMusicBoxSequence(midiFile, profile, true);

        expect(sequence.length).toBeGreaterThan(0);
        expect(sequence.every((event) => profile.supportedNotes.includes(event.note))).toBe(true);

        const exported = exportGeneratedMusicBoxMidi(sequence, { tempoBpm: 120 });
        const exportedBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (reader.result instanceof ArrayBuffer) {
                    resolve(reader.result);
                    return;
                }
                reject(new Error('Blob did not resolve to ArrayBuffer'));
            };
            reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
            reader.readAsArrayBuffer(exported);
        });
        const bytes = new Uint8Array(exportedBuffer);

        expect(exported.size).toBeGreaterThan(0);
        expect(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.slice(0, 4)))).toBe('MThd');
        expect(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.slice(14, 18)))).toBe('MTrk');
        expect(new DataView(exportedBuffer).getUint32(18, false)).toBeGreaterThan(0);
        expect(Array.prototype.slice.call(bytes.slice(8, 10))).toEqual([0x00, 0x00]);
        expect(Array.prototype.slice.call(bytes.slice(10, 12))).toEqual([0x00, 0x01]);
        expect(Array.prototype.slice.call(bytes.slice(12, 14))).toEqual([0x01, 0xe0]);
    });
});
