import { existsSync } from "node:fs";
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
  const normParent = path.resolve(parent).toLowerCase();
  const normChild = path.resolve(child).toLowerCase();
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
    return decodeURIComponent(match[1]);
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

export function checkAttachmentAuthorized(
  rawRef: string,
  authContext?: MediaAuthorizationContext,
): { authorized: boolean; reason?: string } {
  if (!authContext) {
    return {
      authorized: false,
      reason: "Cannot establish attachment ownership: no authorization context provided. Path-based requests fail closed.",
    };
  }

  const normalized = normalizeMediaReference(rawRef);

  // Check for traversal in rawRef, normalized path, or ID
  if (
    rawRef.includes("\0") ||
    rawRef.includes("../") ||
    rawRef.includes("..\\") ||
    rawRef === ".." ||
    normalized.includes("\0") ||
    normalized.includes("../") ||
    normalized.includes("..\\") ||
    normalized === ".."
  ) {
    return { authorized: false, reason: "Path traversal detected in media reference." };
  }

  const mediaId = extractMediaId(normalized) ?? path.basename(normalized);
  if (mediaId.includes("..") || mediaId.includes("/") || mediaId.includes("\\") || mediaId.includes("\0")) {
    return { authorized: false, reason: "Path traversal detected in media reference." };
  }

  const authorizedIds = new Set<string>();
  const authorizedPaths = new Set<string>();
  const authorizedUrls = new Set<string>();

  const addAuthRef = (ref?: string) => {
    if (!ref) return;
    const norm = normalizeMediaReference(ref);
    authorizedUrls.add(norm.toLowerCase());
    authorizedPaths.add(path.resolve(norm).toLowerCase());
    const id = extractMediaId(norm) ?? path.basename(norm);
    authorizedIds.add(id.toLowerCase());
    const ext = path.extname(id);
    if (ext) {
      authorizedIds.add(path.basename(id, ext).toLowerCase());
    }
  };

  if (authContext.mediaPath) addAuthRef(authContext.mediaPath);
  if (authContext.mediaPaths) authContext.mediaPaths.forEach(addAuthRef);
  if (authContext.mediaUrl) addAuthRef(authContext.mediaUrl);
  if (authContext.mediaUrls) authContext.mediaUrls.forEach(addAuthRef);
  if (authContext.authorizedMediaPaths) authContext.authorizedMediaPaths.forEach(addAuthRef);
  if (authContext.authorizedMediaUrls) authContext.authorizedMediaUrls.forEach(addAuthRef);

  const checkItemOwnership = (item: { id?: string; path?: string; url?: string; senderId?: string; conversationId?: string }) => {
    if (item.senderId && authContext.senderId && item.senderId !== authContext.senderId) {
      return false;
    }
    if (item.conversationId && authContext.conversationId && item.conversationId !== authContext.conversationId) {
      return false;
    }
    return true;
  };

  if (authContext.inboundMedia) {
    for (const item of authContext.inboundMedia) {
      if (checkItemOwnership(item)) {
        addAuthRef(item.path);
        addAuthRef(item.url);
        if (item.id) authorizedIds.add(item.id.toLowerCase());
      }
    }
  }

  if (authContext.authorizedAttachments) {
    for (const item of authContext.authorizedAttachments) {
      if (checkItemOwnership(item)) {
        addAuthRef(item.path);
        addAuthRef(item.url);
        if (item.id) authorizedIds.add(item.id.toLowerCase());
      }
    }
  }

  if (authorizedIds.size === 0 && authorizedPaths.size === 0 && authorizedUrls.size === 0) {
    return {
      authorized: false,
      reason: "Cannot establish attachment ownership: no authorized media attachments found in runtime context. Refusing path-based media access.",
    };
  }

  const requestedLower = normalized.toLowerCase();
  const requestedIdLower = mediaId.toLowerCase();
  const requestedIdNoExt = path.extname(requestedIdLower) ? path.basename(requestedIdLower, path.extname(requestedIdLower)) : requestedIdLower;

  if (authorizedUrls.has(requestedLower)) return { authorized: true };
  if (authorizedIds.has(requestedIdLower) || authorizedIds.has(requestedIdNoExt)) return { authorized: true };
  if (authorizedPaths.has(path.resolve(normalized).toLowerCase())) return { authorized: true };

  return {
    authorized: false,
    reason: `Attachment '${rawRef}' is not authorized for sender '${authContext.senderId ?? "unknown"}' in conversation '${authContext.conversationId ?? "unknown"}'. Directory containment alone does not establish ownership.`,
  };
}

export async function resolveAndValidateLocalFile(
  rawPath: string,
  authContext?: MediaAuthorizationContext,
): Promise<{ realPath: string; mimeType: string; base64: string }> {
  const normalized = normalizeMediaReference(rawPath);

  // 1. Check for directory traversal sequences
  if (normalized.includes("\0") || rawPath.includes("..\\") || rawPath.includes("../") || rawPath === "..") {
    throw new MediaResolutionError("path_traversal", `Path traversal rejected: ${rawPath}`);
  }

  // 2. Verify authorization against sender/conversation context
  const authResult = checkAttachmentAuthorized(rawPath, authContext);
  if (!authResult.authorized) {
    throw new MediaResolutionError("unauthorized_media", authResult.reason ?? "Attachment is not authorized.");
  }

  // 3. Locate file on disk
  const mediaId = extractMediaId(normalized) ?? (path.isAbsolute(normalized) ? null : normalized);
  const allowedRoots = getAllowedMediaRoots(authContext?.workspaceDir);
  let resolvedCandidate: string | null = null;

  if (path.isAbsolute(normalized) && existsSync(normalized)) {
    resolvedCandidate = normalized;
  } else if (mediaId) {
    for (const root of allowedRoots) {
      const exact = path.join(root, mediaId);
      if (existsSync(exact)) {
        resolvedCandidate = exact;
        break;
      }
      for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".heic"]) {
        const withExt = path.join(root, `${mediaId}${ext}`);
        if (existsSync(withExt)) {
          resolvedCandidate = withExt;
          break;
        }
      }
      if (resolvedCandidate) break;
    }
  }

  if (!resolvedCandidate) {
    throw new MediaResolutionError("image_not_found", `Requested image attachment not found: ${rawPath}`);
  }

  // 4. Resolve symlinks and verify containment
  let realPath: string;
  try {
    realPath = await fs.realpath(resolvedCandidate);
  } catch {
    throw new MediaResolutionError("image_not_found", `Failed to resolve canonical path for: ${rawPath}`);
  }

  const explicitAllowedPaths = (authContext?.authorizedMediaPaths ?? []).map((p) => path.resolve(p).toLowerCase());
  const isInsideAllowedRoot = allowedRoots.some((root) => isPathInside(root, realPath));
  const isExplicitAllowedFile = explicitAllowedPaths.includes(realPath.toLowerCase());

  if (!isInsideAllowedRoot && !isExplicitAllowedFile) {
    throw new MediaResolutionError(
      "symlink_escape",
      `Attachment escapes authorized media storage via symlink or external path: ${rawPath} -> ${realPath}`,
    );
  }

  // 5. Bounded reads: check file stats before loading into memory
  const stat = await fs.stat(realPath);
  if (stat.isDirectory()) {
    throw new MediaResolutionError("invalid_image_content", `Specified path is a directory, not an image file: ${rawPath}`);
  }
  if (stat.size === 0) {
    throw new MediaResolutionError("invalid_image_content", `Image file is empty (0 bytes): ${rawPath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new MediaResolutionError(
      "oversized_image",
      `Image file exceeds maximum allowed size of 4.5 MiB (${stat.size} bytes > ${MAX_IMAGE_BYTES} bytes): ${rawPath}`,
    );
  }

  // 6. Inspect magic bytes header before full buffer read
  const fd = await fs.open(realPath, "r");
  const headerBuf = Buffer.alloc(64);
  try {
    const { bytesRead } = await fd.read(headerBuf, 0, 64, 0);
    const mimeType = detectImageMimeTypeFromBuffer(headerBuf.subarray(0, bytesRead));
    if (!mimeType) {
      throw new MediaResolutionError(
        "invalid_image_content",
        `File is not a valid supported image format (JPEG, PNG, WebP, HEIC). Header magic bytes do not match an image: ${rawPath}`,
      );
    }

    // 7. Safe bounded full buffer read
    const fullBuffer = await fs.readFile(realPath);
    return {
      realPath,
      mimeType,
      base64: fullBuffer.toString("base64"),
    };
  } finally {
    await fd.close();
  }
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
      const buf = Buffer.from(img.base64, "base64");
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
      if (!detected) {
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

