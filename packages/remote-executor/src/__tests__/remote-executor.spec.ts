import { EventEmitter } from "events";
import { SshPoolManager } from "../ssh-pool.manager";
import { RemoteExecutorService } from "../remote-executor.service";

// Jest allows variables prefixed with "mock" to be referenced in jest.mock
const mockClients: any[] = [];

jest.mock("ssh2", () => {
  const { EventEmitter: EE } = require("events");
  return {
    Client: class extends EE {
      connect = jest.fn().mockImplementation(function (this: any) {
        process.nextTick(() => {
          this.emit("ready");
        });
      });
      exec = jest.fn().mockImplementation(function (this: any, _cmd: string, cb: any) {
        // By default, simulate a successful command execution
        const mockStream = new EE() as any;
        mockStream.stderr = new EE();
        cb(null, mockStream);
        process.nextTick(() => {
          mockStream.emit("data", Buffer.from("success"));
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

      constructor() {
        super();
        mockClients.push(this);
      }
    },
  };
});

describe("SSH Execution & Pooling Integration", () => {
  let pool: SshPoolManager;
  let executor: RemoteExecutorService;
  const config = {
    host: "127.0.0.1",
    port: 22,
    username: "test",
    privateKey: "fake-key",
  };

  beforeEach(() => {
    mockClients.length = 0;
    jest.clearAllMocks();
    pool = new SshPoolManager();
    executor = new RemoteExecutorService(config, pool);
  });

  afterEach(() => {
    pool.destroy();
  });

  // ─── 1. Pool Management Tests ──────────────────────────────────────────────

  describe("SshPoolManager", () => {
    it("reuses idle connections from the pool", async () => {
      const client1 = await pool.getConnection("server1", config);
      expect(mockClients).toHaveLength(1);

      pool.releaseConnection("server1", client1);

      const client2 = await pool.getConnection("server1", config);
      expect(mockClients).toHaveLength(1); // No new client created
      expect(client2).toBe(client1);
    });

    it("creates a new connection if none are idle and capacity allows", async () => {
      const client1 = await pool.getConnection("server1", config);
      const client2 = await pool.getConnection("server1", config);

      expect(mockClients).toHaveLength(2);
      expect(client1).not.toBe(client2);
    });

    it("removes connection from pool on disconnect", async () => {
      const client = await pool.getConnection("server1", config);
      expect(pool.getPoolStats("server1").total).toBe(1);

      client.emit("end");

      // Small tick to let 'end' callback process
      await new Promise((r) => process.nextTick(r));
      expect(pool.getPoolStats("server1").total).toBe(0);
    });

    it("removes connection from pool when SSH emits close without end", async () => {
      const client = await pool.getConnection("server1", config);
      expect(pool.getPoolStats("server1").total).toBe(1);

      client.emit("close");

      expect(pool.getPoolStats("server1").total).toBe(0);
    });

    it("times out if pool is at max capacity and no connection is released", async () => {
      // Connect up to MAX_POOL_SIZE (15)
      for (let i = 0; i < 15; i++) {
        await pool.getConnection("server1", config);
      }
      expect(pool.getPoolStats("server1").total).toBe(15);

      // Next getConnection call should queue and reject on timeout
      jest.useFakeTimers();
      const p = pool.getConnection("server1", config);

      jest.advanceTimersByTime(30000);
      await expect(p).rejects.toThrow("SSH pool timeout for server server1: pool at capacity");
      jest.useRealTimers();
    });

    it("releases blocked waiters when a connection is released", async () => {
      const clients: any[] = [];
      for (let i = 0; i < 15; i++) {
        clients.push(await pool.getConnection("server1", config));
      }

      const p = pool.getConnection("server1", config);
      // Release one client
      pool.releaseConnection("server1", clients[0]);

      const resolvedClient = await p;
      expect(resolvedClient).toBe(clients[0]);
    });
  });

  // ─── 2. Execution & Error Handling Tests ───────────────────────────────────

  describe("RemoteExecutorService", () => {
    it("successfully runs remote commands", async () => {
      const execResult = { stdout: "hello", stderr: "", code: 0 };

      // Setup the mock exec stream
      const mockStream = new EventEmitter() as any;
      mockStream.stderr = new EventEmitter();

      const client = await pool.getConnection("127.0.0.1:22", config);
      const mockClientInstance = mockClients.find((c) => c === (client as any))!;
      mockClientInstance.exec = jest.fn().mockImplementation((_cmd: string, cb: (err: any, stream: any) => void) => {
        cb(null, mockStream);
        process.nextTick(() => {
          mockStream.emit("data", Buffer.from("hello"));
          process.nextTick(() => {
            mockStream.emit("close", 0);
          });
        });
      });
      pool.releaseConnection("127.0.0.1:22", client);

      const res = await executor.execute("echo hello");
      expect(res).toEqual(execResult);
    });

    it("handles command execution timeouts", async () => {
      const mockStream = new EventEmitter() as any;
      mockStream.stderr = new EventEmitter();
      mockStream.destroy = jest.fn();

      const client = await pool.getConnection("127.0.0.1:22", config);
      const mockClientInstance = mockClients.find((c) => c === (client as any))!;
      mockClientInstance.exec = jest.fn().mockImplementation((_cmd: string, cb: (err: any, stream: any) => void) => {
        cb(null, mockStream);
      });
      pool.releaseConnection("127.0.0.1:22", client);

      // Test execution timeout using a short real-time timeout
      const p = executor.execute("sleep 60", { timeout: 15 });

      await expect(p).rejects.toThrow("Command timed out after 15ms");
      expect(mockStream.destroy).toHaveBeenCalled();
    });

    it("evicts connection and retries on Channel Open Failure", async () => {
      const client1 = await pool.getConnection("127.0.0.1:22", config);
      const mockClientInstance1 = mockClients[0];

      // Simulate Channel Open Failure on first attempt
      mockClientInstance1.exec = jest.fn().mockImplementation((_cmd: string, cb: (err: any) => void) => {
        cb(new Error("Channel open failure: maximum sessions reached"));
      });
      pool.releaseConnection("127.0.0.1:22", client1);

      // Trigger the executor execution (which will fail first, evict client1, and retry using a fresh client2)
      const executePromise = executor.execute("echo retry");

      const res = await executePromise;
      expect(res.stdout).toBe("success");
      expect(pool.getPoolStats("127.0.0.1:22").total).toBe(1); // Old one was destroyed, only new one left
    });

    it("evicts a disconnected pooled client and retries before starting the operation", async () => {
      const client1 = await pool.getConnection("127.0.0.1:22", config);
      const staleClient = mockClients[0];
      staleClient.exec = jest.fn().mockImplementation(() => {
        throw new Error("Not connected");
      });
      pool.releaseConnection("127.0.0.1:22", client1);

      const result = await executor.execute("echo retry");

      expect(result.stdout).toBe("success");
      expect(staleClient.destroy).toHaveBeenCalled();
      expect(mockClients).toHaveLength(2);
      expect(pool.getPoolStats("127.0.0.1:22").total).toBe(1);
    });

    it("retries when the SSH server rejects an exec request", async () => {
      const client1 = await pool.getConnection("127.0.0.1:22", config);
      const rejectedClient = mockClients[0];
      rejectedClient.exec = jest.fn().mockImplementation((_cmd: string, cb: (err: Error) => void) => {
        cb(new Error("Unable to exec"));
      });
      pool.releaseConnection("127.0.0.1:22", client1);

      const result = await executor.execute("echo retry");

      expect(result.stdout).toBe("success");
      expect(rejectedClient.destroy).toHaveBeenCalled();
      expect(mockClients).toHaveLength(2);
      expect(pool.getPoolStats("127.0.0.1:22").total).toBe(1);
    });

    it("explains a repeated exec request rejection without exposing the command", async () => {
      const client1 = await pool.getConnection("127.0.0.1:22", config);
      const rejectedClient = mockClients[0];
      rejectedClient.exec = jest.fn().mockImplementation((_cmd: string, cb: (err: Error) => void) => {
        cb(new Error("Unable to exec"));
      });
      const client2 = await pool.getConnection("127.0.0.1:22", config);
      mockClients[1].exec = jest.fn().mockImplementation((_cmd: string, cb: (err: Error) => void) => {
        cb(new Error("Unable to exec"));
      });
      pool.releaseConnection("127.0.0.1:22", client1);
      pool.releaseConnection("127.0.0.1:22", client2);

      await expect(executor.execute("mysql --password=secret")).rejects.toThrow(
        "SSH server rejected the remote command request after one reconnect attempt.",
      );
      expect(mockClients[1].destroy).toHaveBeenCalled();
    });

    it("triggers SFTP stall timeout if no data is transferred", async () => {
      const mockSftp = {
        createReadStream: jest.fn().mockImplementation(() => {
          const stream = new EventEmitter() as any;
          stream.pipe = jest.fn();
          return stream;
        }),
        end: jest.fn(),
      };

      const client = await pool.getConnection("127.0.0.1:22", config);
      const mockClientInstance = mockClients.find((c) => c === (client as any))!;
      mockClientInstance.sftp = jest.fn().mockImplementation((cb: (err: any, sftp: any) => void) => {
        cb(null, mockSftp);
      });
      pool.releaseConnection("127.0.0.1:22", client);

      // Direct invocation of the private sftpGet method with a short 10ms timeout
      const p = (executor as any).sftpGet(client, "/remote/path", 10);

      await expect(p).rejects.toThrow("SFTP pull stalled");
      expect(mockSftp.end).toHaveBeenCalled();
    });

    it("resets SFTP stall timeout on data events", async () => {
      const mockStream = new EventEmitter() as any;
      mockStream.pipe = jest.fn();

      const mockSftp = {
        createReadStream: jest.fn().mockReturnValue(mockStream),
        end: jest.fn(),
      };

      const client = await pool.getConnection("127.0.0.1:22", config);
      const mockClientInstance = mockClients.find((c) => c === (client as any))!;
      mockClientInstance.sftp = jest.fn().mockImplementation((cb: (err: any, sftp: any) => void) => {
        cb(null, mockSftp);
      });
      pool.releaseConnection("127.0.0.1:22", client);

      // Call private sftpGet with 60ms stall timeout
      const p = (executor as any).sftpGet(client, "/remote/path", 60);

      // After 30ms, emit a data event (postpones stall deadline)
      setTimeout(() => {
        mockStream.emit("data", Buffer.from("chunk"));
        // After another 30ms, complete the stream successfully
        setTimeout(() => {
          mockStream.emit("end");
        }, 30);
      }, 30);

      const result = await p;
      expect(result.toString()).toBe("chunk");
      expect(mockSftp.end).toHaveBeenCalled();
    });
  });
});
