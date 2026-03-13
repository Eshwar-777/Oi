export type BrowserPromptHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

export type BrowserPromptHookResult = {
  systemPrompt?: string;
  prependContext?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
};

export type BrowserLegacyPromptHookResult = BrowserPromptHookResult & {
  modelOverride?: string;
  providerOverride?: string;
};
