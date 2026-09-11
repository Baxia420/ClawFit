import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkAttachmentAuthorized,
  detectImageMimeTypeFromBuffer,
  isPathInside,
  resolveAndValidateLocalFile,
  resolveImagePayload,
  type MediaAuthorizationContext,
} from "./media-resolver.js";

describe("media-resolver", () => {
  const testWorkspaceDir = path.join(tmpdir(), "clawfit-test-media-workspace");
  const testInboundDir = path.join(testWorkspaceDir, "media", "inbound");

  // Valid image magic bytes samples
  const validJpegBuffer = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]),
    Buffer.alloc(100, 0xaa),
  ]);

  const validPngBuffer = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100, 0xbb),
  ]);

  const validWebpBuffer = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("WEBPVP8 "),
    Buffer.alloc(100, 0xcc),
  ]);

  const validHeicBuffer = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypheic"),
    Buffer.alloc(100, 0xdd),
  ]);

  const plainTextBuffer = Buffer.from("Hello world! This is a plain text file, not an image.", "utf-8");

  beforeEach(() => {
    if (existsSync(testWorkspaceDir)) {
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
    mkdirSync(testInboundDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testWorkspaceDir)) {
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    }
  });

  describe("detectImageMimeTypeFromBuffer", () => {
    it("identifies JPEG headers", () => {
      expect(detectImageMimeTypeFromBuffer(validJpegBuffer)).toBe("image/jpeg");
    });

    it("identifies PNG headers", () => {
      expect(detectImageMimeTypeFromBuffer(validPngBuffer)).toBe("image/png");
    });

    it("identifies WebP headers", () => {
      expect(detectImageMimeTypeFromBuffer(validWebpBuffer)).toBe("image/webp");
    });

    it("identifies HEIC headers", () => {
      expect(detectImageMimeTypeFromBuffer(validHeicBuffer)).toBe("image/heic");
    });

    it("rejects plain text and arbitrary byte sequences", () => {
      expect(detectImageMimeTypeFromBuffer(plainTextBuffer)).toBeNull();
      expect(detectImageMimeTypeFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
      expect(detectImageMimeTypeFromBuffer(Buffer.alloc(0))).toBeNull();
    });
  });

  describe("isPathInside", () => {
    it("returns true for descendants and exact matches", () => {
      const parent = path.join("C:", "data", "media");
      expect(isPathInside(parent, path.join("C:", "data", "media"))).toBe(true);
      expect(isPathInside(parent, path.join("C:", "data", "media", "sub", "file.jpg"))).toBe(true);
    });

    it("returns false for outside paths and traversals", () => {
      const parent = path.join("C:", "data", "media");
      expect(isPathInside(parent, path.join("C:", "data", "other", "file.jpg"))).toBe(false);
      expect(isPathInside(parent, path.join("C:", "data", "media", "..", "other", "file.jpg"))).toBe(false);
    });
  });

  describe("checkAttachmentAuthorized", () => {
    it("fails closed when no authorization context is provided", () => {
      const res = checkAttachmentAuthorized("test.jpg", undefined);
      expect(res.authorized).toBe(false);
      expect(res.reason).toContain("no authorization context provided");
    });

    it("fails closed when context has no authorized media records", () => {
      const res = checkAttachmentAuthorized("test.jpg", {
        senderId: "user-1",
        conversationId: "conv-1",
      });
      expect(res.authorized).toBe(false);
      expect(res.reason).toContain("no authorized media attachments found");
    });

    it("rejects path traversal in reference", () => {
      const res = checkAttachmentAuthorized("../../etc/passwd", {
        senderId: "user-1",
        authorizedMediaPaths: ["../../etc/passwd"],
      });
      expect(res.authorized).toBe(false);
      expect(res.reason).toContain("Path traversal");
    });

    it("authorizes media when sender and conversation match", () => {
      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        conversationId: "conv-1",
        authorizedMediaPaths: [path.join(testInboundDir, "photo1.jpg")],
      };
      const res = checkAttachmentAuthorized(path.join(testInboundDir, "photo1.jpg"), context);
      expect(res.authorized).toBe(true);
    });

    it("authorizes media by basename or media URI ID", () => {
      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        conversationId: "conv-1",
        inboundMedia: [
          { id: "img-12345", path: path.join(testInboundDir, "img-12345.jpg"), senderId: "user-1", conversationId: "conv-1" },
        ],
      };
      expect(checkAttachmentAuthorized("media://inbound/img-12345", context).authorized).toBe(true);
      expect(checkAttachmentAuthorized("img-12345.jpg", context).authorized).toBe(true);
      expect(checkAttachmentAuthorized("img-12345", context).authorized).toBe(true);
    });

    it("rejects attachment belonging to a different sender", () => {
      const context: MediaAuthorizationContext = {
        senderId: "user-A",
        conversationId: "group-1",
        inboundMedia: [
          { id: "img-user-b", path: path.join(testInboundDir, "img-user-b.jpg"), senderId: "user-B", conversationId: "group-1" },
        ],
      };
      const res = checkAttachmentAuthorized("img-user-b.jpg", context);
      expect(res.authorized).toBe(false);
    });
  });

  describe("resolveAndValidateLocalFile", () => {
    it("successfully loads and verifies a valid authorized JPEG", async () => {
      const filePath = path.join(testInboundDir, "salad.jpg");
      writeFileSync(filePath, validJpegBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [filePath],
      };

      const result = await resolveAndValidateLocalFile(filePath, context);
      expect(result.mimeType).toBe("image/jpeg");
      expect(result.base64).toBe(validJpegBuffer.toString("base64"));
    });

    it("successfully loads and verifies a valid authorized PNG", async () => {
      const filePath = path.join(testInboundDir, "protein.png");
      writeFileSync(filePath, validPngBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [filePath],
      };

      const result = await resolveAndValidateLocalFile(filePath, context);
      expect(result.mimeType).toBe("image/png");
      expect(result.base64).toBe(validPngBuffer.toString("base64"));
    });

    it("rejects unrelated text files even with a .jpg extension (invalid_image_content)", async () => {
      const fakeImagePath = path.join(testInboundDir, "fake.jpg");
      writeFileSync(fakeImagePath, plainTextBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [fakeImagePath],
      };

      await expect(resolveAndValidateLocalFile(fakeImagePath, context)).rejects.toThrowError(
        expect.objectContaining({ code: "invalid_image_content" }),
      );
    });

    it("rejects empty (0-byte) files before inference", async () => {
      const emptyPath = path.join(testInboundDir, "empty.jpg");
      writeFileSync(emptyPath, Buffer.alloc(0));

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [emptyPath],
      };

      await expect(resolveAndValidateLocalFile(emptyPath, context)).rejects.toThrowError(
        expect.objectContaining({ code: "invalid_image_content" }),
      );
    });

    it("rejects missing files (image_not_found)", async () => {
      const nonExistent = path.join(testInboundDir, "ghost.jpg");
      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [nonExistent],
      };

      await expect(resolveAndValidateLocalFile(nonExistent, context)).rejects.toThrowError(
        expect.objectContaining({ code: "image_not_found" }),
      );
    });

    it("rejects path traversal sequences (path_traversal)", async () => {
      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: ["..\\..\\windows\\system32\\cmd.exe"],
      };

      await expect(resolveAndValidateLocalFile("..\\..\\windows\\system32\\cmd.exe", context)).rejects.toThrowError(
        expect.objectContaining({ code: "path_traversal" }),
      );
    });

    it("rejects unauthorized attachments from another sender (unauthorized_media)", async () => {
      const filePath = path.join(testInboundDir, "partner-meal.jpg");
      writeFileSync(filePath, validJpegBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-primary",
        workspaceDir: testWorkspaceDir,
        inboundMedia: [
          { id: "partner-meal.jpg", path: filePath, senderId: "user-partner" },
        ],
      };

      await expect(resolveAndValidateLocalFile(filePath, context)).rejects.toThrowError(
        expect.objectContaining({ code: "unauthorized_media" }),
      );
    });

    it("rejects symlink escape when realpath escapes authorized media storage (symlink_escape)", async () => {
      const fileInside = path.join(testInboundDir, "escape.jpg");
      writeFileSync(fileInside, validJpegBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [fileInside],
      };

      // Mock fs.realpath to simulate symlink resolving to an external outside path
      const externalPath = path.resolve(tmpdir(), "outside-secret-file.jpg");
      vi.spyOn(fs, "realpath").mockResolvedValue(externalPath);

      await expect(resolveAndValidateLocalFile(fileInside, context)).rejects.toThrowError(
        expect.objectContaining({ code: "symlink_escape" }),
      );
    });

    it("enforces bounded reads: rejects oversized file > 4.5 MiB before full read", async () => {
      const oversizedPath = path.join(testInboundDir, "huge.jpg");
      writeFileSync(oversizedPath, validJpegBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [oversizedPath],
      };

      // Mock fs.stat to report 5 MiB without having to create a 5MB file on disk
      vi.spyOn(fs, "stat").mockResolvedValue({
        isDirectory: () => false,
        size: 5 * 1024 * 1024,
      } as any);

      await expect(resolveAndValidateLocalFile(oversizedPath, context)).rejects.toThrowError(
        expect.objectContaining({ code: "oversized_image" }),
      );
    });
  });

  describe("resolveImagePayload", () => {
    it("returns empty object when no image is requested (valid for text-only estimation)", async () => {
      const res = await resolveImagePayload({});
      expect(res).toEqual({});
    });

    it("resolves multiple authorized images when requested as a pair (e.g. food + label)", async () => {
      const img1 = path.join(testInboundDir, "front.jpg");
      const img2 = path.join(testInboundDir, "label.png");
      writeFileSync(img1, validJpegBuffer);
      writeFileSync(img2, validPngBuffer);

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [img1, img2],
      };

      const result = await resolveImagePayload({
        imagePaths: [img1, img2],
        authContext: context,
      });

      expect(result.images).toHaveLength(2);
      expect(result.images![0]!.mimeType).toBe("image/jpeg");
      expect(result.images![1]!.mimeType).toBe("image/png");
    });

    it("never silently drops invalid images in a multi-image request: fails whole set", async () => {
      const validImg = path.join(testInboundDir, "plate.jpg");
      const badImg = path.join(testInboundDir, "corrupted.jpg");
      writeFileSync(validImg, validJpegBuffer);
      writeFileSync(badImg, plainTextBuffer); // text file, invalid image content

      const context: MediaAuthorizationContext = {
        senderId: "user-1",
        workspaceDir: testWorkspaceDir,
        authorizedMediaPaths: [validImg, badImg],
      };

      await expect(
        resolveImagePayload({
          imagePaths: [validImg, badImg],
          authContext: context,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "invalid_image_content" }),
      );
    });

    it("rejects image count exceeding MAX_IMAGES_COUNT (4)", async () => {
      const paths = ["img1.jpg", "img2.jpg", "img3.jpg", "img4.jpg", "img5.jpg"];
      await expect(
        resolveImagePayload({
          imagePaths: paths,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "too_many_images" }),
      );
    });

    it("validates direct base64 image payloads and checks magic bytes", async () => {
      const validBase64 = validJpegBuffer.toString("base64");
      const result = await resolveImagePayload({
        imageBase64: validBase64,
        imageMimeType: "image/jpeg",
      });
      expect(result.image).toBeDefined();
      expect(result.image!.mimeType).toBe("image/jpeg");
    });

    it("rejects direct base64 image payload if magic bytes do not match", async () => {
      const textBase64 = plainTextBuffer.toString("base64");
      await expect(
        resolveImagePayload({
          imageBase64: textBase64,
          imageMimeType: "image/jpeg",
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "invalid_image_content" }),
      );
    });

    it("rejects direct base64 payload exceeding total request limit (16 MiB)", async () => {
      // 4 images of 4.2 MB each = 16.8 MB > 16 MB total limit
      const bigBuf = Buffer.concat([validJpegBuffer, Buffer.alloc(4.2 * 1024 * 1024, 0x11)]);
      const base64 = bigBuf.toString("base64");
      await expect(
        resolveImagePayload({
          images: [
            { mimeType: "image/jpeg", base64 },
            { mimeType: "image/jpeg", base64 },
            { mimeType: "image/jpeg", base64 },
            { mimeType: "image/jpeg", base64 },
          ],
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "oversized_image" }),
      );
    });
  });
});