// First-enable settings seed for Copilot (4.0.20, CURRENT_SETTINGS_VERSION 16). Written ONLY when
// the plugin id is `copilot` and data.json does not exist; an existing file is never touched.
// Without `settingsVersion` Copilot would run its legacy upgrade modals; `claudeCliPath` can only
// be set through `deviceProfiles[<device id>]` (the flat key is dropped on load).

export interface SeedArgs {
  pluginId: string;
  /** Does data.json already exist (non-empty)? */
  dataExists: () => Promise<boolean>;
  writeData: (json: string) => Promise<void>;
  /** `plugin_which('claude')`; null/empty omits the deviceProfiles entry. */
  claudePath: string | null | undefined;
  deviceId: string;
}

export function buildCopilotSeed(claudePath: string | null | undefined, deviceId: string): unknown {
  return {
    settingsVersion: 16,
    agentMode: {
      activeBackend: "claude",
      ...(claudePath ? { deviceProfiles: { [deviceId]: { claudeCliPath: claudePath } } } : {}),
      backends: {
        claude: { autoModePermission: "acceptEdits", enableThinking: false, autoMemory: false },
      },
      debugFullFrames: false,
      offerFeedbackCards: false,
      notificationSound: false,
    },
    enableMiyo: false,
    enableMiyoSearchSkill: false,
    enableSelfHostMode: false,
    autosaveChat: false,
    connectors: [],
    customConnectors: [],
    providers: {},
    configuredModels: [],
    backends: {},
  };
}

/** Returns true when the seed was written. */
export async function seedCopilotDataIfAbsent(args: SeedArgs): Promise<boolean> {
  if (args.pluginId !== "copilot") return false;
  if (await args.dataExists()) return false;
  await args.writeData(JSON.stringify(buildCopilotSeed(args.claudePath, args.deviceId)));
  return true;
}
