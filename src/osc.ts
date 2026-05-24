const ESC = "\x1b";
const BEL = "\x07";

// Limit title length so a single misuse can't push the terminal far.
const MAX_TITLE_LEN = 200;

export function sanitizeTitle(text: string): string {
  return text
    // strip all C0 / DEL control characters so they can't break out of the OSC.
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, MAX_TITLE_LEN);
}

/**
 * Emit OSC 0 to the terminal. OSC 0 sets both the icon name and the window
 * title — Windows Terminal, iTerm2, Alacritty, kitty, GNOME Terminal etc.
 * all honor this.
 *
 * Writing happens to process.stdout, which (when lictor is the foreground
 * process spawned by the terminal) IS the terminal's pty. Claude Code
 * captures the stdout of ITS subprocesses, but lictor is the PARENT of
 * Claude Code, so its own stdout is unmolested.
 */
export function setTitle(text: string): void {
  const safe = sanitizeTitle(text);
  if (!safe) return;
  writeOsc(`0;${safe}`);
}

export function resetTitle(): void {
  // Empty title — most terminals fall back to the default ("Windows Terminal",
  // the profile name, or the active foreground process's name).
  writeOsc(`0;`);
}

function writeOsc(payload: string): void {
  try {
    process.stdout.write(`${ESC}]${payload}${BEL}`);
  } catch {
    // stdout may be closed if the parent terminal already exited; ignore.
  }
}
