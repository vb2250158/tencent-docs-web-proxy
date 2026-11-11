import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RequestJournal } from './state.mjs';
import { uploadMedia } from './upload.mjs';
import { ProxyError } from './errors.mjs';

export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;

/** Validate the public submission fields before uploading or consuming entitlement. */
export function submissionOptions(options = {}) {
  const requestId = options.requestId || randomUUID();
  const language = options.language || '16k_zh';
  if (typeof requestId !== 'string' || !/^[\w.-]{1,128}$/.test(requestId)) throw new ProxyError('INVALID_REQUEST_ID', 'Idempotency-Key must contain 1–128 letters, digits, dots, hyphens or underscores.', { status: 400 });
  if (typeof language !== 'string' || !/^16k_[a-z]{2,3}$/.test(language)) throw new ProxyError('INVALID_LANGUAGE', 'Use a Tencent Docs language engine such as 16k_zh or 16k_en.', { status: 400 });
  if (options.speakerDiarization !== undefined && typeof options.speakerDiarization !== 'boolean') throw new ProxyError('INVALID_OPTIONS', 'speakerDiarization must be a boolean.', { status: 400 });
  if (options.speakerDiarization && !['16k_zh', '16k_en', '16k_ms', '16k_id'].includes(language)) throw new ProxyError('INVALID_OPTIONS', 'The web tool supports speaker separation for Chinese, English, Malay and Indonesian.', { status: 400 });
  const fileName = options.fileName;
  if (typeof fileName !== 'string' || !fileName || fileName.length > 240 || /[\x00-\x1f\\/]/.test(fileName)) throw new ProxyError('INVALID_FILENAME', 'Supply a plain file name with no directory components.', { status: 400 });
  return { requestId, language, speakerDiarization: options.speakerDiarization ?? false, fileName };
}

/** Owns upload/submission orchestration and the durable idempotency journal. */
export class TranscriptionService {
  constructor(client, root, { upload = uploadMedia } = {}) {
    this.client = client;
    this.journal = new RequestJournal(root);
    this.upload = upload;
  }
  async submitFile(path, options = {}) {
    const spec = submissionOptions({ ...options, fileName: options.fileName ?? basename(path) });
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MEDIA_BYTES) throw new ProxyError('INVALID_MEDIA_SIZE', 'Provide a nonempty regular media file no larger than 1 GiB.', { status: 413 });
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
      const fingerprint = hash.update(JSON.stringify({ fileName: spec.fileName, language: spec.language, speakerDiarization: spec.speakerDiarization })).digest('hex');
      const previous = await this.journal.claim(spec.requestId, fingerprint);
      if (previous) return previous;
      const uploaded = await this.upload(this.client.transport, handle, stat.size);
      const media = await this.client.mediaInfo(uploaded.objectKey);
      let accepted;
      try { accepted = await this.client.submit({ ...uploaded, ...spec }); }
      catch (error) {
        if (error instanceof ProxyError && error.code === 'UPSTREAM_REJECTED') throw error;
        throw new ProxyError('SUBMISSION_OUTCOME_UNKNOWN', 'The task may have been accepted. Check Tencent Docs history using the original request ID before submitting again.', { status: 502, details: { requestId: spec.requestId } });
      }
      const result = { requestId: spec.requestId, ...accepted, ...media };
      try { await this.journal.complete(spec.requestId, fingerprint, result); }
      catch { throw new ProxyError('JOURNAL_WRITE_FAILED', 'Tencent Docs accepted this task, but the local receipt could not be saved. Query this task ID directly.', { status: 500, details: result }); }
      return result;
    } finally { await handle.close(); }
  }
}
