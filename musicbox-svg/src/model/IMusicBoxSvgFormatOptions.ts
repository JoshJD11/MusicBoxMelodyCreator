/**
 * Any non-functional formatting (e.g., styling, pagination, etc) to apply to the generate svg.
 */
export interface IMusicBoxSvgFormatOptions {
  /**
   * Max sheet width, used for breaking a horizontal strip into multiple pieces.
   * Also bounds the melody length of a single strip.
   * Only non-zero values have any effect.
   */
  pageWidthMm: number;

  /**
   * Max sheet height, used for placing horizontal strips in rows.
   */
  pageHeightMm: number;

  /**
   * Padding in millimeters before the start of the first note.
   */
  startPaddingMm: number;

  /** Whether to render the rectangular border */
  renderBorder: boolean;

  /** Omit page boundaries when paginating */
  omitPageBoundaries: boolean;

  /** Transpose out of range notes to within range if possible */
  transposeOutOfRangeNotes: boolean;

  /** Experimental: Use jigsaw joins for easy stitching of multiple pages */
  jigsawJoiners: boolean;

  /** Add jigsaw joiners to both start/end so that a loop can be created */
  loopMode: boolean;
}
