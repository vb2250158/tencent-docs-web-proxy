import { setTimeout as delay } from 'node:timers/promises';
import { ProxyError } from './errors.mjs';
import { DOCS_ORIGIN, ENDPOINTS, WebTransport } from './transport.mjs';

/** Normalize the protocol-relative result link used by the current web service. */
function resultDocumentUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  let url;
  try { url = new URL(value, DOCS_ORIGIN); }
  catch { throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs returned an invalid result document URL.'); }
  if (typeof value !== 'string' || url.origin !== DOCS_ORIGIN || url.username || url.password) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'The result document URL must belong to Tencent Docs.');
  return url.href;
}

/** Provider client; all methods use the signed-in user's Tencent Docs web session. */
export class TencentDocsClient {
  constructor(transport) { this.transport = transport; }
  static fromCookie(cookie, options) { return new TencentDocsClient(new WebTransport(cookie, options)); }

  async quota() {
    const result = await this.transport.post(ENDPOINTS.quota, { id: [25] });
    const info = result?.info?.[0];
    if (!info || !Number.isFinite(info.rest) || !Number.isFinite(info.total)) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Transcription entitlement fields are missing.');
    return { remainingSeconds: info.rest, totalSeconds: info.total };
  }

  async history() {
    const result = await this.transport.post(ENDPOINTS.history, {});
    if (!Array.isArray(result?.records)) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Transcription history is missing.');
    return result.records;
  }

  async mediaInfo(objectKey) {
    const result = await this.transport.post(ENDPOINTS.mediaInfo, { objKey: objectKey, isTemp: true });
    const durations = [result?.mediaInfo?.audio?.length, result?.mediaInfo?.video?.length, result?.mediaInfo?.length];
    const seconds = durations.map(value => typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN).find(value => Number.isFinite(value) && value > 0);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new ProxyError('INVALID_MEDIA', 'Tencent Docs could not identify a positive media duration.', { status: 422 });
    if (seconds > 18_000) throw new ProxyError('MEDIA_TOO_LONG', 'Tencent Docs web transcription supports at most five hours per file.', { status: 422 });
    return { durationSeconds: seconds };
  }

  /** Submission is attempted exactly once. Preserve the task ID for subsequent reads. */
  async submit({ objectKey, cosURL, fileName, language = '16k_zh', speakerDiarization = false }) {
    const result = await this.transport.post(ENDPOINTS.submit, {
      cosURL, objKey: objectKey, objName: fileName,
      language, speakerDiarization, parentName: '',
    });
    if (typeof result?.taskId !== 'string' || !result.taskId) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs did not return a task ID. Check history before submitting again.');
    return { taskId: result.taskId };
  }

  async status(taskId) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new ProxyError('INVALID_TASK_ID', 'A nonempty Tencent Docs task ID is required.', { status: 400 });
    const result = await this.transport.post(ENDPOINTS.record, { taskId });
    const record = result?.record;
    if (!record || !Number.isFinite(record.progress) || !Number.isInteger(record.errCode)) throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs task status fields are missing.');
    return { taskId, state: record.errCode !== 0 || record.progress === -1 ? 'failed' : record.progress === 100 ? 'completed' : 'processing', progress: record.progress, errorCode: record.errCode, fileUrl: resultDocumentUrl(record.fileUrl) };
  }

  /** Stop only local polling on timeout/cancel; the provider task remains available. */
  async wait(taskId, { timeoutMs = 30 * 60_000, intervalMs = 3000, signal } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal?.throwIfAborted();
      const result = await this.status(taskId);
      if (result.state !== 'processing') return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProxyError('POLL_TIMEOUT', 'Local polling timed out. Resume querying the same task ID.', { status: 504, details: { taskId } });
      await delay(Math.min(intervalMs, remaining), undefined, { signal });
    }
  }
}
