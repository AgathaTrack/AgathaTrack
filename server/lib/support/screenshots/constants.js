export const SUPPORT_SCREENSHOT_MAX_FILES = 3;
export const SUPPORT_SCREENSHOT_MAX_BYTES_PER_FILE = 2 * 1024 * 1024;
export const SUPPORT_SCREENSHOT_MAX_BYTES_TOTAL = 6 * 1024 * 1024;
/** Bounds decompression bombs before re-encode (SUPPORT-TICKETING-R-008). */
export const SUPPORT_SCREENSHOT_MAX_INPUT_PIXELS = 4096 * 4096;
export const SUPPORT_SCREENSHOT_STORAGE = 'support_screenshots';
export const SUPPORT_SCREENSHOT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
