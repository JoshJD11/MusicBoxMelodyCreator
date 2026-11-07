import './Common.css';
import { IMusicBoxProfile, BuiltInProfiles, validateMusicBoxProfile } from '../model/IMusicBoxProfile';
import React, { useState } from 'react';
import { Card, NumericInput, Button, Label, H4, Callout, Menu, MenuItem, Popover, Position, Intent } from '@blueprintjs/core';
import { MidiNote } from '../model/MidiConstants';

export interface IMusicBoxProfileEditorProps {
    profile: IMusicBoxProfile;
    onChange(profile: IMusicBoxProfile): void;
}

export function MusicBoxProfileEditor(props: IMusicBoxProfileEditorProps) {
    const [profile, setProfile] = useState(props.profile);
    const errors = validateMusicBoxProfile(profile);

    const onApplyProfile = () => {
        if (errors.length === 0 && props.onChange) {
            props.onChange(profile);
        }
    }

    const onSelectProfile = (profileKey: string) => {
        const newProfile = { ...BuiltInProfiles[profileKey] };
        setProfile(newProfile);
        if (props.onChange) {
            props.onChange(newProfile);
        }
    }

    const menuItems: JSX.Element[] = [];
    for (const profileKey in BuiltInProfiles) {
        menuItems.push(
            <MenuItem key={profileKey} text={BuiltInProfiles[profileKey].name} onClick={() => onSelectProfile(profileKey)} />);
    }

    const profileSelectionMenu = <Menu>{menuItems} </Menu>;
    const profileSelectionPopOver =
        <Popover content={profileSelectionMenu} position={Position.BOTTOM}>
            <Button icon="document-open" text="Select profile..." />
        </Popover>;

    return (
        <Card className={'mb-MusicBoxProfileEditor'}>
            <H4><span>{profileSelectionPopOver} Music Box Profile: {profile.name}</span></H4>
            <div className={'mb-settingLayout'}>
                <div className={'mb-settingGroup'}>
                    <Label>
                        Paper width (mm)
                        <NumericInput
                            min={0}
                            value={profile.paperWidthMm}
                            onValueChange={(num) => { setProfile({ ...profile, paperWidthMm: num }) }} />
                    </Label>
                    <Label>
                        Content width (mm)
                        <NumericInput
                            min={0}
                            value={profile.contentWidthMm}
                            onValueChange={(num) => { setProfile({ ...profile, contentWidthMm: num }) }} />
                    </Label>
                    <Label>
                        Minimum Note Gap (mm)
                        <NumericInput
                            min={0}
                            value={profile.minNoteGapMm}
                            onValueChange={(num) => { setProfile({ ...profile, minNoteGapMm: num }) }} />
                    </Label>
                </div>
                <div className={'mb-settingGroup'}>
                    <Label>
                        Millimeters per second
                        <NumericInput
                            min={0}
                            value={profile.millimetersPerSecond}
                            onValueChange={(num) => { setProfile({ ...profile, millimetersPerSecond: num }) }} />
                    </Label>
                    <Label>
                        Hole diameter (mm)
                        <NumericInput
                            min={0}
                            value={profile.holeDiameterMm}
                            onValueChange={(num) => { setProfile({ ...profile, holeDiameterMm: num }) }} />
                    </Label>
                    <Button intent={Intent.PRIMARY} disabled={errors.length > 0} onClick={onApplyProfile}>Apply</Button>
                </div>
                {errors.length > 0 && (
                    <div className={'mb-settingGroup'}>
                        <Callout intent={Intent.DANGER}>
                            {errors.map((error, i) => <p key={i}>{error}</p>)}
                        </Callout>
                    </div>
                )}
                <div className={'mb-settingGroup'}>
                    <Callout>
                        Supported Notes: {profile.supportedNotes.map(x => MidiNote[x].replace('s', '#')).join(', ')}
                    </Callout>
                </div>
            </div>
        </Card>
    );
}