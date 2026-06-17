import {
  PanelSection,
  PanelSectionRow,
  SliderField,
  DropdownItem,
  ToggleField,
  staticClasses,
} from "@decky/ui";
import { callable, definePlugin } from "@decky/api";
import { useEffect, useState, useCallback } from "react";
import { FaGamepad, FaBatteryFull, FaBatteryHalf, FaBatteryQuarter } from "react-icons/fa";

// --- backend bindings (see main.py) ---------------------------------------

interface Status {
  _reachable: boolean;
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

const getStatus = callable<[], Status>("get_status");
const getConfig = callable<[], Config>("get_config");
const setConfig = callable<[fields: Record<string, number>], unknown>("set_config");

// Poll cadence — match the web page's ~4s to stay gentle on lwIP's PCB pool.
const STATUS_POLL_MS = 4000;

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

function Content() {
  const [status, setStatus] = useState<Status>();
  const [config, setConfig_] = useState<Config>();

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

  // Load config once (it only changes when we change it).
  useEffect(() => {
    getConfig().then(setConfig_);
  }, []);

  // Persist a single field and optimistically update local state.
  const updateField = useCallback(
    async (field: keyof Config, value: number) => {
      setConfig_((prev) => (prev ? { ...prev, [field]: value } : prev));
      await setConfig({ [field]: value });
    },
    []
  );

  return (
    <>
      <PanelSection title="Status">
        <StatusHeader status={status} />
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
