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
  /**
   * Limits the height of the preview, which then scrolls on its own (long vertical strips would
   * otherwise make the page very long).
   */
  limitHeight?: boolean;
}

const STROKE_WIDTH_MM = 0.25;

/**
 * Faint dashed outline of the sheet. It is not part of the DXF: it only shows on screen where the
 * strips are on the sheet (as in Silhouette Studio), so that a centered sheet looks centered.
 */
const SHEET_OUTLINE_COLOR = "#c8c8b8";
const SHEET_OUTLINE_DASH = "2 1.5";

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
        <div
          className={
            this.props.limitHeight
              ? "mb-musicBoxSvgPages mb-musicBoxSvgPages-limited"
              : "mb-musicBoxSvgPages"
          }
        >
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

/** Draws one DXF sheet, in millimeters, on its (screen only) sheet outline. */
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
      <rect
        className="mb-sheetOutline"
        x={0}
        y={0}
        width={w}
        height={h}
        fill="none"
        stroke={SHEET_OUTLINE_COLOR}
        strokeWidth={STROKE_WIDTH_MM}
        strokeDasharray={SHEET_OUTLINE_DASH}
      />
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
