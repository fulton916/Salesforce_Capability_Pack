// CSV text for downloads. Pure.

/** RFC 4180 CSV with a BOM so Excel opens UTF-8 correctly. */
export function toCsv(rows) {
  const esc = (v) => {
    let s = String(v ?? "");
    // Org text opened in Excel: a leading = + - @ tab or CR would run as a formula.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
