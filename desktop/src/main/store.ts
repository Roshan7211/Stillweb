import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** Where the app keeps its own files (settings, history, filters); created on first use. */
export function dataPath(...parts: string[]): string {
  return path.join(app.getPath('userData'), ...parts);
}

/** Files that ship with the app: next to the sources in development, in Resources when packaged. */
export function resourcePath(packaged: string, development: string): string {
  return app.isPackaged ? path.join(process.resourcesPath, packaged) : path.join(app.getAppPath(), development);
}

/** Writes through a temporary file, so a crash never leaves half a file behind. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.now.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** A JSON file kept in memory and written back a moment after it changes. */
export class JsonFile<T> {
  value: T;
  private timer: NodeJS.Timeout | null = null;
  private saving = false;
  private readonly file: string;

  constructor(name: string, fallback: T, private readonly delayMs = 1000) {
    this.file = dataPath(name);
    let value = fallback;
    try {
      value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch {
      // Missing or unreadable: start from the default.
    }
    this.value = value;
  }

  /** Call after changing `value`. */
  changed(): void {
    this.timer ??= setTimeout(() => void this.save(), this.delayMs);
  }

  /** The timed save: written in the background, so browsing never waits for the disk. */
  private async save(): Promise<void> {
    this.timer = null;
    if (this.saving) return this.changed();
    this.saving = true;
    try {
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(`${this.file}.tmp`, JSON.stringify(this.value));
      await fs.promises.rename(`${this.file}.tmp`, this.file);
    } catch (error) {
      console.error(`could not save ${this.file}`, error);
    } finally {
      this.saving = false;
    }
  }

  /** Before quitting: writes now, if anything is waiting. */
  flush(): void {
    if (!this.timer && !this.saving) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeFileAtomic(this.file, JSON.stringify(this.value));
    } catch (error) {
      console.error(`could not save ${this.file}`, error);
    }
  }
}

const files = new Set<JsonFile<unknown>>();

export function jsonFile<T>(name: string, fallback: T, delayMs?: number): JsonFile<T> {
  const file = new JsonFile(name, fallback, delayMs);
  files.add(file as JsonFile<unknown>);
  return file;
}

/** Before quitting: write everything that is still waiting. */
export function flushAll(): void {
  for (const file of files) file.flush();
}
