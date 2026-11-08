// Encryption for off-site backups. No database access here, so scripts/restore.js can use it safely.
//
// File format (.qbk):  "QBK1" | salt (16) | iv (12) | auth tag (16) | AES-256-GCM( gzip(SQLite file) )
// The key is derived from your passphrase with scrypt. GCM's auth tag means any change to the file — or a wrong
// passphrase — is detected on decryption; nothing is ever restored from a damaged or tampered backup.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const MAGIC = Buffer.from('QBK1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function checkPassphrase(pass) {
  if (!pass) throw new Error('BACKUP_ENCRYPTION_PASSPHRASE is not set');
  if (String(pass).length < 16) throw new Error('BACKUP_ENCRYPTION_PASSPHRASE must be at least 16 characters');
}
const deriveKey = (pass, salt) => crypto.scryptSync(String(pass), salt, 32, SCRYPT);
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** plaintext (SQLite bytes) → encrypted .qbk bytes */
export function encryptBackup(plain, pass) {
  checkPassphrase(pass);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(plain, { level: 9 })), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/** encrypted .qbk bytes → plaintext; throws if the passphrase is wrong or the file was changed in any way */
export function decryptBackup(enc, pass) {
  checkPassphrase(pass);
  if (enc.length < 48 || !enc.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Quote Bot encrypted backup (.qbk)');
  const salt = enc.subarray(4, 20), iv = enc.subarray(20, 32), tag = enc.subarray(32, 48);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  decipher.setAuthTag(tag);
  let gz;
  try { gz = Buffer.concat([decipher.update(enc.subarray(48)), decipher.final()]); }
  catch { throw new Error('Wrong passphrase, or the backup file was damaged/altered — refusing to use it'); }
  return zlib.gunzipSync(gz);
}
