import type {
  CreateProviderInput,
  CreateProviderResponse,
  ManagerState,
  PiImportPreview,
  PiImportResult,
  ProviderConnectionTestResult,
  StateResponse,
  UpdateProviderInput,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String(payload.error)
      : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

export async function getState(forceRefresh = false): Promise<ManagerState> {
  const payload = await request<ManagerState>(forceRefresh ? '/api/state?refresh=1' : '/api/state');
  return payload;
}

export async function previewPiImport(): Promise<{ ok: true; preview: PiImportPreview }> {
  return request<{ ok: true; preview: PiImportPreview }>('/api/pi/import');
}

export async function importPiProviders(overwrite = false): Promise<{ ok: true; result: PiImportResult; state: ManagerState }> {
  return request<{ ok: true; result: PiImportResult; state: ManagerState }>('/api/pi/import', {
    method: 'POST',
    body: JSON.stringify({ overwrite }),
  });
}

export async function createProvider(input: CreateProviderInput): Promise<CreateProviderResponse> {
  return request<CreateProviderResponse>('/api/providers', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateProvider(providerId: string, input: UpdateProviderInput): Promise<CreateProviderResponse> {
  return request<CreateProviderResponse>(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function setProviderCredential(providerId: string, value: string): Promise<StateResponse> {
  return request<StateResponse>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export async function deleteProviderCredential(providerId: string): Promise<StateResponse> {
  return request<StateResponse>(`/api/providers/${encodeURIComponent(providerId)}/credential`, {
    method: 'DELETE',
  });
}

export async function deleteProvider(providerId: string): Promise<StateResponse> {
  return request<StateResponse>(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
}

export async function testProviderConnection(providerId: string): Promise<{ ok: true; result: ProviderConnectionTestResult; state: ManagerState }> {
  return request<{ ok: true; result: ProviderConnectionTestResult; state: ManagerState }>(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  });
}

export async function routeProvider(input: {
  providerId: string;
  modelId: string;
  thinking: string;
}): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/route', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateModelThinking(input: {
  providerId: string;
  modelId: string;
  thinkingLevelMap: Record<string, string | null>;
  source: string;
  verified: boolean;
}): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/models/thinking', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function updateModelContextWindow(input: {
  providerId: string;
  modelId: string;
  contextWindow: number;
}): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/models/context-window', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function updateCycleList(input: {
  modelRefs: string[];
}): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/models/cycle', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function applyProfile(): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/apply', {
    method: 'POST',
  });
}

export async function rollbackProfile(): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/profile/rollback', {
    method: 'POST',
  });
}

export async function launchPi(): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/pi/launch', {
    method: 'POST',
  });
}

export async function stopPi(): Promise<{ ok: true; state: ManagerState }> {
  return request<{ ok: true; state: ManagerState }>('/api/pi/stop', {
    method: 'POST',
  });
}
