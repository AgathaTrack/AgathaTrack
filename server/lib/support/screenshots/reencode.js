import sharp from 'sharp';

import { validateOrgImageMime, normalizeMimeType } from '../../safeUpload.js';
import {
  SUPPORT_SCREENSHOT_EXTENSIONS,
  SUPPORT_SCREENSHOT_MAX_BYTES_PER_FILE,
  SUPPORT_SCREENSHOT_MAX_INPUT_PIXELS,
} from './constants.js';

export class SupportScreenshotEncodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SupportScreenshotEncodeError';
  }
}

/**
 * Re-encode support screenshot bytes: strip metadata, enforce output caps (R-008).
 * @param {Buffer} buffer
 * @param {string} mimeType effective MIME after intake sniffing
 * @returns {Promise<{ buffer: Buffer, mime: string, bytes: number }>}
 */
export async function reencodeSupportScreenshotBuffer(buffer, mimeType) {
  let pipeline;
  try {
    pipeline = sharp(buffer, {
      limitInputPixels: SUPPORT_SCREENSHOT_MAX_INPUT_PIXELS,
      failOn: 'error',
    }).rotate();
  } catch {
    throw new SupportScreenshotEncodeError('Invalid screenshot image.');
  }

  let encoded;
  try {
    if (mimeType === 'image/jpeg') {
      encoded = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    } else if (mimeType === 'image/png') {
      encoded = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    } else if (mimeType === 'image/webp') {
      encoded = await pipeline.webp({ quality: 82 }).toBuffer();
    } else {
      throw new SupportScreenshotEncodeError('Only PNG, JPEG, and WebP screenshots are allowed.');
    }
  } catch (err) {
    if (err instanceof SupportScreenshotEncodeError) throw err;
    throw new SupportScreenshotEncodeError('Invalid screenshot image.');
  }

  if (encoded.length === 0 || encoded.length > SUPPORT_SCREENSHOT_MAX_BYTES_PER_FILE) {
    throw new SupportScreenshotEncodeError('Each screenshot must be 2 MB or smaller.');
  }

  let mime;
  try {
    mime = validateOrgImageMime('application/octet-stream', encoded, SUPPORT_SCREENSHOT_EXTENSIONS);
  } catch {
    throw new SupportScreenshotEncodeError('Only PNG, JPEG, and WebP screenshots are allowed.');
  }
  if (normalizeMimeType(mime) !== normalizeMimeType(mimeType)) {
    throw new SupportScreenshotEncodeError('Only PNG, JPEG, and WebP screenshots are allowed.');
  }

  return { buffer: encoded, mime, bytes: encoded.length };
}