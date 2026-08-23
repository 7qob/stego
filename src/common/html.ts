/**
 * Filenames are attacker-controlled and land in both HTML text and attribute
 * values (og:title, alt, …). Escape everything on the way out.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
