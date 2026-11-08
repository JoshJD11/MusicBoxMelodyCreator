import "./Common.css";
import React, { useEffect, useState } from "react";
import {
  Card,
  NumericInput,
  Button,
  Label,
  H4,
  Checkbox,
  Callout,
  Intent,
  Radio,
  RadioGroup,
} from "@blueprintjs/core";
import {
  IMusicBoxSvgFormatOptions,
  isStripOrientation,
  StripOrientation,
  validateFormatOptions,
} from "../model/IMusicBoxSvgFormatOptions";
import { shallowEqual } from "../utilities/shallowEqual";
import { rebaseEdits } from "../utilities/rebaseEdits";
import { UnappliedChanges } from "./UnappliedChanges";

export interface IMusicBoxSvgFormatEditorProps {
  options: IMusicBoxSvgFormatOptions;
  onChange(options: IMusicBoxSvgFormatOptions): void;
  /** Called when the edited values start or stop differing from the applied ones. */
  onDirtyChange?(dirty: boolean): void;
}

/** Texts that depend on the strip orientation (the fields keep their meaning in both). */
const ORIENTATION_TEXTS: Record<
  StripOrientation,
  { stripLength: string; across: string; mirror: string; hints: string[] }
> = {
  horizontal: {
    stripLength: "Max strip length / sheet width (mm)",
    across: "Sheet height (mm)",
    mirror: "Mirror strips (lowest note at the top)",
    hints: [
      "Strips are drawn horizontally, one per row: the song starts on the left and the highest note is at the top.",
      "Set a size to 0 for no limit.",
      "A4 landscape: 297 x 210 mm",
      "Letter landscape: 279 x 216 mm",
    ],
  },
  vertical: {
    stripLength: "Max strip length / sheet height (mm)",
    across: "Sheet width (mm)",
    mirror: "Mirror strips (lowest note on the right)",
    hints: [
      "Strips are rotated 90° clockwise, one per column (the first one on the left): the song starts at the top and the highest note is on the right.",
      "Set a size to 0 for no limit.",
      "A4 portrait: strip length 297, sheet width 210 mm",
      "Letter portrait: strip length 279, sheet width 216 mm",
    ],
  },
};

export function MusicBoxSvgFormatEditor(props: IMusicBoxSvgFormatEditorProps) {
  const [options, setOptions] = useState(props.options);
  // When the applied options change from outside (e.g. the sizes fitted to a newly loaded MIDI
  // file), the changed fields show their new values and the other unapplied edits are kept.
  const [appliedOptions, setAppliedOptions] = useState(props.options);
  if (appliedOptions !== props.options) {
    setAppliedOptions(props.options);
    setOptions(rebaseEdits(options, appliedOptions, props.options));
  }
  const errors = validateFormatOptions(options);
  const dirty = !shallowEqual(options, props.options);
  const { onDirtyChange } = props;
  const orientation = options.stripOrientation ?? "horizontal";
  const texts = ORIENTATION_TEXTS[orientation];

  useEffect(() => {
    if (onDirtyChange) {
      onDirtyChange(dirty);
    }
  }, [dirty, onDirtyChange]);

  const onApplyChanges = () => {
    if (errors.length === 0 && props.onChange) {
      props.onChange(options);
    }
  };

  return (
    <Card>
      <H4>
        <span>Layout Options</span>
      </H4>
      {dirty && (
        <UnappliedChanges
          canApply={errors.length === 0}
          onApply={onApplyChanges}
          onDiscard={() => setOptions(props.options)}
        />
      )}
      <div className={"mb-settingLayout"}>
        <div className={"mb-settingGroup"}>
          <RadioGroup
            label="Strip orientation"
            inline={true}
            selectedValue={orientation}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (isStripOrientation(value)) {
                setOptions({ ...options, stripOrientation: value });
              }
            }}
          >
            <Radio label="Horizontal (rows)" value="horizontal" />
            <Radio label="Vertical (columns, rotated 90° clockwise)" value="vertical" />
          </RadioGroup>
          <Label>
            {texts.stripLength}
            <NumericInput
              min={0}
              value={options.pageWidthMm}
              onValueChange={(num) => {
                setOptions({ ...options, pageWidthMm: num });
              }}
            />
          </Label>
          <Label>
            {texts.across}
            <NumericInput
              min={0}
              value={options.pageHeightMm}
              onValueChange={(num) => {
                setOptions({ ...options, pageHeightMm: num });
              }}
            />
          </Label>
          <Label>
            Start padding (mm)
            <NumericInput
              min={0}
              value={options.startPaddingMm}
              onValueChange={(num) => {
                setOptions({ ...options, startPaddingMm: num });
              }}
            />
          </Label>
          <Button
            intent={Intent.PRIMARY}
            disabled={errors.length > 0}
            onClick={onApplyChanges}
          >
            Apply
          </Button>
          {errors.length > 0 && (
            <Callout intent={Intent.DANGER}>
              {errors.map((error, i) => (
                <p key={i}>{error}</p>
              ))}
            </Callout>
          )}
        </div>
        <div className={"mb-settingGroup"}>
          <Checkbox
            checked={options.renderBorder}
            label={"Render border"}
            onChange={() => {
              setOptions({ ...options, renderBorder: !options.renderBorder });
            }}
          />
          <Checkbox
            checked={options.omitPageBoundaries}
            label={"Omit page boundaries"}
            onChange={() => {
              setOptions({
                ...options,
                omitPageBoundaries: !options.omitPageBoundaries,
              });
            }}
          />
          <Checkbox
            checked={options.transposeOutOfRangeNotes}
            label={"Transpose out of range notes"}
            onChange={() => {
              setOptions({
                ...options,
                transposeOutOfRangeNotes: !options.transposeOutOfRangeNotes,
              });
            }}
          />
          <Checkbox
            checked={!!options.includePercussion}
            label={"Include percussion (MIDI channel 10)"}
            onChange={() => {
              setOptions({
                ...options,
                includePercussion: !options.includePercussion,
              });
            }}
          />
          <Checkbox
            checked={options.loopMode}
            label={"Loop mode"}
            onChange={() => {
              setOptions({ ...options, loopMode: !options.loopMode });
            }}
          />
          <Checkbox
            checked={!!options.mirrorVertically}
            label={texts.mirror}
            onChange={() => {
              setOptions({
                ...options,
                mirrorVertically: !options.mirrorVertically,
              });
            }}
          />
          <Checkbox
            checked={options.jigsawJoiners}
            label={"Experimental: jigsaw joiners"}
            onChange={() => {
              setOptions({
                ...options,
                jigsawJoiners: !options.jigsawJoiners,
              });
            }}
          />
          <Callout>
            {texts.hints.map((hint) => (
              <p key={hint}>{hint}</p>
            ))}
          </Callout>
        </div>
      </div>
    </Card>
  );
}
