import { describe, expect, it } from '@jest/globals';
import sharp from 'sharp';

import {
  reencodeSupportScreenshotBuffer,
  SupportScreenshotEncodeError,
} from '../../lib/support/screenshots/reencode.js';

describe('reencodeSupportScreenshotBuffer', () => {
  it('strips EXIF metadata from JPEG output', async () => {
    const withExif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            Copyright: 'sensitive-exif-value',
          },
        },
      })
      .toBuffer();

    const before = await sharp(withExif).metadata();
    expect(before.exif).toBeTruthy();

    const { buffer } = await reencodeSupportScreenshotBuffer(withExif, 'image/jpeg');
    const after = await sharp(buffer).metadata();
    expect(after.exif).toBeFalsy();
  });

  it('rejects input that exceeds limitInputPixels', async () => {
    const huge = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

    await expect(reencodeSupportScreenshotBuffer(huge, 'image/png')).rejects.toThrow(
      SupportScreenshotEncodeError,
    );
  });

  it('rejects corrupt bytes that fail decode', async () => {
    const corrupt = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 0xff)]);
    await expect(reencodeSupportScreenshotBuffer(corrupt, 'image/png')).rejects.toThrow(
      /Invalid screenshot image/,
    );
  });

  it('preserves allowed MIME types on re-encoded output', async () => {
    const cases = [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
    ];
    for (const [format, mime] of cases) {
      const input = await sharp({
        create: { width: 3, height: 3, channels: 3, background: { r: 4, g: 5, b: 6 } },
      })
        [format]()
        .toBuffer();
      const out = await reencodeSupportScreenshotBuffer(input, mime);
      expect(out.mime).toBe(mime);
      expect(out.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });
});