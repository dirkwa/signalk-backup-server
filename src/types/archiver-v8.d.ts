/**
 * Local types shim for `archiver` v8.
 *
 * `@types/archiver` (DefinitelyTyped) only covers v6 (`export = archiver`,
 * the CJS factory function). v8 is pure ESM and exports named classes
 * (`ZipArchive`, `TarArchive`, `JsonArchive`, plus the abstract `Archiver`
 * base) with no default export. Until DefinitelyTyped catches up — or
 * upstream archiver ships its own .d.ts — we declare just what we use.
 *
 * Source of truth: node_modules/archiver/index.js + the migration
 * example in node_modules/archiver/README.md.
 */

declare module 'archiver' {
  import { Readable } from 'stream';
  import { ZlibOptions } from 'zlib';

  interface ArchiverOptions {
    zlib?: ZlibOptions;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    store?: boolean;
    comment?: string;
    statConcurrency?: number;
  }

  export class Archiver extends Readable {
    pointer(): number;
    append(source: Readable | Buffer | string, data?: { name?: string }): this;
    file(filepath: string, data?: { name?: string }): this;
    directory(dirpath: string, destpath: string | false, data?: object): this;
    finalize(): Promise<void>;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'warning', listener: (err: Error) => void): this;
    on(
      event: 'progress',
      listener: (data: { entries: { total: number; processed: number } }) => void
    ): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  export class TarArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }

  export class JsonArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}
