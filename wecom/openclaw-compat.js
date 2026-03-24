import { basename, extname, join, parse, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFile, realpath, stat } from "node:fs/promises";

const sdkReady = import("openclaw/plugin-sdk/media-runtime")
  .then((sdk) => ({
    detectMime: typeof sdk.detectMime === "function" ? sdk.detectMime.bind(sdk) : undefined,
    getDefaultMediaLocalRoots:
      typeof sdk.getDefaultMediaLocalRoots === "function" ? sdk.getDefaultMediaLocalRoots.bind(sdk) : undefined,
  }))
  .catch(() => ({}));

const MIME_BY_EXT = {
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".avi": "video/x-msvideo",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/x-m4a",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".7z": "application/x-7z-compressed",
};

function resolveUserPath(value) {
  if (!value.startsWith("~")) {
    return value;
  }
  return join(homedir(), value.slice(1));
}

function normalizeRootEntry(entry) {
  const value = String(entry ?? "").trim();
  if (!value) {
    return null;
  }
  return resolve(resolveUserPath(value));
}

function normalizeMediaReference(mediaUrl) {
  let value = String(mediaUrl ?? "").trim();
  if (!value) {
    return "";
  }
  value = value.replace(/^\s*(?:MEDIA|FILE)\s*:\s*/i, "");
  if (value.startsWith("sandbox:")) {
    value = value.replace(/^sandbox:\/{0,2}/, "");
    if (!value.startsWith("/")) {
      value = `/${value}`;
    }
  }
  return value;
}

function resolveStateDir() {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolve(resolveUserPath(override));
  }
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return join(tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return join(homedir(), ".openclaw");
}

async function sniffMimeFromBuffer(buffer) {
  try {
    const { fileTypeFromBuffer } = await import("file-type");
    const type = await fileTypeFromBuffer(buffer);
    return type?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

async function detectMimeFallback(options) {
  const ext = options.filePath ? extname(options.filePath).toLowerCase() : "";
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;
  const sniffed = options.buffer ? await sniffMimeFromBuffer(options.buffer) : undefined;
  const headerMime = options.headerMime?.split(";")?.[0]?.trim().toLowerCase();
  const isGeneric = (value) => !value || value === "application/octet-stream" || value === "application/zip";

  if (sniffed && (!isGeneric(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  if (headerMime && !isGeneric(headerMime)) {
    return headerMime;
  }
  return sniffed || headerMime || undefined;
}

function hasExplicitMediaRoots(options = {}) {
  return Boolean(
    (Array.isArray(options.mediaLocalRoots) && options.mediaLocalRoots.length > 0) ||
      (Array.isArray(options.accountConfig?.mediaLocalRoots) && options.accountConfig.mediaLocalRoots.length > 0),
  );
}

function isLocalMediaAccessError(error) {
  const message = String(error?.message ?? error ?? "");
  return /Local media path is not under an allowed directory|LocalMediaAccessError/i.test(message);
}

function shouldFallbackFromLocalAccessError(error, options) {
  return isLocalMediaAccessError(error) && !hasExplicitMediaRoots(options);
}

function isPathInsideRoot(filePath, rootPath) {
  const normalizedRoot = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return filePath === rootPath || filePath.startsWith(normalizedRoot);
}

async function assertLocalPathAllowed(filePath, roots) {
  const canonicalFilePath = await realpath(filePath);

  for (const root of roots) {
    try {
      const canonicalRoot = await realpath(root);
      if (isPathInsideRoot(canonicalFilePath, canonicalRoot)) {
        return canonicalFilePath;
      }
    } catch {
      if (isPathInsideRoot(canonicalFilePath, root)) {
        return canonicalFilePath;
      }
    }
  }

  throw new Error(`LocalMediaAccessError: path is not under an allowed directory: ${filePath}`);
}

async function readLocalMediaFile(filePath, { maxBytes } = {}) {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Local media path is not a file: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`Local media exceeds max size (${buffer.length} > ${maxBytes})`);
  }
  return {
    buffer,
    contentType: (await detectMimeFallback({ buffer, filePath })) || "",
    fileName: basename(filePath) || "file",
  };
}

async function fetchRemoteMedia(url, { maxBytes, fetchImpl } = {}) {
  const response = await (fetchImpl ?? fetch)(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to download media: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (maxBytes && buffer.length > maxBytes) {
    throw new Error(`Media from ${url} exceeds max size (${buffer.length} > ${maxBytes})`);
  }
  const disposition = response.headers.get("content-disposition");
  let fileName = "";
  if (disposition) {
    const match = /filename\*?\s*=\s*(?:UTF-8''|")?([^";]+)/i.exec(disposition);
    if (match?.[1]) {
      try {
        fileName = basename(decodeURIComponent(match[1].replace(/["']/g, "").trim()));
      } catch {
        fileName = basename(match[1].replace(/["']/g, "").trim());
      }
    }
  }
  if (!fileName) {
    try {
      fileName = basename(new URL(url).pathname) || "file";
    } catch {
      fileName = "file";
    }
  }
  const headerMime = response.headers.get("content-type") || "";
  return {
    buffer,
    contentType: (await detectMimeFallback({ buffer, headerMime, filePath: fileName || url })) || headerMime || "",
    fileName,
  };
}

function asLocalPath(mediaRef) {
  if (!mediaRef) {
    return "";
  }
  if (mediaRef.startsWith("file://")) {
    return fileURLToPath(mediaRef);
  }
  if (mediaRef.startsWith("/") || mediaRef.startsWith("~")) {
    return resolve(resolveUserPath(mediaRef));
  }
  return "";
}

export async function detectMime(bufferOrOptions) {
  const sdk = await sdkReady;
  const options = Buffer.isBuffer(bufferOrOptions) ? { buffer: bufferOrOptions } : bufferOrOptions;
  if (sdk.detectMime) {
    try {
      return await sdk.detectMime(options);
    } catch {}
  }
  return detectMimeFallback(options);
}

export async function getDefaultMediaLocalRoots() {
  const sdk = await sdkReady;
  if (sdk.getDefaultMediaLocalRoots) {
    try {
      return await sdk.getDefaultMediaLocalRoots();
    } catch {}
  }

  const stateDir = resolveStateDir();
  return [
    join(stateDir, "media"),
    join(stateDir, "agents"),
    join(stateDir, "workspace"),
    join(stateDir, "sandboxes"),
  ];
}

export async function getExtendedMediaLocalRoots({
  accountConfig,
  mediaLocalRoots,
  includeDefaultMediaLocalRoots = true,
} = {}) {
  const defaults = includeDefaultMediaLocalRoots ? await getDefaultMediaLocalRoots() : [];
  const roots = [
    ...defaults,
    ...(Array.isArray(accountConfig?.mediaLocalRoots) ? accountConfig.mediaLocalRoots : []),
    ...(Array.isArray(mediaLocalRoots) ? mediaLocalRoots : []),
  ]
    .map(normalizeRootEntry)
    .filter(Boolean);

  return [...new Set(roots)];
}

export async function loadOutboundMediaFromUrl(mediaUrl, options = {}) {
  const normalized = normalizeMediaReference(mediaUrl);
  const filePath = asLocalPath(normalized);
  const localRoots = await getExtendedMediaLocalRoots(options);
  const enforceLocalRoots = options.includeDefaultMediaLocalRoots === false || hasExplicitMediaRoots(options);

  if (filePath) {
    const allowedFilePath = enforceLocalRoots ? await assertLocalPathAllowed(filePath, localRoots) : filePath;

    if (typeof options.runtimeLoadMedia === "function" && localRoots.length > 0) {
      try {
        const loaded = await options.runtimeLoadMedia(allowedFilePath, { localRoots });
        return {
          buffer: loaded.buffer,
          contentType: loaded.contentType || "",
          fileName: loaded.fileName || basename(allowedFilePath) || "file",
        };
      } catch (error) {
        if (!shouldFallbackFromLocalAccessError(error, options)) {
          throw error;
        }
      }
    }

    return readLocalMediaFile(allowedFilePath, options);
  }

  return fetchRemoteMedia(normalized, options);
}

export { resolveStateDir };

export const openclawCompatTesting = {
  normalizeMediaReference,
};
