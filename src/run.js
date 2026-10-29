// Runs a command and turns known errors into short, readable messages.
import { ConfigError } from './config.js';
import { ShortcutError } from './shortcut.js';
import { NoIterationError } from './report-builder.js';

export function runMain(fn) {
  fn().catch((err) => {
    const known = err instanceof ConfigError || err instanceof ShortcutError || err instanceof NoIterationError;
    console.error('\nError: ' + (err?.message || err));
    if (!known && process.env.DEBUG) console.error(err);
    process.exitCode = 1;
  });
}
