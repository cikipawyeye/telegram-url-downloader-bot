import net from 'node:net';
import { DownloadCancelledError } from './downloader.js';

export type ProxyEndpoint = {
  host: string;
  port: number;
};

/**
 * Parse the host/port of a proxy URL. Supports the schemes the downloader
 * accepts (`socks5://`, `socks5h://`, `http://`, `https://`) plus a bare
 * `host:port`. A proxy without an explicit port is skipped: guessing the port
 * would probe the wrong service and produce misleading status messages.
 */
export function parseProxyEndpoint(proxyUrl: string): ProxyEndpoint | undefined {
  let value = proxyUrl.trim();

  if (value === '') {
    return undefined;
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `socks5://${value}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }

  if (!/^(?:socks5h?|socks|http|https):$/i.test(parsed.protocol)) {
    return undefined;
  }

  const port = parsed.port === '' ? undefined : Number(parsed.port);
  if (port === undefined || !Number.isFinite(port) || port <= 0 || port > 65535) {
    return undefined;
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === '') {
    return undefined;
  }

  return { host, port };
}

/**
 * Wait until the local proxy accepts TCP connections again.
 *
 * Both SOCKS and HTTP proxies listen on a TCP port, so a plain connect is
 * enough to tell "WARP is restarting / systemd has not brought it back yet"
 * apart from "the remote site is unreachable". The probe is cheap and only runs
 * after a proxy-specific download failure, while the global download slot is
 * already released to other links.
 */
export async function waitForProxyReady(options: {
  proxyUrl: string;
  signal?: AbortSignal;
  /** Total time to wait; 0 skips the wait entirely. */
  timeoutMs: number;
  /** Pause between probes (default 2s). */
  intervalMs?: number;
  /** Per-probe connect timeout (default 3s). */
  probeTimeoutMs?: number;
  /** How often `onWait` is called while the proxy stays down (default 10s). */
  reportEveryMs?: number;
  onWait?: (elapsedMs: number, timeoutMs: number) => void;
}): Promise<boolean> {
  const endpoint = parseProxyEndpoint(options.proxyUrl);

  // Unknown/unprobeable proxy: treat it as ready so the caller falls back to the
  // normal retry/backoff path instead of waiting for nothing.
  if (endpoint === undefined) {
    return true;
  }

  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
  if (timeoutMs === 0) {
    return false;
  }

  const intervalMs = Math.max(50, Math.floor(options.intervalMs ?? 2000));
  const probeTimeoutMs = Math.max(100, Math.floor(options.probeTimeoutMs ?? 3000));
  const reportEveryMs = Math.max(1000, Math.floor(options.reportEveryMs ?? 10_000));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastReportAt = 0;

  for (;;) {
    throwIfAborted(options.signal);

    const now = Date.now();
    if (now >= deadline) {
      return false;
    }

    const probeTimeout = Math.max(1, Math.min(probeTimeoutMs, deadline - now));
    if (await probeProxy(endpoint, probeTimeout, options.signal)) {
      return true;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastReportAt >= reportEveryMs) {
      lastReportAt = elapsedMs;
      options.onWait?.(elapsedMs, timeoutMs);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    await sleep(Math.min(intervalMs, remainingMs), options.signal);
  }
}

/** One TCP connect attempt; never rejects for a normal connection failure. */
function probeProxy(endpoint: ProxyEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadCancelledError());
      return;
    }

    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };

    const settle = (ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      resolve(ready);
    };

    const onConnect = () => settle(true);
    const onError = () => settle(false);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      socket.destroy();
      reject(new DownloadCancelledError());
    };

    timer = setTimeout(() => settle(false), timeoutMs);

    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });

    // The signal may have aborted between the check above and the listener
    // registration; AbortSignal never replays the event.
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DownloadCancelledError());
      return;
    }

    let timer: NodeJS.Timeout | undefined;

    const onAbort = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new DownloadCancelledError());
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DownloadCancelledError();
  }
}
