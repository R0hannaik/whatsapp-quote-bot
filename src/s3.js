// Minimal client for S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO…).
// Only three operations are used — upload, list, download. The app never deletes anything in the bucket, so the
// access key it holds does not need (and should not have) delete permission.
import crypto from 'node:crypto';
import { AwsClient } from 'aws4fetch';

export function s3Config(env = process.env) {
  const c = {
    endpoint: (env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
    region: env.BACKUP_S3_REGION || 'auto',
    bucket: env.BACKUP_S3_BUCKET || '',
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY || '',
    prefix: (env.BACKUP_S3_PREFIX ?? 'quotebot/').replace(/^\/+/, ''),
    pathStyle: env.BACKUP_S3_PATH_STYLE === '1',
  };
  c.configured = !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
  if (c.endpoint && !/^https:\/\//.test(c.endpoint) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(c.endpoint)) {
    c.configured = false; c.problem = 'BACKUP_S3_ENDPOINT must start with https://';
  }
  // Local test servers / IPs only work path-style
  if (/^http:\/\//.test(c.endpoint)) c.pathStyle = true;
  return c;
}

const encKey = key => key.split('/').map(encodeURIComponent).join('/');
function objectUrl(c, key = '') {
  if (c.pathStyle) return `${c.endpoint}/${c.bucket}/${encKey(key)}`;
  const u = new URL(c.endpoint);
  return `${u.protocol}//${c.bucket}.${u.host}/${encKey(key)}`;
}
const client = c => new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 's3', retries: 2 });

async function check(res, what) {
  if (res.ok) return res;
  const body = (await res.text().catch(() => '')).slice(0, 300);
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  throw new Error(`${what} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
}

export async function putObject(c, key, body, meta = {}) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    // Integrity in transit — and required by S3 when the bucket uses Object Lock
    'Content-MD5': crypto.createHash('md5').update(body).digest('base64'),
  };
  for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = String(v);
  await check(await client(c).fetch(objectUrl(c, key), { method: 'PUT', headers, body }), 'Upload');
}

export async function getObject(c, key) {
  const res = await check(await client(c).fetch(objectUrl(c, key)), 'Download');
  const meta = {};
  res.headers.forEach((v, k) => { if (k.startsWith('x-amz-meta-')) meta[k.slice(11)] = v; });
  return { body: Buffer.from(await res.arrayBuffer()), meta };
}

export async function listObjects(c, prefix = c.prefix) {
  const out = [];
  let token = null;
  do {
    const u = new URL(objectUrl(c, ''));
    u.searchParams.set('list-type', '2');
    u.searchParams.set('prefix', prefix);
    if (token) u.searchParams.set('continuation-token', token);
    const xml = await (await check(await client(c).fetch(u.toString()), 'List')).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const get = t => m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
      out.push({ key: get('Key').replace(/&amp;/g, '&'), size: Number(get('Size') || 0), lastModified: get('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : null;
  } while (token);
  return out;
}
