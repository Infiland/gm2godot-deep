import { existsSync } from "node:fs";
import { join } from "node:path";
import { failedResult, skippedResult } from "./levels.ts";
import type { ValidationResult } from "./levels.ts";

/**
 * Level E presentation and export checks.
 *
 * These concerns cannot be verified on a headless host, so they are `skipped` with the reason that
 * stopped them. A successful headless boot is never evidence for any of them, and none of these
 * checks may ever be `passed` here.
 */

export const PRESENTATION_CHECK_IDS = {
  visual: "presentation-visual",
  audio: "presentation-audio",
  control: "presentation-control",
  export: "presentation-export",
} as const;

export const NO_RENDERER_REASON = "no renderer in headless verification";
export const NO_AUDIO_DEVICE_REASON = "no audio device";
export const NO_EXPORT_TEMPLATE_REASON = "no export template installed";

export interface PresentationDeps {
  readonly projectPath: string;
  readonly godotBinary: string | null;
  readonly hasAudioDevice: boolean;
  readonly exportTemplateInstalled: boolean;
  readonly inputRevision: string;
}

export function checkPresentation(deps: PresentationDeps): readonly ValidationResult[] {
  const base = { level: "E" as const, inputRevision: deps.inputRevision };
  const visual = {
    ...base,
    checkId: PRESENTATION_CHECK_IDS.visual,
    name: "level E presentation (visual) — never derived from a successful headless boot",
  };
  const audio = {
    ...base,
    checkId: PRESENTATION_CHECK_IDS.audio,
    name: "level E presentation (audio) — never derived from a successful headless boot",
  };
  const control = {
    ...base,
    checkId: PRESENTATION_CHECK_IDS.control,
    name: "level E presentation (control input) — never derived from a successful headless boot",
  };
  const exportCheck = {
    ...base,
    checkId: PRESENTATION_CHECK_IDS.export,
    name: "level E export — never derived from a successful headless boot",
  };

  if (!existsSync(join(deps.projectPath, "project.godot"))) {
    const reason = `godot project not found at ${deps.projectPath}; there is nothing to inspect`;
    return [
      failedResult({ ...visual, reason }),
      failedResult({ ...audio, reason }),
      failedResult({ ...control, reason }),
      failedResult({ ...exportCheck, reason }),
    ];
  }

  const rendererReason =
    deps.godotBinary === null
      ? `${NO_RENDERER_REASON} (and no godot binary is configured)`
      : NO_RENDERER_REASON;

  return [
    skippedResult({ ...visual, reason: rendererReason }),
    skippedResult({
      ...audio,
      reason: deps.hasAudioDevice
        ? "an audio device is present but no audio-output verification is implemented"
        : NO_AUDIO_DEVICE_REASON,
    }),
    skippedResult({ ...control, reason: rendererReason }),
    skippedResult({
      ...exportCheck,
      reason: deps.exportTemplateInstalled
        ? "an export template is installed but no export verification is implemented"
        : NO_EXPORT_TEMPLATE_REASON,
    }),
  ];
}
