// One indexer per data directory: a lock file holding the holder's pid. A
// lock whose process is gone is taken over.

import { openSync, writeSync, closeSync, readFileSync, unlinkSync } from 'node:fs';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Lock {
  release(): void;
}

export function acquireLock(path: string): Lock {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        release() {
          try {
            if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new Error(`the indexer lock ${path} is held by process ${holder}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not take the indexer lock ${path}`);
}
