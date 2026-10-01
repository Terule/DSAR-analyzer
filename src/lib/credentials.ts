import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";

// Credentials are independent from case data. This path is backed by the
// dedicated `aida_secrets` Docker volume, never by the user's DSAR folder.
const keyPath = "/run/aida-secrets/credentials.key";

async function key(): Promise<Buffer> {
  try {
    return Buffer.from((await fs.readFile(keyPath, "utf8")).trim(), "base64");
  } catch {
    const value = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, value.toString("base64"), { mode: 0o600 });
    return value;
  }
}

export async function encryptSetting(value: string): Promise<string> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", await key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

export async function decryptSetting(value: string | null): Promise<string> {
  if (!value) return "";
  const [iv, tag, body] = value.split(".");
  if (!iv || !tag || !body) throw new Error("Stored credential is invalid.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    await key(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(body, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function runtimeCredentials() {
  const row = await prisma.pipelineSettings.findUnique({
    where: { id: "global" },
    select: {
      openai_api_key_encrypted: true,
      azure_tenant_id_encrypted: true,
      azure_client_id_encrypted: true,
      azure_client_secret_encrypted: true,
      onetrust_client_id_encrypted: true,
      onetrust_client_secret_encrypted: true,
    },
  });
  return {
    openAiKey: await decryptSetting(row?.openai_api_key_encrypted || null),
    azureTenantId: await decryptSetting(row?.azure_tenant_id_encrypted || null),
    azureClientId: await decryptSetting(row?.azure_client_id_encrypted || null),
    azureClientSecret: await decryptSetting(
      row?.azure_client_secret_encrypted || null,
    ),
    oneTrustClientId: await decryptSetting(
      row?.onetrust_client_id_encrypted || null,
    ),
    oneTrustClientSecret: await decryptSetting(
      row?.onetrust_client_secret_encrypted || null,
    ),
  };
}
