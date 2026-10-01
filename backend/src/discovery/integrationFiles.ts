import fs from 'node:fs';

export function readIntegrationFile(file: string, maxBytes = 1024 * 1024): string | undefined {
  let fd: number | undefined;
  try {
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('Expected a regular file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    if (before.size > maxBytes) throw new Error('File exceeds the read limit');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) throw new Error('File exceeds the read limit');
    const after = fs.fstatSync(fd);
    if (count > before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('File changed during inspection; retry on the next scan');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
