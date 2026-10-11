import { constants } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedImage {
  mimeType: string;
  base64: string;
}

export interface MediaAuthorizationContext {
  senderId?: string | undefined;
  conversationId?: string | undefined;
  workspaceDir?: string | undefined;
  authorizedMediaPaths?: string[] | undefined;
  authorizedMediaUrls?: string[] | undefined;
  mediaPath?: string | undefined;
  mediaPaths?: string[] | undefined;
  mediaUrl?: string | undefined;
  mediaUrls?: string[] | undefined;
  inboundMedia?: Array<{ id?: string; path?: string; url?: string; senderId?: string; conversationId?: string }> | undefined;
  authorizedAttachments?: Array<{ id?: string; path?: string; url?: string; senderId?: string; conversationId?: string }> | undefined;
}

export type MediaResolutionErrorCode =
  | "unauthorized_media"
  | "invalid_image_content"
  | "oversized_image"
  | "image_not_found"
  | "path_traversal"
  | "symlink_escape"
  | "too_many_images";

export class MediaResolutionError extends Error {
  readonly code: MediaResolutionErrorCode;

  constructor(code: MediaResolutionErrorCode, message: string) {
    super(message);
    this.name = "MediaResolutionError";
    this.code = code;
  }
}

export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5 MiB raw (~6M base64)
export const MAX_IMAGES_COUNT = 4;
export const MAX_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024; // 16 MiB total across all images

export function detectImageMimeTypeFromBuffer(header: Buffer): string | null {
  if (!header || header.length < 4) return null;

  // JPEG: FF D8 FF
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }

  // WebP: RIFF .... WEBP
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // HEIC / HEIF: byte 4-7 is 'ftyp'
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) {
      return "image/heic";
    }
  }

  return null;
}

export function isPathInside(parent: string, child: string): boolean {
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);
  if (normParent === normChild) return true;
  const rel = path.relative(normParent, normChild);
  return Boolean(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function normalizeMediaReference(ref: string): string {
  let trimmed = ref.trim();
  if (trimmed.startsWith("file://")) {
    try {
      trimmed = fileURLToPath(trimmed);
    } catch {
      // Keep trimmed as-is
    }
  }
  return trimmed;
}

function extractMediaId(ref: string): string | null {
  const match = ref.match(/^media:\/\/inbound\/([^?#]+)$/i);
  if (match && match[1]) {
    try { return decodeURIComponent(match[1]); }
    catch { throw new MediaResolutionError("unauthorized_media", "Malformed media reference."); }
  }
  return null;
}

export function getAllowedMediaRoots(workspaceDir?: string): string[] {
  const roots: string[] = [
    path.join(homedir(), ".openclaw", "media", "inbound"),
    path.join(homedir(), ".openclaw", "workspace", "media", "inbound"),
  ];
  if (workspaceDir) {
    roots.push(path.join(workspaceDir, "media", "inbound"));
  }
  return roots;
}

type Attachment = NonNullable<MediaAuthorizationContext["authorizedAttachments"]>[number];

function authorizedAttachments(context: MediaAuthorizationContext | undefined): Attachment[] {
  if (!context) return [];
  const paths = [...(context.authorizedMediaPaths ?? []), ...(context.mediaPaths ?? []), ...(context.mediaPath ? [context.mediaPath] : [])];
  return [
    ...paths.map((filePath): Attachment => ({ path: filePath })),
    ...(context.inboundMedia ?? []), ...(context.authorizedAttachments ?? []),
  ].filter(item => (!item.senderId || item.senderId === context.senderId)
    && (!item.conversationId || item.conversationId === context.conversationId));
}

function selectAuthorizedPath(rawRef: string, context: MediaAuthorizationContext | undefined): string | undefined {
  const normalized = normalizeMediaReference(rawRef);
  const id = extractMediaId(normalized);
  if (normalized.includes("\0") || normalized.includes("../") || normalized.includes("..\\")
    || normalized === ".." || (id && (id.includes("..") || /[/\\\0]/.test(id)))) {
    throw new MediaResolutionError("path_traversal", "Path traversal detected in media reference.");
  }
  // Absolute/relative paths must match exactly. A basename match must never
  // authorize a different file elsewhere in the inbound storage directory.
  const alias = id ?? (!normalized.includes("/") && !normalized.includes("\\") ? normalized : undefined);
  const matches = authorizedAttachments(context).filter(item => {
    if (!item.path) return false;
    const filePath = normalizeMediaReference(item.path);
    if (normalized === filePath || normalized === item.url) return true;
    if (!alias) return false;
    const basename = path.basename(filePath);
    return alias === item.id || alias === basename || alias === path.basename(basename, path.extname(basename));
  });
  const paths = [...new Set(matches.map(item => normalizeMediaReference(item.path!)))];
  return paths.length === 1 ? paths[0] : undefined;
}

export function checkAttachmentAuthorized(rawRef: string, context?: MediaAuthorizationContext): { authorized: boolean; reason?: string } {
  try {
    if (!context) return { authorized: false, reason: "Cannot establish attachment ownership: no authorization context provided." };
    if (!authorizedAttachments(context).length) return { authorized: false, reason: "Cannot establish attachment ownership: no authorized media attachments found." };
    if (selectAuthorizedPath(rawRef, context)) return { authorized: true };
    return { authorized: false, reason: "Cannot establish attachment ownership from the current authorized media attachments." };
  } catch (err) {
    return { authorized: false, reason: err instanceof Error ? err.message : "Invalid media reference." };
  }
}

export async function resolveAndValidateLocalFile(rawPath: string, authContext?: MediaAuthorizationContext): Promise<{ realPath: string; mimeType: string; base64: string }> {
  const selected = selectAuthorizedPath(rawPath, authContext);
  if (!selected) throw new MediaResolutionError("unauthorized_media", "Attachment is not authorized in this turn.");
  const candidate = path.resolve(selected);
  // Reject symlinks in every path component, including links within the media
  // directory. Exact trusted paths are allowed outside the standard cache root.
  try {
    let cursor = path.parse(candidate).root;
    for (const part of candidate.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new MediaResolutionError("symlink_escape", "Symbolic links cannot be used for attachments.");
    }
  } catch (err) {
    if (err instanceof MediaResolutionError) throw err;
    throw new MediaResolutionError("image_not_found", "The authorized attachment is no longer available.");
  }
  let fd: Awaited<ReturnType<typeof fs.open>>;
  try { fd = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK); }
  catch { throw new MediaResolutionError("image_not_found", "The authorized attachment could not be opened."); }
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size === 0) throw new MediaResolutionError("invalid_image_content", "Attachment must be a non-empty regular file.");
    if (stat.size > MAX_IMAGE_BYTES) throw new MediaResolutionError("oversized_image", "Attachment exceeds the 4.5 MiB image limit.");
    const realPath = await fs.realpath(candidate);
    const current = await fs.stat(candidate);
    if (realPath !== candidate || stat.ino !== current.ino || stat.dev !== current.dev) throw new MediaResolutionError("symlink_escape", "Attachment changed while opening.");
    // One descriptor and a hard upper bound protect against replacement and
    // file growth between validation and reading. Never re-open by path.
    const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await fd.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_IMAGE_BYTES) throw new MediaResolutionError("oversized_image", "Attachment exceeds the 4.5 MiB image limit.");
    const mimeType = detectImageMimeTypeFromBuffer(buffer.subarray(0, Math.min(length, 64)));
    if (!mimeType) throw new MediaResolutionError("invalid_image_content", "Unsupported image content.");
    return { realPath, mimeType, base64: buffer.subarray(0, length).toString("base64") };
  } catch (err) {
    if (err instanceof MediaResolutionError) throw err;
    throw new MediaResolutionError("image_not_found", "The authorized attachment changed or could not be read.");
  } finally { await fd.close(); }
}

export async function resolveImagePayload(params: {
  imagePath?: string | undefined;
  imagePaths?: string[] | undefined;
  imageBase64?: string | undefined;
  imageMimeType?: string | undefined;
  images?: { base64: string; mimeType: string }[] | undefined;
  workspaceDir?: string | undefined;
  authContext?: MediaAuthorizationContext | undefined;
}): Promise<{ images?: ResolvedImage[]; image?: ResolvedImage }> {
  const effectiveAuthContext: MediaAuthorizationContext | undefined =
    params.authContext || params.workspaceDir
      ? {
          ...params.authContext,
          ...(params.workspaceDir && !params.authContext?.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        }
      : undefined;

  const directImages = params.images ?? (params.imageBase64 && params.imageMimeType ? [{ base64: params.imageBase64, mimeType: params.imageMimeType }] : undefined);

  if (directImages && directImages.length > 0) {
    if (directImages.length > MAX_IMAGES_COUNT) {
      throw new MediaResolutionError("too_many_images", `Maximum ${MAX_IMAGES_COUNT} images permitted per request (${directImages.length} provided).`);
    }

    let totalRawBytes = 0;
    const validated: ResolvedImage[] = [];
    for (const [idx, img] of directImages.entries()) {
      if (!img.base64 || !img.mimeType) {
        throw new MediaResolutionError("invalid_image_content", `Direct image payload at index ${idx} is missing base64 data or MIME type.`);
      }
      if (!["image/jpeg", "image/png", "image/webp", "image/heic"].includes(img.mimeType)) {
        throw new MediaResolutionError("invalid_image_content", `Unsupported MIME type '${img.mimeType}' at index ${idx}.`);
      }
      if (img.base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new MediaResolutionError("oversized_image", "Encoded attachment exceeds the image limit.");
      if (img.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(img.base64)) throw new MediaResolutionError("invalid_image_content", "Invalid base64 image encoding.");
      const buf = Buffer.from(img.base64, "base64");
      if (buf.toString("base64") !== img.base64) throw new MediaResolutionError("invalid_image_content", "Invalid base64 image encoding.");
      if (buf.length > MAX_IMAGE_BYTES) {
        throw new MediaResolutionError("oversized_image", `Direct image payload at index ${idx} exceeds 4.5 MiB raw limit (${buf.length} bytes).`);
      }
      totalRawBytes += buf.length;
      if (totalRawBytes > MAX_TOTAL_REQUEST_BYTES) {
        throw new MediaResolutionError(
          "oversized_image",
          `Total image payload exceeds maximum allowed request limit of 16 MiB (${totalRawBytes} bytes > ${MAX_TOTAL_REQUEST_BYTES} bytes).`,
        );
      }
      const detected = detectImageMimeTypeFromBuffer(buf.subarray(0, 64));
      if (!detected || detected !== img.mimeType) {
        throw new MediaResolutionError("invalid_image_content", `Direct image payload at index ${idx} failed magic-byte verification.`);
      }
      validated.push({ mimeType: img.mimeType, base64: img.base64 });
    }

    if (validated.length === 1 && validated[0]) {
      return { image: validated[0], images: validated };
    }
    return { images: validated };
  }

  const rawPaths: string[] = [];
  if (params.imagePaths && params.imagePaths.length > 0) {
    rawPaths.push(...params.imagePaths);
  } else if (params.imagePath) {
    rawPaths.push(params.imagePath);
  }

  if (rawPaths.length === 0) {
    return {};
  }

  if (rawPaths.length > MAX_IMAGES_COUNT) {
    throw new MediaResolutionError("too_many_images", `Maximum ${MAX_IMAGES_COUNT} images permitted per request (${rawPaths.length} requested).`);
  }

  let totalRawBytes = 0;
  const loadedImages: ResolvedImage[] = [];
  for (const raw of rawPaths) {
    const loaded = await resolveAndValidateLocalFile(raw, effectiveAuthContext);
    const byteLength = Buffer.byteLength(loaded.base64, "base64");
    totalRawBytes += byteLength;
    if (totalRawBytes > MAX_TOTAL_REQUEST_BYTES) {
      throw new MediaResolutionError(
        "oversized_image",
        `Total image payload exceeds maximum allowed request limit of 16 MiB (${totalRawBytes} bytes > ${MAX_TOTAL_REQUEST_BYTES} bytes).`,
      );
    }
    loadedImages.push({
      mimeType: loaded.mimeType,
      base64: loaded.base64,
    });
  }

  const first = loadedImages[0];
  if (loadedImages.length === 1 && first) {
    return { image: first, images: loadedImages };
  }
  if (loadedImages.length > 1) {
    return { images: loadedImages };
  }

  return {};
}

