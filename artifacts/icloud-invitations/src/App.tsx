import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowRight, CalendarDays, Check,
  CheckCircle2, CircleHelp, Cloud, Copy, FileClock, FileText, Filter,
  Eye, EyeOff, LayoutDashboard, ListChecks, Mail,
  Plus, RefreshCw, Search, Trash2, Upload, Users, X,
  LockKeyhole, LogOut, ShieldCheck, UserPlus, KeyRound,
} from 'lucide-react';
import { Link, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import {
  getGetAuthStatusQueryKey, getListAdminUsersQueryKey, useCreateAdminUser, useDeleteAdminUser,
  useGetAuthStatus, useListAdminUsers, useLogin, useLogout, useResetUserPassword, useSetupAdmin,
  getGetDashboardQueryKey, getGetEventSettingsQueryKey, getGetIcloudSettingsQueryKey,
  getListLogsQueryKey, getListRecipientsQueryKey,
  useAddRecipients, useClearRecipients, useDeleteIcloudCredentials, useDeleteRecipient,
  useGetDashboard, useGetEventSettings, useGetIcloudSettings, useImportRecipients,
  useListLogs, useListRecipients, useSendInvitations, useStopInvitationSend,
  useSaveIcloudSettings, useTestIcloudConnection,
  useUpdateEventSettings,
} from '@workspace/api-client-react';
import type { ActivityLog, AdminUser, EventSettings, ICloudConnectionTest } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const usernameSchema = z.string().trim().min(3, 'Use at least 3 characters.').max(32, 'Use no more than 32 characters.').regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, periods, underscores, or hyphens only.');
const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Enter your password.').max(128, 'Password must be 128 characters or fewer.'),
});
const setupSchema = z.object({
  username: usernameSchema,
  password: z.string().min(12, 'Use at least 12 characters.').max(128, 'Password must be 128 characters or fewer.'),
  bootstrapToken: z.string().min(32, 'The setup token must be at least 32 characters.').max(256, 'The setup token must be 256 characters or fewer.'),
});
const adminUserSchema = z.object({ username: usernameSchema });

type ToastState = { text: string; error?: boolean };
function useNotice() {
  const [notice, setNotice] = useState<ToastState | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return { notice, setNotice };
}
function Toast({ notice }: { notice: ToastState | null }) {
  return notice ? <div className={`toaster${notice.error ? ' error' : ''}`} role="status" data-testid="status-toast">{notice.text}</div> : null;
}
function errorText(error: unknown, secret = '') {
  const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  return secret ? message.split(secret).join('••••••••') : message;
}
function dateText(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function statusLabel(status: string) {
  return status.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function presentActivity(entry: ActivityLog): ActivityLog {
  if (['campaign-event-submitting', 'invitation-send-event-submitting'].includes(entry.event)) {
    return { ...entry, event: 'invitation-event-submitting', message: 'Saving the calendar event with its attendee list.' };
  }
  if (!['caldav-scheduling-accepted', 'caldav-scheduling-unconfirmed', 'invitation-state-unconfirmed'].includes(entry.event)) {
    return entry;
  }
  return {
    ...entry,
    level: 'info',
    event: 'invitation-sent',
    message: 'The calendar event was saved successfully with its attendees and counted as sent.',
  };
}
const hiddenLegacySendEvents = new Set([
  'campaign-started',
  'campaign-paused',
  'campaign-resumed',
  'campaign-stopped',
  'campaign-restarted',
]);
function isVisibleActivity(entry: ActivityLog) {
  return !hiddenLegacySendEvents.has(entry.event);
}
function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`} data-testid={`status-${status}`}>{statusLabel(status)}</span>;
}
function LoadingPanel() {
  return <div className="panel loading-lines" aria-label="Loading"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>;
}
function ErrorPanel({ message, retry }: { message: string; retry: () => void }) {
  return <div className="notice error error-banner" role="alert" data-testid="status-error"><AlertCircle size={16} className="notice-icon" /><div><strong>We couldn't load this view.</strong><br />{message}<div style={{ marginTop: 10 }}><button className="button button-secondary button-sm" onClick={retry} data-testid="button-retry"><RefreshCw size={13} /> Try again</button></div></div></div>;
}
function EmptyState({ icon: Icon = ListChecks, title, detail, action }: { icon?: typeof ListChecks; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state" data-testid="state-empty"><div className="empty-icon"><Icon size={21} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function BrandMark() {
  return <span className="brand-mark"><CalendarDays size={18} strokeWidth={2.2} /></span>;
}
const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { path: '/recipients', label: 'Recipients', icon: Users },
  { path: '/event-settings', label: 'Event settings', icon: CalendarDays },
  { path: '/settings', label: 'iCloud account', icon: Cloud },
  { path: '/logs', label: 'Activity log', icon: FileClock },
];
function AppNav({ current }: { current: string }) {
  const { data: auth } = useGetAuthStatus();
  const logout = useLogout();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const [logoutError, setLogoutError] = useState('');
  const signOut = () => logout.mutate(undefined, {
    onSuccess: async () => {
      await client.cancelQueries({ queryKey: getGetAuthStatusQueryKey() });
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== getGetAuthStatusQueryKey()[0] });
      client.setQueryData(getGetAuthStatusQueryKey(), (old: import('@workspace/api-client-react').AuthStatus | undefined) =>
        old ? { ...old, user: null } : old);
      setLocation('/login');
    },
    onError: (error) => setLogoutError(errorText(error)),
  });
  return <>
    <aside className="sidebar">
      <Link href="/dashboard" className="brand" data-testid="link-brand"><BrandMark /><span><span className="brand-name">Event System</span><span className="brand-caption">iCloud invitation desk</span></span></Link>
      <div className="nav-label">Workspace</div>
      <nav className="nav-list" aria-label="Main navigation">{navItems.map((item) => <Link key={item.path} href={item.path} className={`nav-link${current === item.path ? ' active' : ''}`} data-testid={`link-nav-${item.path.slice(1)}`}><item.icon size={16} strokeWidth={1.8} />{item.label}</Link>)}</nav>
      <div className="sidebar-bottom">
        {auth?.user?.role === 'admin' && <Link href="/admin/users" className={`nav-link admin-nav-link${current === '/admin/users' ? ' active' : ''}`}><ShieldCheck size={15} />Account management</Link>}
        <div className="connection-chip"><div className="eyebrow">Signed in as</div><div className="chip-row"><span className="live-dot" />{auth?.user?.username ?? 'Workspace member'}</div>
          {logoutError && <p className="sidebar-error" role="alert">{logoutError}</p>}
          <button className="button button-quiet-light signout-button" onClick={signOut} disabled={logout.isPending}><LogOut size={13} />{logout.isPending ? 'Signing out…' : 'Sign out'}</button>
        </div>
        <div className="sidebar-foot">PRIVATE INVITATION WORKSPACE<br />Version 1.0 · Account protected</div>
      </div>
    </aside>
    <div className="mobile-bar"><Link href="/dashboard" className="mobile-brand"><BrandMark /> Event System</Link><button className="mobile-signout" onClick={signOut} disabled={logout.isPending} aria-label="Sign out"><LogOut size={15} /></button></div>
    <nav className="mobile-nav" aria-label="Mobile navigation">{navItems.map((item) => <Link key={item.path} href={item.path} className={`nav-link${current === item.path ? ' active' : ''}`} data-testid={`mobile-nav-${item.path.slice(1)}`}><item.icon size={14} />{item.label}</Link>)}{auth?.user?.role === 'admin' && <Link href="/admin/users" className={`nav-link${current === '/admin/users' ? ' active' : ''}`}><ShieldCheck size={14} />Accounts</Link>}</nav>
  </>;
}
function Shell({ children, title, className = '' }: { children: ReactNode; title: string; className?: string }) {
  const [location] = useLocation();
  const current = location === '/' ? '/dashboard' : location;
  const activeItem = navItems.find((item) => item.path === current);
  return <div className={`app-shell ${className}`}><AppNav current={current} /><div className="main-area">
    <header className="topbar"><div className="crumb"><span>Workspace</span><ArrowRight size={12} /><strong>{activeItem?.label ?? title}</strong></div><div className="top-right"><span className="secure-note"><LockKeyhole size={13} /> Private account workspace</span></div></header>
    {children}
  </div></div>;
}
function PageTitle({ kicker, title, subtitle, actions }: { kicker: string; title: string; subtitle: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="kicker">{kicker}</div><h1>{title}</h1><p className="subtitle">{subtitle}</p></div>{actions}</div>;
}
function WorkspacePage({ children, title, className }: { children: ReactNode; title: string; className?: string }) {
  return <Shell title={title} className={className}>{children}</Shell>;
}

function DashboardPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useGetDashboard();
  const { data: settings } = useGetIcloudSettings();
  const { data: eventSettings } = useGetEventSettings();
  const { data: logs, isLoading: logsLoading, isError: logsError, refetch: refetchLogs } = useListLogs();
  const sendInvitations = useSendInvitations();
  const stopInvitations = useStopInvitationSend();
  const importCsv = useImportRecipients();
  const { notice, setNotice } = useNotice();
  const [confirm, setConfirm] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [explicitConsent, setExplicitConsent] = useState(false);
  const [csvDragging, setCsvDragging] = useState(false);
  const [csvImporting, setCsvImporting] = useState(false);
  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer = 0;
    let disposed = false;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListRecipientsQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListLogsQueryKey() });
    };
    const connect = () => {
      if (disposed) return;
      source = new EventSource('/api/invitation-sends/events');
      source.onopen = refresh;
      source.addEventListener('invitation-send', refresh);
      source.onerror = () => {
        source?.close();
        if (!disposed) reconnectTimer = window.setTimeout(connect, 2500);
      };
    };
    connect();
    return () => { disposed = true; window.clearTimeout(reconnectTimer); source?.close(); };
  }, [queryClient]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListRecipientsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListLogsQueryKey() });
  };
  const importRecipientsCsv = async (file?: File) => {
    if (!file || csvImporting) return;
    setCsvDragging(false);
    setCsvImporting(true);
    let completedRows = 0;
    try {
      const isCsv = file.name.toLowerCase().endsWith('.csv')
        || file.type === 'text/csv'
        || file.type === 'application/vnd.ms-excel';
      if (!isCsv) {
        setNotice({ text: 'Choose a CSV file to import recipients.', error: true });
        return;
      }
      setNotice({ text: 'Reading and importing CSV…' });
      const result = await importCsvFile(
        file,
        (recipients) => importCsv.mutateAsync({ data: { recipients } }),
        (processed) => {
          completedRows = processed;
          setNotice({ text: `Importing recipients… ${processed.toLocaleString()} rows saved.` });
        },
      );
      if (result.total === 0) {
        setNotice({ text: 'No recipient rows found. Use a CSV with email and optional name columns.', error: true });
        return;
      }
      refresh();
      setNotice({ text: `Import reviewed: ${result.added} added, ${result.duplicates} duplicates, ${result.invalid} invalid.` });
    } catch (error) {
      if (completedRows > 0) {
        refresh();
        setNotice({
          text: `Import stopped after ${completedRows.toLocaleString()} rows. Earlier batches are saved; re-uploading is safe because existing email addresses are skipped. ${errorText(error)}`,
          error: true,
        });
      } else {
        setNotice({ text: errorText(error), error: true });
      }
    } finally {
      setCsvImporting(false);
    }
  };
  if (isLoading) return <WorkspacePage title="Dashboard" className="dashboard-shell"><main className="page-wrap dashboard-page"><LoadingPanel /></main></WorkspacePage>;
  if (isError || !data) return <WorkspacePage title="Dashboard" className="dashboard-shell"><main className="page-wrap dashboard-page"><ErrorPanel message={errorText(error)} retry={() => void refetch()} /></main></WorkspacePage>;
  const activeSend = data.activeSend;
  const validCount = data.validRecipients;
  const isSending = activeSend?.status === 'running';
  const isLegacyPendingSend = !!activeSend && ['queued', 'paused'].includes(activeSend.status);
  const canSend = !!validCount && !!settings?.hasStoredPassword && settings.status === 'connected' && !isSending;
  const progress = activeSend?.total
    ? Math.min(100, Math.max(0, ((activeSend.total - activeSend.pending) / activeSend.total) * 100))
    : 0;
  const beginSend = () => {
    if (csvImporting) {
      setNotice({ text: 'Wait for the CSV import to finish before sending invitations.', error: true });
      return;
    }
    if (!explicitConsent || !canSend) return;
    sendInvitations.mutate({ data: { confirmed: true } }, {
      onSuccess: (send) => {
        setConfirm(false);
        setExplicitConsent(false);
        refresh();
        setNotice({ text: `One-time send queued for ${send.total} current valid recipients.` });
      },
      onError: (err) => setNotice({ text: errorText(err), error: true }),
    });
  };
  const stopSend = () => {
    if (!activeSend) return;
    stopInvitations.mutate({ id: activeSend.id }, {
      onSuccess: () => {
        setStopConfirm(false);
        refresh();
        setNotice({ text: 'Invitation send stopped. An event already being saved may still finish.' });
      },
      onError: (err) => {
        refresh();
        setNotice({ text: errorText(err), error: true });
      },
    });
  };
  return <WorkspacePage title="Dashboard" className="dashboard-shell"><main className="page-wrap dashboard-page">
    <PageTitle kicker="Invitation sending" title="Dashboard" subtitle="Send invitations to the current valid recipients and track event activity." />
    <div className="stats-grid send-stats-grid">
      <StatCard label="Recipients" value={data.totalRecipients} foot={`${data.validRecipients} valid · ${data.invalidRecipients} need review`} icon={Users} tone="purple" testId="card-stat-recipients" />
      <StatCard label="Ready to send" value={data.validRecipients} foot="Current valid recipient list" icon={CheckCircle2} tone="green" testId="card-stat-valid-recipients" />
      <StatCard label="Needs review" value={data.invalidRecipients} foot="Invalid or missing email" icon={AlertCircle} tone="amber" testId="card-stat-invalid-recipients" />
    </div>
    <div className="dashboard-columns">
    <section className="send-control-panel" aria-label="One-time invitation send" data-testid="send-controls">
      <div className="dashboard-panel-heading">
        <div className="dashboard-panel-title"><Mail size={15} /><h2>One-time send</h2></div>
        {activeSend ? <StatusBadge status={activeSend.status} /> : <span className="dashboard-ready-pill">Ready</span>}
      </div>
      <div className="control-summary">
        <div className="control-title">
          <h3>{eventSettings?.title || 'Configured event'}</h3>
        </div>
        <p>{activeSend
          ? isLegacyPendingSend
            ? `${activeSend.pending} invitees remain in a previous send that is not running. Confirming a new send will close it and use only the current valid recipient list.`
            : `${activeSend.sent} of ${activeSend.total} recipients sent · ${activeSend.eventsSaved} events saved · ${activeSend.failed} failed · ${activeSend.pending} pending.`
          : `${validCount} valid recipients are ready. Every send uses the current list and never reuses an older recipient snapshot.`}</p>
        {activeSend && !isLegacyPendingSend && <div className="control-progress" aria-label={`${Math.round(progress)} percent complete`}>
          <span>{Math.round(progress)}% complete</span>
          <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
        </div>}
      </div>
      <label
        className={`file-drop dashboard-recipient-dropzone${csvDragging ? ' is-dragging' : ''}${csvImporting ? ' is-importing' : ''}`}
        htmlFor="dashboard-recipient-csv"
        role="button"
        tabIndex={0}
        aria-label="Drop a recipient CSV or browse for one"
        data-testid="dropzone-dashboard-recipients"
        onKeyDown={(event) => {
          if (!csvImporting && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.currentTarget.querySelector<HTMLInputElement>('input[type="file"]')?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!csvImporting) setCsvDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCsvDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setCsvDragging(false);
          if (csvImporting) return;
          const files = Array.from(event.dataTransfer.files);
          if (files.length !== 1) {
            setNotice({ text: 'Drop one CSV file at a time.', error: true });
            return;
          }
          void importRecipientsCsv(files[0]);
        }}
      >
        <span className="quick-icon"><Upload size={15} /></span>
        <span className="file-copy">
          <strong>{csvImporting ? 'Importing recipients…' : 'Drop recipient CSV'}</strong>
          <span>Drop or browse · email and optional name · large files upload in batches with no fixed row cap. New sends use the current valid list.</span>
        </span>
        <span className="button button-secondary button-sm">{csvImporting ? 'Importing…' : 'Browse'}</span>
        <input
          id="dashboard-recipient-csv"
          type="file"
          accept=".csv,text/csv"
          disabled={csvImporting}
          onChange={(event) => {
            void importRecipientsCsv(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
          data-testid="input-dashboard-recipient-csv"
        />
      </label>
      <div className="section-actions send-actions">
        {isSending
          ? <><button className="button button-secondary" disabled data-testid="button-send-in-progress"><Mail size={14} /> Sending…</button><button className="button button-danger" disabled={stopInvitations.isPending} onClick={() => setStopConfirm(true)} data-testid="button-stop-send"><X size={14} /> Stop send</button></>
          : <button className="button button-primary" disabled={!canSend || csvImporting || importCsv.isPending || sendInvitations.isPending} onClick={() => { setExplicitConsent(false); setConfirm(true); }} data-testid="button-send-invitations"><Mail size={14} /> Send invitations</button>}
      </div>
      {!canSend && !isSending && <p className="control-warning"><Link href={!validCount ? '/recipients' : '/settings'}>{!validCount ? 'Add valid recipients before sending.' : 'Connect a working iCloud account before sending.'}</Link></p>}
      {isLegacyPendingSend && <p className="control-warning">This previous send will not resume. Confirming a new send closes it and targets only the current valid recipients.</p>}
    </section>
    <section className="panel live-activity" data-testid="live-activity">
      <div className="panel-head"><div><div className="dashboard-panel-title"><Activity size={15} /><h2 className="panel-title">Live Feed</h2></div><p className="panel-sub">Event and invitee updates</p></div><Link href="/logs" className="text-link">Full log <ArrowRight size={13} /></Link></div>
      {logsLoading ? <div className="dashboard-state"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : logsError ? <div className="dashboard-state"><ErrorPanel message="Activity could not be loaded." retry={() => void refetchLogs()} /></div> : logs?.filter(isVisibleActivity).length ? <div className="activity-list">{logs.filter(isVisibleActivity).slice(0, 12).map((entry) => { const display = presentActivity(entry); return <article className="activity-item" key={entry.id} data-testid={`row-log-${entry.id}`}><div className="activity-meta"><StatusBadge status={display.level} /><time>{dateText(display.createdAt)}</time></div><strong className="activity-event">{display.event}</strong><p>{display.message}</p></article>; })}</div> : <EmptyState icon={Activity} title="No live activity yet" detail="Invitation and calendar activity will appear here as the server processes a send." />}
      <div className="activity-foot"><span className="live-dot" /> Listening for invitation updates</div>
    </section>
    </div>
    <div className="notice caldav-note"><CircleHelp size={15} className="notice-icon" /><span>Events saved successfully with attendees count as sent. Inbox delivery can still depend on iCloud and each recipient.</span></div>
    {confirm && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="send-modal-title"><div className="kicker">Confirm one-time send</div><h2 id="send-modal-title">Send invitations to the current list?</h2><p>This sends <strong>{validCount} current valid recipients</strong> the event <strong>{eventSettings?.title || 'the configured event'}</strong>. Previous recipient snapshots are never reused. A recipient who received an invitation before may receive another event.</p>{isLegacyPendingSend && <p className="control-warning">The previous non-running send will be closed; it will not be resumed.</p>}<label className="check-row"><input type="checkbox" checked={explicitConsent} onChange={(e) => setExplicitConsent(e.target.checked)} data-testid="checkbox-recipient-consent" /><span>I confirm these current recipients should receive this invitation.</span></label><div className="modal-actions"><button className="button button-secondary" onClick={() => setConfirm(false)} data-testid="button-cancel-send">Cancel</button><button className="button button-primary" disabled={!explicitConsent || !canSend || csvImporting || sendInvitations.isPending} onClick={beginSend} data-testid="button-confirm-send">{sendInvitations.isPending ? 'Sending…' : 'Confirm one-time send'}</button></div></div></div>}
    {stopConfirm && activeSend && <ConfirmModal title="Stop this invitation send?" description="No more recipient groups will be started. An event already being saved may still finish, and events already saved will remain on calendars." cancel={() => setStopConfirm(false)} confirm={stopSend} pending={stopInvitations.isPending} destructive testId="button-confirm-stop-send" cancelTestId="button-cancel-stop-send" confirmLabel="Stop send" pendingLabel="Stopping…" />}
    <Toast notice={notice} />
  </main></WorkspacePage>;
}
function StatCard({ label, value, foot, icon: Icon, tone, testId }: { label: string; value: number; foot: string; icon: typeof Users; tone: 'purple' | 'green' | 'red' | 'amber'; testId: string }) {
  return <section className={`panel stat-card stat-card-${tone}`} data-testid={testId}><div className="stat-top"><span>{label}</span><span className="stat-icon"><Icon size={15} /></span></div><div className="stat-value">{value.toLocaleString()}</div><div className="stat-foot">{foot}</div></section>;
}

type RecipientImportResult = {
  added: number;
  duplicates: number;
  invalid: number;
  total: number;
};
type RecipientImportBatch = { email: string; name: string | null }[];
type SendRecipientImportBatch = (recipients: RecipientImportBatch) => Promise<RecipientImportResult>;
const CSV_IMPORT_BATCH_SIZE = 2_000;
const RECIPIENT_ROW_HEIGHT = 52;
const RECIPIENT_TABLE_HEADER_HEIGHT = 36;
const RECIPIENT_WINDOW_SIZE = 40;
const RECIPIENT_OVERSCAN = 10;

function importCsvFile(
  file: File,
  sendBatch: SendRecipientImportBatch,
  onProgress: (processedRows: number) => void,
): Promise<RecipientImportResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let firstRowHandled = false;
    let emailIndex = 0;
    let nameIndex = 1;
    let batch: RecipientImportBatch = [];
    const totals: RecipientImportResult = {
      added: 0,
      duplicates: 0,
      invalid: 0,
      total: 0,
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const flush = async () => {
      if (batch.length === 0) return;
      const currentBatch = batch;
      batch = [];
      const result = await sendBatch(currentBatch);
      totals.added += result.added;
      totals.duplicates += result.duplicates;
      totals.invalid += result.invalid;
      totals.total += result.total;
      onProgress(totals.total);
    };

    Papa.parse<string[]>(file, {
      chunkSize: 1024 * 1024,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      chunk: (result, parser) => {
        parser.pause();
        if (result.errors.length > 0) {
          const firstError = result.errors[0];
          fail(new Error(`CSV format error near row ${(firstError.row ?? 0) + 1}.`));
          parser.abort();
          return;
        }
        void (async () => {
          try {
            for (const row of result.data) {
              if (!firstRowHandled) {
                const first = row.map((cell, index) =>
                  (index === 0 ? cell.replace(/^\uFEFF/, '') : cell)
                    .trim()
                    .toLowerCase(),
                );
                const emailHeaderIndex = first.findIndex((cell) => cell.includes('email'));
                const nameHeaderIndex = first.findIndex((cell) =>
                  /^(name|full name|first name|last name)$/.test(cell),
                );
                const hasHeader = emailHeaderIndex >= 0 || nameHeaderIndex >= 0;
                emailIndex = hasHeader ? Math.max(0, emailHeaderIndex) : 0;
                nameIndex = hasHeader ? nameHeaderIndex : 1;
                firstRowHandled = true;
                if (hasHeader) continue;
              }
              const email = (row[emailIndex] ?? '').replace(/^\uFEFF/, '').trim();
              if (!email) continue;
              batch.push({
                email,
                name: nameIndex >= 0 ? (row[nameIndex] ?? '').trim() || null : null,
              });
              if (batch.length >= CSV_IMPORT_BATCH_SIZE) await flush();
            }
            parser.resume();
          } catch (error) {
            fail(error);
            parser.abort();
          }
        })();
      },
      complete: () => {
        if (settled) return;
        void flush()
          .then(() => {
            if (settled) return;
            settled = true;
            resolve(totals);
          })
          .catch(fail);
      },
      error: (error) => fail(error),
    });
  });
}
function RecipientsPage() {
  const client = useQueryClient();
  const { data: recipients, isLoading, isError, error, refetch } = useListRecipients();
  const add = useAddRecipients();
  const importCsv = useImportRecipients();
  const remove = useDeleteRecipient();
  const clearAll = useClearRecipients();
  const { notice, setNotice } = useNotice();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [clearConfirm, setClearConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [importResult, setImportResult] = useState<{ added: number; duplicates: number; invalid: number; total: number } | null>(null);
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvDragging, setCsvDragging] = useState(false);
  const [recipientScrollTop, setRecipientScrollTop] = useState(0);
  const recipientScrollRef = useRef<HTMLDivElement>(null);
  const refresh = () => {
    void client.invalidateQueries({ queryKey: getListRecipientsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
  };
  const visible = useMemo(() => (recipients ?? []).filter((item) => {
    const matchesQuery = `${item.email} ${item.name ?? ''}`.toLowerCase().includes(search.toLowerCase());
    return matchesQuery && (filter === 'all' || item.status === filter);
  }), [recipients, search, filter]);
  const firstVisibleIndex = Math.max(
    0,
    Math.floor(Math.max(0, recipientScrollTop - RECIPIENT_TABLE_HEADER_HEIGHT) / RECIPIENT_ROW_HEIGHT) - RECIPIENT_OVERSCAN,
  );
  const visibleRows = visible.slice(firstVisibleIndex, firstVisibleIndex + RECIPIENT_WINDOW_SIZE);
  const topSpacerHeight = firstVisibleIndex * RECIPIENT_ROW_HEIGHT;
  const bottomSpacerHeight = Math.max(0, (visible.length - firstVisibleIndex - visibleRows.length) * RECIPIENT_ROW_HEIGHT);
  useEffect(() => {
    setRecipientScrollTop(0);
    if (recipientScrollRef.current) recipientScrollRef.current.scrollTop = 0;
  }, [search, filter, visible.length]);
  const addOne = (event: FormEvent) => {
    event.preventDefault();
    if (csvImporting) return;
    const normalized = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) { setNotice({ text: 'Enter a valid email address before adding a recipient.', error: true }); return; }
    add.mutate({ data: { recipients: [{ email: normalized, name: name.trim() || null }] } }, {
      onSuccess: (result) => { refresh(); setEmail(''); setName(''); setImportResult(result); setNotice({ text: `${result.added} recipient added · ${result.duplicates} duplicate · ${result.invalid} invalid.` }); },
      onError: (err) => setNotice({ text: errorText(err), error: true }),
    });
  };
  const uploadCsv = async (file?: File) => {
    if (!file || csvImporting) return;
    setCsvDragging(false);
    const isCsv = file.name.toLowerCase().endsWith('.csv')
      || file.type === 'text/csv'
      || file.type === 'application/vnd.ms-excel';
    if (!isCsv) {
      setNotice({ text: 'Choose a CSV file to import recipients.', error: true });
      return;
    }
    setCsvImporting(true);
    setImportResult(null);
    let completedRows = 0;
    try {
      setNotice({ text: 'Reading and importing CSV…' });
      const result = await importCsvFile(
        file,
        (recipients) => importCsv.mutateAsync({ data: { recipients } }),
        (processed) => {
          completedRows = processed;
          setNotice({ text: `Importing recipients… ${processed.toLocaleString()} rows saved.` });
        },
      );
      if (result.total === 0) {
        setNotice({ text: 'No recipient rows found. Use a CSV with email and optional name columns.', error: true });
        return;
      }
      setImportResult(result);
      refresh();
      setNotice({ text: `Import reviewed: ${result.added} added, ${result.duplicates} duplicates, ${result.invalid} invalid.` });
    } catch (error) {
      if (completedRows > 0) {
        refresh();
        setNotice({
          text: `Import stopped after ${completedRows.toLocaleString()} rows. Earlier batches are saved; re-uploading is safe because existing email addresses are skipped. ${errorText(error)}`,
          error: true,
        });
      } else {
        setNotice({ text: errorText(error), error: true });
      }
    } finally {
      setCsvImporting(false);
    }
  };
  const doDelete = () => {
    if (deleteTarget === null || csvImporting) return;
    remove.mutate({ id: deleteTarget }, { onSuccess: () => { refresh(); setDeleteTarget(null); setNotice({ text: 'Recipient removed.' }); }, onError: (err) => setNotice({ text: errorText(err), error: true }) });
  };
  const doClear = () => {
    if (csvImporting) return;
    clearAll.mutate(undefined, { onSuccess: (result) => { refresh(); setClearConfirm(false); setImportResult(null); setNotice({ text: `${result.deleted} recipient${result.deleted === 1 ? '' : 's'} cleared.` }); }, onError: (err) => setNotice({ text: errorText(err), error: true }) });
  };
  return <WorkspacePage title="Recipients"><main className="page-wrap">
     <PageTitle kicker="Workspace · People" title="Recipients" subtitle="Build a clean, validated list for a one-time invitation send." actions={<div className="toolbar"><div className="searchbox"><Search size={14} /><input className="input" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search email or name" aria-label="Search recipients" data-testid="input-recipient-search" /></div><button className="button button-danger button-sm" onClick={() => setClearConfirm(true)} disabled={!recipients?.length || csvImporting} data-testid="button-clear-recipients"><Trash2 size={13} /> Clear all</button></div>} />
    <div className="content-stack">
       <section className="panel panel-pad"><div className="panel-head" style={{ margin: '-23px -23px 20px' }}><div><h2 className="panel-title">Add manually</h2><p className="panel-sub">Email addresses are checked by the server when saved.</p></div><Plus size={17} color="#738879" /></div><form className="inline-form" onSubmit={addOne}><div className="field" style={{ marginBottom: 0 }}><label htmlFor="recipient-email">Email address</label><input id="recipient-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" data-testid="input-recipient-email" /></div><div className="field" style={{ marginBottom: 0 }}><label htmlFor="recipient-name">Name <span style={{ fontWeight: 400, color: '#919a91' }}>optional</span></label><input id="recipient-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" data-testid="input-recipient-name" /></div><button className="button button-primary" disabled={add.isPending || csvImporting} type="submit" data-testid="button-add-recipient"><Plus size={14} />{add.isPending ? 'Adding…' : 'Add recipient'}</button></form></section>
       <section className="panel panel-pad"><div className="panel-head" style={{ margin: '-23px -23px 18px' }}><div><h2 className="panel-title">Import a CSV</h2><p className="panel-sub">No fixed row cap; large files are read and uploaded in batches. Accepted columns: email, name.</p></div><Upload size={17} color="#738879" /></div><label
         className={`file-drop recipient-csv-dropzone${csvDragging ? ' is-dragging' : ''}${csvImporting ? ' is-importing' : ''}`}
         htmlFor="recipient-csv"
         role="button"
         tabIndex={0}
         aria-label="Drop a recipient CSV or browse for one"
         data-testid="dropzone-recipient-csv"
         onKeyDown={(event) => {
           if (!csvImporting && (event.key === 'Enter' || event.key === ' ')) {
             event.preventDefault();
             event.currentTarget.querySelector<HTMLInputElement>('input[type="file"]')?.click();
           }
         }}
         onDragOver={(event) => {
           event.preventDefault();
           if (!csvImporting) setCsvDragging(true);
         }}
         onDragLeave={(event) => {
           if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setCsvDragging(false);
         }}
         onDrop={(event) => {
           event.preventDefault();
           setCsvDragging(false);
           if (csvImporting) return;
           const files = Array.from(event.dataTransfer.files);
           if (files.length !== 1) {
             setNotice({ text: 'Drop one CSV file at a time.', error: true });
             return;
           }
           void uploadCsv(files[0]);
         }}
       >
         <span className="quick-icon"><ArrowDownToLine size={16} /></span>
         <span className="file-copy"><strong>{csvImporting ? 'Importing recipients…' : 'Drop a CSV file here'}</strong><span>Drop or browse · Header row is optional · Duplicate and invalid counts come from the server.</span></span>
         <span className="button button-secondary button-sm">{csvImporting ? 'Importing…' : 'Browse files'}</span>
         <input id="recipient-csv" type="file" accept=".csv,text/csv" disabled={csvImporting} onChange={(e) => { void uploadCsv(e.target.files?.[0]); e.currentTarget.value = ''; }} data-testid="input-recipient-csv" />
       </label>
        {importResult && <div className="notice success" style={{ marginTop: 14 }} data-testid="status-import-result"><CheckCircle2 size={16} className="notice-icon" /><span>Latest import — <strong>{importResult.added} added</strong>, {importResult.duplicates} duplicates, {importResult.invalid} invalid out of {importResult.total} rows.</span></div>}
      </section>
       <section className="panel">
        <div className="panel-head"><div><h2 className="panel-title">All recipients <span style={{ color: '#929a91', font: '500 11px var(--app-font-mono)' }}>{recipients?.length ?? '—'}</span></h2><p className="panel-sub">Status reflects validation and invitation processing.</p></div><div className="filter-row">{['all', 'valid', 'invalid', 'pending'].map((value) => <button className={`filter-pill${filter === value ? ' active' : ''}`} key={value} onClick={() => setFilter(value)} data-testid={`filter-recipients-${value}`}>{statusLabel(value)}</button>)}</div></div>
        {isLoading ? <LoadingPanel /> : isError ? <div style={{ padding: 18 }}><ErrorPanel message={errorText(error)} retry={() => void refetch()} /></div> : visible.length ? <>
          <div
            className="recipient-table-scroll"
            role="region"
            aria-label="All recipients; scroll to browse the list"
            tabIndex={0}
            ref={recipientScrollRef}
            onScroll={(event) => setRecipientScrollTop(event.currentTarget.scrollTop)}
            data-testid="scroll-recipients"
          >
            <table className="data-table recipient-data-table">
              <thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Added</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {topSpacerHeight > 0 && <tr className="recipient-virtual-spacer" aria-hidden="true"><td colSpan={5} style={{ height: topSpacerHeight }} /></tr>}
                {visibleRows.map((item) => <tr className="recipient-data-row" key={item.id} data-testid={`row-recipient-${item.id}`}><td title={item.email}>{item.email}</td><td title={item.name || ''}>{item.name || '—'}</td><td><StatusBadge status={item.status} /></td><td className="mono">{dateText(item.createdAt)}</td><td><button className="button button-quiet button-sm" aria-label={`Delete ${item.email}`} onClick={() => setDeleteTarget(item.id)} disabled={csvImporting} data-testid={`button-delete-recipient-${item.id}`}><Trash2 size={14} /></button></td></tr>)}
                {bottomSpacerHeight > 0 && <tr className="recipient-virtual-spacer" aria-hidden="true"><td colSpan={5} style={{ height: bottomSpacerHeight }} /></tr>}
              </tbody>
            </table>
          </div>
          <div className="panel-sub" style={{ padding: '12px 18px' }} data-testid="text-recipient-scroll-count">Showing all {visible.length.toLocaleString()} matching recipients. Scroll the list to browse.</div>
        </> : recipients?.length ? <EmptyState icon={Filter} title="No matches" detail="Try a different search or status filter." action={<button className="button button-secondary button-sm" onClick={() => { setSearch(''); setFilter('all'); }} data-testid="button-reset-recipient-filter">Reset filters</button>} /> : <EmptyState icon={Users} title="Your list is ready for its first person" detail="Add one recipient at a time or import a CSV. Nothing is sent from this page." />}
      </section>
    </div>
    {clearConfirm && <ConfirmModal title="Clear all recipients?" description="This removes every saved recipient from the workspace. Existing activity records are retained." cancel={() => setClearConfirm(false)} confirm={doClear} pending={clearAll.isPending} destructive testId="confirm-clear-recipients" />}
    {deleteTarget !== null && <ConfirmModal title="Remove this recipient?" description="This person will be removed from the current recipient list." cancel={() => setDeleteTarget(null)} confirm={doDelete} pending={remove.isPending} destructive testId="confirm-delete-recipient" />}
    <Toast notice={notice} />
  </main></WorkspacePage>;
}

function ConfirmModal({ title, description, cancel, confirm, pending, destructive = false, testId, cancelTestId = 'button-cancel-modal', confirmLabel = 'Confirm', pendingLabel = 'Working…' }: { title: string; description: string; cancel: () => void; confirm: () => void; pending: boolean; destructive?: boolean; testId: string; cancelTestId?: string; confirmLabel?: string; pendingLabel?: string }) {
  return <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true"><div className="kicker">Please confirm</div><h2>{title}</h2><p>{description}</p><div className="modal-actions"><button className="button button-secondary" onClick={cancel} data-testid={cancelTestId}>Cancel</button><button className={`button ${destructive ? 'button-danger' : 'button-primary'}`} onClick={confirm} disabled={pending} data-testid={testId}>{pending ? pendingLabel : confirmLabel}</button></div></div></div>;
}

const defaultEventSettings: EventSettings = { title: 'Team Meeting', location: '', url: '', note: '', inviteAsAttendees: true, inviteesPerEvent: 1, timezone: 'America/New_York', durationMinutes: 30, minimumLeadMinutes: 15, automaticTimeSelection: true, startAt: null };
function dateTimeInZone(value: string | null | undefined, timezone: string) {
  if (!value) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
  } catch {
    return '';
  }
}
function isoFromZoneDateTime(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target = [Number(yearText), Number(monthText), Number(dayText), Number(hourText), Number(minuteText)];
  const targetAsUtc = Date.UTC(target[0], target[1] - 1, target[2], target[3], target[4]);
  let candidate = targetAsUtc;
  try {
    const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = format.formatToParts(new Date(candidate));
      const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
      const displayedAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
      const next = targetAsUtc - (displayedAsUtc - candidate);
      if (next === candidate) break;
      candidate = next;
    }
    const check = format.formatToParts(new Date(candidate));
    const part = (type: string) => Number(check.find((entry) => entry.type === type)?.value);
    if (part('year') !== target[0] || part('month') !== target[1] || part('day') !== target[2] || part('hour') !== target[3] || part('minute') !== target[4]) return null;
    return new Date(candidate).toISOString();
  } catch {
    return null;
  }
}
function EventSettingsPage() {
  const client = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useGetEventSettings();
  const update = useUpdateEventSettings();
  const { notice, setNotice } = useNotice();
  const [form, setForm] = useState<EventSettings>(defaultEventSettings);
  const [ready, setReady] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  useEffect(() => { if (data) { setForm(data); setReady(true); } }, [data]);
  const setValue = <K extends keyof EventSettings>(key: K, value: EventSettings[K]) => setForm((old) => ({ ...old, [key]: value }));
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!form.automaticTimeSelection && !form.startAt) { setNotice({ text: 'Choose a valid start time in the selected timezone.', error: true }); return; }
    update.mutate({ data: form }, { onSuccess: (settings) => { setForm(settings); setReady(true); void client.invalidateQueries({ queryKey: getGetEventSettingsQueryKey() }); setNotice({ text: 'Event defaults saved.' }); }, onError: (err) => setNotice({ text: errorText(err), error: true }) });
  };
  const resetSavedSettings = () => {
    update.mutate({ data: defaultEventSettings }, {
      onSuccess: (settings) => {
        setForm(settings);
        setReady(true);
        setResetConfirm(false);
        void client.invalidateQueries({ queryKey: getGetEventSettingsQueryKey() });
        setNotice({ text: 'Saved event settings reset to defaults.' });
      },
      onError: (err) => setNotice({ text: errorText(err), error: true }),
    });
  };
  const changeTimezone = (timezone: string) => {
    const wallTime = dateTimeInZone(form.startAt, form.timezone);
    setForm((old) => ({
      ...old,
      timezone,
      startAt: wallTime ? isoFromZoneDateTime(wallTime, timezone) : old.startAt,
    }));
  };
  return <WorkspacePage title="Event settings"><main className="page-wrap"><PageTitle kicker="Workspace · Defaults" title="Event settings" subtitle="Set event details and how many recipients to include in each event." actions={<div className="toolbar"><button className="button button-secondary" type="button" onClick={() => setResetConfirm(true)} disabled={!ready || update.isPending} data-testid="button-reset-event-settings"><RefreshCw size={14} />Reset saved settings</button><button className="button button-primary" form="event-settings-form" type="submit" disabled={!ready || update.isPending} data-testid="button-save-event-settings"><Check size={14} />{update.isPending ? 'Saving…' : 'Save changes'}</button></div>} />
    {isLoading ? <LoadingPanel /> : isError ? <ErrorPanel message={errorText(error)} retry={() => void refetch()} /> : <form id="event-settings-form" onSubmit={save} className="content-stack">
      <section className="panel panel-pad"><div className="kicker">Event identity</div><div className="form-grid">
        <div className="field span-2"><label htmlFor="event-title">Event title</label><input id="event-title" className="input" maxLength={200} required value={form.title} onChange={(e) => setValue('title', e.target.value)} placeholder="A thoughtful event title" data-testid="input-event-title" /></div>
        <div className="field"><label htmlFor="event-location">Location</label><input id="event-location" className="input" maxLength={300} value={form.location} onChange={(e) => setValue('location', e.target.value)} placeholder="Address or meeting place" data-testid="input-event-location" /></div>
        <div className="field"><label htmlFor="event-url">Event link</label><input id="event-url" className="input" maxLength={2000} type="url" value={form.url} onChange={(e) => setValue('url', e.target.value)} placeholder="https://" data-testid="input-event-url" /></div>
        <div className="field span-2"><label htmlFor="event-note">Message for invitees</label><textarea id="event-note" className="textarea" maxLength={5000} value={form.note} onChange={(e) => setValue('note', e.target.value)} placeholder="Add details for the calendar event and invitation" data-testid="input-event-note" /><span className="field-help">Saved with the event; email appearance and delivery depend on iCloud.</span></div>
      </div></section>
      <section className="panel panel-pad"><div className="kicker">Scheduling defaults</div><div className="form-grid">
        <div className="field"><label htmlFor="event-timezone">Timezone</label><input id="event-timezone" className="input" maxLength={100} required value={form.timezone} onChange={(e) => changeTimezone(e.target.value)} placeholder="America/New_York" data-testid="input-event-timezone" /><span className="field-help">Use an IANA timezone identifier.</span></div>
        <div className="field"><label htmlFor="event-duration">Duration in minutes</label><input id="event-duration" className="input" type="number" min={5} max={1440} required value={form.durationMinutes} onChange={(e) => setValue('durationMinutes', Number(e.target.value))} data-testid="input-event-duration" /></div>
        <div className="field"><label htmlFor="event-lead">Minimum lead time in minutes</label><input id="event-lead" className="input" type="number" min={15} max={10080} required value={form.minimumLeadMinutes} onChange={(e) => setValue('minimumLeadMinutes', Number(e.target.value))} data-testid="input-event-lead-time" /><span className="field-help">How far ahead the selected event time must be.</span></div>
         <div className="field"><label htmlFor="event-invitees-per-event">Invitees per event</label><input id="event-invitees-per-event" className="input" type="number" min={1} max={5000} step={1} required value={form.inviteesPerEvent} onChange={(e) => setValue('inviteesPerEvent', Number(e.target.value))} data-testid="input-invitees-per-event" /><span className="field-help">Recipients are grouped into batches of this size; each event is completed before the next batch starts.</span></div>
      </div>
        <Toggle checked={form.automaticTimeSelection} onChange={(value) => setValue('automaticTimeSelection', value)} title="Choose event times automatically" detail="Use available time selection within your minimum lead-time rules." testId="toggle-automatic-time" />
        {!form.automaticTimeSelection && <div className="field" style={{ marginTop: 18 }}><label htmlFor="event-start-time">Event start time ({form.timezone})</label><input id="event-start-time" className="input" type="datetime-local" required value={dateTimeInZone(form.startAt, form.timezone)} min={dateTimeInZone(new Date(Date.now() + form.minimumLeadMinutes * 60_000).toISOString(), form.timezone)} onChange={(event) => { const next = event.target.value ? isoFromZoneDateTime(event.target.value, form.timezone) : null; setValue('startAt', next); if (event.target.value && !next) setNotice({ text: 'That local time is invalid or falls in a daylight-saving time gap.', error: true }); }} data-testid="input-event-start-time" /><span className="field-help">Choose a local date and time at least {form.minimumLeadMinutes} minutes from now.</span></div>}
        <Toggle checked={form.inviteAsAttendees} onChange={(value) => setValue('inviteAsAttendees', value)} title="Add recipients as attendees" detail="This setting determines how attendee information is included in the generated event." testId="toggle-invite-attendees" />
      </section>
      <div className="notice"><CircleHelp size={15} className="notice-icon" /><span>Event settings are captured when a one-time send starts. Changes apply to future sends and do not alter invitations already queued.</span></div>
    </form>}
    {resetConfirm && <ConfirmModal title="Reset saved event settings?" description="This saves Team Meeting, one invitee per event, a 30-minute duration, America/New_York timezone, automatic time selection, and blank location, link, and message. It affects future sends; settings already captured by a send stay unchanged." cancel={() => setResetConfirm(false)} confirm={resetSavedSettings} pending={update.isPending} destructive testId="confirm-reset-event-settings" cancelTestId="button-cancel-reset-event-settings" confirmLabel="Reset and save defaults" pendingLabel="Resetting…" />}
    <Toast notice={notice} />
  </main></WorkspacePage>;
}
function Toggle({ checked, onChange, title, detail, testId }: { checked: boolean; onChange: (value: boolean) => void; title: string; detail: string; testId: string }) {
  return <div className="switch-row"><div className="switch-copy"><strong>{title}</strong><span>{detail}</span></div><button type="button" role="switch" aria-checked={checked} className="toggle" onClick={() => onChange(!checked)} data-testid={testId}><span /></button></div>;
}

function ICloudSettingsPage() {
  const client = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useGetIcloudSettings();
  const saveMutation = useSaveIcloudSettings();
  const deleteMutation = useDeleteIcloudCredentials();
  const testMutation = useTestIcloudConnection();
  const { notice, setNotice } = useNotice();
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);
  const [calendarName, setCalendarName] = useState('');
  const [calendarHref, setCalendarHref] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [connectionTest, setConnectionTest] = useState<ICloudConnectionTest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: getGetIcloudSettingsQueryKey() });
  const openAccountDialog = () => {
    setEmail(data?.email ?? '');
    setPassword('');
    setShowAppPassword(false);
    setCalendarName(data?.calendarName ?? '');
    const savedCalendar = data?.calendars?.find(
      (calendar) => calendar.name === data?.calendarName,
    );
    setCalendarHref(savedCalendar?.href ?? '');
    setTimezone(data?.timezone || 'America/New_York');
    setConnectionTest(null);
    setDialogError('');
    setAccountDialogOpen(true);
  };
  const closeAccountDialog = () => {
    if (testMutation.isPending || saveMutation.isPending) return;
    setAccountDialogOpen(false);
    setPassword('');
    setShowAppPassword(false);
    setConnectionTest(null);
    setDialogError('');
  };
  useEffect(() => {
    if (!accountDialogOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [accountDialogOpen]);
  useEffect(() => {
    if (!accountDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !testMutation.isPending &&
        !saveMutation.isPending
      ) {
        setAccountDialogOpen(false);
        setPassword('');
        setShowAppPassword(false);
        setConnectionTest(null);
        setDialogError('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountDialogOpen, saveMutation.isPending, testMutation.isPending]);
  const testConnection = () => {
    if (!email.trim() || !password) {
      setDialogError('Enter your iCloud email and app-specific password first.');
      return;
    }
    setConnectionTest(null);
    setDialogError('');
    testMutation.mutate({ data: { email: email.trim(), appPassword: password } }, {
      onSuccess: (result) => {
        const safeResult = { ...result, message: password ? result.message.split(password).join('••••••••') : result.message };
        setConnectionTest(safeResult);
        if (result.calendars.length) {
          const selected =
            result.calendars.find((calendar) => calendar.href === calendarHref) ??
            result.calendars.find((calendar) => calendar.name === calendarName) ??
            result.calendars[0];
          setCalendarName(selected.name);
          setCalendarHref(selected.href);
        } else {
          setCalendarName('');
          setCalendarHref('');
        }
        setDialogError('');
      },
      onError: (err) => setDialogError(errorText(err, password)),
    });
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    const selected = connectionTest?.calendars.find(
      (calendar) => calendar.href === calendarHref,
    );
    if (connectionTest?.status !== 'connected' || !selected) {
      setDialogError('Test the connection and select a discovered calendar before saving.');
      return;
    }
    setDialogError('');
    saveMutation.mutate({
      data: {
        email: email.trim(),
        appPassword: password,
        calendarName: selected.name,
        calendarHref: selected.href,
        timezone,
      },
    }, {
      onSuccess: () => {
        setAccountDialogOpen(false);
        setPassword('');
        setShowAppPassword(false);
        setConnectionTest(null);
        setDialogError('');
        refresh();
        setNotice({ text: 'iCloud account saved. The password remains masked and is not returned to this page.' });
      },
      onError: (err) => setDialogError(errorText(err, password)),
    });
  };
  const deleteCredentials = () => deleteMutation.mutate(undefined, { onSuccess: () => { setConfirmDelete(false); setPassword(''); setShowAppPassword(false); setConnectionTest(null); refresh(); setNotice({ text: 'Saved iCloud credentials removed.' }); }, onError: (err) => setNotice({ text: errorText(err), error: true }) });
  return <WorkspacePage title="iCloud account"><main className="page-wrap"><PageTitle kicker="Workspace · Connection" title="iCloud account" subtitle="Connect the calendar that will own each invitation. Passwords are never displayed after submission." actions={<StatusBadge status={data?.status ?? 'not-connected'} />} />
    {isLoading ? <LoadingPanel /> : isError ? <ErrorPanel message={errorText(error)} retry={() => void refetch()} /> : <div className="content-stack">
      <section className="panel panel-pad"><div className="panel-head" style={{ margin: '-23px -23px 20px' }}><div><h2 className="panel-title">Apple account connection</h2><p className="panel-sub">Use an app-specific password, not your Apple Account password.</p></div><span className="stat-icon"><Cloud size={17} /></span></div>
        {data?.hasStoredPassword ? <div className="icloud-account-summary">
          <div className="icloud-account-summary-copy">
            <span className="kicker">Connected Apple account</span>
            <strong>{data.email}</strong>
            <span>{data.calendarName || 'Calendar not selected'} · {data.timezone}</span>
            <span className="field-help">{data.invitationMode === 'caldav-scheduling' ? 'CalDAV scheduling reported available.' : 'Calendar-only mode reported; invitation delivery may not be supported.'}</span>
          </div>
          <div className="section-actions icloud-account-actions">
            <StatusBadge status={data.status} />
            <button className="button button-secondary" onClick={openAccountDialog} data-testid="button-edit-icloud-account">Update account</button>
            <button className="button button-danger" onClick={() => setConfirmDelete(true)} data-testid="button-delete-icloud-credentials"><Trash2 size={14} /> Remove account</button>
          </div>
        </div> : <div className="icloud-empty-account">
          <div><strong>No iCloud account connected</strong><p>Add an Apple Account and test its connection before saving.</p></div>
          <button className="button button-primary" onClick={openAccountDialog} data-testid="button-add-icloud-account"><Plus size={14} /> Add account</button>
        </div>}
        {data?.hasStoredPassword && <p className="field-help icloud-storage-warning">The app-specific password is stored as readable text in the database. Anyone with direct database access can read it.</p>}
      </section>
      <div className="notice warn"><AlertCircle size={15} className="notice-icon" /><span>Events can be saved with attendee details in calendar-only mode, but iCloud has not confirmed invitation scheduling. Attendee notifications are not guaranteed.</span></div>
    </div>}
    {accountDialogOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeAccountDialog(); }}>
      <div className="modal icloud-account-modal" role="dialog" aria-modal="true" aria-labelledby="icloud-account-dialog-title">
        <div className="icloud-modal-heading">
          <div><div className="kicker">{data?.hasStoredPassword ? 'Update connection' : 'New connection'}</div><h2 id="icloud-account-dialog-title">{data?.hasStoredPassword ? 'Update iCloud account' : 'Add iCloud account'}</h2><p>Enter your Apple Account email and app-specific password, then test the connection.</p></div>
          <button type="button" className="button button-secondary button-sm" onClick={closeAccountDialog} disabled={testMutation.isPending || saveMutation.isPending} aria-label="Close iCloud account dialog" data-testid="button-close-icloud-dialog"><X size={15} /></button>
        </div>
        <form onSubmit={save}>
          <div className="form-grid">
            <div className="field"><label htmlFor="icloud-email">Apple Account email</label><input id="icloud-email" className="input" type="email" autoComplete="username" required autoFocus value={email} onChange={(event) => { setEmail(event.target.value); setConnectionTest(null); setCalendarName(''); setCalendarHref(''); setDialogError(''); }} placeholder="you@icloud.com" data-testid="input-icloud-email" /></div>
            <div className="field"><label htmlFor="icloud-password">App-specific password</label><div className="password-input-wrap"><input id="icloud-password" className="input" type={showAppPassword ? 'text' : 'password'} autoComplete="new-password" maxLength={100} required value={password} onChange={(event) => { setPassword(event.target.value); setConnectionTest(null); setDialogError(''); }} placeholder="Enter an app-specific password" data-testid="input-icloud-password" /><button type="button" className="password-visibility-toggle" onClick={() => setShowAppPassword((visible) => !visible)} aria-label={showAppPassword ? 'Hide app-specific password' : 'Show app-specific password'} aria-pressed={showAppPassword} aria-controls="icloud-password" data-testid="button-toggle-icloud-password-visibility">{showAppPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</button></div><span className="field-help">Use an Apple app-specific password, not your Apple Account password.</span></div>
            <div className="field span-2"><label htmlFor="icloud-calendar">Discovered calendar</label><select id="icloud-calendar" className="select" required value={calendarHref} onChange={(event) => { const selected = connectionTest?.calendars.find((calendar) => calendar.href === event.target.value); setCalendarHref(event.target.value); setCalendarName(selected?.name ?? ''); }} disabled={connectionTest?.status !== 'connected'} data-testid="select-icloud-calendar"><option value="" disabled>{connectionTest?.status === 'connected' ? 'Choose a calendar' : 'Test connection to discover calendars'}</option>{connectionTest?.calendars.map((calendar) => <option key={calendar.href} value={calendar.href}>{calendar.name}</option>)}</select>{connectionTest?.status === 'connected' && <span className="field-help">{connectionTest.calendars.length} calendar{connectionTest.calendars.length === 1 ? '' : 's'} discovered.</span>}</div>
            <div className="field span-2"><label htmlFor="icloud-timezone">Calendar timezone</label><input id="icloud-timezone" className="input" maxLength={100} required value={timezone} onChange={(event) => setTimezone(event.target.value)} data-testid="input-icloud-timezone" /></div>
          </div>
          <div className="notice warn icloud-password-warning"><AlertCircle size={15} className="notice-icon" /><span>The app-specific password is stored as readable text in the database. Anyone with direct database access can read it.</span></div>
          {connectionTest && <div className={`notice ${connectionTest.status === 'connected' ? 'success' : 'warn'}`} role="status" data-testid="status-icloud-connection"><Cloud size={16} className="notice-icon" /><span>{connectionTest.message}<br /><strong>{connectionTest.invitationMode === 'caldav-scheduling' ? 'CalDAV scheduling reported available.' : 'Events can include attendees, but iCloud has not confirmed invitation notifications.'}</strong></span></div>}
          {dialogError && <div className="notice error icloud-dialog-error" role="alert" data-testid="status-icloud-dialog-error">{dialogError}</div>}
          <div className="icloud-modal-actions">
            <button type="button" className="button button-secondary" onClick={testConnection} disabled={testMutation.isPending || saveMutation.isPending} data-testid="button-test-icloud">{testMutation.isPending ? 'Testing connection…' : 'Test connection'}</button>
            <div className="icloud-modal-actions-end">
              <button type="button" className="button button-secondary" onClick={closeAccountDialog} disabled={testMutation.isPending || saveMutation.isPending} data-testid="button-cancel-icloud-dialog">Cancel</button>
              <button type="submit" className="button button-primary" disabled={saveMutation.isPending || testMutation.isPending || connectionTest?.status !== 'connected' || !calendarHref} data-testid="button-save-icloud">{saveMutation.isPending ? 'Saving…' : 'Save account'} <Check size={14} /></button>
            </div>
          </div>
        </form>
      </div>
    </div>}
    {confirmDelete && <ConfirmModal title="Remove saved iCloud credentials?" description="Stored credentials will be deleted. New invitation sends require a working connection." cancel={() => setConfirmDelete(false)} confirm={deleteCredentials} pending={deleteMutation.isPending} destructive testId="confirm-delete-icloud" />}
    <Toast notice={notice} />
  </main></WorkspacePage>;
}

function LogsPage() {
  const { data, isLoading, isError, error, refetch } = useListLogs();
  const [level, setLevel] = useState('all');
  const filtered = useMemo(() => (data ?? []).filter(isVisibleActivity).map(presentActivity).filter((item) => level === 'all' || item.level === level), [data, level]);
  if (isLoading) return <WorkspacePage title="Activity log"><main className="page-wrap"><LoadingPanel /></main></WorkspacePage>;
  if (isError) return <WorkspacePage title="Activity log"><main className="page-wrap"><ErrorPanel message={errorText(error)} retry={() => void refetch()} /></main></WorkspacePage>;
  return <WorkspacePage title="Activity log"><main className="page-wrap"><PageTitle kicker="Workspace · Audit trail" title="Activity log" subtitle="Server-reported invitation events and recipient processing." actions={<div className="toolbar"><div className="filter-row">{['all', 'info', 'warning', 'error'].map((item) => <button key={item} className={`filter-pill${level === item ? ' active' : ''}`} onClick={() => setLevel(item)} data-testid={`filter-logs-${item}`}>{statusLabel(item)}</button>)}</div><button className="button button-secondary button-sm" onClick={() => void refetch()} data-testid="button-refresh-logs"><RefreshCw size={13} /> Refresh</button></div>} />
    {filtered.length ? <section className="panel"><div className="table-wrap"><table className="data-table"><thead><tr><th>Level</th><th>Event</th><th>Activity</th><th>Recorded</th></tr></thead><tbody>{filtered.map((entry) => <LogRow key={entry.id} entry={entry} />)}</tbody></table></div></section> : <section className="panel"><EmptyState icon={FileText} title={data?.length ? 'No activity at this level' : 'No activity recorded yet'} detail={data?.length ? 'Choose another level filter to see matching entries.' : 'Invitation and recipient activity will appear here when reported by the server.'} action={data?.length ? <button className="button button-secondary button-sm" onClick={() => setLevel('all')} data-testid="button-reset-log-filter">Show all activity</button> : undefined} /></section>}
  </main></WorkspacePage>;
}
function LogRow({ entry }: { entry: ActivityLog }) {
  const display = presentActivity(entry);
  return <tr data-testid={`row-log-${entry.id}`}><td><StatusBadge status={display.level} /></td><td className="mono log-event">{display.event}</td><td className="log-message">{display.message}</td><td className="mono log-time">{dateText(display.createdAt)}</td></tr>;
}

function AuthBrand() {
  return <Link href="/login" className="auth-brand" data-testid="link-auth-brand"><BrandMark /><span><strong>Event System</strong><small>iCloud invitation desk</small></span></Link>;
}
function AuthFrame({ children, mode }: { children: ReactNode; mode: 'login' | 'setup' }) {
  return <main className="auth-page"><div className="auth-frame auth-frame-account">
    <aside className="auth-aside"><AuthBrand /><div className="auth-aside-copy">
      <div className="auth-kicker">Private invitation workspace</div>
      <h1>{mode === 'setup' ? 'Make this workspace yours.' : 'Your events, kept in their own place.'}</h1>
      <p>{mode === 'setup' ? 'Create the administrator account to begin managing access and private event workspaces.' : 'Sign in with the username provided by your workspace administrator.'}</p>
    </div><div className="auth-aside-foot"><span className="live-dot" /> Account-protected · iCloud settings stay private</div></aside>
    <section className="auth-main"><div className="auth-form-wrap">{children}</div></section>
  </div></main>;
}
function LoginPage() {
  const login = useLogin();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });
  const submit = (values: z.infer<typeof loginSchema>) => {
    const submittedPassword = values.password;
    form.resetField('password');
    setError('');
    login.mutate({ data: { username: values.username, password: submittedPassword } }, {
      onSuccess: async (session) => {
        await client.cancelQueries({ queryKey: getGetAuthStatusQueryKey() });
        clearUserQueries(client);
        client.setQueryData(getGetAuthStatusQueryKey(), (old: import('@workspace/api-client-react').AuthStatus | undefined) => ({
          setupRequired: false, setupEnabled: old?.setupEnabled ?? true, user: session.user,
        }));
        setLocation('/dashboard');
      },
      onError: (err) => setError(errorText(err, submittedPassword)),
    });
  };
  return <AuthFrame mode="login"><div className="kicker">Account sign in</div><h2>Welcome back</h2><p className="auth-intro">Use your administrator-issued credentials to open your workspace.</p>
    {error && <div className="notice error auth-error" role="alert" data-testid="status-login-error"><AlertCircle size={15} className="notice-icon" />{error}</div>}
    <Form {...form}><form onSubmit={form.handleSubmit(submit)} className="auth-form" data-testid="form-login">
      <FormField control={form.control} name="username" render={({ field }) => <FormItem className="field"><FormLabel>Username</FormLabel><FormControl><input {...field} className="input" autoComplete="username" autoFocus data-testid="input-login-username" /></FormControl><FormMessage /></FormItem>} />
      <FormField control={form.control} name="password" render={({ field }) => <FormItem className="field"><FormLabel>Password</FormLabel><FormControl><input {...field} className="input" type="password" autoComplete="current-password" data-testid="input-login-password" /></FormControl><FormMessage /></FormItem>} />
      <button className="button button-primary auth-submit" type="submit" disabled={login.isPending} data-testid="button-login-submit"><LockKeyhole size={14} />{login.isPending ? 'Signing in…' : 'Sign in to workspace'}</button>
      {login.isPending && <p className="field-help" role="status" data-testid="status-login-pending">Checking your account…</p>}
    </form></Form><p className="auth-footnote">Accounts are created and managed by your workspace administrator. Self-signup is not available.</p>
  </AuthFrame>;
}
function SetupPage() {
  const { data: auth } = useGetAuthStatus();
  const setup = useSetupAdmin();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const [error, setError] = useState('');
  const form = useForm<z.infer<typeof setupSchema>>({
    resolver: zodResolver(setupSchema),
    defaultValues: { username: '', password: '', bootstrapToken: '' },
  });
  const submit = (event: FormEvent) => {
    void form.handleSubmit((values) => {
      const submittedPassword = values.password;
      const bootstrapToken = values.bootstrapToken;
      form.resetField('password');
      form.resetField('bootstrapToken');
      setError('');
      setup.mutate({ data: { username: values.username, password: submittedPassword, bootstrapToken } }, {
        onSuccess: async (session) => {
          await client.cancelQueries({ queryKey: getGetAuthStatusQueryKey() });
          clearUserQueries(client);
          client.setQueryData(getGetAuthStatusQueryKey(), { setupRequired: false, setupEnabled: true, user: session.user });
          setLocation('/dashboard');
        },
        onError: (err) => setError(errorText(errorText(err, submittedPassword), bootstrapToken)),
      });
    })(event);
  };
  return <AuthFrame mode="setup"><div className="kicker">First-time setup</div><h2>Establish the administrator</h2><p className="auth-intro">This one-time setup creates the first account and unlocks workspace access controls.</p>
    {!auth?.setupEnabled ? <div className="notice warn setup-config-message" role="status" data-testid="status-setup-disabled"><AlertCircle size={16} className="notice-icon" /><span><strong>No administrator account exists yet, so there is no login to use.</strong><br />Set <code>ADMIN_BOOTSTRAP_TOKEN</code> in Replit Secrets (at least 32 characters), restart the API service, then reload this page. The setup form will let you create the administrator username and password.</span></div> : <>
      {error && <div className="notice error auth-error" role="alert" data-testid="status-setup-error"><AlertCircle size={15} className="notice-icon" />{error}</div>}
      <Form {...form}><form onSubmit={submit} className="auth-form" data-testid="form-setup-admin">
        <FormField control={form.control} name="username" render={({ field }) => <FormItem className="field"><FormLabel>Administrator username</FormLabel><FormControl><input {...field} className="input" autoComplete="username" data-testid="input-setup-username" /></FormControl><FormMessage /></FormItem>} />
        <FormField control={form.control} name="password" render={({ field }) => <FormItem className="field"><FormLabel>Administrator password</FormLabel><FormControl><input {...field} className="input" type="password" autoComplete="new-password" data-testid="input-setup-password" /></FormControl><FormDescription className="field-help">Use at least 12 characters.</FormDescription><FormMessage /></FormItem>} />
        <FormField control={form.control} name="bootstrapToken" render={({ field }) => <FormItem className="field"><FormLabel>Setup token</FormLabel><FormControl><input {...field} className="input" type="password" autoComplete="off" data-testid="input-setup-token" /></FormControl><FormMessage /></FormItem>} />
        <button className="button button-primary auth-submit" type="submit" disabled={setup.isPending} data-testid="button-setup-submit"><ShieldCheck size={14} />{setup.isPending ? 'Creating administrator…' : 'Create administrator'}</button>
        {setup.isPending && <p className="field-help" role="status" data-testid="status-setup-pending">Creating the initial administrator…</p>}
      </form></Form>
    </>}
  </AuthFrame>;
}
type GeneratedCredential = {
  userId: string;
  username: string;
  password: string;
  action: 'created' | 'reset';
  sessionsRevoked?: number;
};

function GeneratedCredentialCard({ credential, onDismiss }: { credential: GeneratedCredential; onDismiss: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(credential.password);
      setCopyState('copied');
      setRevealed(false);
    } catch {
      setCopyState('error');
      setRevealed(true);
    }
  };
  return <section className="generated-credential-card" aria-label="Generated account password" data-testid="status-generated-credential">
    <div className="generated-credential-header">
      <div>
        <strong>{credential.action === 'created' ? 'Account created' : 'Password reset'}</strong>
        <p><span>Username: <code>{credential.username}</code>.</span> This password is shown once. Copy it now and share it privately.{credential.sessionsRevoked !== undefined && ` ${credential.sessionsRevoked} active session${credential.sessionsRevoked === 1 ? '' : 's'} revoked.`}</p>
      </div>
      <button type="button" className="generated-credential-dismiss" onClick={onDismiss} aria-label="Dismiss generated password" data-testid="button-dismiss-generated-password"><X size={15} /></button>
    </div>
    <div className="generated-credential-controls">
      <div className="password-input-wrap generated-password-field">
        <input
          className="input"
          type={revealed ? 'text' : 'password'}
          value={credential.password}
          readOnly
          autoComplete="off"
          aria-label={`Generated password for ${credential.username}`}
          data-testid="input-generated-password"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="password-visibility-toggle" onClick={() => { setRevealed((current) => !current); setCopyState('idle'); }} aria-label={revealed ? 'Hide generated password' : 'Show generated password'} aria-pressed={revealed} data-testid="button-toggle-generated-password">
          {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <button type="button" className="button button-secondary button-sm generated-password-copy" onClick={() => void copyPassword()} data-testid="button-copy-generated-password">
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}{copyState === 'copied' ? 'Copied' : 'Copy password'}
      </button>
    </div>
    {copyState === 'error' && <p className="generated-credential-status error-text" role="alert" data-testid="status-copy-generated-password-error">Clipboard access failed. The password is revealed so you can select and copy it manually.</p>}
    {copyState === 'copied' && <p className="generated-credential-status" role="status" data-testid="status-generated-password-copied">Password copied. Close this message when you have shared it.</p>}
  </section>;
}

function AdminUsersPage() {
  const client = useQueryClient();
  const { data: users, isLoading, isError, error, refetch } = useListAdminUsers();
  const createUser = useCreateAdminUser({ mutation: { gcTime: 0 } });
  const resetPassword = useResetUserPassword({ mutation: { gcTime: 0 } });
  const deleteUser = useDeleteAdminUser();
  const [createError, setCreateError] = useState('');
  const [actionError, setActionError] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [generatedCredential, setGeneratedCredential] = useState<GeneratedCredential | null>(null);
  const [notice, setNotice] = useState('');
  const createForm = useForm<z.infer<typeof adminUserSchema>>({
    resolver: zodResolver(adminUserSchema),
    defaultValues: { username: '' },
  });
  const refreshUsers = () => void client.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
  const submitCreate = createForm.handleSubmit(async (values) => {
    setCreateError('');
    try {
      const created = await createUser.mutateAsync({ data: { username: values.username } });
      createForm.reset();
      refreshUsers();
      setGeneratedCredential({ userId: created.id, username: created.username, password: created.generatedPassword, action: 'created' });
    } catch (err) {
      setCreateError(errorText(err));
    } finally {
      createUser.reset();
    }
  });
  const submitReset = async () => {
    if (!resetTarget) return;
    const target = resetTarget;
    setActionError('');
    try {
      const result = await resetPassword.mutateAsync({ id: target.id });
      refreshUsers();
      setResetTarget(null);
      setGeneratedCredential({
        userId: target.id,
        username: target.username,
        password: result.generatedPassword,
        action: 'reset',
        sessionsRevoked: result.sessionsRevoked,
      });
    } catch (err) {
      setActionError(errorText(err));
    } finally {
      resetPassword.reset();
    }
  };
  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    deleteUser.mutate({ id: deleteTarget.id }, {
      onSuccess: () => {
        refreshUsers();
        setDeleteTarget(null);
        if (generatedCredential?.userId === target.id) setGeneratedCredential(null);
        setNotice('Account and workspace permanently deleted.');
      },
      onError: (err) => setActionError(errorText(err)),
    });
  };
  return <WorkspacePage title="Account management"><main className="page-wrap admin-users-page">
    <PageTitle kicker="Administration · Access" title="Account management" subtitle="Create private workspaces and control who can access them." />
    <section className="panel admin-create-panel"><div className="admin-section-heading"><div><div className="kicker">New workspace account</div><h2>Create an account</h2><p>Each account receives isolated recipients, iCloud settings, invitation sends, and activity.</p></div><span className="stat-icon"><UserPlus size={17} /></span></div>
      {createError && <div className="notice error admin-inline-error" role="alert" data-testid="status-create-account-error">{createError}</div>}
      <Form {...createForm}><form className="admin-create-form" onSubmit={submitCreate} data-testid="form-create-account">
        <FormField control={createForm.control} name="username" render={({ field }) => <FormItem className="field"><FormLabel>Username</FormLabel><FormControl><input {...field} className="input" autoComplete="off" placeholder="e.g. event-coordinator" data-testid="input-create-account-username" /></FormControl><FormMessage /></FormItem>} />
        <button className="button button-primary" type="submit" disabled={createUser.isPending} data-testid="button-create-account"><Plus size={14} />{createUser.isPending ? 'Creating…' : 'Create account'}</button>
        {createUser.isPending && <span className="field-help" role="status" data-testid="status-create-account-pending">Creating isolated workspace…</span>}
      </form></Form>
      <div className="field-help admin-help">A random password is generated and shown once with a Copy button. If it is lost, reset the account to generate a replacement.</div>
    </section>
    {generatedCredential && <GeneratedCredentialCard credential={generatedCredential} onDismiss={() => setGeneratedCredential(null)} />}
    <section className="admin-list-section">
      <div className="admin-list-heading"><div><div className="kicker">Access directory</div><h2>Workspace accounts <span className="count-mark" data-testid="status-account-count">{users?.length ?? 0}</span></h2></div><button className="button button-secondary button-sm" onClick={() => void refetch()} data-testid="button-refresh-admin-users"><RefreshCw size={13} /> Refresh</button></div>
      {notice && <div className="notice success admin-notice" role="status" data-testid="status-admin-success">{notice}<button className="notice-dismiss" onClick={() => setNotice('')} aria-label="Dismiss notice" data-testid="button-dismiss-admin-success"><X size={14} /></button></div>}
      {actionError && <div className="notice error admin-inline-error" role="alert" data-testid="status-admin-action-error">{actionError}<button className="notice-dismiss" onClick={() => setActionError('')} aria-label="Dismiss error" data-testid="button-dismiss-admin-error"><X size={14} /></button></div>}
      {isLoading ? <LoadingPanel /> : isError ? <ErrorPanel message={errorText(error)} retry={() => void refetch()} /> : users?.length ? <section className="panel"><div className="table-wrap"><table className="data-table admin-users-table"><thead><tr><th>Account</th><th>Created</th><th>Last sign-in</th><th>Actions</th></tr></thead><tbody>{users.map((user) => <tr key={user.id} data-testid={`admin-user-${user.id}`}><td><span className="admin-user-cell"><span className="user-initial">{user.username.slice(0, 1).toUpperCase()}</span><strong>{user.username}</strong></span></td><td className="mono">{dateText(user.createdAt)}</td><td className="mono">{dateText(user.lastLoginAt)}</td><td><div className="section-actions admin-row-actions"><button className="button button-secondary button-sm" onClick={() => { setResetTarget(user); setActionError(''); }} data-testid={`button-reset-password-${user.id}`}><KeyRound size={12} /> Reset password</button><button className="button button-danger button-sm" onClick={() => { setDeleteTarget(user); setActionError(''); }} data-testid={`button-delete-account-${user.id}`}><Trash2 size={12} /> Delete</button></div></td></tr>)}</tbody></table></div></section> : <section className="panel"><EmptyState icon={Users} title="No user accounts yet" detail="Create an account above to give someone a private invitation workspace." /></section>}
    </section>
    {resetTarget && <div className="modal-backdrop"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-account-title"><div className="kicker">Account security</div><h2 id="reset-account-title">Generate a new password for {resetTarget.username}?</h2><p>This replaces the current password and revokes active sessions. The new password will appear once with a Copy button; it cannot be retrieved later.</p>{actionError && <div className="notice error admin-inline-error" role="alert" data-testid="status-reset-password-error">{actionError}</div>}<div className="modal-actions"><button type="button" className="button button-secondary" onClick={() => { setResetTarget(null); setActionError(''); }} data-testid="button-cancel-reset-password">Cancel</button><button className="button button-primary" type="button" onClick={() => void submitReset()} disabled={resetPassword.isPending} data-testid="button-submit-reset-password">{resetPassword.isPending ? 'Generating…' : 'Generate and reset'}</button></div>{resetPassword.isPending && <p className="field-help" role="status" data-testid="status-reset-password-pending">Generating a password and revoking sessions…</p>}</div></div>}
    {deleteTarget && <ConfirmModal title={`Permanently delete ${deleteTarget.username}?`} description="This permanently removes the account and all of its workspace data, including recipients, iCloud settings, invitation sends, and activity. This action cannot be undone." cancel={() => { setDeleteTarget(null); setActionError(''); }} confirm={confirmDelete} pending={deleteUser.isPending} destructive testId="confirm-delete-user" cancelTestId="button-cancel-delete-user" />}
  </main></WorkspacePage>;
}
function clearUserQueries(client: ReturnType<typeof useQueryClient>) {
  client.removeQueries({ predicate: (query) => query.queryKey[0] !== getGetAuthStatusQueryKey()[0] });
}
function AuthenticatedRoutes() {
  const { data: auth, isLoading, isError, error, refetch } = useGetAuthStatus({
    query: { queryKey: getGetAuthStatusQueryKey(), refetchInterval: 30_000, refetchOnWindowFocus: true },
  });
  const [location, setLocation] = useLocation();
  const client = useQueryClient();
  const previousUser = useRef<string | null>(null);
  useEffect(() => {
    const userId = auth?.user?.id ?? null;
    if (previousUser.current !== null && previousUser.current !== userId) clearUserQueries(client);
    previousUser.current = userId;
  }, [auth?.user?.id, client, previousUser]);
  let destination = '';
  if (auth) {
    if (auth.setupRequired && location !== '/setup') destination = '/setup';
    else if (!auth.setupRequired && location === '/setup') destination = auth.user ? '/dashboard' : '/login';
    else if (!auth.user && location !== '/login' && location !== '/setup') destination = auth.setupRequired ? '/setup' : '/login';
    else if (auth.user && location === '/login') destination = '/dashboard';
    else if (location === '/admin/users' && auth.user?.role !== 'admin') destination = '/dashboard';
  }
  useEffect(() => {
    if (destination) setLocation(destination);
  }, [destination, setLocation]);
  if (isLoading) return <div className="auth-loading"><LoadingPanel /></div>;
  if (isError || !auth) return <div className="auth-loading"><ErrorPanel message={errorText(error)} retry={() => void refetch()} /></div>;
  if (destination) {
    return <div className="auth-loading"><LoadingPanel /></div>;
  }
  return <Switch>
    <Route path="/login" component={LoginPage} />
    <Route path="/setup" component={SetupPage} />
    <Route path="/" component={DashboardPage} />
    <Route path="/dashboard" component={DashboardPage} />
    <Route path="/recipients" component={RecipientsPage} />
    <Route path="/event-settings" component={EventSettingsPage} />
    <Route path="/settings" component={ICloudSettingsPage} />
    <Route path="/logs" component={LogsPage} />
    <Route path="/admin/users" component={AdminUsersPage} />
    <Route component={NotFound} />
  </Switch>;
}
function App() {
  return <WouterRouter base={basePath}><QueryClientProvider client={queryClient}><AuthenticatedRoutes /></QueryClientProvider></WouterRouter>;
}

export default App;