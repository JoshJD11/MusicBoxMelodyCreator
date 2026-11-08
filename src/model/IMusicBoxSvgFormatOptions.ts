export const STRIP_ORIENTATIONS = ['horizontal', 'vertical'] as const;

/**
 * How the strips are laid out in the exported sheets:
 * - `horizontal`: the song runs to the right, one strip per row, highest note at the top.
 * - `vertical`: every strip is rotated 90° clockwise: the song runs downwards, one strip per column
 *   (the first one on the left), highest note on the right. Ready to cut in Silhouette Studio without
 *   rotating it by hand.
 */
export type StripOrientation = typeof STRIP_ORIENTATIONS[number];

export function isStripOrientation(value: unknown): value is StripOrientation {
  return (STRIP_ORIENTATIONS as readonly unknown[]).includes(value);
}

/**
 * Any non-functional formatting (e.g., styling, pagination, etc) to apply to the generate svg.
 */
export interface IMusicBoxSvgFormatOptions {
  /**
   * Max strip length: used for breaking the tape into multiple pieces. It is the sheet width with
   * horizontal strips, and the sheet height with vertical ones.
   * Only non-zero values have any effect.
   */
  pageWidthMm: number;

  /**
   * Room for placing strips next to each other: the sheet height with horizontal strips (rows), and
   * the sheet width with vertical ones (columns).
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

  /** Include notes of the percussion channel (MIDI channel 10), normally drums. */
  includePercussion?: boolean;

  /** Experimental: Use jigsaw joins for easy stitching of multiple pages */
  jigsawJoiners: boolean;

  /** Add jigsaw joiners to both start/end so that a loop can be created */
  loopMode: boolean;

  /**
   * Mirror every strip across its width (highest <-> lowest note side) within its own row/column.
   * Same result as flipping each strip in the cutting software (vertically if the strips are
   * horizontal, horizontally if they are vertical).
   */
  mirrorVertically?: boolean;

  /** Direction of the strips in the exported sheets. Horizontal when not set. */
  stripOrientation?: StripOrientation;
}

/**
 * User-facing names of the sheet dimensions that hold `pageWidthMm` (along the strips) and
 * `pageHeightMm` (across them): they swap with the orientation.
 */
export function sheetDimensionNames(orientation: StripOrientation = 'horizontal') {
  return orientation === 'vertical'
    ? { alongStrips: 'Sheet height', acrossStrips: 'Sheet width' }
    : { alongStrips: 'Sheet width', acrossStrips: 'Sheet height' };
}

/** Layout options that change the length of the song's tape, and so the sheet size that fits it. */
const STRIP_LENGTH_OPTIONS = [
  'startPaddingMm',
  'transposeOutOfRangeNotes',
  'includePercussion',
  'jigsawJoiners',
  'loopMode',
] as const satisfies ReadonlyArray<keyof IMusicBoxSvgFormatOptions>;

/**
 * Whether applying `next` over `previous` must fit the sheet to the song again: an option that
 * changes the tape's length changed, and the sheet sizes were not edited in the same change (sizes
 * that the user has just typed win). Unset optional flags count as false.
 */
export function shouldRefitSheet(previous: IMusicBoxSvgFormatOptions, next: IMusicBoxSvgFormatOptions): boolean {
  const sizesEdited = previous.pageWidthMm !== next.pageWidthMm || previous.pageHeightMm !== next.pageHeightMm;
  return !sizesEdited && STRIP_LENGTH_OPTIONS.some(key => (previous[key] ?? false) !== (next[key] ?? false));
}

/** Returns the problems that make the options unusable (empty if they are valid). */
export function validateFormatOptions(options: IMusicBoxSvgFormatOptions): string[] {
  const errors: string[] = [];
  const atLeastZero = (value: number, label: string) => {
    if (!Number.isFinite(value) || value < 0) {
      errors.push(`${label} must be a number of at least 0.`);
    }
  };

  const names = sheetDimensionNames(options.stripOrientation);
  atLeastZero(options.pageWidthMm, names.alongStrips);
  atLeastZero(options.pageHeightMm, names.acrossStrips);
  atLeastZero(options.startPaddingMm, "Start padding");

  return errors;
}
