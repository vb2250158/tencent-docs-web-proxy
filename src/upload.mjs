import COS from 'cos-nodejs-sdk-v5';
import { createHash, randomBytes } from 'node:crypto';
import { ENDPOINTS } from './transport.mjs';
import { ProxyError } from './errors.mjs';

/** Use the provider's scoped COS credential with Tencent's maintained upload SDK. */
export async function uploadMedia(transport, handle, size, { Cos = COS } = {}) {
  const result = await transport.post(ENDPOINTS.credentials, null);
  const cred = result?.cred;
  if (!cred || !/^[a-z0-9][a-z0-9-]*-\d+$/.test(cred.bucket) || !/^[a-z]{2}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(cred.region)
      || typeof cred.resource !== 'string' || !cred.resource.includes('*')
      || typeof cred.credential?.secretId !== 'string' || typeof cred.credential?.secretKey !== 'string' || typeof cred.credential?.token !== 'string') {
    throw new ProxyError('UPSTREAM_INVALID_RESPONSE', 'Tencent Docs temporary upload credential fields are missing.');
  }
  const objectKey = cred.resource.replaceAll('*', createHash('md5').update(randomBytes(32)).digest('hex'));
  const cos = new Cos({ SecretId: cred.credential.secretId, SecretKey: cred.credential.secretKey, SecurityToken: cred.credential.token, Protocol: 'https:', FileParallelLimit: 1 });
  const body = handle.createReadStream({ start: 0, autoClose: false });
  try {
    await cos.putObject({ Bucket: cred.bucket, Region: cred.region, Key: objectKey, Body: body, ContentLength: size });
  } catch {
    throw new ProxyError('UPLOAD_FAILED', 'The media upload to Tencent COS failed. No transcription submission was attempted.');
  } finally { body.destroy(); }
  return { objectKey, cosURL: `https://${cred.bucket}.cos.${cred.region}.myqcloud.com/${objectKey.split('/').map(encodeURIComponent).join('/')}` };
}
