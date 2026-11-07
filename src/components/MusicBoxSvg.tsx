import "./MusicBoxSvg.css";

import * as React from "react";
import { Callout, Intent } from "@blueprintjs/core";
import MidiFile from "../model/MidiFile";
import { IMusicBoxProfile } from "../model/IMusicBoxProfile";
import { IMusicBoxSvgFormatOptions } from "../model/IMusicBoxSvgFormatOptions";
import { TrackSelection } from "../utilities/MusicBoxNotes";
import {
  computeMusicBoxLayout,
  IMusicBoxLayout,
  ISheet,
} from "../utilities/MusicBoxLayout";

export interface IMusicBoxSvgProps {
  midiFile: MidiFile;

  /**
   * Profile of the music box for which to generate SVG.
   */
  musicBoxProfile: IMusicBoxProfile;

  /**
   * Options for pagination and formatting of generated layout.
   */
  formatting: IMusicBoxSvgFormatOptions;

  /** Tracks of the MIDI file to use. Defaults to `'auto'`. */
  trackSelection?: TrackSelection;
}

const STROKE_WIDTH_MM = 0.25;

type LayoutResult =
  | { layout: IMusicBoxLayout; error?: undefined }
  | { layout?: undefined; error: string };

/** Preview of the generated music box strips, one SVG per sheet. */
export default class MusicBoxSvg extends React.Component<IMusicBoxSvgProps> {
  private cachedInputs?: IMusicBoxSvgProps;
  private cachedResult?: LayoutResult;

  public render() {
    const result = this.getLayout();

    if (!result.layout) {
      return (
        <Callout intent={Intent.DANGER}>
          <p>Error encountered</p>
          <p>{result.error}</p>
        </Callout>
      );
    }

    const layout = result.layout;
    const hasWarnings = layout.messages.some((m) => m.level === "warning");

    return (
      <>
        <Callout intent={hasWarnings ? Intent.WARNING : Intent.SUCCESS}>
          {layout.messages.map((message, i) => (
            <p key={i}>{message.text}</p>
          ))}
          <p>
            Total paper length: {layout.totalPaperLengthMm.toFixed(2)} mm,
            width: {this.props.musicBoxProfile.paperWidthMm} mm
          </p>
        </Callout>
        <div className="mb-musicBoxSvgPages">
          {layout.sheets.map((sheet, index) => (
            <div className="mb-musicBoxSvgWrapper" key={index}>
              <SheetSvg sheet={sheet} />
            </div>
          ))}
        </div>
      </>
    );
  }

  /** The layout is only recomputed when an input changes. */
  private getLayout(): LayoutResult {
    const p = this.props;
    const c = this.cachedInputs;
    if (
      this.cachedResult &&
      c &&
      c.midiFile === p.midiFile &&
      c.musicBoxProfile === p.musicBoxProfile &&
      c.formatting === p.formatting &&
      c.trackSelection === p.trackSelection
    ) {
      return this.cachedResult;
    }

    let result: LayoutResult;
    try {
      result = {
        layout: computeMusicBoxLayout(
          p.midiFile,
          p.musicBoxProfile,
          p.formatting,
          p.trackSelection
        ),
      };
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.cachedInputs = p;
    this.cachedResult = result;
    return result;
  }
}

/** One sheet (page) with its strips, in millimeters. */
export function SheetSvg(props: { sheet: ISheet }) {
  const { sheet } = props;
  const w = sheet.widthMm;
  const h = sheet.heightMm;

  return (
    <svg
      width={w + "mm"}
      height={h + "mm"}
      viewBox={`0 0 ${w} ${h}`}
      // Namespace required to tell browsers to render downloaded files instead of displaying xml.
      xmlns={"http://www.w3.org/2000/svg"}
    >
      {sheet.strips.map((strip, n) => (
        <g key={n} transform={"translate(0 " + strip.offsetYMm + ")"}>
          <g>
            {strip.geometry.lines.map((line, i) => (
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke="black"
                strokeWidth={STROKE_WIDTH_MM}
              />
            ))}
          </g>
          <g>
            {strip.geometry.circles.map((circle, i) => (
              <circle
                key={i}
                cx={circle.cx}
                cy={circle.cy}
                r={circle.r}
                fill={"none"}
                stroke={"black"}
                strokeWidth={STROKE_WIDTH_MM}
              />
            ))}
          </g>
        </g>
      ))}
    </svg>
  );
}
