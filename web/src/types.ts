export type ProviderKind = 'openai-api' | 'local-bridge' | 'native-subscription';
export type ProviderStatus = 'ready' | 'not-configured' | 'offline' | 'error';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ThinkingMapSource = 'provider-default' | 'provider-docs' | 'request-probe' | 'user';
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelDefinition {
  id: string;
  name: string;
  family?: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
  thinkingLevelMap: ThinkingLevelMap;
  thinkingMapSource: ThinkingMapSource;
  thinkingMapVerified: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
}

export interface ProviderState {
  id: string;
  name: string;
  kind: ProviderKind;
  piProvider?: string;
  baseUrl?: string;
  credentialEnv?: string;
  description?: string;
  bridgePath?: string;
  credentialConfigured: boolean;
  status: ProviderStatus;
  detail: string;
  models: ModelDefinition[];
}

export interface ActiveRoute {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind | '';
  modelId: string;
  modelName: string;
  thinking: string;
  model: ModelDefinition | null;
}

export interface GatewayStats {
  requests: number;
  successful: number;
  failed: number;
  lastRequestAt: string | null;
  lastError: string | null;
}

export interface ManagerEvent {
  id: string;
  at: string;
  type: string;
  message: string;
  detail: string;
}

export interface ProviderConnectionTestResult {
  providerId: string;
  providerName: string;
  ok: boolean;
  category: 'success' | 'auth' | 'not_found' | 'rate_limit' | 'timeout' | 'dns' | 'tls' | 'network' | 'protocol' | 'subscription' | 'unknown';
  message: string;
  detail: string;
  status: number;
  testedAt: string;
  durationMs: number;
}

export interface CycleListEntry {
  index: number;
  ref: string;
  providerId: string;
  providerName: string;
  providerStatus: ProviderStatus | 'missing';
  modelId: string;
  modelName: string;
  valid: boolean;
  reason: 'provider-missing' | 'model-missing' | 'provider-unready' | 'ok';
}

export interface ManagerState {
  app: {
    name: string;
    version: string;
    platform: string;
  };
  targetProject: string;
  cycle: {
    modelRefs: string[];
    entries: CycleListEntry[];
  };
  active: ActiveRoute;
  providers: ProviderState[];
  gateway: {
    enabled: boolean;
    host: string;
    port: number;
    running: boolean;
    stats: GatewayStats;
    lastEvent: Record<string, unknown> | null;
  };
  configuration: {
    revision: number;
    appliedRevision: number;
    dirty: boolean;
  };
  runtime: {
    profilePath: string;
    extensionPath: string;
    configRevision: number;
    appliedRevision: number;
    appliedSnapshot: Record<string, unknown> | null;
    lastAppliedAt: string | null;
    lastLaunchAt: string | null;
    lastLaunchPid: number | null;
    lastStopAt: string | null;
    lastError: string | null;
    lastLiveImportAt: string | null;
    lastLiveBackupDir: string;
    lastLiveVerify: { ok: boolean; error: string; refs: string[] } | null;
    gatewayStats: GatewayStats;
    piExecutable: string;
  };
  pi: {
    installed: boolean;
    path: string;
    version: string;
    subscriptionReady: boolean;
    authStatus?: string;
    authType?: string;
    authReason?: string;
  };
  storage: {
    dataDir: string;
    statePath: string;
  };
  events: ManagerEvent[];
}

export interface CreateProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  kind: 'openai-api';
  models: string[];
  apiKey?: string;
}

export interface UpdateProviderInput {
  id?: string;
  name?: string;
  baseUrl?: string;
  models?: string[];
  apiKey?: string;
}

export interface StateResponse {
  state: ManagerState;
}

export interface CreateProviderResponse extends StateResponse {
  ok: true;
  provider: Omit<ProviderState, 'credentialConfigured' | 'status' | 'detail'>;
}

export interface PiImportCandidate {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: Array<{ id: string; name: string }>;
  credentialEnv: string;
  credentialKind: 'missing' | 'env' | 'literal' | 'command';
  credentialConfigured: boolean;
  conflict: boolean;
  existingKind: string;
  existingName: string;
}

export interface PiImportPreview {
  modelsPath: string;
  candidates: PiImportCandidate[];
  skipped: Array<{ id: string; reason: string }>;
  conflicts: PiImportCandidate[];
}

export interface PiImportResult {
  imported: string[];
  skipped: Array<{ id: string; reason: string }>;
  conflicts: PiImportCandidate[];
  modelsPath: string;
}
