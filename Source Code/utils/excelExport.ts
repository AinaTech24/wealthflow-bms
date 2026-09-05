// xlsx is ~142 KB gzipped — dynamic-import keeps it out of every page that just
// happens to *reference* exportToExcel. The cost is paid only when the user
// actually clicks Export.
export async function exportToExcel(rows: object[], filename: string, sheetName = 'Sheet1') {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// Multi-sheet variant. Each sheet is written even when empty (a single blank row
// keeps the tab visible so the reader knows the section had nothing to show).
// Sheet names are clamped to Excel's 31-char limit.
export async function exportSheetsToExcel(
  sheets: { name: string; rows: object[] }[],
  filename: string
) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ '—': 'No rows' }]);
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  XLSX.writeFile(wb, `${filename}.xlsx`);
}
