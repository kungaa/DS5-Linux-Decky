import {
  PanelSection,
  PanelSectionRow,
  SliderField,
  DropdownItem,
  ToggleField,
  ButtonItem,
  ConfirmModal,
  TextField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState, useCallback } from "react";
import {
  FaGamepad,
  FaBatteryFull,
  FaBatteryHalf,
  FaBatteryQuarter,
  FaNetworkWired,
} from "react-icons/fa";

// --- backend bindings (see main.py) ---------------------------------------

interface Status {
  _reachable: boolean;
  _ip?: string;
  _subnet?: number;
  connected?: boolean;
  model?: "DS5" | "DSE";
  battery_valid?: boolean;
  battery_pct?: number;
  charging?: boolean;
}

interface Config {
  _reachable: boolean;
  version?: string;
  inactive_time?: number;
  disable_inactive_disconnect?: number;
  disable_pico_led?: number;
  polling_rate_mode?: number;
  audio_buffer_length?: number;
  controller_mode?: number;
  webconfig_subnet?: number;
}

interface Bond {
  addr: string;
  name: string;
}

interface Bonds {
  _reachable: boolean;
  connected?: string;
  max?: number;
  bonds?: Bond[];
}

const getStatus = callable<[], Status>("get_status");
const getConfig = callable<[], Config>("get_config");
const setConfig = callable<[fields: Record<string, number>], unknown>("set_config");
const getBonds = callable<[], Bonds>("get_bonds");
const renameBond = callable<[addr: string, name: string], unknown>("rename_bond");
const forgetBond = callable<[addr: string], unknown>("forget_bond");
const forgetAllBonds = callable<[], unknown>("forget_all_bonds");

// Poll cadence — match the web page's ~4s to stay gentle on lwIP's PCB pool.
const STATUS_POLL_MS = 4000;

// Labels for the three selectable subnets (webconfig_subnet 0-2).
const SUBNET_LABELS: Record<number, string> = {
  0: "10.55.55.x (default)",
  1: "172.31.55.x",
  2: "192.168.137.x",
};

function StatusHeader({ status }: { status: Status | undefined }) {
  if (!status) {
    return <PanelSectionRow>Loading…</PanelSectionRow>;
  }
  if (!status._reachable) {
    return (
      <PanelSectionRow>
        No controller connected (dongle interface only exists while connected).
      </PanelSectionRow>
    );
  }
  if (!status.connected) {
    return <PanelSectionRow>Dongle reachable — waiting for controller.</PanelSectionRow>;
  }

  const pct = status.battery_pct ?? 0;
  const BatteryIcon = pct > 66 ? FaBatteryFull : pct > 33 ? FaBatteryHalf : FaBatteryQuarter;
  // battery_valid is false until the first input report — show "—" not "0%".
  const battText = status.battery_valid ? `${pct}%${status.charging ? " ⚡" : ""}` : "—";

  return (
    <>
      <PanelSectionRow>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <FaGamepad />
          <span>{status.model === "DSE" ? "DualSense Edge" : "DualSense"}</span>
        </div>
      </PanelSectionRow>
      <PanelSectionRow>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <BatteryIcon />
          <span>{battText}</span>
        </div>
      </PanelSectionRow>
    </>
  );
}

function renamePrompt(addr: string, current: string, onDone: () => void) {
  let value = current;
  showModal(
    <ConfirmModal
      strTitle="Rename controller"
      strDescription="Up to 15 characters."
      onOK={async () => {
        await renameBond(addr, value.slice(0, 15));
        onDone();
      }}
    >
      <TextField defaultValue={current} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

function forgetPrompt(addr: string, name: string, isLive: boolean, onDone: () => void) {
  showModal(
    <ConfirmModal
      strTitle={`Forget ${name || addr}?`}
      strDescription={
        (isLive ? "This controller is connected and will disconnect immediately. " : "") +
        "Its pairing is blacklisted (persists across power cycles). Re-pair with Share + PS."
      }
      strOKButtonText="Forget"
      onOK={async () => {
        await forgetBond(addr);
        onDone();
      }}
    />
  );
}

function Content() {
  const [status, setStatus] = useState<Status>();
  const [config, setConfig_] = useState<Config>();
  const [bonds, setBonds] = useState<Bonds>();

  // Poll live status.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      const s = await getStatus();
      if (active) setStatus(s);
    };
    tick();
    const id = setInterval(tick, STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const refreshConfig = useCallback(() => getConfig().then(setConfig_), []);
  const refreshBonds = useCallback(() => getBonds().then(setBonds), []);

  useEffect(() => {
    refreshConfig();
    refreshBonds();
  }, [refreshConfig, refreshBonds]);

  // Persist a single config field and optimistically update local state.
  const updateField = useCallback(async (field: keyof Config, value: number) => {
    setConfig_((prev) => (prev ? { ...prev, [field]: value } : prev));
    await setConfig({ [field]: value });
  }, []);

  return (
    <>
      <PanelSection title="Status">
        <StatusHeader status={status} />
        {status?._reachable && status._subnet != null && (
          <PanelSectionRow>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", opacity: 0.7, fontSize: "0.85em" }}>
              <FaNetworkWired />
              <span>Connected via {SUBNET_LABELS[status._subnet] ?? status._ip}</span>
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      {config?._reachable && (
        <PanelSection title="Settings">
          <PanelSectionRow>
            <DropdownItem
              label="Controller mode"
              menuLabel="Controller mode"
              rgOptions={[
                { data: 0, label: "DS5" },
                { data: 1, label: "DSE" },
                { data: 2, label: "Auto" },
              ]}
              selectedOption={config.controller_mode ?? 2}
              onChange={(o) => updateField("controller_mode", o.data)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <DropdownItem
              label="Polling rate"
              menuLabel="Polling rate"
              rgOptions={[
                { data: 0, label: "250 Hz" },
                { data: 1, label: "500 Hz" },
                { data: 2, label: "1000 Hz" },
              ]}
              selectedOption={config.polling_rate_mode ?? 2}
              onChange={(o) => updateField("polling_rate_mode", o.data)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              label="Audio buffer length"
              value={config.audio_buffer_length ?? 32}
              min={16}
              max={128}
              step={8}
              showValue
              onChange={(v) => updateField("audio_buffer_length", v)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <SliderField
              label="Idle disconnect (min)"
              value={config.inactive_time ?? 10}
              min={5}
              max={60}
              step={5}
              showValue
              disabled={config.disable_inactive_disconnect === 1}
              onChange={(v) => updateField("inactive_time", v)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Never idle-disconnect"
              checked={config.disable_inactive_disconnect === 1}
              onChange={(v) => updateField("disable_inactive_disconnect", v ? 1 : 0)}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Disable onboard LED"
              checked={config.disable_pico_led === 1}
              onChange={(v) => updateField("disable_pico_led", v ? 1 : 0)}
            />
          </PanelSectionRow>
        </PanelSection>
      )}

      {config?._reachable && (
        <PanelSection title="Network">
          <PanelSectionRow>
            <DropdownItem
              label="Web config subnet"
              menuLabel="Web config subnet"
              description="Changes the dongle's IP range. Takes effect after replug; the plugin re-discovers automatically."
              rgOptions={[
                { data: 0, label: SUBNET_LABELS[0] },
                { data: 1, label: SUBNET_LABELS[1] },
                { data: 2, label: SUBNET_LABELS[2] },
              ]}
              selectedOption={config.webconfig_subnet ?? 0}
              onChange={(o) => updateField("webconfig_subnet", o.data)}
            />
          </PanelSectionRow>
        </PanelSection>
      )}

      {bonds?._reachable && (
        <PanelSection title="Paired controllers">
          {(bonds.bonds ?? []).length === 0 && (
            <PanelSectionRow>No paired controllers.</PanelSectionRow>
          )}
          {(bonds.bonds ?? []).map((b) => {
            const isLive = b.addr === bonds.connected;
            return (
              <PanelSectionRow key={b.addr}>
                <ButtonItem
                  layout="below"
                  label={`${b.name || "(unnamed)"}${isLive ? " • connected" : ""}`}
                  onClick={() =>
                    showModal(
                      <ConfirmModal
                        strTitle={b.name || b.addr}
                        strOKButtonText="Rename"
                        strMiddleButtonText="Forget"
                        strCancelButtonText="Close"
                        onOK={() => renamePrompt(b.addr, b.name, refreshBonds)}
                        onMiddleButton={() =>
                          forgetPrompt(b.addr, b.name, isLive, refreshBonds)
                        }
                      />
                    )
                  }
                >
                  {b.addr}
                </ButtonItem>
              </PanelSectionRow>
            );
          })}
          {(bonds.bonds ?? []).length > 0 && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() =>
                  showModal(
                    <ConfirmModal
                      strTitle="Forget all controllers?"
                      strDescription="Blacklists every pairing (persists across power cycles). The connected controller disconnects immediately."
                      strOKButtonText="Forget all"
                      onOK={async () => {
                        await forgetAllBonds();
                        refreshBonds();
                      }}
                    />
                  )
                }
              >
                Forget all
              </ButtonItem>
            </PanelSectionRow>
          )}
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  console.log("DS5-Linux-Decky initializing");

  return {
    name: "DS5 Bridge",
    titleView: <div className={staticClasses.Title}>DS5 Bridge</div>,
    content: <Content />,
    icon: <FaGamepad />,
    onDismount() {
      console.log("DS5-Linux-Decky unloading");
    },
  };
});
