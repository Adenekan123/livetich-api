import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';

export interface CertificatePdfData {
  studentName: string;
  courseTitle: string;
  instructorName: string;
  issuedAt: Date;
  verificationCode: string;
  /** Full URL the QR resolves to (public verification endpoint). */
  verifyUrl: string;
}

/** A4 landscape certificate with a QR code that resolves to the verify URL. */
export async function renderCertificatePdf(
  data: CertificatePdfData,
): Promise<Buffer> {
  const qrPng = await QRCode.toBuffer(data.verifyUrl, {
    width: 140,
    margin: 1,
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const w = doc.page.width; // 841.89
    const h = doc.page.height; // 595.28

    doc.rect(24, 24, w - 48, h - 48).lineWidth(3).stroke('#1a3c6e');
    doc.rect(32, 32, w - 64, h - 64).lineWidth(1).stroke('#1a3c6e');

    doc
      .font('Helvetica-Bold')
      .fontSize(30)
      .fillColor('#1a3c6e')
      .text('CERTIFICATE OF COMPLETION', 0, 90, { align: 'center' });

    doc
      .font('Helvetica')
      .fontSize(14)
      .fillColor('#444444')
      .text('This certifies that', 0, 165, { align: 'center' });

    doc
      .font('Helvetica-Bold')
      .fontSize(34)
      .fillColor('#000000')
      .text(data.studentName, 60, 195, { width: w - 120, align: 'center' });

    doc
      .font('Helvetica')
      .fontSize(14)
      .fillColor('#444444')
      .text('has successfully completed the course', 0, 255, {
        align: 'center',
      });

    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor('#1a3c6e')
      .text(data.courseTitle, 60, 285, { width: w - 120, align: 'center' });

    const issued = data.issuedAt.toISOString().slice(0, 10);
    doc
      .font('Helvetica')
      .fontSize(13)
      .fillColor('#444444')
      .text(`Instructor: ${data.instructorName}`, 0, 370, { align: 'center' })
      .text(`Issued: ${issued}`, 0, 390, { align: 'center' });

    doc.image(qrPng, w - 200, h - 210, { width: 120 });
    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(data.verificationCode, w - 200, h - 84, {
        width: 120,
        align: 'center',
      });

    doc
      .fontSize(9)
      .fillColor('#666666')
      .text(`Scan the QR code or visit ${data.verifyUrl} to verify`, 60, h - 60, {
        width: w - 120,
        align: 'center',
      });

    doc.end();
  });
}
