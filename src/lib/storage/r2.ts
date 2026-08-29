import { PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../../config.js";

function client(): S3Client {
  if (!config.r2AccountId || !config.r2AccessKeyId || !config.r2SecretAccessKey || !config.r2Bucket) throw new Error("R2 storage is not configured");
  return new S3Client({ region: "auto", endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey } });
}
export function r2Configured(): boolean { return Boolean(config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket); }
export async function signR2Upload(key: string, contentType: string): Promise<string> { return getSignedUrl(client(), new PutObjectCommand({ Bucket: config.r2Bucket, Key: key, ContentType: contentType }), { expiresIn: 300 }); }
export async function signR2Download(key: string): Promise<string> { return getSignedUrl(client(), new GetObjectCommand({ Bucket: config.r2Bucket, Key: key }), { expiresIn: 300 }); }
export async function inspectR2Object(key: string): Promise<{ size: number; contentType?: string }> { const result = await client().send(new HeadObjectCommand({ Bucket: config.r2Bucket, Key: key })); return { size: Number(result.ContentLength ?? -1), contentType: result.ContentType?.toLowerCase() }; }
export async function deleteR2Object(key: string): Promise<void> { await client().send(new DeleteObjectCommand({ Bucket: config.r2Bucket, Key: key })); }
