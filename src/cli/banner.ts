/**
 * The duckling banner — ASCII art shown at top of `duckling` (no args) and
 * `duckling setup`. A big mama duck leading a parade of ducklings to the right,
 * because the brand mascot is a duck and Claude Code's own startup screen
 * sets a tone we're happy to match.
 *
 * Designed to fit comfortably in a 78-column terminal. Strict ASCII so it
 * renders identically in tmux, ssh, and minimal terminals. Optional ANSI
 * coloring is layered on for terminals that support it.
 */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

// 256-color codes that read as yellow/tan on most palettes. We use 256-color
// (not bright 16) because terminal themes vary wildly on the bright table.
const C_BODY = `${ESC}38;5;220m`; // duck-yellow
const C_BILL = `${ESC}38;5;208m`; // bill-orange
const C_WATER = `${ESC}38;5;39m`; // water-blue
const C_TEXT = `${ESC}38;5;180m`; // muted tan for tagline

// Big mama duck on the right (leading), seven ducklings trailing behind.
//
// We assemble the banner from raw ASCII (no color codes), then re-tokenize
// to color the pieces. This keeps the alignment math sane and lets us toggle
// color off easily.
const RAW_LINES: string[] = [
  '                                                                ___           ',
  '                                                               /   \\__        ',
  '   __    __    __    __    __    __    __                     | o .  >        ',
  '  (o<)  (o<)  (o<)  (o<)  (o<)  (o<)  (o<)                     \\____/         ',
  '   ~~    ~~    ~~    ~~    ~~    ~~    ~~                       ||            ',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
];

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

function colorize(line: string): string {
  if (!supportsColor()) return line;
  return line
    // Tildes (water) → blue
    .replace(/~+/g, (m) => `${C_WATER}${m}${RESET}`)
    // Duckling bodies "(o<)" → yellow with orange beak
    .replace(/\(o<\)/g, `${C_BODY}(${C_BILL}o<${C_BODY})${RESET}`)
    // Mama duck pieces — color the bill ">" and the body separately
    .replace(/\| o \.  >/g, `${C_BODY}| ${C_BILL}o${C_BODY} . ${C_BILL} >${RESET}`)
    .replace(/(\/   \\__)/g, `${C_BODY}$1${RESET}`)
    .replace(/(\\____\/)/g, `${C_BODY}$1${RESET}`)
    .replace(/(___)(\s+)$/g, `${C_BODY}$1${RESET}$2`);
}

export function bannerLines(): string[] {
  return RAW_LINES.map(colorize);
}

export function bannerWithTagline(tagline?: string): string {
  const lines = bannerLines();
  const title = supportsColor()
    ? `${BOLD}🦆 d u c k l i n g${RESET}`
    : '🦆 d u c k l i n g';
  const sub = supportsColor()
    ? `${DIM}${C_TEXT}${tagline ?? 'Claude Code on Telegram · pty-wrapped'}${RESET}`
    : tagline ?? 'Claude Code on Telegram · pty-wrapped';
  return [...lines, '', `        ${title}        ${sub}`, ''].join('\n');
}
