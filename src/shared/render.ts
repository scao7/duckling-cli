/**
 * After the pty pivot the renderer shrank to just one helper: HTML-escape.
 * All rich-message rendering (plans, approval messages, questions) went away
 * because claude renders its own terminal output and we just forward the
 * bytes wrapped in <pre>.
 */

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
