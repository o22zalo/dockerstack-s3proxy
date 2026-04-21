import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

function toBuffer(chunk) {
  if (!chunk) return Buffer.alloc(0)
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

export class S3Destination {
  constructor({ endpoint, accessKeyId, secretKey, bucket, region = 'us-east-1', forcePathStyle = true, prefix = '' } = {}) {
    this.bucket = bucket
    this.prefix = prefix
    this.client = new S3Client({
      endpoint,
      region,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey: secretKey,
      },
    })
  }

  withPrefix(key) {
    return `${this.prefix || ''}${key}`
  }

  async upload({ stream, key, contentType = 'application/octet-stream', size, signal }) {
    if (!this.bucket) throw new Error('s3 destination requires bucket')
    const targetKey = this.withPrefix(key)

    if ((Number(size) || 0) <= 5 * 1024 * 1024) {
      const response = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: targetKey,
        Body: stream,
        ContentType: contentType,
        ContentLength: (Number(size) || undefined),
      }), { abortSignal: signal })
      return { key: targetKey, location: `s3://${this.bucket}/${targetKey}`, etag: response.ETag?.replace(/"/g, '') || '' }
    }

    const create = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: targetKey,
      ContentType: contentType,
    }), { abortSignal: signal })

    const uploadId = create.UploadId
    const parts = []
    let partNumber = 1
    let pending = Buffer.alloc(0)
    const partSize = 5 * 1024 * 1024

    try {
      for await (const chunk of stream) {
        pending = Buffer.concat([pending, toBuffer(chunk)])
        while (pending.length >= partSize) {
          const partBody = pending.subarray(0, partSize)
          pending = pending.subarray(partSize)
          const response = await this.client.send(new UploadPartCommand({
            Bucket: this.bucket,
            Key: targetKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: partBody,
          }), { abortSignal: signal })
          parts.push({ ETag: response.ETag, PartNumber: partNumber })
          partNumber += 1
        }
      }

      if (pending.length > 0) {
        const response = await this.client.send(new UploadPartCommand({
          Bucket: this.bucket,
          Key: targetKey,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: pending,
        }), { abortSignal: signal })
        parts.push({ ETag: response.ETag, PartNumber: partNumber })
      }

      const completed = await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: targetKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }), { abortSignal: signal })

      return {
        key: targetKey,
        location: completed.Location || `s3://${this.bucket}/${targetKey}`,
        etag: completed.ETag?.replace(/"/g, '') || '',
      }
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: targetKey,
        UploadId: uploadId,
      })).catch(() => {})
      throw error
    }
  }

  async read(key) {
    const res = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.withPrefix(key),
    }))
    return res.Body
  }

  async exists(key) {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: this.withPrefix(key),
      }))
      return true
    } catch {
      return false
    }
  }

  async * listKeys(prefix = '') {
    let continuationToken
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: this.withPrefix(prefix),
        ContinuationToken: continuationToken,
      }))
      for (const item of res.Contents || []) {
        yield { key: item.Key, etag: item.ETag?.replace(/\"/g, '') || '', size: Number(item.Size || 0) }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : null
    } while (continuationToken)
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.withPrefix(key),
    }))
  }

  async getMetadata(key) {
    const res = await this.client.send(new HeadObjectCommand({
      Bucket: this.bucket,
      Key: this.withPrefix(key),
    }))
    return {
      etag: res.ETag?.replace(/\"/g, '') || '',
      size: Number(res.ContentLength || 0),
      contentType: res.ContentType || 'application/octet-stream',
    }
  }
}
