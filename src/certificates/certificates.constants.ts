export const CERTIFICATES_QUEUE = 'certificates';

/** Payload of the PDF-generation job. */
export interface GenerateCertificateJob {
  certificateId: string;
}

/** Object-storage key for a certificate's PDF. */
export const certificateKey = (id: string) => `certificates/${id}.pdf`;
