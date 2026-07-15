/**
 * Named `<uc-config>` attribute bundles the sandbox can apply via
 * `?scenario=<name>`. Keys are kebab-case (as they hit the DOM). Any
 * explicit URL param overrides the preset value; the preset overrides
 * the built-in defaults.
 */
export const PRESETS = Object.freeze({
  multipart: {
    "multipart-min-file-size": "5242880", // 5 MiB
    "multipart-chunk-size": "1048576", // 1 MiB
    "multiple": "true",
  },
  "image-crop": {
    "img-only": "true",
    "crop-preset": "1:1,4:3,16:9",
    "use-cloud-image-editor": "true",
  },
  "low-limits": {
    "multiple-max": "1",
    "max-local-file-size-bytes": "1048576", // 1 MiB
  },
  camera: {
    "source-list": "camera",
    "camera-modes": "photo,video",
    "camera-mirror": "true",
  },
  "url-only": {
    "source-list": "url",
    "multiple": "true",
  },
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/**
 * Apply a named preset to a forwarded-params map. Explicit `forwarded`
 * values always win over preset defaults. Unknown preset names are a
 * no-op.
 * @param {string|null|undefined} name
 * @param {Record<string, string>} forwarded
 * @returns {Record<string, string>}
 */
export function applyPreset(name, forwarded) {
  if (!name || !(name in PRESETS)) return forwarded;
  return { ...PRESETS[name], ...forwarded };
}
