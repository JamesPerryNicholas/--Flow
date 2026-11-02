const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');

const MAGIC = Buffer.from('LJF1');
const AAD = Buffer.from('lingjing-flow:file-key:v1');

// Unix local-only storage. The key is protected by owner-only filesystem
// permissions, not an OS keychain; possession of both files permits decryption.
function fileKeyCodec({ keyPath, allowCreate = true }) {
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(dir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid()) throw Error('密钥目录需要属于当前账户、权限为 0700，且不能是符号链接。');
  if (!fs.existsSync(keyPath)) {
    if (!allowCreate) throw Error('加密配置的本机密钥丢失，请恢复原密钥；不能生成新密钥覆盖现有配置。');
    const temp = path.join(dir, `.key-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: 'wx' });
      try { fs.linkSync(temp, keyPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { try { fs.unlinkSync(temp); } catch {} }
  }
  // O_NOFOLLOW and fstat avoid reading a symlink, device, or world-readable key.
  const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let key;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw Error('本机密钥必须属于当前账户、权限为 0600，且为 32 字节的独立普通文件。');
    key = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  return {
    encrypt(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(value) {
      if (!Buffer.isBuffer(value) || value.length < 32 || !value.subarray(0, 4).equals(MAGIC)) throw Error('加密配置格式无效。');
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(4, 16));
      decipher.setAAD(AAD); decipher.setAuthTag(value.subarray(16, 32));
      return Buffer.concat([decipher.update(value.subarray(32)), decipher.final()]);
    },
  };
}

module.exports = { fileKeyCodec };
