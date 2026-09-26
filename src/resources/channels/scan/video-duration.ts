import { execFile } from 'child_process';
import { promisify } from 'util';
import { open, FileHandle } from 'fs/promises';
import { extname } from 'path';

const execFileAsync = promisify(execFile);
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

export async function getVideoDurationSec(
  filePath: string,
): Promise<number | null> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') {
    const fromMp4 = await durationFromMp4(filePath);
    if (fromMp4 != null) return fromMp4;
  }
  return durationFromFfprobe(filePath);
}

async function durationFromMp4(filePath: string): Promise<number | null> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    return await walkBoxes(fh, 0, size);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

async function walkBoxes(
  fh: FileHandle,
  start: number,
  end: number,
): Promise<number | null> {
  let offset = start;
  while (offset + 8 <= end) {
    const header = await readExact(fh, offset, 8);
    if (!header) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString('ascii', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      const large = await readExact(fh, offset + 8, 8);
      if (!large) return null;
      size = Number(large.readBigUInt64BE(0));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) return null;
    const boxEnd = Math.min(offset + size, end);
    if (type === 'mvhd') {
      const body = await readExact(fh, offset + headerSize, boxEnd - offset - headerSize);
      if (!body) return null;
      return parseMvhd(body);
    }
    if (CONTAINER_BOXES.has(type)) {
      const nested = await walkBoxes(fh, offset + headerSize, boxEnd);
      if (nested != null) return nested;
    }
    offset = boxEnd;
  }
  return null;
}

function parseMvhd(body: Buffer): number | null {
  if (body.length < 20) return null;
  const version = body[0];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (body.length < 32) return null;
    timescale = body.readUInt32BE(20);
    duration = Number(body.readBigUInt64BE(24));
  } else {
    timescale = body.readUInt32BE(12);
    duration = body.readUInt32BE(16);
  }
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.round(duration / timescale);
}

async function durationFromFfprobe(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { timeout: 20000, windowsHide: true },
    );
    const seconds = Number(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds);
  } catch {
    return null;
  }
}

async function readExact(
  fh: FileHandle,
  position: number,
  length: number,
): Promise<Buffer | null> {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return bytesRead === length ? buf : null;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
