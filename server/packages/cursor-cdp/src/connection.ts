import { Mutex } from "async-mutex";
import CDPLib from "chrome-remote-interface";

import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { ConnectionState, CursorCdpConfig } from "./types.js";

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000];
const MAX_RECONNECT_ATTEMPTS = 3;

export namespace CDP {
  export type Client = import("chrome-remote-interface").Client;
  export type Target = import("chrome-remote-interface").Target;
}

const connectCDP = CDPLib as (options: {
  port: number;
  host: string;
  target?: string;
}) => Promise<CDP.Client>;

const LOCK_TIMEOUT_MS = 60_000;

type InFlightReject = (error: Error) => void;

interface CDPConnection {
  client: CDP.Client;
  port: number;
  connected: boolean;
  retryCount: number;
  reconnecting: boolean;
  unavailable: boolean;
  lastHealthCheck?: Date;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

function formatConnectionAddress(host: string, port: number): string {
  return `${host}:${port}`;
}

function formatConnectionError(host: string, port: number, cause: unknown): Error {
  const address = formatConnectionAddress(host, port);
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Failed to connect to CDP at ${address}: ${detail}`);
}

export class ConnectionManager {
  private readonly config: CursorCdpConfig;
  private readonly connections = new Map<number, CDPConnection>();
  private readonly portLocks = new Map<number, Mutex>();
  private readonly activeOperations = new Map<number, number>();
  private readonly inFlightRejects = new Map<number, Set<InFlightReject>>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: CursorCdpConfig) {
    this.config = config ?? loadConfig();
  }

  private resolvePort(port?: number): number {
    return port ?? this.config.default_port;
  }

  private getPortLock(port: number): Mutex {
    let lock = this.portLocks.get(port);
    if (!lock) {
      lock = new Mutex();
      this.portLocks.set(port, lock);
    }
    return lock;
  }

  async withLock<T>(fn: () => Promise<T>, port?: number): Promise<T> {
    const resolvedPort = this.resolvePort(port);
    const mutex = this.getPortLock(resolvedPort);
    let release: (() => void) | undefined;
    let acquired = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        mutex.acquire().then((releaser) => {
          if (timedOut) {
            releaser();
            return;
          }
          release = releaser;
          acquired = true;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(`Port ${resolvedPort} busy: lock acquisition timeout (60s)`),
            );
          }, LOCK_TIMEOUT_MS);
        }),
      ]);

      return await fn();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (acquired) release?.();
    }
  }

  async connect(port?: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    const existing = this.connections.get(resolvedPort);
    if (existing?.connected) {
      return;
    }

    if (existing) {
      this.clearReconnectTimer(existing);
      existing.reconnecting = false;
      if (existing.connected) {
        try {
          await existing.client.close();
        } catch {
          // 忽略 close 错误，继续建立新连接
        }
      }
    }

    const host = this.config.cdp_host;
    try {
      const client = await connectCDP({ port: resolvedPort, host });
      await client.Runtime.enable();
      try { await client.Target.enable(); } catch { /* Target domain optional */ }

      const connection: CDPConnection = {
        client,
        port: resolvedPort,
        connected: true,
        retryCount: 0,
        reconnecting: false,
        unavailable: false,
      };
      this.connections.set(resolvedPort, connection);
      this.setupDisconnectListener(resolvedPort);
      this.startHealthChecks();
      logger.info("cdp", "connected", { host, port: resolvedPort });
    } catch (error) {
      logger.error("cdp", "connect failed", {
        host,
        port: resolvedPort,
        error: error instanceof Error ? error.message : String(error),
      });
      throw formatConnectionError(host, resolvedPort, error);
    }
  }

  async disconnect(port?: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    const connection = this.connections.get(resolvedPort);
    if (!connection) {
      return;
    }

    this.clearReconnectTimer(connection);
    connection.reconnecting = false;
    this.rejectAllInFlightCalls(resolvedPort);

    try {
      await connection.client.close();
    } catch {
      // 断开时忽略 close 错误，确保 Map 状态被清理
    } finally {
      logger.info("cdp", "disconnected", { port: resolvedPort });
      this.connections.delete(resolvedPort);
      this.activeOperations.delete(resolvedPort);
      this.stopHealthChecksIfIdle();
    }
  }

  async shutdown(): Promise<void> {
    if (this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    const ports = [...this.connections.keys()];
    await Promise.all(ports.map((port) => this.disconnect(port)));
  }

  async getClient(port?: number): Promise<CDP.Client> {
    const resolvedPort = this.resolvePort(port);
    const connection = this.connections.get(resolvedPort);
    if (connection?.unavailable) {
      throw formatConnectionError(
        this.config.cdp_host,
        resolvedPort,
        `port marked unavailable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
      );
    }
    if (connection?.connected) {
      return connection.client;
    }

    await this.connect(resolvedPort);
    const connected = this.connections.get(resolvedPort);
    if (!connected?.connected) {
      throw formatConnectionError(
        this.config.cdp_host,
        resolvedPort,
        "connection unavailable after connect()",
      );
    }

    return connected.client;
  }

  getState(port?: number): ConnectionState {
    const resolvedPort = this.resolvePort(port);
    const connection = this.connections.get(resolvedPort);

    if (!connection?.connected) {
      return { connected: false, port: resolvedPort };
    }

    const state: ConnectionState = {
      connected: true,
      port: resolvedPort,
    };

    if (connection.lastHealthCheck !== undefined) {
      state.lastHealthCheck = connection.lastHealthCheck;
    }

    return state;
  }

  async evaluate(expression: string, port?: number): Promise<unknown> {
    const resolvedPort = this.resolvePort(port);
    return this.withInFlightTracking(resolvedPort, async () => {
      this.incrementActiveOperations(resolvedPort);
      try {
        const client = await this.getClient(port);
        const response = await (client.Runtime.evaluate as Function)({
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result: { value?: unknown }; exceptionDetails?: { text?: string } };
        if (response.exceptionDetails) {
          throw new Error(
            response.exceptionDetails.text ?? `CDP evaluate exception on port ${resolvedPort}`,
          );
        }
        return response.result.value;
      } finally {
        this.decrementActiveOperations(resolvedPort);
      }
    });
  }

  async getTargets(port?: number): Promise<CDP.Target[]> {
    const resolvedPort = this.resolvePort(port);
    return this.withInFlightTracking(resolvedPort, async () => {
      const client = await this.getClient(port);
      const { targetInfos } = await client.Target.getTargets();
      return targetInfos;
    });
  }

  async switchTarget(targetId: string, port?: number): Promise<void> {
    const resolvedPort = this.resolvePort(port);
    const existing = this.connections.get(resolvedPort);

    if (existing) {
      this.clearReconnectTimer(existing);
      existing.reconnecting = false;
      if (existing.connected) {
        try { await existing.client.close(); } catch { /* ignore */ }
      }
      this.connections.delete(resolvedPort);
    }

    const host = this.config.cdp_host;
    try {
      const client = await connectCDP({ port: resolvedPort, host, target: targetId });
      await client.Runtime.enable();
      try { await client.Target.enable(); } catch { /* optional */ }

      const connection: CDPConnection = {
        client,
        port: resolvedPort,
        connected: true,
        retryCount: 0,
        reconnecting: false,
        unavailable: false,
      };
      this.connections.set(resolvedPort, connection);
      this.setupDisconnectListener(resolvedPort);
      logger.info("cdp", "switched target", { host, port: resolvedPort, targetId });
    } catch (error) {
      logger.error("cdp", "switch target failed", {
        host, port: resolvedPort, targetId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw formatConnectionError(host, resolvedPort, error);
    }
  }

  private withInFlightTracking<T>(
    port: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const inFlightReject: InFlightReject = (error) => reject(error);
      this.addInFlightReject(port, inFlightReject);

      void operation()
        .then(resolve, reject)
        .finally(() => this.removeInFlightReject(port, inFlightReject));
    });
  }

  private addInFlightReject(port: number, reject: InFlightReject): void {
    let rejects = this.inFlightRejects.get(port);
    if (!rejects) {
      rejects = new Set();
      this.inFlightRejects.set(port, rejects);
    }
    rejects.add(reject);
  }

  private removeInFlightReject(port: number, reject: InFlightReject): void {
    const rejects = this.inFlightRejects.get(port);
    if (!rejects) {
      return;
    }
    rejects.delete(reject);
    if (rejects.size === 0) {
      this.inFlightRejects.delete(port);
    }
  }

  private rejectAllInFlightCalls(port: number): void {
    const rejects = this.inFlightRejects.get(port);
    if (!rejects) {
      return;
    }
    const error = new Error(`CDP connection lost on port ${port}`);
    for (const reject of rejects) {
      reject(error);
    }
    this.inFlightRejects.delete(port);
  }

  private clearReconnectTimer(connection: CDPConnection): void {
    if (connection.reconnectTimer !== undefined) {
      clearTimeout(connection.reconnectTimer);
      delete connection.reconnectTimer;
    }
  }

  private setupDisconnectListener(port: number): void {
    const connection = this.connections.get(port);
    if (!connection) {
      return;
    }

    connection.client.on("disconnect", () => {
      void this.handleDisconnect(port);
    });
  }

  private async handleDisconnect(port: number): Promise<void> {
    const connection = this.connections.get(port);
    if (!connection) {
      return;
    }

    connection.connected = false;
    this.rejectAllInFlightCalls(port);

    if (connection.unavailable || connection.reconnecting) {
      return;
    }

    if (connection.retryCount >= MAX_RECONNECT_ATTEMPTS) {
      connection.unavailable = true;
      logger.warn("cdp", "reconnect exhausted", {
        port,
        max_retries: MAX_RECONNECT_ATTEMPTS,
      });
      return;
    }

    this.scheduleReconnect(port);
  }

  private scheduleReconnect(port: number): void {
    const connection = this.connections.get(port);
    if (!connection || connection.reconnecting || connection.unavailable) {
      return;
    }

    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(connection.retryCount, RECONNECT_DELAYS_MS.length - 1)
      ];
    connection.reconnecting = true;
    logger.info("cdp", "reconnecting", {
      port,
      attempt: connection.retryCount + 1,
      delay_ms: delay,
    });

    this.clearReconnectTimer(connection);
    connection.reconnectTimer = setTimeout(() => {
      delete connection.reconnectTimer;
      void this.attemptReconnect(port);
    }, delay);
  }

  private async attemptReconnect(port: number): Promise<void> {
    const connection = this.connections.get(port);
    if (!connection || connection.unavailable) {
      return;
    }

    try {
      const client = await connectCDP({ port, host: this.config.cdp_host });
      await client.Runtime.enable();
      try { await client.Target.enable(); } catch { /* Target domain optional */ }

      connection.client = client;
      connection.connected = true;
      const attempt = connection.retryCount + 1;
      connection.retryCount = 0;
      connection.reconnecting = false;
      connection.unavailable = false;
      this.setupDisconnectListener(port);
      logger.info("cdp", "reconnected", { port, attempt });
    } catch (error) {
      connection.reconnecting = false;
      connection.retryCount += 1;

      if (connection.retryCount >= MAX_RECONNECT_ATTEMPTS) {
        connection.unavailable = true;
        logger.warn("cdp", "reconnect exhausted", {
          port,
          max_retries: MAX_RECONNECT_ATTEMPTS,
        });
        return;
      }

      this.scheduleReconnect(port);
    }
  }

  private incrementActiveOperations(port: number): void {
    this.activeOperations.set(port, (this.activeOperations.get(port) ?? 0) + 1);
  }

  private decrementActiveOperations(port: number): void {
    const count = (this.activeOperations.get(port) ?? 0) - 1;
    if (count <= 0) {
      this.activeOperations.delete(port);
    } else {
      this.activeOperations.set(port, count);
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval !== null) {
      return;
    }

    this.healthCheckInterval = setInterval(() => {
      void this.runHealthChecks();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthChecksIfIdle(): void {
    if (this.connections.size === 0 && this.healthCheckInterval !== null) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    for (const [port, connection] of this.connections) {
      if (!connection.connected || connection.reconnecting || connection.unavailable) {
        continue;
      }
      if ((this.activeOperations.get(port) ?? 0) > 0) {
        continue;
      }
      void this.performHealthCheck(port);
    }
  }

  private async performHealthCheck(port: number): Promise<void> {
    const connection = this.connections.get(port);
    if (
      !connection?.connected ||
      connection.reconnecting ||
      connection.unavailable
    ) {
      return;
    }
    if ((this.activeOperations.get(port) ?? 0) > 0) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.client.Runtime.evaluate({
          expression: "1",
          returnByValue: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("health check timeout")),
            HEALTH_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      connection.lastHealthCheck = new Date();
      logger.debug("cdp", "health-check ok", { port });
    } catch (error) {
      logger.warn("cdp", "health-check failed", {
        port,
        error: error instanceof Error ? error.message : String(error),
      });
      connection.connected = false;
      try {
        await connection.client.close();
      } catch {
        // 健康检查失败时忽略 close 错误，继续触发重连
      }
      await this.handleDisconnect(port);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
