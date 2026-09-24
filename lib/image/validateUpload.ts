/**
 * Uploaded files are untrusted input. We check the declared size, sniff the
 * real format from magic bytes (never trusting the extension or MIME type),
 * and bound the decoded pixel count before anything heavy happens.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PIXELS = 60_000_000;

export type SupportedFormat = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

export class UploadError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'UploadError';
  }
}

export function sniffFormat(head: Uint8Array): SupportedFormat | undefined {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'application/pdf';
  return undefined;
}

export async function validateUpload(file: File): Promise<SupportedFormat> {
  if (file.size === 0) throw new UploadError('The file is empty.');
  if (file.size > MAX_FILE_BYTES) throw new UploadError(`The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  // Image magic bytes win. PDFs may have junk before the header, which readers
  // accept within the first 1 KB, so search for it only if not an image.
  const format = sniffFormat(head) ?? (findPdfHeader(head) >= 0 ? 'application/pdf' : undefined);
  if (!format) throw new UploadError('Unsupported file type. Please upload a PDF, PNG, JPEG or WebP file.');
  return format;
}

function findPdfHeader(head: Uint8Array): number {
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return i;
  }
  return -1;
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
