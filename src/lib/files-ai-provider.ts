import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { bedrockFilesAiClient, isBedrockId } from "./bedrock/files-ai-client";
import { type FilesAiClient, openAiFilesAiClient } from "./files-ai";
import { getAiBatchSettings } from "./pipeline-settings";

/**
 * The Files AI client for the configured provider. New work goes to that
 * provider, but a run already in flight is polled by the provider that owns
 * it (Bedrock ids carry a prefix), so switching the setting never strands one.
 * Throws when the configured provider has no credentials, like the OpenAI
 * client does without a key: callers then send everything to human review.
 */
export async function configuredFilesAiClient(): Promise<FilesAiClient> {
  const { aiProvider } = await getAiBatchSettings();
  let openai: FilesAiClient | undefined;
  let bedrock: FilesAiClient | undefined;
  const getOpenAi = async () => {
    openai ??= await openAiFilesAiClient();
    return openai;
  };
  const getBedrock = () => {
    bedrock ??= bedrockFilesAiClient();
    return bedrock;
  };
  // Fail early on the configured provider, as the OpenAI client always did.
  if (aiProvider === "bedrock") await defaultProvider()();
  else await getOpenAi();
  const owner = async (id: string) =>
    isBedrockId(id) ? getBedrock() : getOpenAi();
  return {
    async uploadBatchFile(filePath) {
      return aiProvider === "bedrock"
        ? getBedrock().uploadBatchFile(filePath)
        : (await getOpenAi()).uploadBatchFile(filePath);
    },
    async createBatch(inputFileId) {
      return (await owner(inputFileId)).createBatch(inputFileId);
    },
    async retrieveBatch(batchId) {
      return (await owner(batchId)).retrieveBatch(batchId);
    },
    async readFile(fileId) {
      return (await owner(fileId)).readFile(fileId);
    },
  };
}
