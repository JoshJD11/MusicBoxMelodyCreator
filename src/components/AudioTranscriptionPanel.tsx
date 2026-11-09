import './AudioTranscriptionPanel.css';
import React, { useEffect, useState } from 'react';
import { Button, Callout, H5, Intent, Slider } from '@blueprintjs/core';
import {
    AUDIO_TRANSCRIPTION_LIMITS,
    DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS,
    IAudioTranscriptionSettings,
    isDefaultTranscriptionSettings,
    minNoteLengthMs,
} from '../utilities/AudioTranscription';

/** Why MP3 is experimental, what input works best, and that a MIDI file is preferable. */
export function ExperimentalAudioNotice() {
    return (
        <Callout intent={Intent.WARNING} icon="lab-test" title="MP3 support is experimental" className="mb-audioNotice">
            <p>
                The notes are detected automatically from the audio (with Spotify&apos;s Basic Pitch), so some
                can be missing, some can be extra (false notes, such as a note that was still ringing or the
                octave of a real one) and a few can be slightly early or late. Check the preview and listen to
                the piano before cutting.
            </p>
            <p>
                <strong>A MIDI file is always preferable</strong>: it contains exactly the notes of the song.
                If you only have audio, a melody played on piano or a similar single instrument (no voice, no
                drums, no accompaniment) gives the most precise result.
            </p>
        </Callout>
    );
}

export interface IAudioTranscriptionPanelProps {
    settings: IAudioTranscriptionSettings;
    /** Notes detected with the current settings. */
    noteCount: number;
    /** Silence removed before the first note. */
    trimmedSeconds: number;
    /** Called when a slider is released (or reset): the notes are detected again. */
    onChange(settings: IAudioTranscriptionSettings): void;
}

type SettingKey = keyof IAudioTranscriptionSettings;

function roundToStep(key: SettingKey, value: number): number {
    const { min, max, step } = AUDIO_TRANSCRIPTION_LIMITS[key];
    const rounded = Math.round((value - min) / step) * step + min;
    return Number(Math.min(max, Math.max(min, rounded)).toFixed(2));
}

const formatMs = (frames: number) => `${Math.round(minNoteLengthMs(frames))} ms`;
const formatThreshold = (value: number) => value.toFixed(2);

const SLIDERS: { key: SettingKey; label: string; hint: string; format(value: number): string }[] = [
    {
        key: 'onsetThreshold',
        label: 'Note segmentation',
        hint: 'How clear the attack of a note must be. Higher: fewer false notes, but soft notes can be missed. Lower: more notes.',
        format: formatThreshold,
    },
    {
        key: 'frameThreshold',
        label: 'Model confidence',
        hint: 'How sure the model must be that a note is sounding. Higher: fewer false notes. Lower: more notes, and more false ones.',
        format: formatThreshold,
    },
    {
        key: 'minNoteLengthFrames',
        label: 'Minimum note length',
        hint: 'Shorter notes are ignored. Higher: drops short blips. Lower: keeps very short notes.',
        format: formatMs,
    },
];

/**
 * Sliders for the sensitivity of the MP3 note detection. The edited values are applied when a
 * slider is released, so that the notes are not detected again on every pixel of a drag.
 */
export function AudioTranscriptionPanel(props: IAudioTranscriptionPanelProps) {
    const [draft, setDraft] = useState(props.settings);
    useEffect(() => setDraft(props.settings), [props.settings]);

    const apply = (settings: IAudioTranscriptionSettings) => {
        const changed = (Object.keys(settings) as SettingKey[]).some(key => settings[key] !== props.settings[key]);
        if (changed) {
            props.onChange(settings);
        }
    };

    return (
        <div className="mb-audioTranscription">
            <ExperimentalAudioNotice />
            <H5>Note detection sensitivity</H5>
            <p className="mb-audioTranscription-summary">
                <strong>{props.noteCount} notes detected.</strong> The default values gave the most precise
                strips in our tests: change them only if notes are missing or there are false ones.
            </p>
            {props.trimmedSeconds >= 0.005 && (
                <p className="mb-audioTranscription-trimmed">
                    The {props.trimmedSeconds.toFixed(2)} s of silence before the first note were removed, so
                    the strip doesn&apos;t start with blank paper.
                </p>
            )}
            {SLIDERS.map(({ key, label, hint, format }) => {
                const limits = AUDIO_TRANSCRIPTION_LIMITS[key];
                return (
                    <div key={key} className="mb-audioSlider" data-setting={key}>
                        <div className="mb-audioSlider-heading">
                            <span>{label}</span>
                            <span className="mb-audioSlider-value">
                                {format(draft[key])}
                                {draft[key] === DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS[key] ? ' (default)' : ''}
                            </span>
                        </div>
                        <div className="mb-audioSlider-track">
                            {/* The value is shown in the heading: no floating labels, which wrap on phones. */}
                            <Slider
                                min={limits.min}
                                max={limits.max}
                                stepSize={limits.step}
                                labelRenderer={false}
                                value={draft[key]}
                                onChange={(value) => setDraft(current => ({ ...current, [key]: roundToStep(key, value) }))}
                                onRelease={(value) => apply({ ...draft, [key]: roundToStep(key, value) })}
                            />
                        </div>
                        <div className="mb-audioSlider-range" aria-hidden="true">
                            <span>{format(limits.min)}</span>
                            <span>{format(limits.max)}</span>
                        </div>
                        <p className="mb-audioSlider-hint">{hint}</p>
                    </div>
                );
            })}
            <Button
                icon="reset"
                text="Reset to defaults"
                disabled={isDefaultTranscriptionSettings(draft) && isDefaultTranscriptionSettings(props.settings)}
                onClick={() => {
                    setDraft({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS });
                    apply({ ...DEFAULT_AUDIO_TRANSCRIPTION_SETTINGS });
                }}
            />
        </div>
    );
}
