import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Trash2,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  ApiError,
  applyProfile,
  addProviderModel,
  createProvider,
  importPiProviders,
  previewPiImport,
  deleteProvider,
  deleteProviderModel,
  deleteProviderCredential,
  getState,
  setProviderCredential,
  launchPi,
  rollbackProfile,
  rollbackLivePi,
  importLivePi,
  testProviderConnection,
  stopPi,
  updateCycleList,
  updateModelContextWindow,
  routeProvider,
  updateModelThinking,
  updateProvider,
} from './api';
import type {
  CreateProviderInput,
  CycleListEntry,
  PiImportPreview,
  ManagerState,
  ModelDefinition,
  ProviderConnectionTestResult,
  ProviderState,
  ThinkingLevel,
  ThinkingLevelMap,
  ThinkingMapSource,
} from './types';

type NavId = 'providers' | 'models' | 'profiles' | 'diagnostics';

const BUILTIN_PROVIDER_IDS = ['qiniu', 'antigravity', 'openai-codex'] as const;

function isCustomApiProvider(provider: ProviderState) {
  return provider.kind === 'openai-api' && !BUILTIN_PROVIDER_IDS.includes(provider.id as typeof BUILTIN_PROVIDER_IDS[number]);
}

function canConfigureCredential(provider: ProviderState) {
  return provider.kind !== 'native-subscription';
}

function projectName(projectPath: string) {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath;
}

function providerKindLabel(kind: ProviderState['kind']) {
  if (kind === 'native-subscription') return 'Pi 原生订阅';
  if (kind === 'local-bridge') return '本地桥接';
  return 'API 中转';
}

function statusMeta(status: ProviderState['status']) {
  if (status === 'ready') return { label: '已就绪', className: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' };
  if (status === 'offline') return { label: '桥接离线', className: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' };
  if (status === 'error') return { label: '配置错误', className: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' };
  return { label: '未配置', className: 'text-surface-500 dark:text-surface-400', dot: 'bg-surface-300 dark:bg-surface-600' };
}

const PI_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const THINKING_MAP_SOURCE_LABELS: Record<ThinkingMapSource, string> = {
  'provider-default': 'Provider 默认',
  'provider-docs': '供应商文档',
  'request-probe': '请求探测',
  user: '用户手工',
};

function hasThinkingMapValue(map: ThinkingLevelMap, level: ThinkingLevel) {
  return Object.prototype.hasOwnProperty.call(map, level);
}

function supportedThinkingLevels(model: ModelDefinition): ThinkingLevel[] {
  if (!model.reasoning) return ['off'];
  return PI_THINKING_LEVELS.filter((level) => {
    if (hasThinkingMapValue(model.thinkingLevelMap, level)) return model.thinkingLevelMap[level] !== null;
    return level !== 'xhigh' && level !== 'max';
  });
}

function thinkingSummary(model: ModelDefinition) {
  if (!model.reasoning) return '关闭';
  return supportedThinkingLevels(model).filter((level) => level !== 'off').join(' / ') || '未验证';
}

function serializeThinkingMap(map: ThinkingLevelMap) {
  const ordered: ThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    if (hasThinkingMapValue(map, level)) ordered[level] = map[level];
  }
  return JSON.stringify(ordered);
}

function splitModelRef(ref: string) {
  const value = String(ref || '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0 || slash >= value.length - 1) return { providerId: '', modelId: '' };
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function serializeModelRefs(modelRefs: string[]) {
  return JSON.stringify(modelRefs);
}

function resolveCycleEntry(ref: string, providers: ProviderState[]): CycleListEntry {
  const normalizedRef = String(ref || '').trim();
  const { providerId, modelId } = splitModelRef(normalizedRef);
  const provider = providers.find((item) => item.id === providerId);
  const model = provider?.models.find((item) => item.id === modelId);
  const valid = Boolean(provider && model && provider.status === 'ready');
  return {
    index: 0,
    ref: normalizedRef,
    providerId,
    providerName: provider?.name || providerId,
    providerStatus: provider?.status || 'missing',
    modelId,
    modelName: model?.name || modelId,
    valid,
    reason: !provider ? 'provider-missing' : !model ? 'model-missing' : provider.status !== 'ready' ? 'provider-unready' : 'ok',
  };
}

function resolveCycleEntries(modelRefs: string[], providers: ProviderState[]) {
  return modelRefs.map((ref, index) => ({ ...resolveCycleEntry(ref, providers), index }));
}

function cycleEntryLabel(entry: CycleListEntry) {
  return entry.providerId && entry.modelId ? `${entry.providerId}/${entry.modelId}` : entry.ref || '无效引用';
}

function Sidebar({ activeNav, onNavigate, piInstalled }: { activeNav: NavId; onNavigate: (nav: NavId) => void; piInstalled: boolean }) {
  const workspaceItems: Array<{ id: NavId; label: string; icon: ReactNode }> = [
    { id: 'providers', label: '供应商与账号', icon: <Server size={16} strokeWidth={2.3} /> },
    { id: 'models', label: '模型资源库', icon: <Boxes size={16} strokeWidth={2.3} /> },
    { id: 'profiles', label: '环境 Profiles', icon: <SlidersHorizontal size={16} strokeWidth={2.3} /> },
  ];

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-surface-200 bg-surface-50/60 dark:border-surface-800 dark:bg-surface-950">
      <div className="flex h-16 items-center border-b border-surface-200 px-6 dark:border-surface-800">
        <div className="mr-3 flex h-7 w-7 items-center justify-center rounded-[6px] bg-surface-950 text-[11px] font-bold tracking-tighter text-white shadow-sm dark:bg-white dark:text-surface-950">
          Pi
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-surface-900 dark:text-white">Manager</span>
      </div>

      <nav className="flex-1 overflow-y-auto p-4">
        <div className="mb-3 mt-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-surface-400">工作区 Workspace</div>
        <div className="space-y-0.5">
          {workspaceItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${activeNav === item.id
                ? 'bg-surface-200/50 text-surface-900 dark:bg-surface-800 dark:text-surface-50'
                : 'text-surface-500 hover:bg-surface-200/30 hover:text-surface-900 dark:hover:bg-surface-900 dark:hover:text-surface-50'}`}
            >
              <span className={`mr-2.5 ${activeNav === item.id ? 'text-surface-900 dark:text-white' : 'opacity-70'}`}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div className="mb-3 mt-8 px-3 text-[10px] font-semibold uppercase tracking-widest text-surface-400">系统 System</div>
        <button
          type="button"
          onClick={() => onNavigate('diagnostics')}
          className={`flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${activeNav === 'diagnostics'
            ? 'bg-surface-200/50 text-surface-900 dark:bg-surface-800 dark:text-surface-50'
            : 'text-surface-500 hover:bg-surface-200/30 hover:text-surface-900 dark:hover:bg-surface-900 dark:hover:text-surface-50'}`}
        >
          <span className="mr-2.5 opacity-70"><Activity size={16} strokeWidth={2.3} /></span>
          系统诊断
        </button>
        <button
          type="button"
          disabled
          title="全局设置尚未接入"
          className="flex w-full cursor-not-allowed items-center rounded-md px-3 py-2 text-left text-[13px] font-medium text-surface-400 opacity-70"
        >
          <span className="mr-2.5"><Settings2 size={16} strokeWidth={2.3} /></span>
          全局设置
        </button>
      </nav>

      <div className="border-t border-surface-200 p-4 dark:border-surface-800">
        <div className="flex items-center px-2 text-[11px] font-medium text-surface-500">
          <span className={`mr-2 h-1.5 w-1.5 rounded-full ${piInstalled ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-amber-500'}`} />
          {piInstalled ? 'Pi 环境已检测' : 'Pi 环境未检测'}
        </div>
      </div>
    </aside>
  );
}

function Topbar({ state, onDeploy, onRefresh, refreshing }: { state: ManagerState; onDeploy: () => void; onRefresh: () => void; refreshing: boolean }) {
  const dirty = state.configuration.dirty;
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-surface-200 bg-white/85 px-8 backdrop-blur-md dark:border-surface-800 dark:bg-surface-950/85">
      <div className="flex min-w-0 items-center text-[13px] font-medium text-surface-500">
        <LayoutDashboard size={15} className="mr-2 shrink-0 text-surface-400" />
        <span className="truncate">{projectName(state.targetProject)}</span>
        <span className="mx-2 text-surface-300 dark:text-surface-700">/</span>
        <span className="truncate text-surface-900 dark:text-white">{state.active.providerName}</span>
        <span className="mx-2 text-surface-300 dark:text-surface-700">/</span>
        <span className="truncate font-mono text-[12px] text-surface-500">{state.active.modelId}</span>
      </div>
      <div className="ml-4 flex shrink-0 items-center gap-3">
        {state.runtime.lastError && (
          <span className="flex items-center text-[12px] font-medium text-red-600 dark:text-red-400" title={state.runtime.lastError}>
            <CircleAlert size={14} className="mr-1.5" />
            最近有错误
          </span>
        )}
        {dirty && <span className="text-[12px] font-medium text-amber-600 dark:text-amber-400">有未应用修改</span>}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title="重新读取状态"
          aria-label="重新读取状态"
          className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-white"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
        </button>
        <button
          type="button"
          onClick={onDeploy}
          disabled={!dirty}
          className={`flex h-8 items-center rounded-md px-4 text-[13px] font-medium shadow-sm transition-all ${dirty
            ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/20 hover:bg-primary-700'
            : 'cursor-not-allowed bg-surface-950 text-white opacity-40 dark:bg-white dark:text-surface-950'}`}
        >
          部署变更
        </button>
      </div>
    </header>
  );
}

function ProviderCard({ provider, testResult, onTest, onRefresh, onCredential, onEdit, onDelete }: {
  provider: ProviderState;
  testResult?: ProviderConnectionTestResult;
  onTest: () => void;
  onRefresh: () => void;
  onCredential?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const meta = statusMeta(provider.status);
  const isNative = provider.kind === 'native-subscription';
  const canEdit = isCustomApiProvider(provider);
  const canDelete = canEdit;
  const canCredential = canConfigureCredential(provider);

  return (
    <article className="group flex min-h-[286px] flex-col overflow-hidden rounded-xl border border-surface-200 bg-white transition-all hover:border-surface-400 hover:shadow-vercel dark:border-surface-800 dark:bg-[#0a0a0a] dark:hover:border-surface-600 dark:hover:shadow-linear">
      <div className="flex items-start justify-between p-5 pb-4">
        <div className="flex min-w-0 items-center space-x-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-200 text-surface-500 dark:border-surface-700 dark:text-surface-400">
            <Server size={15} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold tracking-tight text-surface-900 dark:text-white">{provider.name}</h3>
            <p className="mt-0.5 truncate font-mono text-[10px] text-surface-400">{provider.id}</p>
          </div>
        </div>
        <span className="ml-2 shrink-0 rounded-full border border-surface-200 bg-surface-100 px-2 py-0.5 text-[10px] font-medium tracking-wide text-surface-600 dark:border-surface-700/50 dark:bg-surface-800 dark:text-surface-400">
          {providerKindLabel(provider.kind)}
        </span>
      </div>

      <div className="flex-1 space-y-4 px-5 text-[13px] text-surface-600 dark:text-surface-400">
        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">认证状态</span>
          <div className={`flex items-center font-medium ${meta.className}`}>
            <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {isNative ? (provider.status === 'ready' ? 'Pi 已授权' : '需要 Pi 登录') : (provider.credentialConfigured ? 'API Key 已配置' : 'API Key 未配置')}
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">接入节点</span>
          {provider.baseUrl ? (
            <span className="max-w-[180px] truncate font-mono text-[11px] text-surface-600 dark:text-surface-400" title={provider.baseUrl}>{provider.baseUrl}</span>
          ) : (
            <span className="font-mono text-[11px] text-surface-400">Pi 原生</span>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">模型数量</span>
          <span className="font-mono text-[12px] text-surface-900 dark:text-surface-200">{provider.models.length}</span>
        </div>

        <div className="rounded-md bg-surface-50 p-3 dark:bg-surface-800/30">
          <div className="flex items-center text-[12px] font-medium text-surface-900 dark:text-surface-200">
            <Activity size={14} className="mr-2 text-surface-400" />
            接入状态
          </div>
          <p className="mt-1 pl-[22px] text-[11px] leading-4 text-surface-500">{provider.detail}</p>
        </div>
        {testResult && (
          <div className={`rounded-md border p-3 text-[11px] leading-4 ${testResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">连接测试</span>
              <span className="font-mono">{testResult.ok ? '通过' : '失败'} · {testResult.category}</span>
            </div>
            <div className="mt-1">{testResult.message}</div>
            <div className="mt-1 font-mono text-[10px] opacity-80">{testResult.detail}</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-surface-100 bg-surface-50/30 px-3 py-3 dark:border-surface-800/50 dark:bg-[#0a0a0a]">
        <span className="px-2.5 text-[11px] text-surface-500">实际使用模型在模型资源库配置</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onTest}
            title="测试供应商连接"
            aria-label={`测试 ${provider.name} 连接`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
          >
            <CheckCircle2 size={14} />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            title="刷新供应商状态"
            aria-label={`刷新 ${provider.name} 状态`}
            className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
          >
            <RefreshCw size={14} />
          </button>
          {canCredential && onCredential && (
            <button
              type="button"
              onClick={onCredential}
              title="配置 API Key"
              aria-label={`配置 ${provider.name} API Key`}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
            >
              <KeyRound size={14} />
            </button>
          )}
          {canEdit && onEdit && (
            <button
              type="button"
              onClick={onEdit}
              title="编辑供应商"
              aria-label={`编辑 ${provider.name}`}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
            >
              <Pencil size={14} />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              title="删除供应商"
              aria-label={`删除 ${provider.name}`}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ProvidersPage({ state, testResults, onAdd, onImport, onRefresh, onTest, onCredential, onEdit, onDelete }: {
  state: ManagerState;
  testResults: Record<string, ProviderConnectionTestResult>;
  onAdd: () => void;
  onImport: () => void;
  onRefresh: () => void;
  onTest: (provider: ProviderState) => void;
  onCredential: (provider: ProviderState) => void;
  onEdit: (provider: ProviderState) => void;
  onDelete: (provider: ProviderState) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'ready' | 'native'>('all');
  const [query, setQuery] = useState('');
  const visibleProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return state.providers.filter((provider) => {
      const matchesFilter = filter === 'all'
        || (filter === 'ready' && provider.status === 'ready')
        || (filter === 'native' && provider.kind === 'native-subscription');
      const matchesQuery = !normalizedQuery
        || provider.name.toLowerCase().includes(normalizedQuery)
        || provider.id.toLowerCase().includes(normalizedQuery)
        || (provider.baseUrl || '').toLowerCase().includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [filter, query, state.providers]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">供应商与账号</h1>
          <p className="mt-1 text-[14px] text-surface-500">管理 Pi 原生账号、API 凭据和第三方中转；实际使用模型在模型资源库配置。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onImport}
            className="flex h-9 items-center rounded-md border border-surface-200 bg-white px-4 text-[13px] font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            <Download size={16} className="mr-2 opacity-70" />
            从本机 Pi 导入
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="flex h-9 items-center rounded-md bg-surface-950 px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-surface-800 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200"
          >
            <Plus size={16} className="mr-2 opacity-70" />
            新增供应商
          </button>
        </div>
      </div>

      <div className="flex flex-col items-start justify-between gap-4 border-b border-surface-200 pb-2 md:flex-row md:items-center dark:border-surface-800">
        <div className="flex w-full items-center gap-6 overflow-x-auto md:w-auto">
          {[
            ['all', `全部账号 ${state.providers.length}`],
            ['ready', `已连接 ${state.providers.filter((provider) => provider.status === 'ready').length}`],
            ['native', `Pi 原生 ${state.providers.filter((provider) => provider.kind === 'native-subscription').length}`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value as 'all' | 'ready' | 'native')}
              className={`shrink-0 pb-2 text-[13px] font-medium transition-colors ${filter === value
                ? 'border-b-2 border-surface-900 text-surface-900 dark:border-white dark:text-white'
                : 'text-surface-500 hover:text-surface-900 dark:hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative w-full md:w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索供应商或 ID"
            aria-label="搜索供应商或 ID"
            className="w-full rounded-md border border-surface-200 bg-white py-1.5 pl-8 pr-3 text-[13px] text-surface-900 outline-none transition-colors placeholder:text-surface-400 focus:border-surface-400 focus:ring-1 focus:ring-surface-400 dark:border-surface-700 dark:bg-[#0a0a0a] dark:text-white"
          />
        </div>
      </div>

      {visibleProviders.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visibleProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              testResult={testResults[provider.id]}
              onTest={() => onTest(provider)}
              onRefresh={onRefresh}
              onCredential={() => onCredential(provider)}
              onEdit={() => onEdit(provider)}
              onDelete={() => onDelete(provider)}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-surface-300 bg-white/60 text-center dark:border-surface-800 dark:bg-[#0a0a0a]/60">
          <Search size={22} className="mb-3 text-surface-400" />
          <h2 className="text-[14px] font-medium text-surface-900 dark:text-white">没有匹配的供应商</h2>
          <p className="mt-1 text-[13px] text-surface-500">清除搜索或添加新的 API 中转。</p>
        </div>
      )}
    </div>
  );
}

function ProviderEditorModal({ provider, isOpen, onClose, onSaved }: {
  provider?: ProviderState | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const editing = Boolean(provider);
  const [name, setName] = useState(provider?.name || '');
  const [id, setId] = useState(provider?.id || '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(provider?.models.map((model) => model.id).join(', ') || '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const modelIds = models.split(',').map((model) => model.trim()).filter(Boolean);
    if (modelIds.length === 0) {
      setError('至少填写一个模型 ID。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      if (editing && provider) {
        const response = await updateProvider(provider.id, {
          id: id.trim() || undefined,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          models: modelIds,
          apiKey: apiKey.trim() || undefined,
        });
        onSaved(response.state, '供应商已更新为候选配置');
      } else {
        const input: CreateProviderInput = {
          id: id.trim() || undefined,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          kind: 'openai-api',
          models: modelIds,
          apiKey: apiKey.trim() || undefined,
        };
        const response = await createProvider(input);
        onSaved(response.state, '供应商已保存为候选配置');
      }
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '保存失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm dark:bg-black/60" role="presentation">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-surface-200 bg-white shadow-2xl dark:border-surface-800 dark:bg-surface-950" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="provider-editor-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{editing ? '编辑 API 中转' : '新增 API 中转'}</h2>
            <p className="mt-1 text-[12px] text-surface-500">OpenAI 兼容接口</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭" className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="space-y-4 p-6">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">显示名称</span>
              <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：公司中转" autoFocus className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Provider ID <span className="font-normal text-surface-400">可选</span></span>
              <input value={id} onChange={(event) => setId(event.target.value)} placeholder="例如：company-relay" pattern="[A-Za-z0-9_-]+" title="仅支持字母、数字、下划线和连字符" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Base URL</span>
              <input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">模型 ID</span>
              <input required value={models} onChange={(event) => setModels(event.target.value)} placeholder="gpt-5.6-luna, grok-4.6" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
              <p className="text-[11px] text-surface-500">多个模型用逗号分隔。</p>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">API Key <span className="font-normal text-surface-400">可选</span></span>
              <div className="relative">
                <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" placeholder={editing ? (provider?.credentialConfigured ? '留空则保留已有密钥' : '留空则稍后配置') : '留空则稍后配置'} className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
              </div>
              <p className="text-[11px] text-surface-500">只显示配置状态，不在界面回显密钥。</p>
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">取消</button>
            <button type="submit" disabled={submitting} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              保存为候选配置
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ImportPiModal({ isOpen, onClose, onSaved }: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const [preview, setPreview] = useState<PiImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void previewPiImport()
      .then((response) => {
        if (!cancelled) setPreview(response.preview);
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : '无法读取本机 Pi 配置。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const importNow = async (overwrite: boolean) => {
    setSubmitting(true);
    setError('');
    try {
      const response = await importPiProviders(overwrite);
      onSaved(response.state, `已导入 ${response.result.imported.length} 个本机 Pi 渠道`);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '导入失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm dark:bg-black/60" role="presentation">
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-surface-200 bg-white shadow-2xl dark:border-surface-800 dark:bg-surface-950" role="dialog" aria-modal="true" aria-labelledby="import-pi-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="import-pi-title" className="text-[16px] font-bold text-surface-900 dark:text-white">从本机 Pi 导入</h2>
            <p className="mt-1 text-[12px] text-surface-500">只读读取 models.json 中的 OpenAI 兼容渠道，不修改源文件。</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭" className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <div className="max-h-[420px] space-y-4 overflow-y-auto p-6">
          {loading && <div className="flex items-center text-[13px] text-surface-500"><Loader2 size={14} className="mr-2 animate-spin" />正在读取本机 Pi 配置</div>}
          {preview && (
            <>
              <div className="truncate font-mono text-[11px] text-surface-400" title={preview.modelsPath}>{preview.modelsPath || '未找到 models.json'}</div>
              {preview.candidates.length === 0 ? (
                <p className="text-[13px] text-surface-500">没有可导入的 OpenAI 兼容渠道。</p>
              ) : (
                <ul className="space-y-2">
                  {preview.candidates.map((candidate) => (
                    <li key={candidate.id} className="rounded-md border border-surface-200 px-3 py-2 text-[12px] dark:border-surface-800">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-surface-900 dark:text-white">{candidate.name}</span>
                        <span className="font-mono text-surface-400">{candidate.id}</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-surface-500">{candidate.baseUrl}</div>
                      <div className="mt-1 text-surface-500">{candidate.models.length} 个模型 · {candidate.credentialKind === 'literal' ? '将导入密钥到 Manager 凭据存储' : candidate.credentialKind === 'env' ? `引用 ${candidate.credentialEnv}` : '未配置密钥'}</div>
                      {candidate.conflict && <div className="mt-1 text-amber-600 dark:text-amber-400">与现有渠道冲突：{candidate.existingName || candidate.id}</div>}
                    </li>
                  ))}
                </ul>
              )}
              {preview.skipped.length > 0 && <p className="text-[11px] text-surface-400">已跳过 {preview.skipped.map((item) => item.id).join(', ')}</p>}
            </>
          )}
          {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
        </div>
        <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">取消</button>
          {preview && preview.conflicts.length > 0 && (
            <button type="button" onClick={() => void importNow(true)} disabled={submitting || preview.candidates.length === 0} className="rounded-md border border-amber-200 px-4 py-2 text-[13px] font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10">覆盖冲突并导入</button>
          )}
          <button type="button" onClick={() => void importNow(false)} disabled={submitting || !preview || preview.candidates.length === 0} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
            {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
            导入
          </button>
        </div>
      </div>
    </div>
  );
}

function CredentialModal({ provider, isOpen, onClose, onSaved }: {
  provider?: ProviderState | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen || !provider) return null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError('API Key 不能为空。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await setProviderCredential(provider.id, apiKey.trim());
      onSaved(response.state, `${provider.name} 凭据已保存`);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '保存凭据失败。');
    } finally {
      setSubmitting(false);
    }
  };

  const clear = async () => {
    setSubmitting(true);
    setError('');
    try {
      const response = await deleteProviderCredential(provider.id);
      onSaved(response.state, `${provider.name} 凭据已清除`);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '清除凭据失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm dark:bg-black/60" role="presentation">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-surface-200 bg-white shadow-2xl dark:border-surface-800 dark:bg-surface-950" role="dialog" aria-modal="true" aria-labelledby="credential-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="credential-title" className="text-[16px] font-bold text-surface-900 dark:text-white">配置 API Key</h2>
            <p className="mt-1 text-[12px] text-surface-500">{provider.name} · {provider.id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭" className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={save}>
          <div className="space-y-4 p-6">
            <div className="rounded-md bg-surface-50 px-3 py-2 text-[12px] text-surface-500 dark:bg-surface-900/50">
              {provider.credentialConfigured ? '当前已配置 API Key，保存新值会覆盖 Manager 中的密钥。' : '当前尚未配置 API Key。'}
              {provider.id === 'antigravity' ? ' Antigravity 按本地 OpenAI 兼容桥接入，不在此登录其订阅。' : ''}
            </div>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">API Key</span>
              <div className="relative">
                <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(''); }} type="password" autoComplete="new-password" autoFocus placeholder="不会在界面回显已有密钥" className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
              </div>
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={() => void clear()} disabled={submitting || !provider.credentialConfigured} className="rounded-md px-4 py-2 text-[13px] font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-40 dark:text-red-400">清除凭据</button>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">取消</button>
              <button type="submit" disabled={submitting} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
                {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
                保存凭据
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeployModal({ state, isOpen, onClose, onApplied }: { state: ManagerState; isOpen: boolean; onClose: () => void; onApplied: (state: ManagerState) => void }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const submit = async () => {
    setSubmitting(true);
    setError('');
    try {
      const response = await applyProfile();
      onApplied(response.state);
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '应用失败，请查看系统诊断。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm dark:bg-black/60" role="presentation">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-surface-200 bg-white shadow-2xl dark:border-surface-800 dark:bg-surface-950" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <div className="border-b border-surface-100 p-6 dark:border-surface-800">
          <div className="flex items-center justify-between">
            <h2 id="review-title" className="text-[18px] font-bold text-surface-900 dark:text-white">配置变更预览</h2>
            <button type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭" className="text-surface-400 hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
          </div>
          <p className="mt-1 text-[13px] text-surface-500">确认后生成隔离的 Pi profile。</p>
        </div>
        <div className="space-y-3 bg-surface-50/60 p-6 dark:bg-surface-900/20">
          <div className="rounded-lg border border-surface-200 bg-white p-4 dark:border-surface-800 dark:bg-surface-900">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-surface-900 dark:text-white">候选配置</span>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold tracking-wider text-amber-700 dark:bg-amber-500/20 dark:text-amber-400">REV {state.configuration.revision}</span>
            </div>
            <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-[12px]">
              <dt className="text-surface-500">当前渠道</dt><dd className="text-surface-900 dark:text-surface-200">{state.active.providerName}</dd>
              <dt className="text-surface-500">默认模型</dt><dd className="font-mono text-surface-900 dark:text-surface-200">{state.active.providerId}/{state.active.modelId}</dd>
              <dt className="text-surface-500">Thinking</dt><dd className="text-surface-900 dark:text-surface-200">{state.active.thinking}</dd>
              <dt className="text-surface-500">供应商数量</dt><dd className="text-surface-900 dark:text-surface-200">{state.providers.length}</dd>
            </dl>
          </div>
          <div className="flex items-start rounded-md border border-surface-200 bg-white px-3 py-2.5 text-[12px] leading-5 text-surface-500 dark:border-surface-800 dark:bg-surface-900">
            <ExternalLink size={14} className="mr-2 mt-0.5 shrink-0 text-surface-400" />
            应用会写入 Manager 自己的数据目录，不修改项目原有的 .pi 文件。
          </div>
          {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
        </div>
        <div className="flex items-center justify-between border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900">
          <span className="text-[12px] text-surface-500">已应用 revision {state.configuration.appliedRevision}</span>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">取消</button>
            <button type="button" onClick={() => void submit()} disabled={submitting} className="flex items-center rounded-md bg-primary-600 px-5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-wait disabled:opacity-60">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              应用配置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddCatalogModelModal({ providers, onClose, onSaved }: {
  providers: ProviderState[];
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [reasoning, setReasoning] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!providerId || !modelId.trim()) {
      setError('请选择自定义渠道并填写模型 ID。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await addProviderModel(providerId, {
        id: modelId.trim(),
        name: name.trim() || modelId.trim(),
        reasoning,
      });
      onSaved(response.state, `已添加 ${providerId}/${modelId.trim()}`);
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '添加模型失败。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4 backdrop-blur-sm dark:bg-black/60" role="presentation">
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-surface-200 bg-white shadow-2xl dark:border-surface-800 dark:bg-surface-950" role="dialog" aria-modal="true" aria-labelledby="add-model-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="add-model-title" className="text-[16px] font-bold text-surface-900 dark:text-white">添加模型</h2>
            <p className="mt-1 text-[12px] text-surface-500">只对自定义 OpenAI 兼容渠道写入完整目录。</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭" className="text-surface-400 hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <div className="space-y-4 p-6">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">自定义渠道</span>
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white">
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">模型 ID</span>
              <input required value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如：gpt-5.6-luna" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">显示名称 <span className="font-normal text-surface-400">可选</span></span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="默认使用模型 ID" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-300">
              <input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} className="h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500" />
              支持 reasoning / Thinking
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">取消</button>
            <button type="submit" disabled={submitting || providers.length === 0} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white hover:bg-surface-800 disabled:opacity-60 dark:bg-white dark:text-surface-950">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              添加到完整目录
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type ModelsTab = 'catalog' | 'cycle' | 'default' | 'thinking';

function ModelsPage({ state, onStateChanged }: { state: ManagerState; onStateChanged: (nextState: ManagerState, notice: string) => void }) {
  const [activeTab, setActiveTab] = useState<ModelsTab>('catalog');
  const [query, setQuery] = useState('');
  const [selectedProviderId, setSelectedProviderId] = useState(state.active.providerId);
  const [selectedModelId, setSelectedModelId] = useState(state.active.modelId);
  const [selectedThinking, setSelectedThinking] = useState<ThinkingLevel>(state.active.thinking as ThinkingLevel);
  const [savingRoute, setSavingRoute] = useState(false);
  const [routeError, setRouteError] = useState('');
  const [mappingRef, setMappingRef] = useState(`${state.active.providerId}/${state.active.modelId}`);
  const [showAddModel, setShowAddModel] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const customProviders = state.providers.filter((provider) => isCustomApiProvider(provider));
  const models = useMemo(() => state.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model }))), [state.providers]);
  const visibleModels = models.filter(({ provider, model }) => {
    const value = `${provider.id}/${model.id} ${model.name}`.toLowerCase();
    return !query.trim() || value.includes(query.trim().toLowerCase());
  });
  const providerOptions = state.providers.filter((provider) => provider.models.length > 0);
  const selectedProvider = state.providers.find((provider) => provider.id === selectedProviderId);
  const selectedModel = selectedProvider?.models.find((model) => model.id === selectedModelId);
  const thinkingLevels = selectedModel ? supportedThinkingLevels(selectedModel) : [];
  const routeIsValid = Boolean(selectedProvider && selectedModel && selectedProvider.status === 'ready' && thinkingLevels.includes(selectedThinking));
  const routeChanged = selectedProviderId !== state.active.providerId
    || selectedModelId !== state.active.modelId
    || selectedThinking !== state.active.thinking;
  const effectiveMappingRef = models.some(({ provider, model }) => `${provider.id}/${model.id}` === mappingRef)
    ? mappingRef
    : models[0]
      ? `${models[0].provider.id}/${models[0].model.id}`
      : '';
  const mappingEntry = models.find(({ provider, model }) => `${provider.id}/${model.id}` === effectiveMappingRef) || models[0];
  const mappingProvider = mappingEntry?.provider;
  const mappingModel = mappingEntry?.model;
  const mappingEditorKey = mappingModel
    ? `${effectiveMappingRef}:${serializeThinkingMap(mappingModel.thinkingLevelMap)}:${mappingModel.thinkingMapSource}:${mappingModel.thinkingMapVerified}`
    : effectiveMappingRef;

  const handleProviderChange = (providerId: string) => {
    const provider = state.providers.find((item) => item.id === providerId);
    const model = provider?.models[0];
    const levels = model ? supportedThinkingLevels(model) : [];
    setSelectedProviderId(providerId);
    setSelectedModelId(model?.id || '');
    setSelectedThinking((levels.includes(state.active.thinking as ThinkingLevel) ? state.active.thinking : levels.at(-1) || 'off') as ThinkingLevel);
    setRouteError('');
  };

  const handleModelChange = (modelId: string) => {
    const model = selectedProvider?.models.find((item) => item.id === modelId);
    const levels = model ? supportedThinkingLevels(model) : [];
    setSelectedModelId(modelId);
    setSelectedThinking((levels.includes(selectedThinking) ? selectedThinking : levels.at(-1) || 'off') as ThinkingLevel);
    setRouteError('');
  };

  const saveDefaultRoute = async () => {
    if (!selectedProvider || !selectedModel || !routeIsValid) {
      setRouteError('请选择已连接的供应商、可用模型和该模型支持的 Thinking 等级。');
      return;
    }
    setSavingRoute(true);
    setRouteError('');
    try {
      const response = await routeProvider({
        providerId: selectedProvider.id,
        modelId: selectedModel.id,
        thinking: selectedThinking,
      });
      onStateChanged(response.state, '默认模型已保存为候选配置');
    } catch (caughtError) {
      setRouteError(caughtError instanceof ApiError ? caughtError.message : '保存默认模型失败。');
    } finally {
      setSavingRoute(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">模型资源库</h1>
        <p className="mt-1 text-[14px] text-surface-500">当前从 Manager 状态读取 {models.length} 个模型。</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-surface-200 dark:border-surface-800">
        {[
          ['catalog', '完整目录'],
          ['cycle', '循环列表'],
          ['default', '默认模型'],
          ['thinking', 'Thinking 映射'],
        ].map(([value, label]) => (
          <button key={value} type="button" onClick={() => setActiveTab(value as ModelsTab)} className={`pb-2 text-[13px] font-medium ${activeTab === value ? 'border-b-2 border-surface-900 text-surface-900 dark:border-white dark:text-white' : 'text-surface-500 hover:text-surface-900 dark:hover:text-white'}`}>{label}</button>
        ))}
      </div>

      {activeTab === 'catalog' && (
        <div className="overflow-hidden rounded-xl border border-surface-200 bg-white shadow-sm dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-100 bg-surface-50/50 p-3 dark:border-surface-800 dark:bg-surface-900/20">
            <div className="relative w-64 max-w-full">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型 ID" aria-label="搜索模型 ID" className="w-full rounded-md border border-surface-200 bg-white py-1.5 pl-8 pr-3 text-[13px] outline-none focus:border-surface-400 dark:border-surface-700 dark:bg-[#0a0a0a] dark:text-white" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-surface-500">自定义渠道可增删完整目录；内置渠道只能改映射和 Context</span>
              <button type="button" onClick={() => setShowAddModel(true)} disabled={customProviders.length === 0} className="inline-flex h-8 items-center rounded-md border border-surface-200 bg-white px-3 text-[12px] font-medium text-surface-700 hover:bg-surface-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200">
                <Plus size={13} className="mr-1.5" />添加模型
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[13px]">
              <thead className="bg-surface-50/80 text-[12px] font-medium text-surface-500 dark:bg-surface-900/50 dark:text-surface-400">
                <tr>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">模型</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">Provider</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">输入</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">Thinking</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">Context</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">状态</th>
                  <th className="border-b border-surface-100 px-4 py-3 dark:border-surface-800">策略</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100 text-surface-700 dark:divide-surface-800/50 dark:text-surface-300">
                {visibleModels.map(({ provider, model }) => (
                  <tr key={`${provider.id}/${model.id}`} className="hover:bg-surface-50 dark:hover:bg-surface-900/30">
                    <td className="px-4 py-3"><div className="font-medium text-surface-900 dark:text-white">{model.name}</div><div className="font-mono text-[11px] text-surface-400">{provider.id}/{model.id}</div></td>
                    <td className="px-4 py-3">{provider.name}</td>
                    <td className="px-4 py-3 text-[12px] text-surface-500">{model.input.join(', ')}</td>
                    <td className="px-4 py-3 text-[12px] text-surface-500">{thinkingSummary(model)}</td>
                    <td className="px-4 py-3"><ModelContextWindowEditor key={`${provider.id}/${model.id}:${model.contextWindow}`} provider={provider} model={model} onStateChanged={onStateChanged} /></td>
                    <td className="px-4 py-3">{provider.id === state.active.providerId && model.id === state.active.modelId ? <span className="text-primary-600 dark:text-primary-400">默认</span> : provider.status === 'ready' ? <span className="text-surface-400">可用</span> : <span className="text-amber-600 dark:text-amber-400">{statusMeta(provider.status).label}</span>}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => { setMappingRef(`${provider.id}/${model.id}`); setActiveTab('thinking'); }} title={`编辑 ${model.name} 的 Thinking 映射`} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-surface-600 transition-colors hover:bg-surface-100 hover:text-surface-950 dark:text-surface-400 dark:hover:bg-surface-800 dark:hover:text-white"><Pencil size={13} />映射</button>
                        {isCustomApiProvider(provider) && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`确定从完整目录删除 ${provider.id}/${model.id} 吗？`)) return;
                              void deleteProviderModel(provider.id, model.id)
                                .then((response) => { setCatalogError(''); onStateChanged(response.state, `已删除 ${provider.id}/${model.id}`); })
                                .catch((caughtError) => setCatalogError(caughtError instanceof ApiError ? caughtError.message : '删除模型失败。'));
                            }}
                            title={`删除 ${model.name}`}
                            aria-label={`删除 ${model.name}`}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-surface-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {visibleModels.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-[13px] text-surface-500">没有匹配的模型。</td></tr>}
              </tbody>
            </table>
          </div>
          {catalogError && <div className="mx-4 mb-4 mt-3 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{catalogError}</div>}
        </div>
      )}
      {showAddModel && (
        <AddCatalogModelModal
          providers={customProviders}
          onClose={() => setShowAddModel(false)}
          onSaved={(nextState, notice) => {
            onStateChanged(nextState, notice);
            setShowAddModel(false);
          }}
        />
      )}

      {activeTab === 'cycle' && (
        <CycleListEditor key={serializeModelRefs(state.cycle.modelRefs)} state={state} onStateChanged={onStateChanged} />
      )}

      {activeTab === 'default' && (
        <div className="max-w-3xl rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-100 text-surface-500 dark:bg-surface-800"><CheckCircle2 size={17} /></div>
            <div><h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">默认模型</h2><p className="text-[12px] text-surface-500">选择实际使用的 provider、model 和 Thinking 等级</p></div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Provider</span>
              <select value={selectedProviderId} onChange={(event) => handleProviderChange(event.target.value)} disabled={providerOptions.length === 0} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-900 dark:text-white">
                {providerOptions.length === 0 && <option value="">暂无模型来源</option>}
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}{provider.status === 'ready' ? '' : ` · ${statusMeta(provider.status).label}`}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Model</span>
              <select value={selectedModelId} onChange={(event) => handleModelChange(event.target.value)} disabled={!selectedProvider || selectedProvider.models.length === 0} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-900 dark:text-white">
                {!selectedProvider && <option value="">请先选择 Provider</option>}
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Thinking</span>
              <select value={selectedThinking} onChange={(event) => { setSelectedThinking(event.target.value as ThinkingLevel); setRouteError(''); }} disabled={!selectedModel} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-900 dark:text-white">
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-md bg-surface-50 px-4 py-3 text-[12px] dark:bg-surface-900/50">
            <div className="min-w-0">
              <div className="font-mono text-surface-900 dark:text-white">{selectedProvider && selectedModel ? `${selectedProvider.id}/${selectedModel.id}` : '尚未选择模型'}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-surface-500">
                <span>{selectedProvider ? `认证：${selectedProvider.status === 'ready' ? '已就绪' : statusMeta(selectedProvider.status).label}` : '请选择供应商'}</span>
                <span>{selectedModel ? `支持：${thinkingLevels.join(' / ')}` : '未读取模型能力'}</span>
              </div>
            </div>
            <button type="button" onClick={() => void saveDefaultRoute()} disabled={!routeIsValid || !routeChanged || savingRoute} className="flex h-8 shrink-0 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">
              {savingRoute && <Loader2 size={13} className="mr-1.5 animate-spin" />}
              保存为候选配置
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-surface-500">
            <span>保存后不会立即改变正在运行的 Pi</span>
            <span>revision {state.configuration.revision} · 已应用 {state.configuration.appliedRevision}</span>
          </div>
          {routeError && <div className="mt-4 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{routeError}</div>}
        </div>
      )}

      {activeTab === 'thinking' && (
        <div className="max-w-4xl space-y-4">
          <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-[#0a0a0a]">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <label className="block min-w-[280px] flex-1 space-y-1.5">
                <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">选择模型</span>
                <select value={effectiveMappingRef} onChange={(event) => { setMappingRef(event.target.value); }} disabled={!mappingModel} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-900 dark:text-white">
                  {models.map(({ provider, model }) => <option key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>{provider.id}/{model.id}</option>)}
                </select>
              </label>
              {mappingModel && <div className="text-right text-[12px] text-surface-500"><div>有效等级 <span className="font-mono text-surface-900 dark:text-white">{supportedThinkingLevels(mappingModel).length}/7</span></div><div className="mt-1">{mappingModel.thinkingMapVerified ? '已标记为已验证' : '尚未完成真实请求验证'}</div></div>}
            </div>
          </div>

          {mappingModel ? (
            <ThinkingMappingEditor key={mappingEditorKey} provider={mappingProvider} model={mappingModel} onStateChanged={onStateChanged} />
          ) : <div className="rounded-xl border border-dashed border-surface-300 p-8 text-center text-[13px] text-surface-500 dark:border-surface-800">暂无可编辑的模型。</div>}
        </div>
      )}
    </div>
  );
}

function ModelContextWindowEditor({
  provider,
  model,
  onStateChanged,
}: {
  provider: ProviderState;
  model: ModelDefinition;
  onStateChanged: (nextState: ManagerState, notice: string) => void;
}) {
  const [draft, setDraft] = useState(String(model.contextWindow));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = draft !== String(model.contextWindow);

  const save = async () => {
    if (!/^\d+$/.test(draft) || Number(draft) < 1 || Number(draft) > 100000000) {
      setError('请输入 1-100000000 之间的正整数。');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await updateModelContextWindow({
        providerId: provider.id,
        modelId: model.id,
        contextWindow: Number(draft),
      });
      onStateChanged(response.state, `${model.name} 的 Context 长度已保存为候选配置`);
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '保存 Context 长度失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-[190px]">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min="1"
          max="100000000"
          step="1"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); setError(''); }}
          aria-label={`${model.name} Context 长度`}
          className="w-[118px] rounded-md border border-surface-200 bg-white px-2 py-1.5 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white"
        />
        <span className="text-[11px] text-surface-400">tokens</span>
        {changed && <button type="button" onClick={() => void save()} disabled={saving} title="保存 Context 长度" aria-label="保存 Context 长度" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary-600 hover:bg-primary-50 disabled:cursor-wait disabled:opacity-50 dark:text-primary-400 dark:hover:bg-primary-500/10"><Save size={13} /></button>}
      </div>
      {error && <div className="mt-1 max-w-[190px] text-[10px] leading-4 text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

function ThinkingMappingEditor({
  provider,
  model,
  onStateChanged,
}: {
  provider: ProviderState;
  model: ModelDefinition;
  onStateChanged: (nextState: ManagerState, notice: string) => void;
}) {
  const [mappingDraft, setMappingDraft] = useState<ThinkingLevelMap>({ ...model.thinkingLevelMap });
  const [mappingSource, setMappingSource] = useState<ThinkingMapSource>(model.thinkingMapSource);
  const [mappingVerified, setMappingVerified] = useState(model.thinkingMapVerified);
  const [savingMapping, setSavingMapping] = useState(false);
  const [mappingError, setMappingError] = useState('');

  const mappingChanged = Boolean(
    serializeThinkingMap(mappingDraft) !== serializeThinkingMap(model.thinkingLevelMap)
    || mappingSource !== model.thinkingMapSource
    || mappingVerified !== model.thinkingMapVerified
  );

  const mappingMode = (level: ThinkingLevel): 'default' | 'value' | 'unsupported' => {
    if (!model.reasoning && level !== 'off') return 'unsupported';
    if (!hasThinkingMapValue(mappingDraft, level)) return 'default';
    return mappingDraft[level] === null ? 'unsupported' : 'value';
  };

  const changeMappingMode = (level: ThinkingLevel, mode: 'default' | 'value' | 'unsupported') => {
    setMappingDraft((current) => {
      const next = { ...current };
      if (mode === 'default') delete next[level];
      else if (mode === 'unsupported') next[level] = null;
      else if (typeof next[level] !== 'string' || !next[level]) next[level] = level === 'off' ? 'none' : level;
      return next;
    });
    setMappingError('');
  };

  const changeMappingValue = (level: ThinkingLevel, value: string) => {
    setMappingDraft((current) => ({ ...current, [level]: value }));
    setMappingError('');
  };

  const saveThinkingMap = async () => {
    setSavingMapping(true);
    setMappingError('');
    try {
      const response = await updateModelThinking({
        providerId: provider.id,
        modelId: model.id,
        thinkingLevelMap: { ...mappingDraft },
        source: mappingSource,
        verified: mappingVerified,
      });
      onStateChanged(response.state, `${model.name} 的 Thinking 映射已保存为候选配置`);
    } catch (caughtError) {
      setMappingError(caughtError instanceof ApiError ? caughtError.message : '保存 Thinking 映射失败。');
    } finally {
      setSavingMapping(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
      <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">Pi 等级与上游值</h2><p className="mt-1 text-[12px] text-surface-500">缺省项遵循 Provider 默认；xhigh 和 max 缺省时不启用。</p></div>
          <span className="rounded-md bg-surface-100 px-2 py-1 text-[11px] font-medium text-surface-600 dark:bg-surface-800 dark:text-surface-300">{provider.name}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="bg-surface-50/80 text-[12px] font-medium text-surface-500 dark:bg-surface-900/50 dark:text-surface-400">
            <tr><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">Pi 等级</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">映射方式</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">上游值</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">结果</th></tr>
          </thead>
          <tbody className="divide-y divide-surface-100 dark:divide-surface-800/50">
            {PI_THINKING_LEVELS.map((level) => {
              const mode = mappingMode(level);
              const mappedValue = mappingDraft[level];
              const isDisabled = !model.reasoning && level !== 'off';
              return (
                <tr key={level}>
                  <td className="px-5 py-3 font-mono text-[12px] font-medium text-surface-900 dark:text-white">{level}</td>
                  <td className="px-5 py-3"><select value={mode} onChange={(event) => changeMappingMode(level, event.target.value as 'default' | 'value' | 'unsupported')} disabled={isDisabled} aria-label={`${level} 映射方式`} className="rounded-md border border-surface-200 bg-surface-50 px-2.5 py-1.5 text-[12px] text-surface-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200"><option value="default">Provider 默认</option><option value="value">指定上游值</option><option value="unsupported">不支持</option></select></td>
                  <td className="px-5 py-3">{mode === 'value' ? <input value={typeof mappedValue === 'string' ? mappedValue : ''} onChange={(event) => changeMappingValue(level, event.target.value)} aria-label={`${level} 上游值`} placeholder={level === 'off' ? 'none' : level} className="w-48 max-w-full rounded-md border border-surface-200 bg-white px-2.5 py-1.5 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" /> : <span className={`text-[12px] ${mode === 'unsupported' ? 'text-surface-400' : 'text-surface-500'}`}>{mode === 'unsupported' ? '不支持' : level === 'xhigh' || level === 'max' ? '缺省时不启用' : '跟随 Provider 默认'}</span>}</td>
                  <td className="px-5 py-3 text-[12px]">{mode === 'value' ? <span className="text-emerald-600 dark:text-emerald-400">发送 {mappedValue || '待填写'}</span> : mode === 'unsupported' ? <span className="text-surface-400">隐藏</span> : <span className="text-surface-500">使用默认</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block space-y-1.5"><span className="text-[11px] font-semibold text-surface-600 dark:text-surface-300">映射来源</span><select value={mappingSource} onChange={(event) => setMappingSource(event.target.value as ThinkingMapSource)} className="block rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-[12px] text-surface-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200">{Object.entries(THINKING_MAP_SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="flex items-center gap-2 pb-1.5 text-[12px] text-surface-600 dark:text-surface-300"><input type="checkbox" checked={mappingVerified} onChange={(event) => setMappingVerified(event.target.checked)} className="h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500" />已完成真实请求验证</label>
        </div>
        <button type="button" onClick={() => void saveThinkingMap()} disabled={!mappingChanged || savingMapping} className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">{savingMapping ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}保存为候选配置</button>
      </div>
      {mappingError && <div className="mx-5 mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{mappingError}</div>}
    </div>
  );
}

function CycleListEditor({
  state,
  onStateChanged,
}: {
  state: ManagerState;
  onStateChanged: (nextState: ManagerState, notice: string) => void;
}) {
  const [draftRefs, setDraftRefs] = useState<string[]>(() => [...state.cycle.modelRefs]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const draftEntries = useMemo(() => resolveCycleEntries(draftRefs, state.providers), [draftRefs, state.providers]);
  const draftSet = useMemo(() => new Set(draftRefs), [draftRefs]);
  const availableModels = useMemo(() => (
    state.providers.flatMap((provider) => provider.models.map((model) => ({
      ref: `${provider.id}/${model.id}`,
      provider,
      model,
    })))
  ).filter(({ provider, model, ref }) => {
    const value = `${provider.id}/${model.id} ${provider.name} ${model.name}`.toLowerCase();
    return provider.status === 'ready' && (!query.trim() || value.includes(query.trim().toLowerCase())) && !draftSet.has(ref);
  }), [draftSet, query, state.providers]);
  const changed = serializeModelRefs(draftRefs) !== serializeModelRefs(state.cycle.modelRefs);
  const invalidEntries = draftEntries.filter((entry) => !entry.valid);

  const addModel = (ref: string) => {
    setDraftRefs((current) => (current.includes(ref) ? current : [...current, ref]));
    setError('');
  };

  const removeModel = (index: number) => {
    setDraftRefs((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setError('');
  };

  const moveModel = (index: number, delta: number) => {
    setDraftRefs((current) => {
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
    setError('');
  };

  const saveCycleList = async () => {
    if (draftRefs.length === 0 && !window.confirm('循环列表为空时，Pi 会回到自己的默认行为。仍然要保存吗？')) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await updateCycleList({ modelRefs: draftRefs });
      onStateChanged(response.state, '循环列表已保存为候选配置');
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '保存循环列表失败。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
      <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
        <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">已加入循环</h2>
              <p className="mt-1 text-[12px] text-surface-500">顺序就是写入顺序。空列表会让 Pi 回到默认行为。</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full bg-surface-100 px-2.5 py-1 text-surface-600 dark:bg-surface-800 dark:text-surface-300">{draftRefs.length} 项</span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{draftEntries.filter((entry) => entry.valid).length} 可用</span>
              {invalidEntries.length > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{invalidEntries.length} 失效</span>}
            </div>
          </div>
        </div>
        <div className="divide-y divide-surface-100 dark:divide-surface-800/50">
          {draftEntries.length > 0 ? draftEntries.map((entry, index) => (
            <div key={`${entry.ref}-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-100 text-[11px] font-medium text-surface-600 dark:bg-surface-800 dark:text-surface-300">{index + 1}</span>
                  <span className="font-mono text-[12px] font-medium text-surface-900 dark:text-white">{cycleEntryLabel(entry)}</span>
                  {entry.valid ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">可用</span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">失效 · {entry.reason}</span>
                  )}
                </div>
                <div className="mt-1 text-[12px] text-surface-500">
                  {entry.providerName} · {entry.modelName}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => moveModel(index, -1)} disabled={index === 0} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 hover:text-surface-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white" aria-label="上移"><ArrowUp size={14} /></button>
                <button type="button" onClick={() => moveModel(index, 1)} disabled={index === draftEntries.length - 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 hover:text-surface-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white" aria-label="下移"><ArrowDown size={14} /></button>
                <button type="button" onClick={() => removeModel(index)} className="inline-flex h-8 items-center rounded-md border border-surface-200 px-3 text-[12px] font-medium text-surface-500 hover:bg-surface-50 hover:text-surface-900 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white"><Trash2 size={13} className="mr-1.5" />移除</button>
              </div>
            </div>
          )) : (
            <div className="px-5 py-10 text-center text-[13px] text-surface-500">
              当前没有任何循环项。保存后 Pi 会使用默认行为。
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20">
          <div className="text-[12px] text-surface-500">
            {invalidEntries.length > 0 ? `有 ${invalidEntries.length} 个失效引用，应用时会被拦住。` : '所有引用当前都可用。'}
          </div>
          <button type="button" onClick={() => void saveCycleList()} disabled={!changed || saving} className="inline-flex h-8 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}保存为候选配置</button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
        <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
          <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">可加入模型</h2>
          <p className="mt-1 text-[12px] text-surface-500">从完整目录里挑选已就绪模型，加入后会追加到列表末尾。</p>
        </div>
        <div className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 provider 或模型" className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-900 dark:text-white" />
          </div>
        </div>
        <div className="max-h-[520px] divide-y divide-surface-100 overflow-y-auto dark:divide-surface-800/50">
          {availableModels.length > 0 ? availableModels.map(({ ref, provider, model }) => (
            <div key={ref} className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <div className="font-mono text-[12px] font-medium text-surface-900 dark:text-white">{ref}</div>
                <div className="mt-1 text-[12px] text-surface-500">{provider.name} · {model.name} · {statusMeta(provider.status).label}</div>
              </div>
              <button type="button" onClick={() => addModel(ref)} className="inline-flex h-8 items-center rounded-md border border-surface-200 px-3 text-[12px] font-medium text-surface-600 hover:bg-surface-50 hover:text-surface-900 dark:border-surface-700 dark:text-surface-300 dark:hover:bg-surface-800 dark:hover:text-white"><Plus size={13} className="mr-1.5" />加入</button>
            </div>
          )) : (
            <div className="px-5 py-10 text-center text-[13px] text-surface-500">
              没有匹配的可加入模型。
            </div>
          )}
        </div>
        {error && <div className="mx-5 mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
      </div>
    </div>
  );
}

function ProfilePage({ state, onStateChanged }: { state: ManagerState; onStateChanged: (nextState: ManagerState, notice: string) => void }) {
  const [applying, setApplying] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [importingLive, setImportingLive] = useState(false);
  const [rollingLive, setRollingLive] = useState(false);
  const [actionError, setActionError] = useState('');

  const appliedSnapshot = state.runtime.appliedSnapshot as {
    targetProject?: string;
    active?: { providerId?: string; modelId?: string; thinking?: string };
    cycle?: { modelRefs?: string[] };
    gateway?: { enabled?: boolean; host?: string; port?: number };
    providers?: ProviderState[];
  } | null;
  const currentActiveProvider = state.providers.find((provider) => provider.id === state.active.providerId);
  const appliedActiveProvider = appliedSnapshot?.providers?.find((provider) => provider.id === appliedSnapshot.active?.providerId);

  const currentRows = [
    { label: '目标项目', value: state.targetProject },
    { label: '默认模型', value: `${state.active.providerId}/${state.active.modelId}` },
    { label: 'Thinking', value: state.active.thinking },
    { label: '凭据引用', value: currentActiveProvider ? `${currentActiveProvider.name} · ${currentActiveProvider.credentialConfigured ? '已配置' : '未配置'}` : '未选择' },
    { label: '循环列表', value: state.cycle.modelRefs.join(' / ') || '空' },
    { label: '网关', value: `${state.gateway.host}:${state.gateway.port} · ${state.gateway.enabled ? '启用' : '关闭'}` },
  ];

  const appliedRows = [
    { label: '目标项目', value: appliedSnapshot?.targetProject || '尚未应用' },
    { label: '默认模型', value: appliedSnapshot?.active ? `${appliedSnapshot.active.providerId}/${appliedSnapshot.active.modelId}` : '尚未应用' },
    { label: 'Thinking', value: appliedSnapshot?.active?.thinking || '尚未应用' },
    { label: '凭据引用', value: appliedActiveProvider ? `${appliedActiveProvider.name} · ${appliedActiveProvider.credentialConfigured ? '已配置' : '未配置'}` : '尚未应用' },
    { label: '循环列表', value: appliedSnapshot?.cycle?.modelRefs?.join(' / ') || '尚未应用' },
    { label: '网关', value: appliedSnapshot?.gateway ? `${appliedSnapshot.gateway.host}:${appliedSnapshot.gateway.port} · ${appliedSnapshot.gateway.enabled ? '启用' : '关闭'}` : '尚未应用' },
  ];

  const applyNow = async () => {
    setApplying(true);
    setActionError('');
    try {
      const response = await applyProfile();
      onStateChanged(response.state, '配置已应用到受控 Profile');
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '应用配置失败。');
    } finally {
      setApplying(false);
    }
  };

  const launchNow = async () => {
    setLaunching(true);
    setActionError('');
    try {
      const response = await launchPi();
      onStateChanged(response.state, '已启动 Pi');
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '启动 Pi 失败。');
    } finally {
      setLaunching(false);
    }
  };

  const stopNow = async () => {
    setStopping(true);
    setActionError('');
    try {
      const response = await stopPi();
      onStateChanged(response.state, '已停止 Pi');
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '停止 Pi 失败。');
    } finally {
      setStopping(false);
    }
  };

  const rollbackNow = async () => {
    if (!state.runtime.appliedSnapshot) {
      setActionError('没有可回滚的已应用配置。');
      return;
    }
    setRollingBack(true);
    setActionError('');
    try {
      const response = await rollbackProfile();
      onStateChanged(response.state, '已回滚到上次成功应用的配置');
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '回滚失败。');
    } finally {
      setRollingBack(false);
    }
  };

  const importLiveNow = async () => {
    if (!window.confirm('将备份并写入本机 ~/.pi/agent 的 settings.json / models.json / auth.json。继续？')) return;
    setImportingLive(true);
    setActionError('');
    try {
      const response = await importLivePi();
      const verify = response.state.runtime.lastLiveVerify;
      onStateChanged(response.state, verify?.ok ? '已导入本机 Pi，可用 pi --list-models 验证' : `已写入本机 Pi，但验证未完全通过：${verify?.error || '未知原因'}`);
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '导入本机 Pi 失败。');
    } finally {
      setImportingLive(false);
    }
  };

  const rollbackLiveNow = async () => {
    if (!state.runtime.lastLiveBackupDir) {
      setActionError('没有可回滚的本机 Pi 备份。');
      return;
    }
    setRollingLive(true);
    setActionError('');
    try {
      const response = await rollbackLivePi();
      onStateChanged(response.state, '已回滚本机 Pi 配置');
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : '回滚本机 Pi 失败。');
    } finally {
      setRollingLive(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">环境 Profiles</h1>
        <p className="mt-1 text-[14px] text-surface-500">隔离 profile 用于试跑；导入本机 Pi 会备份后写入 ~/.pi/agent，供普通 pi 命令验证。</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
            <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">当前状态</h2>
            <p className="mt-1 text-[12px] text-surface-500">这部分显示候选配置、已应用配置和 profile 位置。</p>
          </div>
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <div className="rounded-lg border border-surface-200 p-4 dark:border-surface-800">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Save size={15} /> 候选配置</div>
              <dl className="space-y-2 text-[12px]">
                {currentRows.map((row) => (
                  <div key={row.label} className="flex justify-between gap-4">
                    <dt className="text-surface-500">{row.label}</dt>
                    <dd className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white" title={row.value}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="rounded-lg border border-surface-200 p-4 dark:border-surface-800">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><CheckCircle2 size={15} /> 已应用配置</div>
              <dl className="space-y-2 text-[12px]">
                {appliedRows.map((row) => (
                  <div key={row.label} className="flex justify-between gap-4">
                    <dt className="text-surface-500">{row.label}</dt>
                    <dd className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white" title={row.value}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <div className="grid gap-3 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20 md:grid-cols-3 xl:grid-cols-6">
            <button type="button" onClick={() => void applyNow()} disabled={applying} className="inline-flex items-center justify-center rounded-md border border-surface-200 px-4 py-2 text-[13px] font-medium text-surface-700 hover:bg-surface-50 disabled:cursor-wait disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800">
              {applying ? <Loader2 size={14} className="mr-2 animate-spin" /> : <CheckCircle2 size={14} className="mr-2" />}
              应用隔离 Profile
            </button>
            <button type="button" onClick={() => void importLiveNow()} disabled={importingLive} className="inline-flex items-center justify-center rounded-md bg-primary-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-wait disabled:opacity-60">
              {importingLive ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Download size={14} className="mr-2" />}
              导入本机 Pi
            </button>
            <button type="button" onClick={() => void launchNow()} disabled={launching} className="inline-flex items-center justify-center rounded-md border border-surface-200 px-4 py-2 text-[13px] font-medium text-surface-700 hover:bg-surface-50 hover:text-surface-950 disabled:cursor-wait disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800 dark:hover:text-white">
              {launching ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Play size={14} className="mr-2" />}
              应用并启动
            </button>
            <button type="button" onClick={() => void stopNow()} disabled={stopping || !state.runtime.lastLaunchPid} className="inline-flex items-center justify-center rounded-md border border-surface-200 px-4 py-2 text-[13px] font-medium text-surface-700 hover:bg-surface-50 hover:text-surface-950 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800 dark:hover:text-white">
              {stopping ? <Loader2 size={14} className="mr-2 animate-spin" /> : <X size={14} className="mr-2" />}
              停止 Pi
            </button>
            <button type="button" onClick={() => void rollbackNow()} disabled={rollingBack || !state.runtime.appliedSnapshot} className="inline-flex items-center justify-center rounded-md border border-surface-200 px-4 py-2 text-[13px] font-medium text-surface-700 hover:bg-surface-50 hover:text-surface-950 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800 dark:hover:text-white">
              {rollingBack ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RotateCcw size={14} className="mr-2" />}
              回滚隔离 Profile
            </button>
            <button type="button" onClick={() => void rollbackLiveNow()} disabled={rollingLive || !state.runtime.lastLiveBackupDir} className="inline-flex items-center justify-center rounded-md border border-surface-200 px-4 py-2 text-[13px] font-medium text-surface-700 hover:bg-surface-50 hover:text-surface-950 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800 dark:hover:text-white">
              {rollingLive ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RotateCcw size={14} className="mr-2" />}
              回滚本机 Pi
            </button>
          </div>
          {actionError && <div className="mx-5 mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{actionError}</div>}
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
            <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
              <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">注入预览</h2>
              <p className="mt-1 text-[12px] text-surface-500">应用时会写入 Manager-owned 的隔离 profile。</p>
            </div>
            <div className="space-y-3 p-5 text-[12px]">
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">profile 目录</span>
                <span className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white" title={state.runtime.profilePath}>{state.runtime.profilePath || '尚未生成'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">settings.json</span>
                <span className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white">{state.runtime.profilePath ? `${state.runtime.profilePath}/settings.json` : '尚未生成'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">extensions</span>
                <span className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white" title={state.runtime.extensionPath}>{state.runtime.extensionPath || '尚未生成'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">应用时间</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.runtime.lastAppliedAt || '尚未应用'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">启动时间</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.runtime.lastLaunchAt || '尚未启动'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">启动 PID</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.runtime.lastLaunchPid ?? '无'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">停止时间</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.runtime.lastStopAt || '尚未停止'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">本机 Pi 导入</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.runtime.lastLiveImportAt || '尚未导入'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">本机验证</span>
                <span className="max-w-[220px] truncate font-mono text-surface-900 dark:text-white" title={state.runtime.lastLiveVerify?.error || ''}>{state.runtime.lastLiveVerify ? (state.runtime.lastLiveVerify.ok ? '通过' : '未完全通过') : '尚未验证'}</span>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-[#0a0a0a]">
            <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
              <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">最近状态</h2>
              <p className="mt-1 text-[12px] text-surface-500">当前版本不会把密钥、token 或正文写入事件。</p>
            </div>
            <div className="space-y-3 p-5 text-[12px]">
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">配置 revision</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.configuration.revision}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">已应用 revision</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.configuration.appliedRevision}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">dirty</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.configuration.dirty ? '是' : '否'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-surface-500">Pi 状态</span>
                <span className="font-mono text-surface-900 dark:text-white">{state.pi.installed ? '已安装' : '未安装'} · {state.pi.subscriptionReady ? '订阅可用' : '未验证'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiagnosticsPage({ state }: { state: ManagerState }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">系统诊断</h1>
        <p className="mt-1 text-[14px] text-surface-500">Pi 与 Manager 的当前运行信息。</p>
      </div>
      <div className="grid max-w-5xl gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Activity size={15} /> Pi 环境</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">安装状态</dt><dd>{state.pi.installed ? '已安装' : '未检测到'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">版本</dt><dd className="font-mono">{state.pi.version || '未检测'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">可执行文件</dt><dd className="max-w-[180px] truncate font-mono" title={state.pi.path}>{state.pi.path}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">订阅授权</dt><dd>{state.pi.subscriptionReady ? '已就绪' : '未就绪'}</dd></div>
          </dl>
        </div>
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Server size={15} /> Gateway</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">状态</dt><dd>{state.gateway.running ? '运行中' : '已停止'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">地址</dt><dd className="font-mono">{state.gateway.host}:{state.gateway.port}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">请求数</dt><dd className="font-mono">{state.gateway.stats.requests}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">最近错误</dt><dd className="max-w-[220px] truncate text-right">{state.gateway.stats.lastError || '无'}</dd></div>
          </dl>
        </div>
      </div>
      <div className="grid max-w-5xl gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><CheckCircle2 size={15} /> 配置状态</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">revision</dt><dd className="font-mono">{state.configuration.revision}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">已应用</dt><dd className="font-mono">{state.configuration.appliedRevision}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">dirty</dt><dd>{state.configuration.dirty ? '是' : '否'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">Profile</dt><dd className="max-w-[220px] truncate font-mono" title={state.runtime.profilePath}>{state.runtime.profilePath || '尚未生成'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">Pi PID</dt><dd className="font-mono">{state.runtime.lastLaunchPid ?? '无'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">停止时间</dt><dd className="font-mono">{state.runtime.lastStopAt || '尚未停止'}</dd></div>
          </dl>
        </div>
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-[#0a0a0a]">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Activity size={15} /> 最近事件</div>
          <div className="space-y-3">
            {(state.events.length > 0 ? state.events.slice(0, 6) : []).map((event) => (
              <div key={event.id} className="rounded-md border border-surface-200 px-3 py-2 text-[12px] dark:border-surface-800">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-surface-900 dark:text-white">{event.message}</span>
                  <span className="font-mono text-[11px] text-surface-400">{event.at.slice(11, 19)}</span>
                </div>
                {event.detail && <div className="mt-1 max-w-[420px] truncate text-surface-500">{event.detail}</div>}
              </div>
            ))}
            {state.events.length === 0 && <div className="rounded-md border border-dashed border-surface-200 px-3 py-6 text-center text-[12px] text-surface-500 dark:border-surface-800">暂无事件。</div>}
          </div>
        </div>
      </div>
      {state.runtime.lastError && <div className="flex max-w-5xl items-start rounded-md border border-red-200 bg-red-50 p-3 text-[13px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={15} className="mr-2 mt-0.5 shrink-0" />{state.runtime.lastError}</div>}
    </div>
  );
}

function App() {
  const [activeNav, setActiveNav] = useState<NavId>('providers');
  const [state, setState] = useState<ManagerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionTests, setConnectionTests] = useState<Record<string, ProviderConnectionTestResult>>({});
  const [editingProvider, setEditingProvider] = useState<ProviderState | null | undefined>(undefined);
  const [credentialProvider, setCredentialProvider] = useState<ProviderState | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showDeployModal, setShowDeployModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getState()
      .then((nextState) => {
        if (!cancelled) {
          setState(nextState);
          setError('');
        }
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : '无法连接 Pi Manager API。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshState = async () => {
    setRefreshing(true);
    try {
      const nextState = await getState(true);
      setState(nextState);
      setError('');
      setNotice('状态已刷新');
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '刷新失败，请确认 Manager 服务仍在运行。');
    } finally {
      setRefreshing(false);
    }
  };

  const handleDeleteProvider = async (provider: ProviderState) => {
    if (!window.confirm(`确定删除供应商“${provider.name}”吗？`)) return;
    try {
      const response = await deleteProvider(provider.id);
      setState(response.state);
      setNotice(`已删除 ${provider.name}`);
      setConnectionTests((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '删除供应商失败。');
    }
  };

  const handleTestProvider = async (provider: ProviderState) => {
    try {
      const response = await testProviderConnection(provider.id);
      setState(response.state);
      setConnectionTests((current) => ({ ...current, [provider.id]: response.result }));
      setNotice(`${provider.name} 连接测试：${response.result.message}`);
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : '连接测试失败。');
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-surface-50 text-[13px] text-surface-500 dark:bg-surface-950"><Loader2 size={17} className="mr-2 animate-spin" />正在读取 Pi Manager 状态</div>;
  }

  if (!state) {
    return <div className="flex h-screen flex-col items-center justify-center bg-surface-50 px-6 text-center dark:bg-surface-950"><CircleAlert size={24} className="mb-3 text-red-500" /><h1 className="text-[16px] font-semibold text-surface-900 dark:text-white">无法连接 Manager API</h1><p className="mt-1 max-w-sm text-[13px] text-surface-500">{error || '请先启动 Pi Manager 服务。'}</p><button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-md bg-surface-950 px-4 py-2 text-[13px] font-medium text-white dark:bg-white dark:text-surface-950">重新连接</button></div>;
  }

  return (
    <div className="flex h-screen w-full bg-surface-50 font-sans antialiased dark:bg-surface-950">
      <Sidebar activeNav={activeNav} onNavigate={setActiveNav} piInstalled={state.pi.installed} />
      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar state={state} onDeploy={() => setShowDeployModal(true)} onRefresh={() => void refreshState()} refreshing={refreshing} />
        <div className="flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-[1200px] pb-20">
            {error && <div className="mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
            {notice && <div className="mb-5 flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"><CheckCircle2 size={14} className="mr-2" />{notice}</div>}
            {activeNav === 'providers' && <ProvidersPage state={state} testResults={connectionTests} onAdd={() => setEditingProvider(null)} onImport={() => setShowImportModal(true)} onRefresh={() => void refreshState()} onTest={(provider) => void handleTestProvider(provider)} onCredential={(provider) => setCredentialProvider(provider)} onEdit={(provider) => setEditingProvider(provider)} onDelete={(provider) => void handleDeleteProvider(provider)} />}
            {activeNav === 'models' && <ModelsPage state={state} onStateChanged={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />}
            {activeNav === 'profiles' && <ProfilePage state={state} onStateChanged={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />}
            {activeNav === 'diagnostics' && <DiagnosticsPage state={state} />}
          </div>
        </div>
      </main>
      <ProviderEditorModal key={editingProvider === undefined ? 'closed' : editingProvider?.id || 'create'} provider={editingProvider} isOpen={editingProvider !== undefined} onClose={() => setEditingProvider(undefined)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <ImportPiModal key={showImportModal ? 'import-open' : 'import-closed'} isOpen={showImportModal} onClose={() => setShowImportModal(false)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <CredentialModal key={credentialProvider?.id || 'credential-closed'} provider={credentialProvider} isOpen={Boolean(credentialProvider)} onClose={() => setCredentialProvider(null)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <DeployModal key={showDeployModal ? 'open' : 'closed'} state={state} isOpen={showDeployModal} onClose={() => setShowDeployModal(false)} onApplied={(nextState) => { setState(nextState); setNotice('配置已应用'); setError(''); }} />
    </div>
  );
}

export default App;
