import "./DxfPreview.css";

import * as React from "react";
import { Callout, Intent } from "@blueprintjs/core";
import { ICircle, IMusicBoxLayout } from "../utilities/MusicBoxLayout";
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
  /** Holes shown as selected (note ids, see `IMusicBoxNote.id`). */
  selectedHoleIds?: ReadonlySet<string>;
  /** Makes the holes selectable: called with the note id of the hole clicked or tapped. */
  onHoleClick?(noteId: string): void;
  /** Shown above the sheets, and below the error when they can't be drawn. */
  toolbar?: React.ReactNode;
}

const STROKE_WIDTH_MM = 0.25;

/**
 * How far from the edge of a hole a click still selects it, in mm (holes are only 2-2.2 mm wide).
 * When several holes are that close, the nearest one is picked.
 */
export const HOLE_HIT_MARGIN_MM = 1.2;

/** The same for a finger on a touch screen, less precise than a mouse. */
export const HOLE_TOUCH_MARGIN_MM = 2.5;

/** Gap between a hole and the ring drawn around it when it is hovered or selected, in mm. */
const HOLE_RING_GAP_MM = 0.7;

/**
 * Preview of the strips, drawn from the DXF documents themselves: what is shown is exactly the
 * content of the files that are downloaded. The only additions are the highlights of the holes
 * under the pointer or selected, which are not part of the sheet.
 */
export default class DxfPreview extends React.Component<IDxfPreviewProps> {
  private cachedDxfs?: string[];
  private cachedDrawings: Array<IDxfDrawing | Error> = [];
  private cachedLayout?: IMusicBoxLayout;
  private cachedHoleIds: string[][] = [];

  public render() {
    const { layout, dxfs, error } = this.props.files;

    if (error || !layout || !dxfs) {
      return (
        <>
          <Callout intent={Intent.DANGER}>
            <p>Error encountered</p>
            <p>{error}</p>
          </Callout>
          {this.props.toolbar}
        </>
      );
    }

    const hasWarnings = layout.messages.some((m) => m.level === "warning");
    const drawings = this.getDrawings(dxfs);
    const holeIds = this.getHoleIds(layout);

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
        {this.props.toolbar}
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
                <DxfDrawingSvg
                  drawing={drawing}
                  holeIds={holeIds[index]}
                  selectedHoleIds={this.props.selectedHoleIds}
                  onHoleClick={this.props.onHoleClick}
                />
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

  /** For every sheet, the note id of each hole (in the order of its circles). */
  private getHoleIds(layout: IMusicBoxLayout): string[][] {
    if (this.cachedLayout !== layout) {
      this.cachedLayout = layout;
      this.cachedHoleIds = (layout.holeNotes || []).map((notes) => notes.map((note) => note.id));
    }
    return this.cachedHoleIds;
  }
}

/**
 * Index of the hole nearest to the point (x, y) (sheet mm), among those whose edge is at most
 * `marginMm` away; null if there is none.
 */
export function findHoleAt(circles: ICircle[], x: number, y: number, marginMm = HOLE_HIT_MARGIN_MM): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  circles.forEach((circle, i) => {
    const distance = Math.hypot(circle.cx - x, circle.cy - y);
    if (distance <= circle.r + marginMm && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

export interface IDxfDrawingSvgProps {
  drawing: IDxfDrawing;
  /** Note id of every circle of the drawing, in order. */
  holeIds?: string[];
  selectedHoleIds?: ReadonlySet<string>;
  /**
   * Makes the holes selectable (only if `holeIds` has one id per circle): a hole is ringed when
   * the mouse is over it, and a click or tap reports its note id.
   */
  onHoleClick?(noteId: string): void;
}

/** Draws one DXF sheet, in millimeters. */
export function DxfDrawingSvg(props: IDxfDrawingSvgProps) {
  const { drawing, holeIds, selectedHoleIds, onHoleClick } = props;
  const w = drawing.widthMm;
  const h = drawing.heightMm;
  const svgRef = React.useRef<SVGSVGElement>(null);
  // Whether the last press was a finger: its click gets a wider margin.
  const touchPress = React.useRef(false);
  // An id rather than an index: once that hole is deleted, nothing stays ringed.
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const editable = !!onHoleClick && !!holeIds && holeIds.length === drawing.circles.length;

  const holeAt = (clientX: number, clientY: number, marginMm = HOLE_HIT_MARGIN_MM): string | null => {
    const svg = svgRef.current;
    if (!svg || !holeIds) {
      return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const index = findHoleAt(
      drawing.circles,
      ((clientX - rect.left) * w) / rect.width,
      ((clientY - rect.top) * h) / rect.height,
      marginMm
    );
    return index === null ? null : holeIds[index];
  };

  const handlers: React.SVGProps<SVGSVGElement> = editable
    ? {
      onPointerMove: (event) => {
        // Touch screens have no hover: a tap selects directly.
        if (event.pointerType !== "touch") {
          setHoveredId(holeAt(event.clientX, event.clientY));
        }
      },
      onPointerLeave: () => setHoveredId(null),
      onPointerDown: (event) => {
        touchPress.current = event.pointerType === "touch";
      },
      onClick: (event) => {
        const id = holeAt(event.clientX, event.clientY, touchPress.current ? HOLE_TOUCH_MARGIN_MM : HOLE_HIT_MARGIN_MM);
        if (id !== null && onHoleClick) {
          onHoleClick(id);
        }
      },
    }
    : {};

  const hoveredIndex = editable && hoveredId !== null ? holeIds!.indexOf(hoveredId) : -1;

  return (
    <svg
      ref={svgRef}
      width={w + "mm"}
      height={h + "mm"}
      viewBox={`0 0 ${w} ${h}`}
      xmlns={"http://www.w3.org/2000/svg"}
      className={editable ? "mb-sheetSvg mb-sheetSvg-editable" : "mb-sheetSvg"}
      style={hoveredIndex >= 0 ? { cursor: "pointer" } : undefined}
      {...handlers}
    >
      <DxfShapes drawing={drawing} />
      {editable && (
        <HoleHighlights
          circles={drawing.circles}
          holeIds={holeIds!}
          selectedHoleIds={selectedHoleIds}
          hoveredIndex={hoveredIndex}
        />
      )}
    </svg>
  );
}

/** The lines and holes of the DXF. Not redrawn when only the highlights change. */
const DxfShapes = React.memo(function DxfShapes(props: { drawing: IDxfDrawing }) {
  const { drawing } = props;
  return (
    <>
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
    </>
  );
});

/** Selected holes are filled and ringed in green; the hole under the mouse is ringed. */
function HoleHighlights(props: {
  circles: ICircle[];
  holeIds: string[];
  selectedHoleIds?: ReadonlySet<string>;
  hoveredIndex: number;
}) {
  const { circles, holeIds, selectedHoleIds, hoveredIndex } = props;
  const selected = selectedHoleIds && selectedHoleIds.size > 0
    ? circles.filter((_, i) => selectedHoleIds.has(holeIds[i]))
    : [];
  const hovered = hoveredIndex >= 0 ? circles[hoveredIndex] : null;
  return (
    <g className="mb-holeHighlights" aria-hidden="true">
      {selected.map((circle, i) => (
        <g key={i} className="mb-hole-selected">
          <circle cx={circle.cx} cy={circle.cy} r={circle.r} className="mb-hole-selectedFill" />
          <circle cx={circle.cx} cy={circle.cy} r={circle.r + HOLE_RING_GAP_MM} className="mb-hole-ring" />
        </g>
      ))}
      {hovered && (
        <circle cx={hovered.cx} cy={hovered.cy} r={hovered.r + HOLE_RING_GAP_MM} className="mb-hole-hover" />
      )}
    </g>
  );
}
