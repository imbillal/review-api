import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_SECRET_API_KEY,
  api_secret: process.env.CLOUDINARY_SECRET,
  secure: true,
});

export type UploadedAsset = {
  publicId: string;
  url: string;
  bytes: number;
  format: string;
  pages?: number;
};

/**
 * Upload a PDF (or any raw file) buffer to Cloudinary.
 * `resource_type: "raw"` keeps the file bit-identical — Cloudinary won't try to
 * transform the PDF. We still get back a `secure_url` we can serve.
 */
export async function uploadPdfBuffer(
  buffer: Buffer,
  filename: string,
  folder = "pinion/documents",
): Promise<UploadedAsset> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder,
        filename_override: filename,
        use_filename: false,
        unique_filename: true,
      },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error("Cloudinary upload failed"));
        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          bytes: result.bytes,
          format: result.format ?? "pdf",
          pages: (result as { pages?: number }).pages,
        });
      },
    );
    stream.end(buffer);
  });
}

export async function deleteAsset(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
}
