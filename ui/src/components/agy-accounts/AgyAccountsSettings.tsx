import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AgyAccountLogin,
  AgyAccountQuota,
  AgyAccountQuotaBucket,
  AgyAccountSummary,
} from "@paperclipai/shared";
import { agyAccountsApi } from "@/api/agy-accounts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const LOGIN_POLL_MS = 2000;
/** How often the page reads the limits again while it is open. */
const QUOTA_REFRESH_MS = 5 * 60_000;
const QUOTA_STALE_MS = 60_000;
/** A bucket at or below this share of its limit is drawn as nearly spent. */
const QUOTA_LOW_FRACTION = 0.1;

function isLoginActive(login: AgyAccountLogin | null | undefined): boolean {
  return login?.status === "starting" || login?.status === "waiting_for_code" || login?.status === "verifying";
}

function isOutOfQuota(account: AgyAccountSummary, now = Date.now()): boolean {
  return Boolean(account.exhaustedUntil && Date.parse(account.exhaustedUntil) > now);
}

function AccountStatus({ account }: { account: AgyAccountSummary }) {
  if (!account.signedIn) return <Badge variant="outline">Not signed in</Badge>;
  if (isOutOfQuota(account)) {
    return (
      <Badge variant="secondary">
        Out of quota until {new Date(account.exhaustedUntil!).toLocaleString()}
      </Badge>
    );
  }
  return <Badge variant="default">Ready</Badge>;
}

function QuotaBucketRow({ bucket }: { bucket: AgyAccountQuotaBucket }) {
  const fraction = bucket.remainingFraction;
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const nearlySpent = fraction !== null && fraction <= QUOTA_LOW_FRACTION;
  return (
    <div className={`flex items-center gap-3 text-xs ${bucket.disabled ? "text-muted-foreground" : ""}`}>
      <div className="min-w-0 w-40 shrink-0">
        <p className="truncate">{bucket.name}</p>
        {bucket.resetAt && (
          <p className="truncate text-muted-foreground">Resets {new Date(bucket.resetAt).toLocaleString()}</p>
        )}
      </div>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        {!bucket.disabled && percent !== null && (
          <div className={`h-full ${nearlySpent ? "bg-destructive" : "bg-primary"}`} style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="w-20 shrink-0 text-right tabular-nums">
        {bucket.disabled ? "Disabled" : percent === null ? "—" : `${percent}% left`}
      </span>
    </div>
  );
}

function AccountQuotaDetail({ quota, loading }: { quota: AgyAccountQuota | undefined; loading: boolean }) {
  if (!quota) return loading ? <p className="mt-2 text-xs text-muted-foreground">Checking usage…</p> : null;
  if (quota.status === "not_signed_in") return null;
  if (quota.status === "error") return <p className="mt-2 text-xs text-destructive">{quota.error}</p>;
  return (
    <div className="mt-3 space-y-3">
      {quota.groups.map((group) => (
        <div key={group.name} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{group.name}</p>
          {group.buckets.map((bucket) => (
            <QuotaBucketRow key={bucket.id} bucket={bucket} />
          ))}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Checked {new Date(quota.checkedAt).toLocaleTimeString()}</p>
    </div>
  );
}

function LoginPanel({
  login,
  code,
  onCodeChange,
  onSubmitCode,
  onCancel,
  submitting,
  error,
}: {
  login: AgyAccountLogin;
  code: string;
  onCodeChange: (value: string) => void;
  onSubmitCode: () => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const active = isLoginActive(login);
  return (
    <div className="space-y-3 rounded-md border border-border p-4" aria-live="polite">
      {login.status === "starting" && <p className="text-sm text-muted-foreground">Starting the AGY sign-in…</p>}
      {login.status === "waiting_for_code" && login.authorizationUrl && (
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            <p className="mb-2">Sign in with the Google account you want to add.</p>
            <Button asChild variant="outline">
              <a href={login.authorizationUrl} target="_blank" rel="noreferrer">
                Open Google sign-in
              </a>
            </Button>
          </li>
          <li>
            <p className="mb-2">Copy the authorization code that the Antigravity page shows, and paste it here.</p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmitCode();
              }}
            >
              <Input
                value={code}
                onChange={(event) => onCodeChange(event.target.value)}
                placeholder="Authorization code"
                aria-label="Authorization code"
                autoComplete="off"
                className="min-w-0 flex-1 font-mono"
              />
              <Button type="submit" disabled={!code.trim() || submitting}>
                {submitting ? "Sending…" : "Send code"}
              </Button>
            </form>
          </li>
        </ol>
      )}
      {login.status === "verifying" && <p className="text-sm text-muted-foreground">Checking the code with AGY…</p>}
      {login.status === "signed_in" && <p className="text-sm">The account is signed in. Agents can use it now.</p>}
      {login.status === "failed" && (
        <p role="alert" className="text-sm text-destructive">{login.error ?? "The AGY sign-in failed."}</p>
      )}
      {login.status === "cancelled" && <p className="text-sm text-muted-foreground">The sign-in was cancelled.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {active && (
        <Button variant="ghost" onClick={onCancel}>
          Cancel sign-in
        </Button>
      )}
    </div>
  );
}

export function AgyAccountsSettingsSection({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const key = ["agy-accounts", companyId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => agyAccountsApi.list(companyId),
    refetchInterval: (current) => (isLoginActive(current.state.data?.login) ? LOGIN_POLL_MS : false),
  });
  const quotaKey = ["agy-accounts-quota", companyId];
  const quotaQuery = useQuery({
    queryKey: quotaKey,
    queryFn: async () => {
      const quota = await agyAccountsApi.quota(companyId);
      // The read also updates each account's quota state, which the list shows.
      void client.invalidateQueries({ queryKey: key });
      return quota;
    },
    enabled: Boolean(query.data?.available) && (query.data?.accounts.length ?? 0) > 0,
    staleTime: QUOTA_STALE_MS,
    refetchInterval: QUOTA_REFRESH_MS,
    refetchOnWindowFocus: false,
  });
  const quotaByAccount = new Map((quotaQuery.data?.accounts ?? []).map((quota) => [quota.accountId, quota]));
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const refresh = () => {
    void client.invalidateQueries({ queryKey: key });
    void client.invalidateQueries({ queryKey: quotaKey });
  };

  const start = useMutation({
    mutationFn: () => agyAccountsApi.startLogin(companyId, label.trim() ? { label: label.trim() } : {}),
    onSuccess: () => {
      setLabel("");
      setCode("");
      void refresh();
    },
  });
  const submitCode = useMutation({
    mutationFn: (loginId: string) => agyAccountsApi.submitCode(companyId, loginId, code),
    onSuccess: () => {
      setCode("");
      void refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (loginId: string) => agyAccountsApi.cancelLogin(companyId, loginId),
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (accountId: string) => agyAccountsApi.remove(companyId, accountId),
    onSettled: () => void refresh(),
  });

  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading Antigravity accounts…</p>;
  if (query.error) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">Could not load Antigravity accounts.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>Try again</Button>
      </div>
    );
  }
  const data = query.data;
  const login = data.login;
  const loginActive = isLoginActive(login);
  const canAdd = data.available && data.canManage && !loginActive;

  return (
    <section className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Antigravity accounts</h2>
        <p className="text-sm text-muted-foreground">
          Agents that use the Antigravity CLI (agy) share these accounts. When one account runs out of quota, the run
          continues on the next account that has quota, in the order below.
        </p>
      </div>

      {!data.available && (
        <p role="status" className="text-sm text-muted-foreground">{data.unavailableReason}</p>
      )}

      {data.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Antigravity accounts are signed in yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {data.accounts.map((account) => (
            <li key={account.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{account.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {account.isDefault ? "Signed in on the Paperclip host" : account.id}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <AccountStatus account={account} />
                  {!account.isDefault && data.canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`Remove "${account.label}" and its Antigravity sign-in?`)) {
                          remove.mutate(account.id);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {account.signedIn && (
                <AccountQuotaDetail quota={quotaByAccount.get(account.id)} loading={quotaQuery.isFetching} />
              )}
            </li>
          ))}
        </ul>
      )}
      {quotaQuery.error && (
        <p role="alert" className="text-sm text-destructive">Could not read the account usage.</p>
      )}
      {quotaQuery.data && data.accounts.length > 0 && (
        <div>
          <Button variant="outline" size="sm" disabled={quotaQuery.isFetching} onClick={() => void quotaQuery.refetch()}>
            {quotaQuery.isFetching ? "Checking usage…" : "Refresh usage"}
          </Button>
        </div>
      )}
      {remove.error && <p role="alert" className="text-sm text-destructive">{remove.error.message}</p>}

      {login && data.canManage && (
        <LoginPanel
          login={login}
          code={code}
          onCodeChange={setCode}
          onSubmitCode={() => submitCode.mutate(login.id)}
          onCancel={() => cancel.mutate(login.id)}
          submitting={submitCode.isPending}
          error={submitCode.error?.message ?? cancel.error?.message ?? null}
        />
      )}

      {data.canManage && data.available && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (canAdd) start.mutate();
          }}
        >
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Account name (optional)"
            aria-label="Account name"
            maxLength={80}
            className="min-w-0 flex-1"
            disabled={!canAdd}
          />
          <Button type="submit" disabled={!canAdd || start.isPending}>
            {start.isPending ? "Starting…" : "Add account"}
          </Button>
        </form>
      )}
      {start.error && <p role="alert" className="text-sm text-destructive">{start.error.message}</p>}
      {!data.canManage && (
        <p className="text-sm text-muted-foreground">You need the manage connections permission to add accounts.</p>
      )}
    </section>
  );
}
