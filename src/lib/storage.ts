import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

const REGION = process.env.S3_REGION ?? "us-east-1";
const BUCKET = process.env.S3_BUCKET ?? "";
const ENDPOINT = process.env.S3_ENDPOINT;
const PUBLIC_URL_BASE = process.env.S3_PUBLIC_URL_BASE;

let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
    // The SDK's default checksum behavior bakes a CRC32-of-empty-body into the
    // signed URL for PutObject, which then fails when the browser PUTs the
    // real file. Disable for browser-based presigned uploads.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return cached;
}

export function publicUrlFor(key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  if (PUBLIC_URL_BASE) return `${PUBLIC_URL_BASE.replace(/\/$/, "")}/${encoded}`;
  if (ENDPOINT) return `${ENDPOINT.replace(/\/$/, "")}/${BUCKET}/${encoded}`;
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${encoded}`;
}

export function keyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (PUBLIC_URL_BASE) {
      const base = new URL(PUBLIC_URL_BASE);
      if (u.host === base.host) {
        const prefix = base.pathname.replace(/\/$/, "");
        const path = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;
        return decodeURIComponent(path.replace(/^\//, ""));
      }
    }
    if (
      u.hostname === `${BUCKET}.s3.${REGION}.amazonaws.com` ||
      u.hostname.startsWith(`${BUCKET}.s3.`)
    ) {
      return decodeURIComponent(u.pathname.replace(/^\//, ""));
    }
    if (u.pathname.startsWith(`/${BUCKET}/`)) {
      return decodeURIComponent(u.pathname.slice(`/${BUCKET}/`.length));
    }
    return null;
  } catch {
    return null;
  }
}

function safeName(filename: string): string {
  const cleaned = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return cleaned || "file";
}

export async function presignPut(
  prefix: string,
  filename: string,
  contentType: string,
  expiresIn = 60 * 5,
): Promise<{ uploadUrl: string; key: string; publicUrl: string; expiresIn: number }> {
  const random = crypto.randomBytes(12).toString("hex");
  const key = `${prefix}/${random}/${safeName(filename)}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(client(), cmd, { expiresIn });
  return { uploadUrl, key, publicUrl: publicUrlFor(key), expiresIn };
}

export async function uploadBuffer(
  buffer: Buffer,
  prefix: string,
  filename: string,
  contentType: string,
): Promise<{ key: string; publicUrl: string }> {
  const random = crypto.randomBytes(12).toString("hex");
  const key = `${prefix}/${random}/${safeName(filename)}`;
  await client().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );
  return { key, publicUrl: publicUrlFor(key) };
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteByUrl(url: string | null | undefined): Promise<void> {
  if (!url) return;
  const key = keyFromUrl(url);
  if (!key) return;
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    console.warn("[s3] delete failed", key, (e as Error).message);
  }
}

export async function deleteByUrls(urls: Array<string | null | undefined>): Promise<void> {
  const keys = urls
    .map((u) => (u ? keyFromUrl(u) : null))
    .filter((k): k is string => !!k);
  if (keys.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    try {
      await client().send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: slice.map((Key) => ({ Key })) },
        }),
      );
    } catch (e) {
      console.warn("[s3] batch delete failed", (e as Error).message);
    }
  }
}
