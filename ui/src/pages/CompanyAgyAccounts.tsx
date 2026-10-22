import { useEffect } from "react";
import { UserRoundCog } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgyAccountsSettingsSection } from "../components/agy-accounts/AgyAccountsSettings";

export function CompanyAgyAccounts() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Antigravity accounts" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No organization selected. Select an organization from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <UserRoundCog className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Antigravity accounts</h1>
      </div>
      <AgyAccountsSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />
    </div>
  );
}
