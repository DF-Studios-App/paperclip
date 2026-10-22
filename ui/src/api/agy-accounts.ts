import type { AgyAccountLogin, AgyAccountsResponse, StartAgyAccountLogin } from "@paperclipai/shared";
import { api } from "./client";

export const agyAccountsApi = {
  list: (companyId: string) => api.get<AgyAccountsResponse>(`/companies/${companyId}/agy-accounts`),
  startLogin: (companyId: string, body: StartAgyAccountLogin) =>
    api.post<AgyAccountLogin>(`/companies/${companyId}/agy-accounts/logins`, body),
  getLogin: (companyId: string, loginId: string) =>
    api.get<AgyAccountLogin>(`/companies/${companyId}/agy-accounts/logins/${loginId}`),
  submitCode: (companyId: string, loginId: string, code: string) =>
    api.post<AgyAccountLogin>(`/companies/${companyId}/agy-accounts/logins/${loginId}/code`, { code }),
  cancelLogin: (companyId: string, loginId: string) =>
    api.delete<AgyAccountLogin>(`/companies/${companyId}/agy-accounts/logins/${loginId}`),
  remove: (companyId: string, accountId: string) =>
    api.delete<void>(`/companies/${companyId}/agy-accounts/${encodeURIComponent(accountId)}`),
};
