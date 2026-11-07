import "./DxfPreview.css";

import * as React from "react";
import { Callout, Intent } from "@blueprintjs/core";
import { IMusicBoxLayout } from "../utilities/MusicBoxLayout";
import { IDxfDrawing, parseDxf } from "../utilities/DxfReader";

/** The strips to cut: the layout and the DXF document of every sheet (what gets downloaded). */
export interface IStripFiles {
  layout?: IMusicBoxLayout;
  dxfs?: string[];
  error?: string;
}

export interface IDxfPreviewProps {
  files: IStripFiles;
  paperWidthMm: number;
}

const STROKE_WIDTH_MM = 0.25;

/**
 * Preview of the strips, drawn from the DXF documents themselves: what is shown is exactly the
 * content of the files that are downloaded.
 */
export default class DxfPreview extends React.Component<IDxfPreviewProps> {
  private cachedDxfs?: string[];
  private cachedDrawings: Array<IDxfDrawing | Error> = [];

  public render() {
    const { layout, dxfs, error } = this.props.files;

    if (error || !layout || !dxfs) {
      return (
        <Callout intent={Intent.DANGER}>
          <p>Error encountered</p>
          <p>{error}</p>
        </Callout>
      );
    }

    const hasWarnings = layout.messages.some((m) => m.level === "warning");
    const drawings = this.getDrawings(dxfs);

    return (
      <>
        <Callout intent={hasWarnings ? Intent.WARNING : Intent.SUCCESS}>
          {layout.messages.map((message, i) => (
            <p key={i}>{message.text}</p>
          ))}
          <p>
            Total paper length: {layout.totalPaperLengthMm.toFixed(2)} mm,
            width: {this.props.paperWidthMm} mm
          </p>
        </Callout>
        <div className="mb-musicBoxSvgPages">
          {drawings.map((drawing, index) => (
            <div className="mb-musicBoxSvgWrapper" key={index}>
              {drawing instanceof Error ? (
                <Callout intent={Intent.DANGER}>
                  Sheet {index + 1}: {drawing.message}
                </Callout>
              ) : (
                <DxfDrawingSvg drawing={drawing} />
              )}
            </div>
          ))}
        </div>
      </>
    );
  }

  /** Parsing is only repeated when the DXF documents change. */
  private getDrawings(dxfs: string[]): Array<IDxfDrawing | Error> {
    if (this.cachedDxfs !== dxfs) {
      this.cachedDxfs = dxfs;
      this.cachedDrawings = dxfs.map((dxf) => {
        try {
          return parseDxf(dxf);
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      });
    }
    return this.cachedDrawings;
  }
}

/** Draws one DXF sheet, in millimeters. */
export function DxfDrawingSvg(props: { drawing: IDxfDrawing }) {
  const { drawing } = props;
  const w = drawing.widthMm;
  const h = drawing.heightMm;

  return (
    <svg
      width={w + "mm"}
      height={h + "mm"}
      viewBox={`0 0 ${w} ${h}`}
      xmlns={"http://www.w3.org/2000/svg"}
    >
      <g>
        {drawing.lines.map((line, i) => (
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
        {drawing.circles.map((circle, i) => (
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
    </svg>
  );
}
