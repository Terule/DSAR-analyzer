import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { bedrockFilesAiClient, isBedrockId } from "./bedrock/files-ai-client";
import { type FilesAiClient, openAiFilesAiClient } from "./files-ai";
import { type AiProvider, getAiBatchSettings } from "./pipeline-settings";

export interface FilesAiProviderDeps {
  provider?: AiProvider;
  openAi?: () => Promise<FilesAiClient>;
  bedrock?: () => FilesAiClient;
  /** Resolves when AWS credentials exist, rejects when they do not. */
  bedrockCredentials?: () => Promise<unknown>;
}

/**
 * The Files AI client for the configured provider. New work goes to that
 * provider, but a run already in flight is read by the provider that owns it
 * (Bedrock ids carry a prefix), so switching the setting never strands one.
 *
 * Submitting needs the configured provider: it throws without credentials, like
 * the OpenAI client does without a key, and callers then send everything to
 * human review. Polling (`forPolling`) only needs any provider that works, so
 * runs started with the other provider can still finish after the switch.
 */
export async function configuredFilesAiClient(
  options: { forPolling?: boolean } = {},
  deps: FilesAiProviderDeps = {},
): Promise<FilesAiClient> {
  const aiProvider = deps.provider ?? (await getAiBatchSettings()).aiProvider;
  const openAiFactory = deps.openAi ?? openAiFilesAiClient;
  const bedrockFactory = deps.bedrock ?? bedrockFilesAiClient;
  const credentials = deps.bedrockCredentials ?? (() => defaultProvider()());

  let openai: FilesAiClient | undefined;
  let bedrock: FilesAiClient | undefined;
  const getOpenAi = async () => {
    openai ??= await openAiFactory();
    return openai;
  };
  const getBedrock = () => {
    bedrock ??= bedrockFactory();
    return bedrock;
  };

  const usable = {
    openai: () =>
      getOpenAi().then(
        () => true,
        () => false,
      ),
    bedrock: () =>
      credentials().then(
        () => true,
        () => false,
      ),
  };
  const configuredOk = await usable[aiProvider ?? "openai"]();
  if (!configuredOk) {
    const other = aiProvider === "bedrock" ? "openai" : "bedrock";
    if (!options.forPolling || !(await usable[other]())) {
      throw new Error(`No ${aiProvider} credentials for Files AI.`);
    }
  }

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
