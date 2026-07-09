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
  FaPowerOff,
  FaWifi,
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
  // Gen A (WiFi) fields.
  hostname?: string;
  wol_target_mac?: string;
  wol_target_mac2?: string;
  wake_kbd_enabled?: number;
  wake_kbd_capable?: boolean;
  wol_capable?: boolean;
  wifi_capable?: boolean;
  // Gen B (USB-NCM) fields — absent on current firmware.
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

// "A" = WiFi firmware, "B" = USB-NCM firmware.
type Gen = "A" | "B";

interface Dongle {
  ip: string;
  subnet?: number;
  gen: Gen;
  status: Status;
  config?: Config;
}

interface Discovery {
  dongles: Dongle[];
  // Whether a full LAN sweep ran (vs. just the fast cached/mDNS/NCM tier).
  _deep?: boolean;
}

interface ResolveResult {
  _reachable: boolean;
  pending?: boolean;
  ok?: boolean;
  mac?: string;
}

const discover = callable<[deep?: boolean], Discovery>("discover");
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
const wolWake = callable<[ip: string, mac?: string], unknown>("wol_wake");
const resolveMacStart = callable<[ip: string, targetIp: string], unknown>("resolve_mac_start");
const resolveMacPoll = callable<[ip: string], ResolveResult>("resolve_mac_poll");
const wifiReset = callable<[ip: string], unknown>("wifi_reset");

// Poll cadence — match the web page's ~4s to stay gentle on lwIP's PCB pool.
const STATUS_POLL_MS = 4000;
// Re-run discovery less often than per-status — a LAN sweep probes many hosts.
const DISCOVERY_POLL_MS = 15000;

// Gen B: labels for the selectable NCM subnets (webconfig_subnet 0-3).
const SUBNET_LABELS: Record<number, string> = {
  0: "10.55.55.x (default)",
  1: "172.31.55.x",
  2: "192.168.137.x",
  3: "Custom IP",
};

// A subnet index of 3 means the dongle is on a user-typed custom NCM address.
const CUSTOM_SUBNET = 3;

const ZERO_MAC = "000000000000";

// Decky may remount plugin content around QAM/modal interactions. Keep the
// chosen dongle outside React state too, so a remount does not silently fall
// back to the first-discovered dongle.
let rememberedSelectedIp: string | undefined;

// A friendly label for a dongle in the picker: its mDNS hostname on Gen A, the
// NCM subnet on Gen B, else the raw IP.
function dongleLabel(d: Dongle): string {
  if (d.gen === "A" && d.config?.hostname) return `${d.config.hostname}.local`;
  if (d.subnet != null && SUBNET_LABELS[d.subnet]) return SUBNET_LABELS[d.subnet];
  return d.ip;
}

// Format 12 hex chars as AA:BB:CC:DD:EE:FF for display.
function formatMac(mac?: string): string {
  if (!mac || mac === ZERO_MAC) return "";
  return (mac.match(/.{1,2}/g) ?? []).join(":").toUpperCase();
}

// Normalize user MAC input to 12 uppercase hex chars, or "" if not 12 hex.
function normalizeMac(raw: string): string | null {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.length === 12 ? hex : null;
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
            The dongle may have taken a new address, or (on USB dongles) the Steam
            Deck hasn't leased its interface yet. Toggle the controller off and
            back on, or replug the dongle, then Retry.
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

// Gen A: editing the dongle's mDNS hostname. Firmware clamps to [a-z0-9-], <=10
// chars, and it takes effect after the dongle reboots / re-plugs itself.
function hostnamePrompt(ip: string, current: string, onDone: () => void) {
  let value = current;
  showModal(
    <ConfirmModal
      strTitle="Dongle name"
      strDescription="The dongle's mDNS name (its <name>.local). Lowercase letters, digits and hyphens, up to 10 characters. Takes effect after the dongle reboots."
      onOK={async () => {
        const v = value
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "")
          .slice(0, 10);
        if (v) {
          await setConfig(ip, { hostname: v });
        }
        onDone();
      }}
    >
      <TextField defaultValue={current} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

// Gen A: editing a WOL target MAC directly. `slot` is "wol_target_mac" or
// "wol_target_mac2". Blank clears the target (all-zero).
function wolMacPrompt(
  ip: string,
  slot: "wol_target_mac" | "wol_target_mac2",
  current: string,
  onDone: () => void
) {
  let value = formatMac(current);
  showModal(
    <ConfirmModal
      strTitle="Wake-on-LAN target"
      strDescription="The MAC address of the PC to wake (AA:BB:CC:DD:EE:FF). Leave blank to clear."
      onOK={async () => {
        const trimmed = value.trim();
        const mac = trimmed ? normalizeMac(trimmed) : ZERO_MAC;
        if (mac) {
          await setConfig(ip, { [slot]: mac });
        }
        onDone();
      }}
    >
      <TextField defaultValue={value} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

// Gen A: fill a WOL target MAC by ARP-resolving an IP. Two-step: POST to start,
// then poll the GET until it settles.
function resolveMacPrompt(
  ip: string,
  slot: "wol_target_mac" | "wol_target_mac2",
  onDone: () => void
) {
  let value = "";
  showModal(
    <ConfirmModal
      strTitle="Resolve MAC from IP"
      strDescription="Enter the PC's IP address on your network; the dongle will look up its MAC via ARP and store it as a wake target."
      strOKButtonText="Resolve"
      onOK={async () => {
        const target = value.trim();
        if (!target) return;
        await resolveMacStart(ip, target);
        // Poll up to ~5s for the ARP result.
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const res = await resolveMacPoll(ip);
          if (!res._reachable) break;
          if (res.pending) continue;
          if (res.ok && res.mac) {
            await setConfig(ip, { [slot]: res.mac });
          }
          break;
        }
        onDone();
      }}
    >
      <TextField defaultValue={value} onChange={(e) => (value = e.target.value)} />
    </ConfirmModal>
  );
}

// Gen B: editing a custom NCM dongle IP. The firmware re-validates (must be a
// private IPv4) and the change only takes effect after replug.
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

// The Settings panel: shared config fields (both generations) plus the Gen-A
// wake-keyboard toggle when the firmware supports it, plus a factory reset.
function SettingsPanel({
  ip,
  config,
  updateField,
  onReset,
}: {
  ip: string;
  config: Config;
  updateField: (field: keyof Config, value: number) => void;
  onReset: () => void;
}) {
  return (
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
      {config.wake_kbd_capable && (
        <PanelSectionRow>
          <ToggleField
            label="USB wake keyboard"
            description="Enumerate a USB keyboard the dongle can use to wake the host. Re-enumerates USB when changed."
            checked={config.wake_kbd_enabled === 1}
            onChange={(v) => updateField("wake_kbd_enabled", v ? 1 : 0)}
          />
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() =>
            showModal(
              <ConfirmModal
                strTitle="Factory reset settings?"
                strDescription="Resets all settings to defaults. Paired controllers are kept."
                strOKButtonText="Reset"
                onOK={async () => {
                  await setConfig(ip, { factory_reset: 1 });
                  onReset();
                }}
              />
            )
          }
        >
          Factory reset settings
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

// Gen A: Wake-on-LAN targets + a glanceable "Wake PC" button. Gated on
// wol_capable by the caller.
function WolPanel({
  ip,
  config,
  refreshConfig,
}: {
  ip: string;
  config: Config;
  refreshConfig: () => void;
}) {
  const mac1 = config.wol_target_mac ?? ZERO_MAC;
  const mac2 = config.wol_target_mac2 ?? ZERO_MAC;
  const haveTarget = mac1 !== ZERO_MAC || mac2 !== ZERO_MAC;

  const targetButton = (
    slot: "wol_target_mac" | "wol_target_mac2",
    mac: string,
    label: string
  ) => (
    <PanelSectionRow>
      <ButtonItem
        layout="below"
        label={label}
        onClick={() =>
          showModal(
            <ConfirmModal
              strTitle={label}
              strOKButtonText="Enter MAC"
              strMiddleButtonText="Resolve from IP"
              strCancelButtonText="Close"
              onOK={() => wolMacPrompt(ip, slot, mac, refreshConfig)}
              onMiddleButton={() => resolveMacPrompt(ip, slot, refreshConfig)}
            />
          )
        }
      >
        {formatMac(mac) || "Not set"}
      </ButtonItem>
    </PanelSectionRow>
  );

  return (
    <PanelSection title="Wake-on-LAN">
      {haveTarget && (
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => wolWake(ip)}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <FaPowerOff />
              <span>Wake PC</span>
            </div>
          </ButtonItem>
        </PanelSectionRow>
      )}
      {targetButton("wol_target_mac", mac1, "Target 1")}
      {targetButton("wol_target_mac2", mac2, "Target 2")}
    </PanelSection>
  );
}

// Gen A: dongle name (mDNS) + destructive WiFi reset. Gated on wifi_capable by
// the caller.
function NetworkPanelGenA({
  ip,
  config,
  refreshConfig,
}: {
  ip: string;
  config: Config;
  refreshConfig: () => void;
}) {
  return (
    <PanelSection title="Network">
      {config.hostname != null && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            label="Dongle name"
            onClick={() => hostnamePrompt(ip, config.hostname ?? "", refreshConfig)}
          >
            {config.hostname ? `${config.hostname}.local` : "Set name…"}
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          onClick={() =>
            showModal(
              <ConfirmModal
                strTitle="Reset WiFi?"
                strDescription="Clears the dongle's saved WiFi and reboots it into DS5-Setup onboarding mode. The dongle will drop off your network and you'll need to set it up again. This can't be undone from here."
                strOKButtonText="Reset WiFi"
                onOK={() => {
                  // Fire-and-forget: the dongle reboots as it acts.
                  wifiReset(ip);
                }}
              />
            )
          }
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <FaWifi />
            <span>Reset WiFi…</span>
          </div>
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

// Gen B: the legacy NCM subnet selector.
function NetworkPanelGenB({
  ip,
  config,
  refreshConfig,
  updateField,
}: {
  ip: string;
  config: Config;
  refreshConfig: () => void;
  updateField: (field: keyof Config, value: number) => void;
}) {
  return (
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
            onClick={() => customIpPrompt(ip, config.webconfig_custom_ip ?? "", refreshConfig)}
          >
            {config.webconfig_custom_ip && config.webconfig_custom_ip !== "0.0.0.0"
              ? config.webconfig_custom_ip
              : "Set address…"}
          </ButtonItem>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}

// Which generation a dongle's config represents. Gen A advertises capability
// flags; Gen B carries webconfig_subnet and none of the WiFi fields.
function genOf(config: Config | undefined): Gen {
  if (config?.wifi_capable || config?.wol_capable) return "A";
  if (config && "webconfig_subnet" in config && config.webconfig_subnet != null) return "B";
  return "A";
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

  const gen = genOf(config);

  return (
    <>
      <PanelSection title="Status">
        <StatusHeader status={status} onRetry={retryAll} />
        {status?._reachable && (
          <PanelSectionRow>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                opacity: 0.7,
                fontSize: "0.85em",
              }}
            >
              <FaNetworkWired />
              <span>
                {gen === "A" && config?.hostname
                  ? `${config.hostname}.local`
                  : status._subnet != null && SUBNET_LABELS[status._subnet]
                    ? SUBNET_LABELS[status._subnet]
                    : status._ip}
                {config?.version ? ` · ${config.version}` : ""}
              </span>
            </div>
          </PanelSectionRow>
        )}
      </PanelSection>

      {config?._reachable && (
        <SettingsPanel
          ip={ip}
          config={config}
          updateField={updateField}
          onReset={refreshConfig}
        />
      )}

      {config?._reachable && gen === "A" && config.wol_capable !== false && (
        <WolPanel ip={ip} config={config} refreshConfig={refreshConfig} />
      )}

      {config?._reachable && gen === "A" && config.wifi_capable !== false && (
        <NetworkPanelGenA ip={ip} config={config} refreshConfig={refreshConfig} />
      )}

      {config?._reachable && gen === "B" && (
        <NetworkPanelGenB
          ip={ip}
          config={config}
          refreshConfig={refreshConfig}
          updateField={updateField}
        />
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
                      // Fire-and-forget: on Gen B the NCM link blips as the
                      // current controller drops, so don't block on it. Refresh
                      // bonds a moment later once the new controller has had a
                      // chance to connect.
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

// Remember, across QAM remounts, that we've completed at least one full LAN
// sweep this session — so a remount doesn't flash "No dongle found" before the
// (cached-IP) fast pass even returns.
let sessionDidDeep = false;

function Content() {
  const [dongles, setDongles] = useState<Dongle[]>();
  const [selectedIp, setSelectedIp] = useState<string | undefined>(
    () => rememberedSelectedIp
  );
  // A discovery call is in flight (drives the "Searching…" UI + disables the
  // button so it's clear the press did something).
  const [searching, setSearching] = useState(false);
  // Whether a full LAN sweep has completed this session. Until it has, an empty
  // result means "still looking", not "nothing there".
  const [didDeep, setDidDeep] = useState(sessionDidDeep);

  const runDiscovery = useCallback(async (deep: boolean) => {
    setSearching(true);
    try {
      // The backend auto-escalates a fast pass to a deep sweep when it finds
      // nothing, so even deep=false may come back _deep=true.
      const d = await discover(deep);
      setDongles(d.dongles);
      if (d._deep) {
        sessionDidDeep = true;
        setDidDeep(true);
      }
      setSelectedIp((prev) => {
        const preferred = prev ?? rememberedSelectedIp;
        // Keep the current selection if it's still present; otherwise default to
        // the first discovered dongle.
        if (preferred && d.dongles.some((x) => x.ip === preferred)) return preferred;
        const fallback = d.dongles[0]?.ip;
        rememberedSelectedIp = fallback;
        return fallback;
      });
    } finally {
      setSearching(false);
    }
  }, []);

  const selectDongle = useCallback((ip: string) => {
    rememberedSelectedIp = ip;
    setSelectedIp(ip);
  }, []);

  useEffect(() => {
    // Fast pass on mount: hits the persisted cached IP instantly on re-opens.
    runDiscovery(false);
    // Periodic re-discovery stays fast (cheap tier only) so it doesn't sweep the
    // whole LAN every 15s; the explicit button is the way to force a deep scan.
    const id = setInterval(() => runDiscovery(false), DISCOVERY_POLL_MS);
    return () => clearInterval(id);
  }, [runDiscovery]);

  const found = dongles && dongles.length > 0;

  // Still looking: no dongle yet AND (a search is running, or we haven't yet
  // completed a full sweep). This keeps the search state visible instead of
  // prematurely declaring "not found" while the ~254-host sweep is still going.
  if (!found && (searching || !didDeep)) {
    return (
      <PanelSection title="Status">
        <PanelSectionRow>Searching for the dongle…</PanelSectionRow>
        <PanelSectionRow>
          <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
            Checking the last-known address and scanning your network. A full scan
            can take up to a minute the first time; once found, the address is
            remembered and re-opens are instant.
          </span>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  if (!found) {
    return (
      <PanelSection title="Status">
        <PanelSectionRow>No dongle found.</PanelSectionRow>
        <PanelSectionRow>
          <span style={{ fontSize: "0.85em", opacity: 0.8 }}>
            Make sure the dongle is powered on and on the same network as the
            Steam Deck (or plugged in, for USB dongles), then search again.
          </span>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={searching}
            onClick={() => runDiscovery(true)}
          >
            {searching ? "Searching…" : "Search again"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const found_ = dongles as Dongle[]; // narrowed: `found` guaranteed non-empty above
  const current = selectedIp ?? found_[0].ip;

  return (
    <>
      {found_.length > 1 && (
        <PanelSection title="Dongle">
          {found_.map((d) => {
            const isSelected = d.ip === current;
            return (
              <PanelSectionRow key={d.ip}>
                <ButtonItem
                  layout="below"
                  label={dongleLabel(d)}
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
        statusHint={found_.find((d) => d.ip === current)?.status}
      />
      <PanelSection title="Discovery">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={searching}
            onClick={() => runDiscovery(true)}
          >
            {searching ? "Scanning…" : "Scan for more dongles"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
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
