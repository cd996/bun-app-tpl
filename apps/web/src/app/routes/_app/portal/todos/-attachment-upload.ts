export function validateAttachmentSelection(
  files: readonly File[],
  existingCount: number,
  maxFileSize: number,
  maxAttachments: number,
): "ok" | "limit" | "size" {
  const remainingSlots = maxAttachments - existingCount;

  if (remainingSlots <= 0 || files.length > remainingSlots) {
    return "limit";
  }

  for (const file of files) {
    if (file.size > maxFileSize) {
      return "size";
    }
  }

  return "ok";
}
