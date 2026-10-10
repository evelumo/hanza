// A real Carrier's Label is its own PDF. This one is built here so a download has a file that opens in any viewer.
const encoder = new TextEncoder()

/** One 300x200 pt page with `lines` of text; only plain characters are kept, so nothing can break the content stream. */
export function fakeLabelPdf(lines: string[]): Uint8Array {
  const text = lines.map((line, index) => `${index === 0 ? '' : '0 -22 Td '}(${line.replace(/[^A-Za-z0-9 ._:-]/g, '')}) Tj`).join('\n')
  const content = `BT /F1 16 Tf 24 150 Td\n${text}\nET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  // Every character is ASCII, so a string's length is its length in bytes: the cross-reference table needs the offsets.
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return encoder.encode(pdf)
}
