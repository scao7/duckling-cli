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

// Side view: big mama duck on the right (leading), a row of ducklings
// trailing behind on the left. All face the same direction (right), so the
// parade reads as one cohesive scene. Water underneath, river along the bottom.
//
// We assemble the banner from raw ASCII (no color codes), then re-tokenize
// to color the pieces. This keeps the alignment math sane and lets us toggle
// color off easily.
const RAW_LINES: string[] = [
  '                                                              ____            ',
  '                                                          ___/    \\__         ',
  '   __    __    __    __    __    __    __                /   o      \\        ',
  '  (o>   (o>   (o>   (o>   (o>   (o>   (o>                \\_         >        ',
  '   ~~    ~~    ~~    ~~    ~~    ~~    ~~                  \\_______/         ',
  '                                                             ||  ||           ',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
];

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

function colorize(line: string): string {
  if (!supportsColor()) return line;
  // Tokenize by character class so the colors stay consistent regardless of
  // tiny art tweaks. Order matters: water first (so `~` doesn't get matched
  // by the body class), then eyes/beaks, then body outlines.
  return line
    .replace(/~+/g, (m) => `${C_WATER}${m}${RESET}`)
    // Eyes (`o`) and beaks (`>`) — the bright bits.
    .replace(/[o>]/g, (m) => `${C_BILL}${m}${RESET}`)
    // Body outlines — slashes, underscores, pipes, parens.
    .replace(/[/\\_|()]+/g, (m) => `${C_BODY}${m}${RESET}`);
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
    ? `${DIM}${C_TEXT}${tagline ?? 'Claude Code on Telegram'}${RESET}`
    : tagline ?? 'Claude Code on Telegram';
  return [...lines, '', `        ${title}        ${sub}`, ''].join('\n');
}
