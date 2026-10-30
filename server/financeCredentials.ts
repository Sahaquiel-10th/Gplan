import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type SealedCredential = { version: 1; keyId: string; iv: string; tag: string; ciphertext: string };

export function credentialMasterKey(env: NodeJS.ProcessEnv = process.env) {
  const value = env.FINANCE_CREDENTIAL_MASTER_KEY?.trim() || "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("资金凭证加密主密钥未正确配置");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("资金凭证加密主密钥未正确配置");
  return key;
}

export function sealCredential(value: unknown, scope: string, key: Buffer): SealedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, keyId: createHash("sha256").update(key).digest("hex").slice(0, 16), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

export function openCredential<T>(value: SealedCredential, scope: string, key: Buffer): T {
  try {
    if (value.version !== 1 || value.keyId !== createHash("sha256").update(key).digest("hex").slice(0, 16)) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8")) as T;
  } catch {
    throw new Error("资金凭证解密失败，请联系维护人员检查主密钥或备份");
  }
}
