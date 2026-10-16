'use strict';
module.exports = () => {
  const text = 'BT /F1 12 Tf 20 80 Td (Synthetic evidence) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let n = 0; n < objects.length; n++) { offsets.push(Buffer.byteLength(pdf)); pdf += (n + 1) + ' 0 obj\n' + objects[n] + '\nendobj\n'; }
  const xref = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf);
};
