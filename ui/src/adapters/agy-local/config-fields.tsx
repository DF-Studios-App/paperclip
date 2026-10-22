import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftTextarea,
  ToggleField,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the Antigravity CLI prompt at runtime.";

const accountsHint =
  "One AGY account per line, in priority order: an id for the default sign-in, or id=/absolute/home for an account signed in with HOME=/absolute/home agy. When an account runs out of quota, the run moves to the next account. Linux hosts (Docker) only.";

function formatAgyAccounts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id : "";
        const home = typeof record.home === "string" ? record.home : "";
        return home ? `${id}=${home}` : id;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseAgyAccounts(text: string): string[] | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

export function AgyLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values!.instructionsFilePath ?? ""
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ instructionsFilePath: v })
                  : mark("adapterConfig", "instructionsFilePath", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="/absolute/path/to/AGENTS.md"
            />
            <ChoosePathButton />
          </div>
        </Field>
      )}
      <ToggleField
        label="Skip permissions"
        hint="Auto-approve AGY tool actions in unattended runs. This is dangerous; enable it only when intended."
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff("adapterConfig", "dangerouslySkipPermissions", config.dangerouslySkipPermissions === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      {!isCreate && (
        <Field label="AGY accounts" hint={accountsHint}>
          <DraftTextarea
            value={formatAgyAccounts(eff("adapterConfig", "accounts", config.accounts))}
            onCommit={(v) => mark("adapterConfig", "accounts", parseAgyAccounts(v))}
            immediate
            placeholder={"conta1\nconta2=/paperclip/agy-accounts/conta2\nconta3=/paperclip/agy-accounts/conta3"}
            minRows={3}
          />
        </Field>
      )}
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
