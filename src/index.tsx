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
  FaPlus,
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
  webconfig_custom_ip?: string;
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

interface Dongle {
  ip: string;
  subnet?: number;
  status: Status;
}

interface Discovery {
  dongles: Dongle[];
}

const discover = callable<[], Discovery>("discover");
const getStatus = callable<[ip: string], Status>("get_status");
const getConfig = callable<[ip: string], Config>("get_config");
const setConfig = callable<[ip: string, fields: Record<string, number | string>], unknown>(
  "set_config"
);
const getBonds = callable<[ip: string], Bonds>("get_bonds");
const renameBond = callable<[ip: string, addr: string, name: string], unknown>("rename_bond");
const forgetBond = callable<[ip: string, addr: string], unknown>("forget_bond");
const forgetAllBonds = callable<[ip: string], unknown>("forget_all_bonds");
const pairController = callable<[ip: string], unknown>("pair_controller");

// Poll cadence — match the web page's ~4s to stay gentle on lwIP's PCB pool.
const STATUS_POLL_MS = 4000;
// Re-run discovery less often than per-status — it probes several addresses.
const DISCOVERY_POLL_MS = 12000;

// Labels for the selectable subnets (webconfig_subnet 0-3).
const SUBNET_LABELS: Record<number, string> = {
  0: "10.55.55.x (default)",
  1: "172.31.55.x",
  2: "192.168.137.x",
  3: "Custom IP",
};

// A subnet index of 3 means the dongle is on a user-typed custom address.
const CUSTOM_SUBNET = 3;

// Decky may remount plugin content around QAM/modal interactions. Keep the
// chosen dongle outside React state too, so a remount does not silently fall
// back to the first-discovered dongle.
let rememberedSelectedIp: string | undefined;

function subnetDescr(d: Dongle): string {
  if (d.subnet != null && SUBNET_LABELS[d.subnet]) return SUBNET_LABELS[d.subnet];
  return d.ip; // custom / NCM-discovered address with no preset index
}

function StatusHeader({
  status,
  onRetry,
}: {
  status: Status | undefined;
  onRetry: () => void;
}) {
  if (!status) {
    return <PanelSectionRow>Loading…</PanelSectionRow>;
  }
  if (!status._reachable) {
    return (
      <>
        <PanelSectionRow>Can't reach the dongle.</PanelSectionRow>
        <PanelSectionRow>
          <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
            The dongle's network interface is always present, so this is usually
            the Steam Deck not having leased its address yet. Toggle the
            controller off and back on (or replug the dongle), then Retry.
          </span>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={onRetry}>
            Retry
          </ButtonItem>
        </PanelSectionRow>
      </>
    );
  }
  if (!status.connected) {
    return (
      <PanelSectionRow>Dongle reachable — no controller connected.</PanelSectionRow>
    );
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

function renamePrompt(ip: string, addr: string, current: string, onDone: () => void) {
  let value = current;
  showModal(
    <ConfirmModal
      strTitle="Rename controller"
      strDescription="Up to 15 characters."
      onOK={async () => {
        await renameBond(ip, addr, value.slice(0, 15));
        onDone();
      }}
    >
      <TextField defaultValue={current} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

function forgetPrompt(
  ip: string,
  addr: string,
  name: string,
  isLive: boolean,
  onDone: () => void
) {
  showModal(
    <ConfirmModal
      strTitle={`Forget ${name || addr}?`}
      strDescription={
        (isLive ? "This controller is connected and will disconnect immediately. " : "") +
        "It won't reconnect until you pair it again (hold Share + PS)."
      }
      strOKButtonText="Forget"
      onOK={async () => {
        await forgetBond(ip, addr);
        onDone();
      }}
    />
  );
}

// Editing a custom dongle IP. The firmware re-validates (must be a private IPv4)
// and the change only takes effect after replug, so we just POST what's typed.
function customIpPrompt(ip: string, current: string, onDone: () => void) {
  let value = current && current !== "0.0.0.0" ? current : "";
  showModal(
    <ConfirmModal
      strTitle="Custom dongle IP"
      strDescription="A private IPv4 address (e.g. 10.55.55.105). Takes effect after the dongle is replugged."
      onOK={async () => {
        const v = value.trim();
        if (v) {
          await setConfig(ip, { webconfig_subnet: CUSTOM_SUBNET, webconfig_custom_ip: v });
        }
        onDone();
      }}
    >
      <TextField defaultValue={value} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

// One dongle's panels: status, settings, network, bonds. Scoped to `ip`.
function DongleView({ ip, statusHint }: { ip: string; statusHint?: Status }) {
  const [status, setStatus] = useState<Status | undefined>(statusHint);
  const [config, setConfig_] = useState<Config>();
  const [bonds, setBonds] = useState<Bonds>();

  const refreshConfig = useCallback(() => getConfig(ip).then(setConfig_), [ip]);
  const refreshBonds = useCallback(() => getBonds(ip).then(setBonds), [ip]);

  // Poll live status for this dongle. When it flips from unreachable -> reachable,
  // (re)load config and bonds too: those only fetch on demand, so if the dongle
  // wasn't reachable at mount their sections would otherwise stay empty.
  useEffect(() => {
    let active = true;
    let wasReachable = false;
    const tick = async () => {
      const s = await getStatus(ip);
      if (!active) return;
      setStatus(s);
      if (s._reachable && !wasReachable) {
        refreshConfig();
        refreshBonds();
      }
      wasReachable = !!s._reachable;
    };
    tick();
    const id = setInterval(tick, STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [ip, refreshConfig, refreshBonds]);

  const retryAll = useCallback(async () => {
    const s = await getStatus(ip);
    setStatus(s);
    refreshConfig();
    refreshBonds();
  }, [ip, refreshConfig, refreshBonds]);

  // Persist a single config field and optimistically update local state.
  const updateField = useCallback(
    async (field: keyof Config, value: number) => {
      setConfig_((prev) => (prev ? { ...prev, [field]: value } : prev));
      await setConfig(ip, { [field]: value });
    },
    [ip]
  );

  return (
    <>
      <PanelSection title="Status">
        <StatusHeader status={status} onRetry={retryAll} />
        {status?._reachable && (
          <PanelSectionRow>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", opacity: 0.7, fontSize: "0.85em" }}>
              <FaNetworkWired />
              <span>
                {status._subnet != null && SUBNET_LABELS[status._subnet]
                  ? SUBNET_LABELS[status._subnet]
                  : status._ip}
              </span>
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
                { data: 3, label: SUBNET_LABELS[3] },
              ]}
              selectedOption={config.webconfig_subnet ?? 0}
              onChange={(o) =>
                o.data === CUSTOM_SUBNET
                  ? customIpPrompt(ip, config.webconfig_custom_ip ?? "", refreshConfig)
                  : updateField("webconfig_subnet", o.data)
              }
            />
          </PanelSectionRow>
          {config.webconfig_subnet === CUSTOM_SUBNET && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                label="Custom IP"
                onClick={() =>
                  customIpPrompt(ip, config.webconfig_custom_ip ?? "", refreshConfig)
                }
              >
                {config.webconfig_custom_ip && config.webconfig_custom_ip !== "0.0.0.0"
                  ? config.webconfig_custom_ip
                  : "Set address…"}
              </ButtonItem>
            </PanelSectionRow>
          )}
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
                        onOK={() => renamePrompt(ip, b.addr, b.name, refreshBonds)}
                        onMiddleButton={() =>
                          forgetPrompt(ip, b.addr, b.name, isLive, refreshBonds)
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
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() =>
                showModal(
                  <ConfirmModal
                    strTitle="Pair a new controller"
                    strDescription="Put the controller into pairing mode (hold Share + PS until the light bar flashes), then confirm. This opens a 30-second pairing window and briefly disconnects any controller that's currently connected (it stays paired and reconnects afterward)."
                    strOKButtonText="Start pairing"
                    onOK={async () => {
                      // Fire-and-forget: the NCM link blips as the current
                      // controller drops, so don't block on it. Refresh bonds a
                      // moment later once the new controller has had a chance to
                      // connect.
                      pairController(ip);
                      setTimeout(refreshBonds, 6000);
                    }}
                  />
                )
              }
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <FaPlus />
                <span>Pair new controller</span>
              </div>
            </ButtonItem>
          </PanelSectionRow>
          {(bonds.bonds ?? []).length > 0 && (
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() =>
                  showModal(
                    <ConfirmModal
                      strTitle="Forget all controllers?"
                      strDescription="Forgets every paired controller. None will reconnect until paired again (hold Share + PS), and the connected one disconnects immediately."
                      strOKButtonText="Forget all"
                      onOK={async () => {
                        await forgetAllBonds(ip);
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

function Content() {
  const [dongles, setDongles] = useState<Dongle[]>();
  const [selectedIp, setSelectedIp] = useState<string | undefined>(
    () => rememberedSelectedIp
  );

  const runDiscovery = useCallback(async () => {
    const d = await discover();
    setDongles(d.dongles);
    setSelectedIp((prev) => {
      const preferred = prev ?? rememberedSelectedIp;
      // Keep the current selection if it's still present; otherwise default to
      // the first discovered dongle.
      if (preferred && d.dongles.some((x) => x.ip === preferred)) return preferred;
      const fallback = d.dongles[0]?.ip;
      rememberedSelectedIp = fallback;
      return fallback;
    });
  }, []);

  const selectDongle = useCallback((ip: string) => {
    rememberedSelectedIp = ip;
    setSelectedIp(ip);
  }, []);

  useEffect(() => {
    runDiscovery();
    const id = setInterval(runDiscovery, DISCOVERY_POLL_MS);
    return () => clearInterval(id);
  }, [runDiscovery]);

  if (!dongles) {
    return (
      <PanelSection title="Status">
        <PanelSectionRow>Looking for the dongle…</PanelSectionRow>
      </PanelSection>
    );
  }

  if (dongles.length === 0) {
    return (
      <PanelSection title="Status">
        <PanelSectionRow>No dongle found.</PanelSectionRow>
        <PanelSectionRow>
          <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
            Make sure the dongle is plugged in. If it is, the Steam Deck may not
            have leased its address yet — toggle the controller off and back on
            (or replug the dongle), then Refresh.
          </span>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={runDiscovery}>
            Refresh
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const current = selectedIp ?? dongles[0].ip;

  return (
    <>
      {dongles.length > 1 && (
        <PanelSection title="Dongle">
          {dongles.map((d) => {
            const isSelected = d.ip === current;
            return (
              <PanelSectionRow key={d.ip}>
                <ButtonItem
                  layout="below"
                  label={subnetDescr(d)}
                  onClick={() => selectDongle(d.ip)}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                    }}
                  >
                    <span>{d.ip}</span>
                    <span style={{ opacity: 0.75 }}>
                      {isSelected
                        ? "Selected"
                        : d.status?.connected
                          ? "Controller connected"
                          : "Idle"}
                    </span>
                  </div>
                </ButtonItem>
              </PanelSectionRow>
            );
          })}
        </PanelSection>
      )}
      <DongleView
        key={current}
        ip={current}
        statusHint={dongles.find((d) => d.ip === current)?.status}
      />
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
