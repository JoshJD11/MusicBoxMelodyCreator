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
} from "@blueprintjs/core";
import {
  IMusicBoxSvgFormatOptions,
  validateFormatOptions,
} from "../model/IMusicBoxSvgFormatOptions";
import { shallowEqual } from "../utilities/shallowEqual";
import { UnappliedChanges } from "./UnappliedChanges";

export interface IMusicBoxSvgFormatEditorProps {
  options: IMusicBoxSvgFormatOptions;
  onChange(options: IMusicBoxSvgFormatOptions): void;
  /** Called when the edited values start or stop differing from the applied ones. */
  onDirtyChange?(dirty: boolean): void;
}

export function MusicBoxSvgFormatEditor(props: IMusicBoxSvgFormatEditorProps) {
  const [options, setOptions] = useState(props.options);
  const errors = validateFormatOptions(options);
  const dirty = !shallowEqual(options, props.options);
  const { onDirtyChange } = props;

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
          <Label>
            Max strip length / sheet width (mm)
            <NumericInput
              min={0}
              value={options.pageWidthMm}
              onValueChange={(num) => {
                setOptions({ ...options, pageWidthMm: num });
              }}
            />
          </Label>
          <Label>
            Sheet height (mm)
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
            label={"Mirror strips vertically (no need to flip in Silhouette)"}
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
            <p>Strips are drawn horizontally, one per row.</p>
            <p>Set a size to 0 for no limit.</p>
            <p>A4 landscape: 297 x 210 mm</p>
            <p>Letter landscape: 279 x 216 mm</p>
          </Callout>
        </div>
      </div>
    </Card>
  );
}
