import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { bedrockFilesAiClient } from "./bedrock/files-ai-client";
import type { FilesAiClient } from "./files-ai";

export interface FilesAiProviderDeps {
  bedrock?: () => FilesAiClient;
  /** Resolves when AWS credentials exist, rejects when they do not. */
  bedrockCredentials?: () => Promise<unknown>;
}

/**
 * The AI client (Amazon Bedrock). It throws without AWS credentials, and
 * callers then send everything to human review instead of delivering it
 * unchecked.
 */
export async function configuredFilesAiClient(
  deps: FilesAiProviderDeps = {},
): Promise<FilesAiClient> {
  const credentials = deps.bedrockCredentials ?? (() => defaultProvider()());
  try {
    await credentials();
  } catch {
    throw new Error("No AWS credentials for Files AI.");
  }
  return (deps.bedrock ?? bedrockFilesAiClient)();
}
