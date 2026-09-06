import { describe, expect, it } from 'vitest';
import {
  ImageFormat,
  imageFormatLabel,
  isAvatarMimeType,
  parseContentLength,
  parseImageContentType,
  sniffImageFormat,
} from '../avatar-image.js';

/** Header bytes are all that identification looks at; the payload is filler. */
function withHeader(header: readonly number[], length = 64): Buffer {
  const buffer = Buffer.alloc(length);
  Buffer.from(header).copy(buffer);
  return buffer;
}

const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** "RIFF" <size> "WEBP" — the container, which is what identifies a WebP. */
function webp(): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(56, 4);
  buffer.write('WEBP', 8, 'latin1');
  return buffer;
}

/** An ISO base-media file whose `ftyp` box declares `brand`. */
function isoBmff(brand: string): Buffer {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(32, 0);
  buffer.write('ftyp', 4, 'latin1');
  buffer.write(brand, 8, 'latin1');
  return buffer;
}

describe('sniffImageFormat', () => {
  it.each([
    ['JPEG', JPEG, ImageFormat.JPEG],
    ['PNG', PNG, ImageFormat.PNG],
    ['WebP', webp(), ImageFormat.WEBP],
    ['GIF87a', Buffer.from('GIF87a________'), ImageFormat.GIF],
    ['GIF89a', Buffer.from('GIF89a________'), ImageFormat.GIF],
    ['BMP', Buffer.from('BM____________'), ImageFormat.BMP],
    ['little-endian TIFF', withHeader([0x49, 0x49, 0x2a, 0x00]), ImageFormat.TIFF],
    ['big-endian TIFF', withHeader([0x4d, 0x4d, 0x00, 0x2a]), ImageFormat.TIFF],
    ['AVIF', isoBmff('avif'), ImageFormat.AVIF],
    ['HEIC', isoBmff('heic'), ImageFormat.HEIC],
    ['iPhone HEIF', isoBmff('mif1'), ImageFormat.HEIC],
  ])('identifies %s from its magic bytes', (_label, bytes, expected) => {
    expect(sniffImageFormat(bytes)).toBe(expected);
  });

  it('needs all three JPEG signature bytes', () => {
    // FF D8 alone is a two-byte prefix shared with other formats; accepting it
    // would let a crafted payload pass as a JPEG.
    expect(sniffImageFormat(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });

  it('does not mistake a plain RIFF container for a WebP', () => {
    // A WAV file is also RIFF. Only the "WEBP" form type at offset 8 decides.
    const wav = Buffer.alloc(64);
    wav.write('RIFF', 0, 'latin1');
    wav.write('WAVE', 8, 'latin1');
    expect(sniffImageFormat(wav)).toBeNull();
  });

  describe('SVG, which is a script-bearing document rather than a bitmap', () => {
    it.each([
      ['a bare root element', '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
      ['an XML declaration first', '<?xml version="1.0"?>\n<svg xmlns="x"></svg>'],
      ['a doctype first', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">\n<svg></svg>'],
      ['leading whitespace', '\n\n   <svg></svg>'],
      ['a self-closing root', '<svg/>'],
    ])('detects %s', (_label, source) => {
      expect(sniffImageFormat(Buffer.from(source, 'utf8'))).toBe(ImageFormat.SVG);
    });

    it('detects one behind a UTF-8 byte-order mark', () => {
      const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<svg></svg>')]);
      expect(sniffImageFormat(bytes)).toBe(ImageFormat.SVG);
    });

    it('does not claim every scrap of markup is an SVG', () => {
      expect(sniffImageFormat(Buffer.from('<html><body>hi</body></html>'))).toBeNull();
    });
  });

  it('returns null for an empty body and for arbitrary noise', () => {
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
    expect(sniffImageFormat(Buffer.from('not an image at all'))).toBeNull();
  });

  it('is safe on a payload shorter than the signature it might match', () => {
    // A one-byte body must not read past the end of the buffer.
    expect(sniffImageFormat(Buffer.from([0xff]))).toBeNull();
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('isAvatarMimeType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (value) => {
    expect(isAvatarMimeType(value)).toBe(true);
  });

  it.each(['image/svg+xml', 'image/gif', 'image/heic', 'text/html', 'application/octet-stream'])(
    'rejects %s',
    (value) => {
      expect(isAvatarMimeType(value)).toBe(false);
    },
  );
});

describe('parseImageContentType', () => {
  it('strips parameters and normalises case', () => {
    // `image/jpeg; charset=binary` and `IMAGE/JPEG` are the same media type;
    // treating them as different would refuse ordinary clients.
    expect(parseImageContentType('IMAGE/JPEG; charset=binary')).toBe('image/jpeg');
    expect(parseImageContentType('  image/png  ')).toBe('image/png');
  });

  it('takes the first value when a header arrives repeated', () => {
    expect(parseImageContentType(['image/png', 'image/jpeg'])).toBe('image/png');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['only a parameter', '; charset=utf-8'],
  ])('returns null when the header is %s', (_label, header) => {
    expect(parseImageContentType(header)).toBeNull();
  });
});

describe('parseContentLength', () => {
  it('reads a plain decimal length', () => {
    expect(parseContentLength('2048')).toBe(2048);
    expect(parseContentLength(' 10 ')).toBe(10);
  });

  it.each([
    ['absent', undefined],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['hexadecimal', '0x10'],
    ['non-numeric', 'lots'],
    ['beyond a safe integer', '99999999999999999999'],
  ])('returns null for a %s length, so the streaming cap decides', (_label, header) => {
    expect(parseContentLength(header)).toBeNull();
  });
});

describe('imageFormatLabel', () => {
  it('names a recognised format for the error message', () => {
    expect(imageFormatLabel(ImageFormat.PNG)).toBe('PNG');
    expect(imageFormatLabel(ImageFormat.HEIC)).toBe('HEIC');
  });

  it('has wording for bytes it could not identify', () => {
    expect(imageFormatLabel(null)).toBe('an unrecognised format');
  });
});
