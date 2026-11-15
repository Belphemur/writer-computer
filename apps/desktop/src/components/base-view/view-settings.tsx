import { useState } from "react";
import { optionValue, type ValueOption, type ViewOption } from "@/lib/bases/view-options";
import type { BaseView } from "@/lib/bases/types";
import type { ViewConfig } from "@/lib/bases/view-registry";
import { ExpressionInput } from "./expression-input";
import type { MenuContext } from "./menu-context";
import { PropertySelect, useVaultProperties } from "./property-select";
import { FIELD, ToolbarMenu } from "./toolbar-menu";

function OptionControl({
  option,
  view,
  ctx,
  config,
  vault,
}: {
  option: ValueOption;
  view: BaseView;
  ctx: MenuContext;
  config: ViewConfig;
  vault: ReturnType<typeof useVaultProperties>["properties"];
}) {
  const stored = optionValue(view, option);
  const label = option.displayName;
  const set = (v: unknown) => config.setOption(option.key, v);
  switch (option.type) {
    case "dropdown":
      return (
        <select
          aria-label={label}
          value={typeof stored === "string" ? stored : (option.default ?? "")}
          onChange={(e) => set(e.target.value)}
          className={FIELD}
        >
          {Object.entries(option.options).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      );
    case "toggle":
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={typeof stored === "boolean" ? stored : (option.default ?? false)}
          onChange={(e) => set(e.target.checked)}
        />
      );
    case "slider":
      return (
        <SliderControl
          option={option}
          value={typeof stored === "number" ? stored : (option.default ?? option.min)}
          onCommit={set}
        />
      );
    case "property":
      return (
        <PropertySelect
          label={label}
          value={typeof stored === "string" ? stored : ""}
          none={option.placeholder ?? "None"}
          document={ctx.document}
          vault={vault}
          onChange={(id) => set(id === "" ? undefined : id)}
        />
      );
    case "formula":
      return (
        <FormulaControl
          label={label}
          value={typeof stored === "string" ? stored : ""}
          placeholder={option.default !== undefined ? String(option.default) : option.placeholder}
          formulas={ctx.document.formulas}
          vault={vault}
          onCommit={(text) => set(text === "" ? undefined : text)}
        />
      );
    case "multitext":
      return (
        <TextControl
          label={label}
          multiline
          value={Array.isArray(stored) ? stored.join("\n") : ""}
          placeholder="One value per line"
          onCommit={(text) => {
            const items = text
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            set(items.length === 0 ? undefined : items);
          }}
        />
      );
    default:
      return (
        <TextControl
          label={label}
          value={typeof stored === "string" ? stored : ""}
          placeholder={option.default !== undefined ? String(option.default) : option.placeholder}
          onCommit={(text) => set(text === "" ? undefined : text)}
        />
      );
  }
}

/** A formula-typed option: an expression field with completion, committed on blur or Enter. */
function FormulaControl({
  label,
  value,
  placeholder,
  formulas,
  vault,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  formulas: Record<string, string>;
  vault: ReturnType<typeof useVaultProperties>["properties"];
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <span className="w-48">
      <ExpressionInput
        label={label}
        value={draft}
        placeholder={placeholder}
        vault={vault}
        formulas={formulas}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </span>
  );
}

function SliderControl({
  option,
  value,
  onCommit,
}: {
  option: Extract<ValueOption, { type: "slider" }>;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => draft !== value && onCommit(draft);
  return (
    <span className="flex items-center gap-2">
      <input
        type="range"
        aria-label={option.displayName}
        min={option.min}
        max={option.max}
        step={option.step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="w-10 text-right text-[12px] tabular-nums text-text-muted">{draft}</span>
    </span>
  );
}

function TextControl({
  label,
  value,
  placeholder,
  multiline,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => draft !== value && onCommit(draft);
  const common = {
    "aria-label": label,
    value: draft,
    placeholder,
    onBlur: commit,
    className: `${FIELD} w-40`,
  };
  return multiline ? (
    <textarea rows={3} {...common} onChange={(e) => setDraft(e.target.value)} />
  ) : (
    <input
      {...common}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function SettingsBody({
  options,
  ctx,
  config,
}: {
  options: readonly ViewOption[];
  ctx: MenuContext;
  config: ViewConfig;
}) {
  const { properties: vault, error } = useVaultProperties();
  const render = (list: readonly ViewOption[]): React.ReactNode =>
    list.map((o, i) =>
      o.type === "group" ? (
        <fieldset key={`g${i}`} className="flex flex-col gap-2 rounded-md border border-border p-2">
          <legend className="px-1 text-[11px] text-text-muted">{o.displayName}</legend>
          {render(o.items)}
        </fieldset>
      ) : (
        <div
          key={o.key}
          data-view-option={o.key}
          className="flex items-center justify-between gap-2"
        >
          <span className="text-text-secondary">{o.displayName}</span>
          <OptionControl option={o} view={ctx.view} ctx={ctx} config={config} vault={vault} />
        </div>
      ),
    );
  return (
    <div className="flex flex-col gap-2.5">
      {error ? (
        <div role="alert" className="text-[12px] text-[var(--danger,#e5484d)]">
          {error}
        </div>
      ) : null}
      {options.length === 0 ? (
        <div className="text-text-muted">This view has no settings</div>
      ) : null}
      {render(options)}
    </div>
  );
}

/** View-settings popover: the option controls of the selected view's type, persisted by `key`. */
export function ViewSettings({
  ctx,
  options,
  config,
}: {
  ctx: MenuContext;
  options: readonly ViewOption[];
  config: ViewConfig;
}) {
  return (
    <ToolbarMenu label="Settings">
      {() => <SettingsBody options={options} ctx={ctx} config={config} />}
    </ToolbarMenu>
  );
}
