import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  CircleAlert,
  Download,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  ApiError,
  addProviderModel,
  createProvider,
  discoverProviderModels,
  importPiProviders,
  listFeaturedNativeProviders,
  previewPiImport,
  deleteProvider,
  deleteProviderModel,
  deleteProviderCredential,
  getState,
  setProviderCredential,
  rollbackLivePi,
  importLivePi,
  startNativeLogin,
  getNativeLogin,
  answerNativeLogin,
  logoutNativeProvider,
  testProviderConnection,
  type NativeLoginState,
  updateCycleList,
  updateModelContextWindow,
  routeProvider,
  updateModelThinking,
  updateProvider,
} from './api';
import type {
  CreateProviderInput,
  CycleListEntry,
  DiscoveredModel,
  PiImportPreview,
  ManagerState,
  ModelDefinition,
  ProviderConnectionTestResult,
  ProviderState,
  ThinkingLevel,
  ThinkingLevelMap,
  ThinkingMapSource,
} from './types';
import { useI18n, type Translate } from './i18n';

type NavId = 'providers' | 'models' | 'profiles' | 'diagnostics';

function isCustomApiProvider(provider: ProviderState) {
  return provider.kind === 'openai-api';
}

function canConfigureCredential(provider: ProviderState) {
  return provider.kind !== 'native-subscription';
}

function projectName(projectPath: string) {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) || projectPath;
}

function providerKindLabel(kind: ProviderState['kind'], t: Translate) {
  if (kind === 'native-subscription') return t('kind.native');
  if (kind === 'local-bridge') return t('kind.bridge');
  return t('kind.api');
}

function statusMeta(status: ProviderState['status'], t: Translate) {
  if (status === 'ready') return { label: t('status.ready'), className: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' };
  if (status === 'offline') return { label: t('status.offline'), className: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' };
  if (status === 'error') return { label: t('status.error'), className: 'text-red-600 dark:text-red-400', dot: 'bg-red-500' };
  return { label: t('status.unconfigured'), className: 'text-surface-500 dark:text-surface-400', dot: 'bg-surface-300 dark:bg-surface-600' };
}

const PI_THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function thinkingSourceLabel(source: ThinkingMapSource, t: Translate) {
  if (source === 'provider-default') return t('thinkingSource.providerDefault');
  if (source === 'provider-docs') return t('thinkingSource.providerDocs');
  if (source === 'request-probe') return t('thinkingSource.requestProbe');
  return t('thinkingSource.user');
}

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

function thinkingSummary(model: ModelDefinition, t: Translate) {
  if (!model.reasoning) return t('thinking.off');
  return supportedThinkingLevels(model).filter((level) => level !== 'off').join(' / ') || t('thinking.unverified');
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

function cycleEntryLabel(entry: CycleListEntry, t: Translate) {
  return entry.providerId && entry.modelId ? `${entry.providerId}/${entry.modelId}` : entry.ref || t('cycle.invalidRef');
}

function Sidebar({ activeNav, onNavigate, piInstalled }: { activeNav: NavId; onNavigate: (nav: NavId) => void; piInstalled: boolean }) {
  const { t, locale, setLocale } = useI18n();
  const workspaceItems: Array<{ id: NavId; label: string; icon: ReactNode }> = [
    { id: 'providers', label: t('nav.providers'), icon: <Server size={16} strokeWidth={2.3} /> },
    { id: 'models', label: t('nav.models'), icon: <Boxes size={16} strokeWidth={2.3} /> },
    { id: 'profiles', label: t('nav.profiles'), icon: <SlidersHorizontal size={16} strokeWidth={2.3} /> },
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
        <div className="mb-3 mt-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-surface-400">{t('nav.workspace')}</div>
        <div className="space-y-0.5">
          {workspaceItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${activeNav === item.id
                ? 'bg-surface-100 text-surface-900 dark:bg-surface-800 dark:text-surface-50'
                : 'text-surface-500 hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-900 dark:hover:text-surface-50'}`}
            >
              <span className={`mr-2.5 ${activeNav === item.id ? 'text-surface-900 dark:text-white' : 'opacity-70'}`}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>

        <div className="mb-3 mt-8 px-3 text-[10px] font-semibold uppercase tracking-widest text-surface-400">{t('nav.system')}</div>
        <button
          type="button"
          onClick={() => onNavigate('diagnostics')}
          className={`flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${activeNav === 'diagnostics'
            ? 'bg-surface-100 text-surface-900 dark:bg-surface-800 dark:text-surface-50'
            : 'text-surface-500 hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-900 dark:hover:text-surface-50'}`}
        >
          <span className="mr-2.5 opacity-70"><Activity size={16} strokeWidth={2.3} /></span>
          {t('nav.diagnostics')}
        </button>
      </nav>

      <div className="space-y-3 border-t border-surface-200 p-4 dark:border-surface-800">
        <div className="px-1">
          <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-widest text-surface-400">{t('nav.language')}</div>
          <div className="flex rounded-md bg-surface-100 p-0.5 dark:bg-surface-900">
            <button
              type="button"
              onClick={() => setLocale('zh')}
              className={`flex-1 rounded-[5px] px-2 py-1.5 text-[12px] font-medium transition-colors ${locale === 'zh' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-white' : 'text-surface-500 hover:text-surface-900 dark:hover:text-surface-200'}`}
            >
              {t('nav.languageZh')}
            </button>
            <button
              type="button"
              onClick={() => setLocale('en')}
              className={`flex-1 rounded-[5px] px-2 py-1.5 text-[12px] font-medium transition-colors ${locale === 'en' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-800 dark:text-white' : 'text-surface-500 hover:text-surface-900 dark:hover:text-surface-200'}`}
            >
              {t('nav.languageEn')}
            </button>
          </div>
        </div>
        <div className="flex items-center px-2 text-[11px] font-medium text-surface-500">
          <span className={`mr-2 h-1.5 w-1.5 rounded-full ${piInstalled ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-amber-500'}`} />
          {piInstalled ? t('nav.piDetected') : t('nav.piMissing')}
        </div>
      </div>
    </aside>
  );
}

function Topbar({ state, onRefresh, refreshing }: { state: ManagerState; onRefresh: () => void; refreshing: boolean }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-surface-200 bg-white/85 px-8 backdrop-blur-md dark:border-surface-800 dark:bg-surface-950/85">
      <div className="flex min-w-0 items-center text-[13px] font-medium text-surface-500">
        <LayoutDashboard size={15} className="mr-2 shrink-0 text-surface-400" />
        <span className="truncate">{projectName(state.targetProject)}</span>
        {state.active.providerId ? (
          <>
            <span className="mx-2 text-surface-300 dark:text-surface-700">/</span>
            <span className="truncate text-surface-900 dark:text-white">{state.active.providerName}</span>
            <span className="mx-2 text-surface-300 dark:text-surface-700">/</span>
            <span className="truncate font-mono text-[12px] text-surface-500">{state.active.modelId}</span>
          </>
        ) : (
          <span className="ml-2 text-surface-400">· {t('topbar.noModel')}</span>
        )}
      </div>
      <div className="ml-4 flex shrink-0 items-center gap-3">
        {state.runtime.lastError && (
          <span className="flex items-center text-[12px] font-medium text-red-600 dark:text-red-400" title={state.runtime.lastError}>
            <CircleAlert size={14} className="mr-1.5" />
            {t('topbar.recentError')}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          title={t('topbar.refresh')}
          aria-label={t('topbar.refresh')}
          className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-surface-800 dark:hover:text-white"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
    </header>
  );
}

function ProviderCard({ provider, testResult, onTest, onRefresh, onCredential, onLogin, onLogout, onEdit, onDelete }: {
  provider: ProviderState;
  testResult?: ProviderConnectionTestResult;
  onTest: () => void;
  onRefresh: () => void;
  onCredential?: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const meta = statusMeta(provider.status, t);
  const isNative = provider.kind === 'native-subscription';
  const canEdit = isCustomApiProvider(provider);
  const canDelete = canEdit;
  const canCredential = canConfigureCredential(provider);

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-surface-200 bg-white transition-colors hover:border-surface-300 hover:shadow-vercel dark:border-surface-800 dark:bg-surface-900 dark:hover:border-surface-700 dark:hover:shadow-linear">
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
          {providerKindLabel(provider.kind, t)}
        </span>
      </div>

      <div className="flex-1 space-y-4 px-5 text-[13px] text-surface-600 dark:text-surface-400">
        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">{t('card.authStatus')}</span>
          <div className={`flex items-center font-medium ${meta.className}`}>
            <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${meta.dot}`} />
            {isNative ? (provider.status === 'ready' ? t('card.nativeAuthorized') : t('card.nativeNeedsLogin')) : (provider.credentialConfigured ? t('card.apiKeyConfigured') : t('card.apiKeyMissing'))}
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">{t('card.endpoint')}</span>
          {provider.baseUrl ? (
            <span className="max-w-[180px] truncate font-mono text-[11px] text-surface-600 dark:text-surface-400" title={provider.baseUrl}>{provider.baseUrl}</span>
          ) : (
            <span className="font-mono text-[11px] text-surface-400">{t('card.nativeShort')}</span>
          )}
        </div>

        <div className="flex items-center justify-between border-b border-surface-100 pb-3 dark:border-surface-800/50">
          <span className="font-medium text-surface-500">{t('card.modelCount')}</span>
          <span className="font-mono text-[12px] text-surface-900 dark:text-surface-200">{provider.models.length}</span>
        </div>

        <div className="rounded-md bg-surface-50 p-3 dark:bg-surface-800/30">
          <div className="flex items-center text-[12px] font-medium text-surface-900 dark:text-surface-200">
            <Activity size={14} className="mr-2 text-surface-400" />
            {t('card.accessStatus')}
          </div>
          <p className="mt-1 pl-[22px] text-[11px] leading-4 text-surface-500">{provider.detail}</p>
        </div>
        {testResult && (
          <div className={`rounded-md border p-3 text-[11px] leading-4 ${testResult.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{t('card.connectionTest')}</span>
              <span className="font-mono">{testResult.ok ? t('card.testPass') : t('card.testFail')} · {testResult.category}</span>
            </div>
            <div className="mt-1">{testResult.message}</div>
            <div className="mt-1 font-mono text-[10px] opacity-80">{testResult.detail}</div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-surface-100 bg-surface-50/60 px-3 py-2.5 dark:border-surface-800 dark:bg-surface-900">
        <span className="min-w-0 flex-1 truncate px-2 text-[11px] text-surface-500" title={t('card.modelsHint')}>{t('card.modelsHint')}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onTest}
            title={t('card.testTitle')}
            aria-label={t('card.testAria', { name: provider.name })}
            className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
          >
            <CheckCircle2 size={14} />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            title={t('card.refreshTitle')}
            aria-label={t('card.refreshAria', { name: provider.name })}
            className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
          >
            <RefreshCw size={14} />
          </button>
          {isNative && onLogin && provider.status !== 'ready' && (
            <button
              type="button"
              onClick={onLogin}
              title={t('card.loginTitle')}
              aria-label={t('card.loginAria', { name: provider.name })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
            >
              <KeyRound size={14} />
            </button>
          )}
          {isNative && onLogout && provider.status === 'ready' && (
            <button
              type="button"
              onClick={onLogout}
              title={t('card.logoutTitle')}
              aria-label={t('card.logoutAria', { name: provider.name })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <X size={14} />
            </button>
          )}
          {canCredential && onCredential && (
            <button
              type="button"
              onClick={onCredential}
              title={t('card.credentialTitle')}
              aria-label={t('card.credentialAria', { name: provider.name })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
            >
              <KeyRound size={14} />
            </button>
          )}
          {canEdit && onEdit && (
            <button
              type="button"
              onClick={onEdit}
              title={t('card.editTitle')}
              aria-label={t('card.editAria', { name: provider.name })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-900 dark:hover:bg-surface-800 dark:hover:text-white"
            >
              <Pencil size={14} />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              title={t('card.deleteTitle')}
              aria-label={t('card.deleteAria', { name: provider.name })}
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

function ProvidersPage({ state, testResults, onAdd, onImport, onRefresh, onTest, onCredential, onLogin, onLogout, onEdit, onDelete, onNativeLogin }: {
  state: ManagerState;
  testResults: Record<string, ProviderConnectionTestResult>;
  onAdd: () => void;
  onImport: () => void;
  onRefresh: () => void;
  onTest: (provider: ProviderState) => void;
  onCredential: (provider: ProviderState) => void;
  onLogin: (provider: ProviderState) => void;
  onLogout: (provider: ProviderState) => void;
  onEdit: (provider: ProviderState) => void;
  onDelete: (provider: ProviderState) => void;
  onNativeLogin: () => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<'all' | 'ready' | 'native'>('all');
  const [query, setQuery] = useState('');
  const isTrulyEmpty = state.providers.length === 0 && !query.trim();
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">{t('providers.title')}</h1>
          <p className="mt-1 text-[14px] text-surface-500">{t('providers.subtitle')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onImport}
            className="flex h-9 items-center rounded-md border border-surface-200 bg-white px-4 text-[13px] font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            <Download size={16} className="mr-2 opacity-70" />
            {t('providers.importPi')}
          </button>
          <button
            type="button"
            onClick={onNativeLogin}
            className="flex h-9 items-center rounded-md border border-surface-200 bg-white px-4 text-[13px] font-medium text-surface-700 shadow-sm transition-colors hover:bg-surface-50 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200 dark:hover:bg-surface-800"
          >
            <KeyRound size={16} className="mr-2 opacity-70" />
            {t('providers.loginNative')}
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="flex h-9 items-center rounded-md bg-surface-950 px-4 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-surface-800 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200"
          >
            <Plus size={16} className="mr-2 opacity-70" />
            {t('providers.add')}
          </button>
        </div>
      </div>

      <div className="flex flex-col items-start justify-between gap-4 border-b border-surface-200 pb-2 md:flex-row md:items-center dark:border-surface-800">
        <div className="flex w-full items-center gap-6 overflow-x-auto md:w-auto">
          {[
            ['all', t('providers.filterAll', { count: state.providers.length })],
            ['ready', t('providers.filterReady', { count: state.providers.filter((provider) => provider.status === 'ready').length })],
            ['native', t('providers.filterNative', { count: state.providers.filter((provider) => provider.kind === 'native-subscription').length })],
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
            placeholder={t('providers.search')}
            aria-label={t('providers.search')}
            className="w-full rounded-md border border-surface-200 bg-white py-1.5 pl-8 pr-3 text-[13px] text-surface-900 outline-none transition-colors placeholder:text-surface-400 focus:border-surface-400 focus:ring-1 focus:ring-surface-400 dark:border-surface-700 dark:bg-surface-950 dark:text-white"
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
              onLogin={() => onLogin(provider)}
              onLogout={() => onLogout(provider)}
              onEdit={() => onEdit(provider)}
              onDelete={() => onDelete(provider)}
            />
          ))}
        </div>
      ) : isTrulyEmpty ? (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-surface-300 bg-white/60 px-6 text-center dark:border-surface-800 dark:bg-surface-900/60">
          <Server size={22} className="mb-3 text-surface-400" />
          <h2 className="text-[14px] font-medium text-surface-900 dark:text-white">{t('providers.emptyTitle')}</h2>
          <p className="mt-1 text-[13px] text-surface-500">{t('providers.emptyBody')}</p>
          <div className="mt-4 flex items-center gap-2">
            <button type="button" onClick={onImport} className="flex h-9 items-center rounded-md bg-surface-950 px-4 text-[13px] font-medium text-white hover:bg-surface-800 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
              <Download size={15} className="mr-2 opacity-70" />
              {t('providers.importPi')}
            </button>
            <button type="button" onClick={onNativeLogin} className="flex h-9 items-center rounded-md border border-surface-200 bg-white px-4 text-[13px] font-medium text-surface-700 hover:bg-surface-50 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200">{t('providers.loginNative')}</button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-surface-300 bg-white/60 text-center dark:border-surface-800 dark:bg-surface-900/60">
          <Search size={22} className="mb-3 text-surface-400" />
          <h2 className="text-[14px] font-medium text-surface-900 dark:text-white">{t('providers.noMatchTitle')}</h2>
          <p className="mt-1 text-[13px] text-surface-500">{t('providers.noMatchBody')}</p>
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
  const { t } = useI18n();
  const editing = Boolean(provider);
  const [name, setName] = useState(provider?.name || '');
  const [id, setId] = useState(provider?.id || '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || '');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState(provider?.models.map((model) => model.id).join(', ') || '');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [discoveryQuery, setDiscoveryQuery] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const discover = async () => {
    if (!baseUrl.trim()) {
      setDiscoveryError(t('editor.needBaseUrl'));
      return;
    }
    setDiscovering(true);
    setDiscoveryError('');
    try {
      const response = await discoverProviderModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined });
      if (!response.result.ok) {
        setDiscoveryError(t('editor.discoverPartial', { message: response.result.message }));
        return;
      }
      setDiscoveredModels(response.result.models);
      setSelectedModelIds(response.result.models.map((model) => model.id));
      setModels(response.result.models.map((model) => model.id).join(', '));
    } catch (caughtError) {
      setDiscoveryError(caughtError instanceof ApiError ? caughtError.message : t('editor.discoverFailed'));
    } finally {
      setDiscovering(false);
    }
  };

  const visibleDiscoveredModels = discoveredModels.filter((model) => {
    const query = discoveryQuery.trim().toLowerCase();
    return !query || `${model.id} ${model.name} ${model.ownedBy || ''}`.toLowerCase().includes(query);
  });

  const updateDiscoveredModel = (modelId: string, patch: Partial<DiscoveredModel>) => {
    setDiscoveredModels((current) => current.map((model) => model.id === modelId ? { ...model, ...patch } : model));
    if (patch.id !== undefined && patch.id !== modelId) {
      setSelectedModelIds((current) => current.map((id) => id === modelId ? patch.id! : id));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const modelIds = models.split(',').map((model) => model.trim()).filter(Boolean);
    const selectedModels = discoveredModels
      .filter((model) => selectedModelIds.includes(model.id) && model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
        reasoning: model.reasoning,
        input: model.input,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {})
      }));
    if (discoveredModels.length > 0 && selectedModels.length === 0) {
      setError(t('editor.needSelection'));
      return;
    }
    if (discoveredModels.length === 0 && modelIds.length === 0) {
      setError(t('editor.needModelId'));
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
          models: discoveredModels.length > 0 ? selectedModels : modelIds,
          apiKey: apiKey.trim() || undefined,
        });
        onSaved(response.state, t('editor.updated'));
      } else {
        const input: CreateProviderInput = {
          id: id.trim() || undefined,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          kind: 'openai-api',
          models: discoveredModels.length > 0 ? selectedModels : modelIds,
          apiKey: apiKey.trim() || undefined,
        };
        const response = await createProvider(input);
        onSaved(response.state, t('editor.created'));
      }
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('editor.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel max-w-lg" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="provider-editor-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{editing ? t('editor.editTitle') : t('editor.createTitle')}</h2>
            <p className="mt-1 text-[12px] text-surface-500">{t('editor.compat')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title={t('common.close')} aria-label={t('common.close')} className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('editor.displayName')}</span>
              <input required value={name} onChange={(event) => setName(event.target.value)} placeholder={t('editor.namePlaceholder')} autoFocus className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Provider ID <span className="font-normal text-surface-400">{t('common.optional')}</span></span>
              <input value={id} onChange={(event) => setId(event.target.value)} placeholder={t('editor.idPlaceholder')} pattern="[A-Za-z0-9_-]+" title={t('editor.idPattern')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Base URL</span>
              <input required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </label>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('editor.catalog')}</span>
                  <p className="mt-0.5 text-[11px] text-surface-500">{t('editor.catalogHint')}</p>
                </div>
                <button type="button" onClick={() => void discover()} disabled={discovering} className="inline-flex h-8 shrink-0 items-center rounded-md border border-surface-200 px-3 text-[12px] font-medium text-surface-700 hover:bg-surface-50 disabled:cursor-wait disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800">
                  {discovering && <Loader2 size={13} className="mr-1.5 animate-spin" />}
                  {t('editor.fetchModels')}
                </button>
              </div>
              {discoveredModels.length > 0 && <div className="space-y-2 rounded-md border border-surface-200 p-2 dark:border-surface-700">
                <div className="flex items-center gap-2">
                  <input value={discoveryQuery} onChange={(event) => setDiscoveryQuery(event.target.value)} placeholder={t('editor.searchUpstream')} className="min-w-0 flex-1 rounded border border-surface-200 bg-surface-50 px-2 py-1.5 text-[12px] outline-none focus:border-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
                  <button type="button" onClick={() => setSelectedModelIds(visibleDiscoveredModels.map((model) => model.id))} className="shrink-0 text-[11px] text-primary-600 hover:underline dark:text-primary-400">{t('common.selectAll')}</button>
                  <button type="button" onClick={() => setSelectedModelIds([])} className="shrink-0 text-[11px] text-surface-500 hover:underline">{t('common.clear')}</button>
                </div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                {visibleDiscoveredModels.map((model) => (
                  <div key={model.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-50 dark:hover:bg-surface-800/60">
                    <input type="checkbox" checked={selectedModelIds.includes(model.id)} onChange={(event) => setSelectedModelIds((current) => event.target.checked ? [...current, model.id] : current.filter((id) => id !== model.id))} aria-label={t('editor.selectModel', { id: model.id })} className="h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500" />
                    <input value={model.id} onChange={(event) => updateDiscoveredModel(model.id, { id: event.target.value })} aria-label={t('editor.modelIdAria', { id: model.id })} className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 font-mono text-[12px] text-surface-900 outline-none focus:border-surface-300 focus:bg-white dark:text-white dark:focus:border-surface-600 dark:focus:bg-surface-950" />
                    <input value={model.name} onChange={(event) => updateDiscoveredModel(model.id, { name: event.target.value })} aria-label={t('editor.modelNameAria', { id: model.id })} className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-1 text-[12px] text-surface-700 outline-none focus:border-surface-300 focus:bg-white dark:text-surface-200 dark:focus:border-surface-600 dark:focus:bg-surface-950" />
                    <label className="flex shrink-0 items-center gap-1 text-[10px] text-surface-400" title={t('editor.thinkingHint')}><input type="checkbox" checked={model.reasoning} onChange={(event) => updateDiscoveredModel(model.id, { reasoning: event.target.checked })} aria-label={t('editor.thinkingAria', { id: model.id })} />{t('common.thinking')}</label>
                  </div>
                ))}
                {visibleDiscoveredModels.length === 0 && <p className="px-2 py-3 text-[11px] text-surface-500">{t('editor.noUpstreamMatch')}</p>}
                </div>
              </div>}
              <input value={models} onChange={(event) => { setModels(event.target.value); setSelectedModelIds([]); }} placeholder={t('editor.manualPlaceholder')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
              {discoveryError && <p className="text-[11px] leading-4 text-amber-600 dark:text-amber-400">{discoveryError}</p>}
            </div>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">API Key <span className="font-normal text-surface-400">{t('common.optional')}</span></span>
              <div className="relative">
                <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" placeholder={editing ? (provider?.credentialConfigured ? t('editor.keepKey') : t('editor.laterKey')) : t('editor.laterKey')} className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
              </div>
              <p className="text-[11px] text-surface-500">{t('editor.keyHint')}</p>
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">{t('common.cancel')}</button>
            <button type="submit" disabled={submitting} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              {t('common.saveCandidate')}
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
  const { t } = useI18n();
  const [preview, setPreview] = useState<PiImportPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSelectedIds([]);
    void previewPiImport()
      .then((response) => {
        if (!cancelled) setPreview(response.preview);
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : t('import.readFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, t]);

  if (!isOpen) return null;

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
    setError('');
  };

  const importNow = async (overwrite: boolean) => {
    setSubmitting(true);
    setError('');
    try {
      const response = await importPiProviders(overwrite, selectedIds);
      onSaved(response.state, t('import.imported', { count: response.result.imported.length }));
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('import.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel max-w-xl" role="dialog" aria-modal="true" aria-labelledby="import-pi-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="import-pi-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{t('import.title')}</h2>
            <p className="mt-1 text-[12px] text-surface-500">{t('import.subtitle')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title={t('common.close')} aria-label={t('common.close')} className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          {loading && <div className="flex items-center text-[13px] text-surface-500"><Loader2 size={14} className="mr-2 animate-spin" />{t('import.reading')}</div>}
          {preview && (
            <>
              <div className="truncate font-mono text-[11px] text-surface-400" title={preview.modelsPath}>{preview.modelsPath || t('import.noModelsJson')}</div>
              {preview.candidates.length === 0 ? (
                <p className="text-[13px] text-surface-500">{t('import.empty')}</p>
              ) : (
                <ul className="space-y-2">
                  {preview.candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-surface-200 px-3 py-2 text-[12px] dark:border-surface-800">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(candidate.id)}
                          onChange={() => toggleSelected(candidate.id)}
                          aria-label={t('import.importAria', { name: candidate.name })}
                          className="mt-1 h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center justify-between gap-3">
                            <span className="font-medium text-surface-900 dark:text-white">{candidate.name}</span>
                            <span className="font-mono text-surface-400">{candidate.id}</span>
                          </span>
                          <span className="mt-1 block truncate font-mono text-[11px] text-surface-500">{candidate.baseUrl}</span>
                          <span className="mt-1 block text-surface-500">{t('import.modelsCount', { count: candidate.models.length })} · {candidate.credentialKind === 'literal' ? t('import.willStoreKey') : candidate.credentialKind === 'env' ? t('import.refEnv', { env: candidate.credentialEnv || '' }) : t('import.noKey')}</span>
                          {candidate.conflict && <span className="mt-1 block text-amber-600 dark:text-amber-400">{t('import.conflict', { name: candidate.existingName || candidate.id })}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {preview.skipped.length > 0 && <p className="text-[11px] text-surface-400">{t('import.skipped', { ids: preview.skipped.map((item) => item.id).join(', ') })}</p>}
            </>
          )}
          {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
        </div>
        <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">{t('common.cancel')}</button>
          {preview && preview.candidates.some((candidate) => candidate.conflict && selectedIds.includes(candidate.id)) && (
            <button type="button" onClick={() => void importNow(true)} disabled={submitting || selectedIds.length === 0} className="rounded-md border border-amber-200 px-4 py-2 text-[13px] font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/10">{t('import.overwriteConflict')}</button>
          )}
          <button type="button" onClick={() => void importNow(false)} disabled={submitting || !preview || selectedIds.length === 0} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
            {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
            {selectedIds.length > 0 ? t('import.submitCount', { count: selectedIds.length }) : t('import.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

function NativeLoginModal({ provider, isOpen, onClose, onSaved }: {
  provider?: ProviderState | null;
  isOpen: boolean;
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const { t } = useI18n();
  const [authType, setAuthType] = useState<'oauth' | 'api_key'>('oauth');
  const [apiKey, setApiKey] = useState('');
  const [promptValue, setPromptValue] = useState('');
  const [login, setLogin] = useState<NativeLoginState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [featured, setFeatured] = useState<ProviderState[]>([]);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderState | null>(provider || null);
  const methods = (selectedProvider || provider)?.authMethods?.length
    ? (selectedProvider || provider)!.authMethods!
    : (['oauth', 'api_key'] as Array<'oauth' | 'api_key'>);

  useEffect(() => {
    if (!isOpen) {
      setLogin(null);
      setApiKey('');
      setPromptValue('');
      setError('');
      setSubmitting(false);
      setSelectedProvider(provider || null);
      setAuthType('oauth');
    }
  }, [isOpen, provider?.id]);

  useEffect(() => {
    if (!isOpen || provider) return;
    let cancelled = false;
    setFeaturedLoading(true);
    void listFeaturedNativeProviders()
      .then((response) => {
        if (!cancelled) setFeatured(response.providers);
      })
      .catch((caughtError) => {
        if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : t('login.listFailed'));
      })
      .finally(() => {
        if (!cancelled) setFeaturedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, provider?.id, t]);

  useEffect(() => {
    if (!isOpen || !login?.loginId || login.status === 'completed' || login.status === 'error') return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getNativeLogin(login.loginId!)
        .then((response) => {
          if (cancelled) return;
          setLogin(response.login);
          if (response.login.status === 'completed') {
            onSaved(response.state, t('login.loggedIn', { name: provider?.name || t('login.nativeFallback') }));
            onClose();
          }
          if (response.login.status === 'error') setError(response.login.error || t('login.failed'));
        })
        .catch((caughtError) => {
          if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : t('login.statusFailed'));
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isOpen, login?.loginId, login?.status, provider?.name, t]);

  if (!isOpen) return null;
  const activeProvider = selectedProvider || provider || null;

  const startLogin = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!activeProvider) {
      setError(t('login.needProvider'));
      return;
    }
    if (authType === 'api_key' && !apiKey.trim()) {
      setError(t('login.needApiKey'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await startNativeLogin({
        providerId: activeProvider.id,
        type: authType,
        apiKey: authType === 'api_key' ? apiKey.trim() : undefined,
      });
      setLogin(response.login);
      if (response.login.status === 'completed') {
        onSaved(response.state, t('login.loggedIn', { name: activeProvider.name }));
        onClose();
      }
      if (response.login.status === 'error') setError(response.login.error || t('login.failed'));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const submitPrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!login?.loginId || !promptValue.trim()) {
      setError(t('login.needInput'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await answerNativeLogin(login.loginId, promptValue.trim());
      setPromptValue('');
      setLogin(response.login);
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('login.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel max-w-md" role="dialog" aria-modal="true" aria-labelledby="native-login-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="native-login-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{t('login.title')}</h2>
            <p className="mt-1 text-[12px] text-surface-500">{activeProvider ? `${activeProvider.name} · ${activeProvider.id}` : t('login.pickProvider')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title={t('common.close')} aria-label={t('common.close')} className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div className="rounded-md bg-surface-50 px-3 py-2 text-[12px] text-surface-500 dark:bg-surface-950/60">{t('login.authHint')}</div>
          {!login && !provider && (
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('login.channel')}</span>
              <select value={selectedProvider?.id || ''} onChange={(event) => { setSelectedProvider(featured.find((item) => item.id === event.target.value) || null); setAuthType('oauth'); setError(''); }} disabled={featuredLoading} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                <option value="">{featuredLoading ? t('login.reading') : t('login.pleaseSelect')}</option>
                {featured.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
              </select>
            </label>
          )}
          {!login && activeProvider && methods.length > 1 && (
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('login.method')}</span>
              <select value={authType} onChange={(event) => setAuthType(event.target.value as 'oauth' | 'api_key')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                {methods.includes('oauth') && <option value="oauth">{t('login.oauth')}</option>}
                {methods.includes('api_key') && <option value="api_key">{t('login.apiKeyMethod')}</option>}
              </select>
            </label>
          )}
          {!login && authType === 'api_key' && (
            <form onSubmit={(event) => void startLogin(event)} className="space-y-4">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">API Key</span>
                <input value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(''); }} type="password" autoComplete="new-password" autoFocus placeholder={t('login.noEcho')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
              </label>
              <button type="submit" disabled={submitting} className="flex h-9 w-full items-center justify-center rounded-md bg-surface-950 text-[13px] font-medium text-white hover:bg-surface-800 disabled:opacity-60 dark:bg-white dark:text-surface-950">
                {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
                {t('login.saveAuth')}
              </button>
            </form>
          )}
          {!login && authType === 'oauth' && (
            <button type="button" onClick={() => void startLogin()} disabled={submitting} className="flex h-9 w-full items-center justify-center rounded-md bg-surface-950 text-[13px] font-medium text-white hover:bg-surface-800 disabled:opacity-60 dark:bg-white dark:text-surface-950">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              {t('login.openBrowser')}
            </button>
          )}
          {login?.authUrl && (
            <div className="space-y-2 rounded-md border border-surface-200 px-3 py-2 text-[12px] dark:border-surface-800">
              <div className="text-surface-500">{t('login.opened')}</div>
              <a href={login.authUrl} target="_blank" rel="noreferrer" className="block truncate font-mono text-primary-600 hover:underline dark:text-primary-400">{login.authUrl}</a>
            </div>
          )}
          {login?.status === 'need_prompt' && login.prompt && (
            <form onSubmit={(event) => void submitPrompt(event)} className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{login.prompt.message}</span>
                {login.prompt.options && login.prompt.options.length > 0 ? (
                  <select value={promptValue} onChange={(event) => setPromptValue(event.target.value)} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                    <option value="">{t('login.pleaseSelect')}</option>
                    {login.prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                ) : (
                  <input value={promptValue} onChange={(event) => setPromptValue(event.target.value)} placeholder={login.prompt.placeholder || ''} autoFocus className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] outline-none focus:border-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
                )}
              </label>
              <button type="submit" disabled={submitting} className="flex h-9 w-full items-center justify-center rounded-md bg-surface-950 text-[13px] font-medium text-white hover:bg-surface-800 disabled:opacity-60 dark:bg-white dark:text-surface-950">
                {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
                {t('login.continue')}
              </button>
            </form>
          )}
          {login?.status === 'pending' && <div className="flex items-center text-[12px] text-surface-500"><Loader2 size={14} className="mr-2 animate-spin" />{t('login.waiting')}</div>}
          {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
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
  const { t } = useI18n();
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen || !provider) return null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!apiKey.trim()) {
      setError(t('login.needApiKey'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await setProviderCredential(provider.id, apiKey.trim());
      onSaved(response.state, t('cred.saved', { name: provider.name }));
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('cred.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const clear = async () => {
    setSubmitting(true);
    setError('');
    try {
      const response = await deleteProviderCredential(provider.id);
      onSaved(response.state, t('cred.cleared', { name: provider.name }));
      onClose();
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('cred.clearFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel max-w-md" role="dialog" aria-modal="true" aria-labelledby="credential-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="credential-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{t('cred.title')}</h2>
            <p className="mt-1 text-[12px] text-surface-500">{provider.name} · {provider.id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title={t('common.close')} aria-label={t('common.close')} className="text-surface-400 transition-colors hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
            <div className="rounded-md bg-surface-50 px-3 py-2 text-[12px] text-surface-500 dark:bg-surface-900/50">
              {provider.credentialConfigured ? t('cred.hasKey') : t('cred.noKey')}
              {provider.id === 'antigravity' ? t('cred.antigravity') : ''}
            </div>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">API Key</span>
              <div className="relative">
                <KeyRound size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(''); }} type="password" autoComplete="new-password" autoFocus placeholder={t('cred.noEcho')} className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
              </div>
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={() => void clear()} disabled={submitting || !provider.credentialConfigured} className="rounded-md px-4 py-2 text-[13px] font-medium text-red-600 transition-colors hover:text-red-700 disabled:opacity-40 dark:text-red-400">{t('cred.clear')}</button>
            <div className="flex gap-3">
              <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 transition-colors hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">{t('common.cancel')}</button>
              <button type="submit" disabled={submitting} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white transition-colors hover:bg-surface-800 disabled:cursor-wait disabled:opacity-60 dark:bg-white dark:text-surface-950 dark:hover:bg-surface-200">
                {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
                {t('cred.save')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

function AddCatalogModelModal({ providers, onClose, onSaved }: {
  providers: ProviderState[];
  onClose: () => void;
  onSaved: (state: ManagerState, notice: string) => void;
}) {
  const { t } = useI18n();
  const [providerId, setProviderId] = useState(providers[0]?.id || '');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [reasoning, setReasoning] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!providerId || !modelId.trim()) {
      setError(t('addModel.needFields'));
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
      onSaved(response.state, t('addModel.added', { ref: `${providerId}/${modelId.trim()}` }));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('addModel.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-panel max-w-md" role="dialog" aria-modal="true" aria-labelledby="add-model-title">
        <div className="flex items-center justify-between border-b border-surface-100 p-5 dark:border-surface-800">
          <div>
            <h2 id="add-model-title" className="text-[16px] font-bold text-surface-900 dark:text-white">{t('addModel.title')}</h2>
            <p className="mt-1 text-[12px] text-surface-500">{t('addModel.subtitle')}</p>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} title={t('common.close')} aria-label={t('common.close')} className="text-surface-400 hover:text-surface-900 disabled:opacity-50 dark:hover:text-white"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('addModel.channel')}</span>
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('addModel.modelId')}</span>
              <input required value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={t('addModel.idPlaceholder')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('addModel.displayName')} <span className="font-normal text-surface-400">{t('common.optional')}</span></span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('addModel.namePlaceholder')} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-surface-600 dark:text-surface-300">
              <input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} className="h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500" />
              {t('addModel.reasoning')}
            </label>
            {error && <div className="flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
          </div>
          <div className="flex justify-end gap-3 border-t border-surface-100 bg-surface-50 p-5 dark:border-surface-800 dark:bg-surface-900/50">
            <button type="button" onClick={onClose} disabled={submitting} className="rounded-md px-4 py-2 text-[13px] font-medium text-surface-600 hover:text-surface-900 disabled:opacity-50 dark:text-surface-400 dark:hover:text-white">{t('common.cancel')}</button>
            <button type="submit" disabled={submitting || providers.length === 0} className="flex items-center rounded-md bg-surface-950 px-5 py-2 text-[13px] font-medium text-white hover:bg-surface-800 disabled:opacity-60 dark:bg-white dark:text-surface-950">
              {submitting && <Loader2 size={14} className="mr-2 animate-spin" />}
              {t('addModel.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type ModelsTab = 'catalog' | 'cycle' | 'default' | 'thinking';

function ModelsPage({ state, onStateChanged }: { state: ManagerState; onStateChanged: (nextState: ManagerState, notice: string) => void }) {
  const { t } = useI18n();
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
      setRouteError(t('models.needRoute'));
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
      onStateChanged(response.state, t('models.routeSaved'));
    } catch (caughtError) {
      setRouteError(caughtError instanceof ApiError ? caughtError.message : t('models.routeFailed'));
    } finally {
      setSavingRoute(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">{t('models.title')}</h1>
        <p className="mt-1 text-[14px] text-surface-500">{t('models.subtitle', { count: models.length })}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-surface-200 dark:border-surface-800">
        {[
          ['catalog', t('models.tabCatalog')],
          ['cycle', t('models.tabCycle')],
          ['default', t('models.tabDefault')],
          ['thinking', t('models.tabThinking')],
        ].map(([value, label]) => (
          <button key={value} type="button" onClick={() => setActiveTab(value as ModelsTab)} className={`pb-2 text-[13px] font-medium ${activeTab === value ? 'border-b-2 border-surface-900 text-surface-900 dark:border-white dark:text-white' : 'text-surface-500 hover:text-surface-900 dark:hover:text-white'}`}>{label}</button>
        ))}
      </div>

      {activeTab === 'catalog' && (
        <div className="overflow-hidden rounded-xl border border-surface-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-surface-100 bg-surface-50/50 p-3 dark:border-surface-800 dark:bg-surface-900/20">
            <div className="relative w-64 max-w-full">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('models.searchId')} aria-label={t('models.searchId')} className="w-full rounded-md border border-surface-200 bg-white py-1.5 pl-8 pr-3 text-[13px] outline-none focus:border-surface-400 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden max-w-md truncate text-[12px] text-surface-500 xl:inline" title={t('models.catalogHint')}>{t('models.catalogHint')}</span>
              <button type="button" onClick={() => setShowAddModel(true)} disabled={customProviders.length === 0} className="inline-flex h-8 items-center rounded-md border border-surface-200 bg-white px-3 text-[12px] font-medium text-surface-700 hover:bg-surface-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200">
                <Plus size={13} className="mr-1.5" />{t('models.add')}
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[13px]">
              <thead className="bg-surface-50/80 text-[12px] font-medium text-surface-500 dark:bg-surface-900/50 dark:text-surface-400">
                <tr>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">{t('models.colModel')}</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">Provider</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">{t('models.colInput')}</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">Thinking</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">Context</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">{t('models.colStatus')}</th>
                  <th className="whitespace-nowrap border-b border-surface-100 px-4 py-3 dark:border-surface-800">{t('models.colPolicy')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-100 text-surface-700 dark:divide-surface-800/50 dark:text-surface-300">
                {visibleModels.map(({ provider, model }) => (
                  <tr key={`${provider.id}/${model.id}`} className="hover:bg-surface-50 dark:hover:bg-surface-900/30">
                    <td className="px-4 py-3"><div className="font-medium text-surface-900 dark:text-white">{model.name}</div><div className="font-mono text-[11px] text-surface-400">{provider.id}/{model.id}</div></td>
                    <td className="max-w-[180px] truncate px-4 py-3" title={provider.name}>{provider.name}</td>
                    <td className="px-4 py-3 text-[12px] text-surface-500">{model.input.join(', ')}</td>
                    <td className="px-4 py-3 text-[12px] text-surface-500">{thinkingSummary(model, t)}</td>
                    <td className="px-4 py-3"><ModelContextWindowEditor key={`${provider.id}/${model.id}:${model.contextWindow}`} provider={provider} model={model} onStateChanged={onStateChanged} /></td>
                    <td className="whitespace-nowrap px-4 py-3">{provider.id === state.active.providerId && model.id === state.active.modelId ? <span className="text-primary-600 dark:text-primary-400">{t('models.default')}</span> : provider.status === 'ready' ? <span className="text-surface-400">{t('common.available')}</span> : <span className="text-amber-600 dark:text-amber-400">{statusMeta(provider.status, t).label}</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => { setMappingRef(`${provider.id}/${model.id}`); setActiveTab('thinking'); }} title={t('models.editThinking', { name: model.name })} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-surface-600 transition-colors hover:bg-surface-100 hover:text-surface-950 dark:text-surface-400 dark:hover:bg-surface-800 dark:hover:text-white"><Pencil size={13} />{t('models.map')}</button>
                        {isCustomApiProvider(provider) && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!window.confirm(t('models.deleteConfirm', { ref: `${provider.id}/${model.id}` }))) return;
                              void deleteProviderModel(provider.id, model.id)
                                .then((response) => { setCatalogError(''); onStateChanged(response.state, t('models.deleted', { ref: `${provider.id}/${model.id}` })); })
                                .catch((caughtError) => setCatalogError(caughtError instanceof ApiError ? caughtError.message : t('models.deleteFailed')));
                            }}
                            title={t('models.deleteAria', { name: model.name })}
                            aria-label={t('models.deleteAria', { name: model.name })}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-surface-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {visibleModels.length === 0 && <tr><td colSpan={7} className="px-4 py-10 text-center text-[13px] text-surface-500">{t('models.noMatch')}</td></tr>}
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
        <div className="max-w-3xl rounded-xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-100 text-surface-500 dark:bg-surface-800"><CheckCircle2 size={17} /></div>
            <div><h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">{t('models.defaultTitle')}</h2><p className="text-[12px] text-surface-500">{t('models.defaultHint')}</p></div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Provider</span>
              <select value={selectedProviderId} onChange={(event) => handleProviderChange(event.target.value)} disabled={providerOptions.length === 0} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                {providerOptions.length === 0 && <option value="">{t('models.noSources')}</option>}
                {providerOptions.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}{provider.status === 'ready' ? '' : ` · ${statusMeta(provider.status, t).label}`}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Model</span>
              <select value={selectedModelId} onChange={(event) => handleModelChange(event.target.value)} disabled={!selectedProvider || selectedProvider.models.length === 0} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                {!selectedProvider && <option value="">{t('models.pickProviderFirst')}</option>}
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.id}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">Thinking</span>
              <select value={selectedThinking} onChange={(event) => { setSelectedThinking(event.target.value as ThinkingLevel); setRouteError(''); }} disabled={!selectedModel} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 text-[13px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-md bg-surface-50 px-4 py-3 text-[12px] dark:bg-surface-900/50">
            <div className="min-w-0">
              <div className="font-mono text-surface-900 dark:text-white">{selectedProvider && selectedModel ? `${selectedProvider.id}/${selectedModel.id}` : t('models.notSelected')}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-surface-500">
                <span>{selectedProvider ? (selectedProvider.status === 'ready' ? t('models.authReady') : t('models.authStatus', { label: statusMeta(selectedProvider.status, t).label })) : t('models.pickProvider')}</span>
                <span>{selectedModel ? t('models.supported', { levels: thinkingLevels.join(' / ') }) : t('models.noCaps')}</span>
              </div>
            </div>
            <button type="button" onClick={() => void saveDefaultRoute()} disabled={!routeIsValid || !routeChanged || savingRoute} className="flex h-8 shrink-0 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">
              {savingRoute && <Loader2 size={13} className="mr-1.5 animate-spin" />}
              {t('common.saveCandidate')}
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-surface-500">
            <span>{t('models.saveHint')}</span>
            <span>{t('models.revision', { revision: state.configuration.revision, applied: state.configuration.appliedRevision })}</span>
          </div>
          {routeError && <div className="mt-4 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{routeError}</div>}
        </div>
      )}

      {activeTab === 'thinking' && (
        <div className="max-w-4xl space-y-4">
          <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <label className="block min-w-[280px] flex-1 space-y-1.5">
                <span className="text-[12px] font-semibold text-surface-700 dark:text-surface-300">{t('models.pickModel')}</span>
                <select value={effectiveMappingRef} onChange={(event) => { setMappingRef(event.target.value); }} disabled={!mappingModel} className="w-full rounded-md border border-surface-200 bg-surface-50 px-3 py-2 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-950 dark:text-white">
                  {models.map(({ provider, model }) => <option key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>{provider.id}/{model.id}</option>)}
                </select>
              </label>
              {mappingModel && <div className="text-right text-[12px] text-surface-500"><div>{t('models.validLevels')} <span className="font-mono text-surface-900 dark:text-white">{supportedThinkingLevels(mappingModel).length}/7</span></div><div className="mt-1">{mappingModel.thinkingMapVerified ? t('models.verified') : t('models.unverified')}</div></div>}
            </div>
          </div>

          {mappingModel ? (
            <ThinkingMappingEditor key={mappingEditorKey} provider={mappingProvider} model={mappingModel} onStateChanged={onStateChanged} />
          ) : <div className="rounded-xl border border-dashed border-surface-300 p-8 text-center text-[13px] text-surface-500 dark:border-surface-800">{t('models.noEditable')}</div>}
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
  const { t } = useI18n();
  const [draft, setDraft] = useState(String(model.contextWindow));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changed = draft !== String(model.contextWindow);

  const save = async () => {
    if (!/^\d+$/.test(draft) || Number(draft) < 1 || Number(draft) > 100000000) {
      setError(t('context.invalid'));
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
      onStateChanged(response.state, t('context.saved', { name: model.name }));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('context.saveFailed'));
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
          aria-label={t('context.aria', { name: model.name })}
          className="w-[118px] rounded-md border border-surface-200 bg-white px-2 py-1.5 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white"
        />
        <span className="text-[11px] text-surface-400">tokens</span>
        {changed && <button type="button" onClick={() => void save()} disabled={saving} title={t('context.save')} aria-label={t('context.save')} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary-600 hover:bg-primary-50 disabled:cursor-wait disabled:opacity-50 dark:text-primary-400 dark:hover:bg-primary-500/10"><Save size={13} /></button>}
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
  const { t } = useI18n();
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
      onStateChanged(response.state, t('thinking.saved', { name: model.name }));
    } catch (caughtError) {
      setMappingError(caughtError instanceof ApiError ? caughtError.message : t('thinking.saveFailed'));
    } finally {
      setSavingMapping(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
      <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">{t('thinking.title')}</h2><p className="mt-1 text-[12px] text-surface-500">{t('thinking.hint')}</p></div>
          <span className="rounded-md bg-surface-100 px-2 py-1 text-[11px] font-medium text-surface-600 dark:bg-surface-800 dark:text-surface-300">{provider.name}</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead className="bg-surface-50/80 text-[12px] font-medium text-surface-500 dark:bg-surface-900/50 dark:text-surface-400">
            <tr><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">{t('thinking.colLevel')}</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">{t('thinking.colMode')}</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">{t('thinking.colValue')}</th><th className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">{t('thinking.colEffect')}</th></tr>
          </thead>
          <tbody className="divide-y divide-surface-100 dark:divide-surface-800/50">
            {PI_THINKING_LEVELS.map((level) => {
              const mode = mappingMode(level);
              const mappedValue = mappingDraft[level];
              const isDisabled = !model.reasoning && level !== 'off';
              return (
                <tr key={level}>
                  <td className="px-5 py-3 font-mono text-[12px] font-medium text-surface-900 dark:text-white">{level}</td>
                  <td className="px-5 py-3"><select value={mode} onChange={(event) => changeMappingMode(level, event.target.value as 'default' | 'value' | 'unsupported')} disabled={isDisabled} aria-label={t('thinking.modeAria', { level })} className="rounded-md border border-surface-200 bg-surface-50 px-2.5 py-1.5 text-[12px] text-surface-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200"><option value="default">{t('thinking.modeDefault')}</option><option value="value">{t('thinking.specifyValue')}</option><option value="unsupported">{t('thinking.modeUnsupported')}</option></select></td>
                  <td className="px-5 py-3">{mode === 'value' ? <input value={typeof mappedValue === 'string' ? mappedValue : ''} onChange={(event) => changeMappingValue(level, event.target.value)} aria-label={t('thinking.valueAria', { level })} placeholder={level === 'off' ? 'none' : level} className="w-48 max-w-full rounded-md border border-surface-200 bg-white px-2.5 py-1.5 font-mono text-[12px] text-surface-900 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" /> : <span className={`text-[12px] ${mode === 'unsupported' ? 'text-surface-400' : 'text-surface-500'}`}>{mode === 'unsupported' ? t('thinking.modeUnsupported') : level === 'xhigh' || level === 'max' ? t('thinking.disabledDefault') : t('thinking.modeDefault')}</span>}</td>
                  <td className="px-5 py-3 text-[12px]">{mode === 'value' ? <span className="text-emerald-600 dark:text-emerald-400">{t('thinking.send', { value: mappedValue || t('thinking.pendingValue') })}</span> : mode === 'unsupported' ? <span className="text-surface-400">{t('thinking.hidden')}</span> : <span className="text-surface-500">{t('thinking.useDefault')}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20">
        <div className="flex flex-wrap items-end gap-4">
          <label className="block space-y-1.5"><span className="text-[11px] font-semibold text-surface-600 dark:text-surface-300">{t('thinking.source')}</span><select value={mappingSource} onChange={(event) => setMappingSource(event.target.value as ThinkingMapSource)} className="block rounded-md border border-surface-200 bg-white px-2.5 py-1.5 text-[12px] text-surface-800 outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-surface-200">{(['provider-default', 'provider-docs', 'request-probe', 'user'] as ThinkingMapSource[]).map((value) => <option key={value} value={value}>{thinkingSourceLabel(value, t)}</option>)}</select></label>
          <label className="flex items-center gap-2 pb-1.5 text-[12px] text-surface-600 dark:text-surface-300"><input type="checkbox" checked={mappingVerified} onChange={(event) => setMappingVerified(event.target.checked)} className="h-3.5 w-3.5 rounded border-surface-300 text-primary-600 focus:ring-primary-500" />{t('thinking.verifiedCheckbox')}</label>
        </div>
        <button type="button" onClick={() => void saveThinkingMap()} disabled={!mappingChanged || savingMapping} className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">{savingMapping ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}{t('common.saveCandidate')}</button>
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
  const { t } = useI18n();
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
    if (draftRefs.length === 0 && !window.confirm(t('cycle.emptyConfirm'))) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await updateCycleList({ modelRefs: draftRefs });
      onStateChanged(response.state, t('cycle.saved'));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('cycle.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
      <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
        <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">{t('cycle.joined')}</h2>
              <p className="mt-1 text-[12px] text-surface-500">{t('cycle.orderHint')}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full bg-surface-100 px-2.5 py-1 text-surface-600 dark:bg-surface-800 dark:text-surface-300">{t('cycle.items', { count: draftRefs.length })}</span>
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{t('cycle.availableCount', { count: draftEntries.filter((entry) => entry.valid).length })}</span>
              {invalidEntries.length > 0 && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{t('cycle.invalidCount', { count: invalidEntries.length })}</span>}
            </div>
          </div>
        </div>
        <div className="divide-y divide-surface-100 dark:divide-surface-800/50">
          {draftEntries.length > 0 ? draftEntries.map((entry, index) => (
            <div key={`${entry.ref}-${index}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-100 text-[11px] font-medium text-surface-600 dark:bg-surface-800 dark:text-surface-300">{index + 1}</span>
                  <span className="font-mono text-[12px] font-medium text-surface-900 dark:text-white">{cycleEntryLabel(entry, t)}</span>
                  {entry.valid ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{t('common.available')}</span>
                  ) : (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{t('cycle.invalidReason', { reason: entry.reason })}</span>
                  )}
                </div>
                <div className="mt-1 text-[12px] text-surface-500">
                  {entry.providerName} · {entry.modelName}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => moveModel(index, -1)} disabled={index === 0} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 hover:text-surface-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white" aria-label={t('cycle.moveUp')}><ArrowUp size={14} /></button>
                <button type="button" onClick={() => moveModel(index, 1)} disabled={index === draftEntries.length - 1} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-surface-200 text-surface-500 hover:bg-surface-50 hover:text-surface-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white" aria-label={t('cycle.moveDown')}><ArrowDown size={14} /></button>
                <button type="button" onClick={() => removeModel(index)} className="inline-flex h-8 items-center rounded-md border border-surface-200 px-3 text-[12px] font-medium text-surface-500 hover:bg-surface-50 hover:text-surface-900 dark:border-surface-700 dark:hover:bg-surface-800 dark:hover:text-white"><Trash2 size={13} className="mr-1.5" />{t('common.remove')}</button>
              </div>
            </div>
          )) : (
            <div className="px-5 py-10 text-center text-[13px] text-surface-500">
              {t('cycle.emptyList')}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20">
          <div className="text-[12px] text-surface-500">
            {invalidEntries.length > 0 ? t('cycle.blocked', { count: invalidEntries.length }) : t('cycle.allValid')}
          </div>
          <button type="button" onClick={() => void saveCycleList()} disabled={!changed || saving} className="inline-flex h-8 items-center rounded-md bg-primary-600 px-3 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50">{saving ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Save size={13} className="mr-1.5" />}{t('common.saveCandidate')}</button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
        <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
          <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">{t('cycle.availableTitle')}</h2>
          <p className="mt-1 text-[12px] text-surface-500">{t('cycle.availableHint')}</p>
        </div>
        <div className="border-b border-surface-100 px-5 py-3 dark:border-surface-800">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('cycle.search')} className="w-full rounded-md border border-surface-200 bg-surface-50 py-2 pl-8 pr-3 text-[13px] outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500 dark:border-surface-700 dark:bg-surface-950 dark:text-white" />
          </div>
        </div>
        <div className="max-h-[520px] divide-y divide-surface-100 overflow-y-auto dark:divide-surface-800/50">
          {availableModels.length > 0 ? availableModels.map(({ ref, provider, model }) => (
            <div key={ref} className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <div className="font-mono text-[12px] font-medium text-surface-900 dark:text-white">{ref}</div>
                <div className="mt-1 text-[12px] text-surface-500">{provider.name} · {model.name} · {statusMeta(provider.status, t).label}</div>
              </div>
              <button type="button" onClick={() => addModel(ref)} className="inline-flex h-8 items-center rounded-md border border-surface-200 px-3 text-[12px] font-medium text-surface-600 hover:bg-surface-50 hover:text-surface-900 dark:border-surface-700 dark:text-surface-300 dark:hover:bg-surface-800 dark:hover:text-white"><Plus size={13} className="mr-1.5" />{t('common.add')}</button>
            </div>
          )) : (
            <div className="px-5 py-10 text-center text-[13px] text-surface-500">
              {t('cycle.noAddable')}
            </div>
          )}
        </div>
        {error && <div className="mx-5 mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
      </div>
    </div>
  );
}

function ProfilePage({ state, onStateChanged }: { state: ManagerState; onStateChanged: (nextState: ManagerState, notice: string) => void }) {
  const { t } = useI18n();
  const [importingLive, setImportingLive] = useState(false);
  const [rollingLive, setRollingLive] = useState(false);
  const [actionError, setActionError] = useState('');

  const currentActiveProvider = state.providers.find((provider) => provider.id === state.active.providerId);
  const cycleRefs = (state.cycle.modelRefs || []).filter(Boolean);
  const cycleSummary = cycleRefs.length === 0
    ? { text: t('cycle.empty'), title: t('cycle.empty') }
    : { text: t(cycleRefs.length > 1 ? 'cycle.summaryMore' : 'cycle.summaryOne', { count: cycleRefs.length, first: cycleRefs[0] }), title: cycleRefs.join(' / ') };
  const liveVerify = state.runtime.lastLiveVerify;
  const statusRows = [
    { label: t('live.target'), value: state.targetProject },
    { label: t('live.defaultModel'), value: `${state.active.providerId}/${state.active.modelId}` },
    { label: 'Thinking', value: state.active.thinking },
    { label: t('live.credential'), value: currentActiveProvider ? `${currentActiveProvider.name} · ${currentActiveProvider.credentialConfigured ? t('live.configured') : t('live.unconfigured')}` : t('live.unselected') },
    { label: t('live.cycle'), value: cycleSummary.text, title: cycleSummary.title },
    { label: t('live.lastImport'), value: state.runtime.lastLiveImportAt || t('live.neverImported') },
    { label: t('live.verify'), value: liveVerify ? (liveVerify.ok ? t('card.testPass') : t('live.verifyPartial')) : t('live.neverVerified'), title: liveVerify?.error || '' },
  ];

  const importLiveNow = async () => {
    if (!window.confirm(t('live.confirm'))) return;
    setImportingLive(true);
    setActionError('');
    try {
      const response = await importLivePi();
      const verify = response.state.runtime.lastLiveVerify;
      onStateChanged(response.state, verify?.ok ? t('live.importedOk') : t('live.importedPartial', { error: verify?.error || t('live.unknownError') }));
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : t('live.importFailed'));
    } finally {
      setImportingLive(false);
    }
  };

  const rollbackLiveNow = async () => {
    if (!state.runtime.lastLiveBackupDir) {
      setActionError(t('live.noBackup'));
      return;
    }
    setRollingLive(true);
    setActionError('');
    try {
      const response = await rollbackLivePi();
      onStateChanged(response.state, t('live.rolledBack'));
    } catch (caughtError) {
      setActionError(caughtError instanceof ApiError ? caughtError.message : t('live.rollbackFailed'));
    } finally {
      setRollingLive(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">{t('live.title')}</h1>
        <p className="mt-1 text-[14px] text-surface-500">{t('live.subtitle')}</p>
      </div>

      <div className="max-w-3xl overflow-hidden rounded-xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
        <div className="border-b border-surface-100 px-5 py-4 dark:border-surface-800">
          <h2 className="text-[14px] font-semibold text-surface-900 dark:text-white">{t('live.candidate')}</h2>
          <p className="mt-1 text-[12px] text-surface-500">{t('live.candidateHint')}</p>
        </div>
        <div className="overflow-x-auto p-5">
          <table className="w-full text-left text-[12px]">
            <tbody className="divide-y divide-surface-100 dark:divide-surface-800/60">
              {statusRows.map((row) => (
                <tr key={row.label}>
                  <th className="w-[88px] whitespace-nowrap py-2.5 pr-3 align-top font-medium text-surface-500">{row.label}</th>
                  <td className="min-w-0 py-2.5 align-top font-mono text-surface-900 dark:text-white" title={row.title || row.value}><span className="block truncate">{row.value}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-surface-100 bg-surface-50/50 px-5 py-4 dark:border-surface-800 dark:bg-surface-900/20">
          <button type="button" onClick={() => void importLiveNow()} disabled={importingLive} className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md bg-primary-600 px-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-wait disabled:opacity-60">
            {importingLive ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Download size={14} className="mr-2" />}
            {t('live.import')}
          </button>
          <button type="button" onClick={() => void rollbackLiveNow()} disabled={rollingLive || !state.runtime.lastLiveBackupDir} className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-surface-200 px-3 text-[13px] font-medium text-surface-700 hover:bg-surface-50 hover:text-surface-950 disabled:cursor-not-allowed disabled:opacity-60 dark:border-surface-700 dark:text-surface-200 dark:hover:bg-surface-800 dark:hover:text-white">
            {rollingLive ? <Loader2 size={14} className="mr-2 animate-spin" /> : <RotateCcw size={14} className="mr-2" />}
            {t('live.rollback')}
          </button>
        </div>
        {actionError && <div className="mx-5 mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{actionError}</div>}
      </div>
    </div>
  );
}

function DiagnosticsPage({ state }: { state: ManagerState }) {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-surface-900 dark:text-white">{t('diag.title')}</h1>
        <p className="mt-1 text-[14px] text-surface-500">{t('diag.subtitle')}</p>
      </div>
      <div className="grid max-w-5xl gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Activity size={15} /> {t('diag.piEnv')}</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.install')}</dt><dd>{state.pi.installed ? t('diag.installed') : t('diag.notFound')}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.version')}</dt><dd className="font-mono">{state.pi.version || t('diag.notDetected')}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.executable')}</dt><dd className="max-w-[180px] truncate font-mono" title={state.pi.path}>{state.pi.path}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.subscription')}</dt><dd>{state.pi.subscriptionReady ? t('status.ready') : t('diag.notReady')}</dd></div>
          </dl>
        </div>
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Server size={15} /> Gateway</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.status')}</dt><dd>{state.gateway.running ? t('diag.running') : t('diag.stopped')}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.address')}</dt><dd className="font-mono">{state.gateway.host}:{state.gateway.port}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.requests')}</dt><dd className="font-mono">{state.gateway.stats.requests}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.lastError')}</dt><dd className="max-w-[220px] truncate text-right">{state.gateway.stats.lastError || t('diag.none')}</dd></div>
          </dl>
        </div>
      </div>
      <div className="grid max-w-5xl gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><CheckCircle2 size={15} /> {t('diag.config')}</div>
          <dl className="space-y-2 text-[12px]">
            <div className="flex justify-between gap-4"><dt className="text-surface-500">revision</dt><dd className="font-mono">{state.configuration.revision}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.liveImport')}</dt><dd className="max-w-[220px] truncate font-mono" title={state.runtime.lastLiveImportAt || ''}>{state.runtime.lastLiveImportAt || t('live.neverImported')}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.liveVerify')}</dt><dd>{state.runtime.lastLiveVerify ? (state.runtime.lastLiveVerify.ok ? t('card.testPass') : t('live.verifyPartial')) : t('live.neverVerified')}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-surface-500">{t('diag.backup')}</dt><dd className="max-w-[220px] truncate font-mono" title={state.runtime.lastLiveBackupDir}>{state.runtime.lastLiveBackupDir || t('diag.none')}</dd></div>
          </dl>
        </div>
        <div className="rounded-xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
          <div className="mb-4 flex items-center gap-2 text-[13px] font-semibold text-surface-900 dark:text-white"><Activity size={15} /> {t('diag.events')}</div>
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
            {state.events.length === 0 && <div className="rounded-md border border-dashed border-surface-200 px-3 py-6 text-center text-[12px] text-surface-500 dark:border-surface-800">{t('diag.noEvents')}</div>}
          </div>
        </div>
      </div>
      {state.runtime.lastError && <div className="flex max-w-5xl items-start rounded-md border border-red-200 bg-red-50 p-3 text-[13px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={15} className="mr-2 mt-0.5 shrink-0" />{state.runtime.lastError}</div>}
    </div>
  );
}

function App() {
  const { t } = useI18n();
  const [activeNav, setActiveNav] = useState<NavId>('providers');
  const [state, setState] = useState<ManagerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connectionTests, setConnectionTests] = useState<Record<string, ProviderConnectionTestResult>>({});
  const [editingProvider, setEditingProvider] = useState<ProviderState | null | undefined>(undefined);
  const [credentialProvider, setCredentialProvider] = useState<ProviderState | null>(null);
  const [loginProvider, setLoginProvider] = useState<ProviderState | null | undefined>(undefined);
  const [showImportModal, setShowImportModal] = useState(false);

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
        if (!cancelled) setError(caughtError instanceof ApiError ? caughtError.message : t('app.connectFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const refreshState = async () => {
    setRefreshing(true);
    try {
      const nextState = await getState(true);
      setState(nextState);
      setError('');
      setNotice(t('app.refreshed'));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('app.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleDeleteProvider = async (provider: ProviderState) => {
    if (!window.confirm(t('app.deleteConfirm', { name: provider.name }))) return;
    try {
      const response = await deleteProvider(provider.id);
      setState(response.state);
      setNotice(t('app.deleted', { name: provider.name }));
      setConnectionTests((current) => {
        const next = { ...current };
        delete next[provider.id];
        return next;
      });
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('app.deleteFailed'));
    }
  };

  const handleLogoutProvider = async (provider: ProviderState) => {
    if (!window.confirm(t('app.logoutConfirm', { name: provider.name }))) return;
    try {
      const response = await logoutNativeProvider(provider.id);
      setState(response.state);
      setNotice(t('app.loggedOut', { name: provider.name }));
      setError('');
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('app.logoutFailed'));
    }
  };

  const handleTestProvider = async (provider: ProviderState) => {
    try {
      const response = await testProviderConnection(provider.id);
      setState(response.state);
      setConnectionTests((current) => ({ ...current, [provider.id]: response.result }));
      setNotice(t('app.testNotice', { name: provider.name, message: response.result.message }));
    } catch (caughtError) {
      setError(caughtError instanceof ApiError ? caughtError.message : t('app.testFailed'));
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-surface-50 text-[13px] text-surface-500 dark:bg-surface-950"><Loader2 size={17} className="mr-2 animate-spin" />{t('app.loading')}</div>;
  }

  if (!state) {
    return <div className="flex h-screen flex-col items-center justify-center bg-surface-50 px-6 text-center dark:bg-surface-950"><CircleAlert size={24} className="mb-3 text-red-500" /><h1 className="text-[16px] font-semibold text-surface-900 dark:text-white">{t('app.cannotConnect')}</h1><p className="mt-1 max-w-sm text-[13px] text-surface-500">{error || t('app.startFirst')}</p><button type="button" onClick={() => window.location.reload()} className="mt-5 rounded-md bg-surface-950 px-4 py-2 text-[13px] font-medium text-white dark:bg-white dark:text-surface-950">{t('app.reconnect')}</button></div>;
  }

  return (
    <div className="flex h-screen w-full bg-surface-50 font-sans antialiased dark:bg-surface-950">
      <Sidebar activeNav={activeNav} onNavigate={setActiveNav} piInstalled={state.pi.installed} />
      <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar state={state} onRefresh={() => void refreshState()} refreshing={refreshing} />
        <div className="flex-1 overflow-y-auto p-8">
          <div className="mx-auto max-w-[1200px] pb-20">
            {error && <div className="mb-5 flex items-start rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-5 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"><CircleAlert size={14} className="mr-2 mt-0.5 shrink-0" />{error}</div>}
            {notice && <div className="mb-5 flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"><CheckCircle2 size={14} className="mr-2" />{notice}</div>}
            {activeNav === 'providers' && <ProvidersPage state={state} testResults={connectionTests} onAdd={() => setEditingProvider(null)} onImport={() => setShowImportModal(true)} onRefresh={() => void refreshState()} onTest={(provider) => void handleTestProvider(provider)} onCredential={(provider) => setCredentialProvider(provider)} onLogin={(provider) => setLoginProvider(provider)} onNativeLogin={() => setLoginProvider(null)} onLogout={(provider) => void handleLogoutProvider(provider)} onEdit={(provider) => setEditingProvider(provider)} onDelete={(provider) => void handleDeleteProvider(provider)} />}
            {activeNav === 'models' && <ModelsPage state={state} onStateChanged={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />}
            {activeNav === 'profiles' && <ProfilePage state={state} onStateChanged={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />}
            {activeNav === 'diagnostics' && <DiagnosticsPage state={state} />}
          </div>
        </div>
      </main>
      <ProviderEditorModal key={editingProvider === undefined ? 'closed' : editingProvider?.id || 'create'} provider={editingProvider} isOpen={editingProvider !== undefined} onClose={() => setEditingProvider(undefined)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <ImportPiModal key={showImportModal ? 'import-open' : 'import-closed'} isOpen={showImportModal} onClose={() => setShowImportModal(false)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <NativeLoginModal key={loginProvider === undefined ? 'login-closed' : loginProvider?.id || 'login-picker'} provider={loginProvider} isOpen={loginProvider !== undefined} onClose={() => setLoginProvider(undefined)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
      <CredentialModal key={credentialProvider?.id || 'credential-closed'} provider={credentialProvider} isOpen={Boolean(credentialProvider)} onClose={() => setCredentialProvider(null)} onSaved={(nextState, nextNotice) => { setState(nextState); setNotice(nextNotice); setError(''); }} />
    </div>
  );
}

export default App;
