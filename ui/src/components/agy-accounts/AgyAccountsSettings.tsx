import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgyAccountLogin, AgyAccountSummary } from "@paperclipai/shared";
import { agyAccountsApi } from "@/api/agy-accounts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const LOGIN_POLL_MS = 2000;

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
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: key });

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
            <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
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
            </li>
          ))}
        </ul>
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
