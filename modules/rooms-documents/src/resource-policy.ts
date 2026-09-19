/**
 * Fixed parser and upload safety bounds. These are deliberately not operator
 * configuration: raising them changes the threat model and permits resource
 * amplification before content can be trusted.
 */
export const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
export const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
export const MAX_MULTIPART_PART_BYTES = 64 * 1024 * 1024;
export const MAX_MULTIPART_PARTS = Math.ceil(MAX_SOURCE_BYTES / MIN_MULTIPART_PART_BYTES);
export const MAX_DIRECTORY_FILES = 1_000;
export const MAX_DIRECTORY_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_DIRECTORY_LEVELS = 5;
// Image dimensions are read from headers before decode. Area and decoded bytes
// bound decompression bombs; the axis cap separately protects parser arithmetic.
export const MAX_IMAGE_PIXELS = 64_000_000;
export const MAX_IMAGE_DECODED_BYTES = 256 * 1024 * 1024;
export const MAX_IMAGE_AXIS = 32_768;
// Spreadsheet containers are ZIPs. These bounds prevent high-ratio expansion
// from consuming worker disk/RSS before LibreOffice processing in the next wave.
export const MAX_OFFICE_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
export const MAX_OFFICE_COMPRESSION_RATIO = 100;

export interface MultipartPartPlan {
  readonly partNumber: number;
  readonly size: number;
  readonly checksumSha256?: string;
}

export function validateDeclaredSourceSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_BYTES)
    throw new Error('SOURCE_SIZE_REJECTED');
}

export function validateMultipartPlan(
  declaredSize: number,
  parts: readonly MultipartPartPlan[],
  checksumRequired: boolean,
): void {
  validateDeclaredSourceSize(declaredSize);
  if (parts.length < 1 || parts.length > MAX_MULTIPART_PARTS)
    throw new Error('PART_PLAN_REJECTED');
  let total = 0;
  for (const [index, part] of parts.entries()) {
    if (part.partNumber !== index + 1) throw new Error('PART_PLAN_REJECTED');
    if (!Number.isSafeInteger(part.size) || part.size < 1)
      throw new Error('PART_PLAN_REJECTED');
    const finalPart = index === parts.length - 1;
    if (
      (!finalPart && part.size < MIN_MULTIPART_PART_BYTES) ||
      part.size > MAX_MULTIPART_PART_BYTES
    )
      throw new Error('PART_PLAN_REJECTED');
    if (
      checksumRequired &&
      (part.checksumSha256 === undefined || !/^[A-Za-z0-9+/]{43}=$/u.test(part.checksumSha256))
    )
      throw new Error('PART_CHECKSUM_REJECTED');
    total += part.size;
  }
  if (total !== declaredSize) throw new Error('PART_PLAN_REJECTED');
}
