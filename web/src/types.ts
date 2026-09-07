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

export interface ManagerState {
  app: {
    name: string;
    version: string;
    platform: string;
  };
  targetProject: string;
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
    lastAppliedAt: string | null;
    lastLaunchAt: string | null;
    lastError: string | null;
    gatewayStats: GatewayStats;
    piExecutable: string;
  };
  pi: {
    installed: boolean;
    path: string;
    version: string;
    subscriptionReady: boolean;
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

export interface StateResponse {
  state: ManagerState;
}

export interface CreateProviderResponse extends StateResponse {
  ok: true;
  provider: Omit<ProviderState, 'credentialConfigured' | 'status' | 'detail'>;
}
