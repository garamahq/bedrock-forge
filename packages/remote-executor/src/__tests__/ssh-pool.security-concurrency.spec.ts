import { EventEmitter } from "events";
import { SshPoolManager, type SshServerConfig } from "../ssh-pool.manager";
import { RemoteExecutorService } from "../remote-executor.service";

const mockClientBehavior = {
  autoReady: true,
  pendingConnects: [] as Array<EventEmitter & { connect: jest.Mock; exec: jest.Mock; end: jest.Mock; destroy: jest.Mock }>,
};

jest.mock("ssh2", () => {
  const { EventEmitter: EE } = require("events");
  return {
    Client: class extends EE {
      connect = jest.fn().mockImplementation(function (this: any) {
        mockClientBehavior.pendingConnects.push(this);
        if (mockClientBehavior.autoReady) {
          process.nextTick(() => {
            this.emit("ready");
          });
        }
      });
      exec = jest.fn().mockImplementation(function (this: any, _cmd: string, cb: any) {
        const mockStream = new EE() as any;
        mockStream.stderr = new EE();
        cb(null, mockStream);
        process.nextTick(() => {
          mockStream.emit("data", Buffer.from("ok"));
          process.nextTick(() => {
            mockStream.emit("close", 0);
          });
        });
      });
      sftp = jest.fn();
      end = jest.fn().mockImplementation(function (this: any) {
        process.nextTick(() => {
          this.emit("end");
        });
      });
      destroy = jest.fn();
    },
  };
});

describe("SshPoolManager & RemoteExecutorService (#77, #78, #79)", () => {
  let pool: SshPoolManager;

  beforeEach(() => {
    mockClientBehavior.autoReady = true;
    mockClientBehavior.pendingConnects.length = 0;
    pool = new SshPoolManager();
  });

  afterEach(() => {
    jest.useRealTimers();
    pool.destroy();
  });

  it("stops waiting on timeout so subsequently released connection remains idle for new callers (#77)", async () => {
    const config: SshServerConfig = {
      host: "198.51.100.10",
      port: 22,
      username: "root",
      privateKey: "key-1",
    };

    const clients = [];
    for (let i = 0; i < 15; i++) {
      clients.push(await pool.getConnection("pool-77", config));
    }

    jest.useFakeTimers();
    const timedOutReq = pool.getConnection("pool-77", config);
    jest.advanceTimersByTime(30_000);
    await expect(timedOutReq).rejects.toThrow(/timeout/i);

    pool.releaseConnection("pool-77", clients[0]);
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(pool.getPoolStats("pool-77")).toMatchObject({
      active: 14,
      idle: 1,
      total: 15,
    });

    const freshClient = await pool.getConnection("pool-77", config);
    expect(freshClient).toBe(clients[0]);
    pool.releaseConnection("pool-77", freshClient);
    expect(pool.getPoolStats("pool-77")).toMatchObject({
      active: 14,
      idle: 1,
      total: 15,
    });
  });

  it("handles release coinciding with the 30s timeout boundary without double-accounting (#77)", async () => {
    const config: SshServerConfig = {
      host: "198.51.100.11",
      port: 22,
      username: "root",
      privateKey: "key-1",
    };

    const clients = [];
    for (let i = 0; i < 15; i++) {
      clients.push(await pool.getConnection("pool-boundary", config));
    }

    jest.useFakeTimers();
    const waiter = pool.getConnection("pool-boundary", config);
    jest.advanceTimersByTime(29_999);
    pool.releaseConnection("pool-boundary", clients[0]);
    jest.advanceTimersByTime(5);

    const outcome = await waiter.then(
      (c) => ({ ok: true as const, client: c }),
      (e: Error) => ({ ok: false as const, err: e }),
    );

    if (outcome.ok) {
      expect(outcome.client).toBe(clients[0]);
      pool.releaseConnection("pool-boundary", outcome.client);
    }

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(pool.getPoolStats("pool-boundary")).toMatchObject({
      active: 14,
      idle: 1,
      total: 15,
    });
  });

  it("counts in-flight handshakes against MAX_POOL_SIZE so concurrent calls never exceed 15 (#78)", async () => {
    mockClientBehavior.autoReady = false;
    const config: SshServerConfig = {
      host: "198.51.100.20",
      port: 22,
      username: "root",
      privateKey: "key-2",
    };

    const pending = Array.from({ length: 20 }, () =>
      pool.getConnection("pool-78", config),
    );
    const failedReqExpectation = expect(pending[0]).rejects.toThrow(
      /handshake dropped/,
    );
    await Promise.resolve();

    expect(mockClientBehavior.pendingConnects).toHaveLength(15);

    // Emit error on first attempt so an excess waiter gets a slot rather than 16th parallel connect before decrement
    const failedClient = mockClientBehavior.pendingConnects[0];
    for (let i = 1; i < 15; i++) {
      mockClientBehavior.pendingConnects[i].emit("ready");
    }
    failedClient.emit("error", new Error("handshake dropped"));
    await failedReqExpectation;

    await new Promise((r) => setTimeout(r, 20));
    expect(mockClientBehavior.pendingConnects.length).toBeLessThanOrEqual(16);

    // Finish the replacement 16th connection and verify released slots serve remaining 4 waiters cleanly
    const replacement = mockClientBehavior.pendingConnects[15];
    replacement?.emit("ready");

    const clients1to14 = await Promise.all(pending.slice(1, 15));
    const waiter16 = await pending[15];
    expect(pool.getPoolStats("pool-78").total).toBeLessThanOrEqual(15);

    for (let i = 0; i < 4; i++) {
      pool.releaseConnection("pool-78", clients1to14[i]);
    }
    await Promise.all(pending.slice(16));
    expect(pool.getPoolStats("pool-78").total).toBeLessThanOrEqual(15);
    pool.releaseConnection("pool-78", waiter16);
  });

  it("isolates pooled sessions by user, credential, and trust policy even for the same host and port (#79)", async () => {
    const secretKeyA = "PRIVATE-KEY-MATERIAL-ALPHA";
    const secretKeyB = "PRIVATE-KEY-MATERIAL-BETA";

    const cfgRootFpA: SshServerConfig = {
      host: "203.0.113.50",
      port: 22,
      username: "root",
      privateKey: secretKeyA,
      expectedHostKeyFingerprint: "SHA256:hostA",
    };
    const cfgDeploySameHost: SshServerConfig = {
      host: "203.0.113.50",
      port: 22,
      username: "deploy",
      privateKey: secretKeyA,
      expectedHostKeyFingerprint: "SHA256:hostA",
    };
    const cfgRootChangedFp: SshServerConfig = {
      host: "203.0.113.50",
      port: 22,
      username: "root",
      privateKey: secretKeyB,
      expectedHostKeyFingerprint: "SHA256:hostB",
    };

    const execA = new RemoteExecutorService(cfgRootFpA, pool);
    const execB = new RemoteExecutorService(cfgDeploySameHost, pool);
    const execC = new RemoteExecutorService(cfgRootChangedFp, pool);

    await execA.execute("whoami");
    await execB.execute("whoami");
    await execC.execute("whoami");

    // 3 distinct accounts/trust configs on same host:22 MUST NOT share one SSH Client
    expect(mockClientBehavior.pendingConnects).toHaveLength(3);

    // Repeated call with same config reuses its own idle client
    await execA.execute("uptime");
    expect(mockClientBehavior.pendingConnects).toHaveLength(3);

    // Direct SshPoolManager call with identical key string but different user MUST NOT return wrong identity's client
    const c1 = await pool.getConnection("shared-manual-key", cfgRootFpA);
    pool.releaseConnection("shared-manual-key", c1);
    const c2 = await pool.getConnection("shared-manual-key", cfgDeploySameHost);
    expect(c2).not.toBe(c1);

    // Verify no key material leaks into keys or errors
    const allStatsKeys = Array.from(
      (pool as unknown as { pools: Map<string, unknown> }).pools.keys(),
    );
    expect(allStatsKeys.join("|")).not.toContain(secretKeyA);
    expect(allStatsKeys.join("|")).not.toContain(secretKeyB);
  });
});
