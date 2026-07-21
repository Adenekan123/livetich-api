export const CERTIFICATES_QUEUE = 'certificates';

/** Payload of the PDF-generation job. */
export interface GenerateCertificateJob {
  certificateId: string;
}
