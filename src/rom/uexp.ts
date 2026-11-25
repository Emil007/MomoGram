// MomoGram shared reader: puzzle data of Unreal Engine 4 games stored as a cooked DataTable.
//
// Unreal 4 keeps data tables in ".uasset" (the header) + ".uexp" (the export payload). The puzzle
// rows live in the .uexp as contiguous serialized records:
//
//   FString owner       the struct/package name (e.g. "puzzledata")
//   FString rowName     e.g. "P001_solution_en"
//   FString title       the localized name shown when the puzzle is solved
//   … more fields of the row's struct (ints, further strings)
//
// An FString is UE4's length-prefixed string:
//   int32 len  >= 0  UTF-8/ASCII, len bytes include the trailing NUL
//   int32 len  <  0  UTF-16LE, -len 16-bit code units including the trailing NUL
// Strings are packed without alignment padding.
//
// Nonogram grids appear as FStrings of space-separated 0/1 cells ("0 1 1 0 …", row-major) in the
// same export. This reader only looks at the payload buffer — it does not parse the .uasset header
// (the string layout is self-describing), so it works on any cooked UE4 DataTable that carries
// per-language rows plus per-puzzle solution strings. Pairing a row with its grid by cell count
// (width×height) is the caller's job.

/** Read one UE4 FString at `off`; returns the string and the offset of the next field. */
export function ueFString(d: Uint8Array, off: number): { s: string; next: number } | null {
  if (off + 4 > d.length) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const len = dv.getInt32(off, true);
  if (len === 0) return { s: '', next: off + 4 };
  const wide = len < 0;
  const n = Math.abs(len);
  const nbytes = wide ? n * 2 : n;
  if (nbytes > 64 * 1024 || off + 4 + nbytes > d.length) return null;
  const raw = d.subarray(off + 4, off + 4 + nbytes);
  if (wide) return { s: new TextDecoder('utf-16le').decode(raw).replace(/\0+$/, ''), next: off + 4 + nbytes };
  return { s: new TextDecoder().decode(raw).replace(/\0+$/, ''), next: off + 4 + nbytes };
}

/** rows of '#'/'.' for a cell array in row-major order. */
export function cellRows(cells: number[], w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += cells[y * w + x] ? '#' : '.';
    out.push(s);
  }
  return out;
}

export interface UeGrid { cells: number[]; count: number }

/** every "0 1 1 0 … 1" solution-grid string in the export (space-separated 0/1, row-major). */
export function ueSolutionGrids(d: Uint8Array): UeGrid[] {
  const out: UeGrid[] = [];
  // a grid is a maximal run of '0', '1' and ' ' satisfying "(?:[01] )+[01]", and it must end
  // at a NUL (it is an FString with a trailing terminator; other runs are coincidental ASCII).
  let run = -1;
  const flush = (end: number) => {
    if (run < 0) return;
    let s = '';
    for (let i = run; i < end; i++) s += String.fromCharCode(d[i]);
    run = -1;
    if (!/^(?:[01] )+[01]$/.test(s)) return;
    if (end >= d.length || d[end] !== 0) return;
    const cells = s.split(' ').map(Number);
    out.push({ cells, count: cells.length });
  };
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    if (c === 0x30 || c === 0x31 || c === 0x20) { if (run < 0) run = i; }
    else flush(i);
  }
  flush(d.length);
  return out.filter(g => g.count >= 20); // 25 cells is the smallest real grid (5×5)
}
