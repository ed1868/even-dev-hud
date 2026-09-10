/**
 * Limits the Even Hub SDK documents for a single glasses page. The SDK validates
 * some of these itself and only tells you after the round trip (a `false` return
 * or `StartUpPageCreateResult.invalid`); checking here gives a message that names
 * the offending container.
 *
 * Source: @evenrealities/even_hub_sdk 0.0.15 README, "Glasses UI" → Rules.
 */
export const LIMITS = {
  /** `containerTotalNum` must be 1..12. */
  minContainers: 1,
  maxContainers: 12,
  /** At most 8 text containers on a page. */
  maxTextContainers: 8,
  /** At most 10 first-level contextual menu items. */
  maxMenuItems: 10,
  /** Menu item names are capped in UTF-8 bytes, not characters. */
  maxMenuNameBytes: 32,
  /** `textColor` is a brightness level, not an RGB value. */
  minTextBrightness: 0,
  maxTextBrightness: 4,
} as const;

/**
 * G2 display canvas. 576x288 is stated by Even Realities' own
 * `@evenrealities/even-terminal` README ("renders it onto the G2's 576x288
 * canvas"). The Even Hub SDK does not restate it, and does not promise that
 * container coordinates map 1:1 onto display pixels — so treat this as the
 * display size, and verify the mapping on your device before laying out to the
 * edges. Origin is top-left.
 */
export const CANVAS = { width: 576, height: 288, origin: 'top-left' } as const;

/** @deprecated Renamed to {@link CANVAS} now that the size is sourced, not guessed. */
export const ASSUMED_CANVAS = CANVAS;

export class PageConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageConstraintError';
  }
}
