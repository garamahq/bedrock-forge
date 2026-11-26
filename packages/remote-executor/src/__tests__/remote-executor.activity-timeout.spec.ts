import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { SshPoolManager, sshPoolManager } from "../ssh-pool.manager";
import { RemoteExecutorService } from "../remote-executor.service";
import type { Client } from "ssh2";

// Mutable array to capture ssh2 Client instances created during tests
const mockClients: Client[] = [];

jest.mock("ssh2", () => {
  const { EventEmitter: EE } = require("events");
  return {
    Client: class extends EE {
      connect = jest.fn().mockImplementation(function (this: Client) {
        process.nextTick(() => {
          (this as unknown as EventEmitter).emit("ready");
        });
      });
      exec = jest.fn();
      sftp = jest.fn();
      end = jest.fn().mockImplementation(function (this: Client) {
        process.nextTick(() => {
          (this as unknown as EventEmitter).emit("end");
        });
      });
      destroy = jest.fn();

      constructor() {
        super();
        mockClients.push(this as unknown as Client);
      }
    },
  };
});

describe("RemoteExecutorService activity timeout, indeterminate SSH exit, and async stream errors (#53, #59, #31)", () => {
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
    jest.useRealTimers();
    pool.destroy();
  });

  afterAll(() => {
    sshPoolManager.destroy();
  });

  describe("#59 SSH channel close without exit code or terminated by signal", () => {
    it("marks execution indeterminate and non-zero when close emits null/undefined exit code", async () => {
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: EventEmitter & { stderr: EventEmitter; destroy: jest.Mock }) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroy: jest.fn(),
          });
          cb(null, stream);
          process.nextTick(() => {
            stream.emit("data", Buffer.from("partial"));
            stream.emit("close", undefined);
          });
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const res = await executor.execute("php restore.php");
      expect(res.code).not.toBe(0);
      expect(res.indeterminate).toBe(true);
    });

    it("marks execution indeterminate and non-zero when terminated by signal", async () => {
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: EventEmitter & { stderr: EventEmitter; destroy: jest.Mock }) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroy: jest.fn(),
          });
          cb(null, stream);
          process.nextTick(() => {
            stream.emit("close", null, "SIGTERM");
          });
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const res = await executor.execute("php restore.php");
      expect(res.code).not.toBe(0);
      expect(res.indeterminate).toBe(true);
      expect(res.signal).toBe("SIGTERM");
    });

    it("returns indeterminate=undefined and code=0 on explicit zero close", async () => {
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: EventEmitter & { stderr: EventEmitter }) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
          });
          cb(null, stream);
          process.nextTick(() => {
            stream.emit("data", Buffer.from("ok"));
            stream.emit("close", 0);
          });
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const res = await executor.execute("echo ok");
      expect(res.code).toBe(0);
      // Clean exit: indeterminate field is not present (or falsy)
      expect(res.indeterminate).toBeFalsy();
    });
  });

  describe("#53 Activity-based idleTimeoutMs vs maxTimeoutMs", () => {
    it("resets idleTimeoutMs whenever stdout or stderr chunks arrive and succeeds past single idle window", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      let streamRef: EventEmitter & { stderr: EventEmitter; destroy: jest.Mock };
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: typeof streamRef) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroy: jest.fn(),
          });
          streamRef = stream;
          cb(null, stream);
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const execPromise = executor.execute("tar -czf out.tar.gz /var/www", {
        idleTimeoutMs: 1_000,
        maxTimeoutMs: 5_000,
      });

      // Flush pool ready/exec microtasks
      await Promise.resolve();
      await Promise.resolve();

      // Advance 700ms and emit progress -> resets 1000ms idle timer
      jest.advanceTimersByTime(700);
      streamRef!.stderr.emit("data", Buffer.from("working..."));

      // Advance another 700ms (total 1400ms > single 1000ms idleTimeoutMs!) -> still alive!
      jest.advanceTimersByTime(700);
      streamRef!.emit("data", Buffer.from('{"status":"ok"}'));
      streamRef!.emit("close", 0);

      const res = await execPromise;
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('{"status":"ok"}');
    });

    it("aborts after idleTimeoutMs when no output arrives even if maxTimeoutMs is larger", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      const destroyMock = jest.fn();
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: EventEmitter & { stderr: EventEmitter; destroy: jest.Mock }) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroy: destroyMock,
          });
          cb(null, stream);
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const execPromise = executor.execute("hung-cmd", {
        idleTimeoutMs: 500,
        maxTimeoutMs: 5_000,
      });

      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(550);

      await expect(execPromise).rejects.toThrow(/idle|stalled|timed out/i);
      expect(destroyMock).toHaveBeenCalled();
    });

    it("enforces maxTimeoutMs hard cap even while output keeps resetting idleTimeoutMs", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick"] });
      const destroyMock = jest.fn();
      let streamRef: EventEmitter & { stderr: EventEmitter; destroy: jest.Mock };
      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { exec: jest.Mock }).exec = jest.fn(
        (_cmd: string, cb: (err: null, stream: typeof streamRef) => void) => {
          const stream = Object.assign(new EventEmitter(), {
            stderr: new EventEmitter(),
            destroy: destroyMock,
          });
          streamRef = stream;
          cb(null, stream);
        },
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const execPromise = executor.execute("chatty-cmd", {
        idleTimeoutMs: 1_000,
        maxTimeoutMs: 2_200,
      });

      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(800);
      streamRef!.stderr.emit("data", Buffer.from("tick1"));
      jest.advanceTimersByTime(800);
      streamRef!.stderr.emit("data", Buffer.from("tick2"));
      jest.advanceTimersByTime(700); // cumulative 2300ms > 2200ms maxTimeoutMs

      await expect(execPromise).rejects.toThrow(/max timeout/i);
      expect(destroyMock).toHaveBeenCalled();
    });
  });

  describe("#31 Async onProgress rejection propagation in pushFileFromStream", () => {
    it("rejects the SFTP push transfer when an async onProgress callback rejects and honours fileMode", async () => {
      const mockWriteStream = Object.assign(new EventEmitter(), {
        destroy: jest.fn(),
        end: jest.fn(),
        write: jest.fn().mockReturnValue(true),
      });
      const mockSftp = {
        createWriteStream: jest.fn().mockReturnValue(mockWriteStream),
        end: jest.fn(),
      };

      const client = await pool.getConnection("127.0.0.1:22", config);
      (client as unknown as { sftp: jest.Mock }).sftp = jest.fn((cb: (err: null, sftp: typeof mockSftp) => void) =>
        cb(null, mockSftp),
      );
      pool.releaseConnection("127.0.0.1:22", client);

      const readable = new PassThrough();
      const pushPromise = executor.pushFileFromStream(
        "/tmp/restore.tar.gz",
        readable,
        5_000,
        async () => {
          throw new Error("Cancelled by user");
        },
        0o600,
      );

      process.nextTick(() => {
        readable.write(Buffer.from("chunk-data"));
        readable.end();
        mockWriteStream.emit("close");
      });

      await expect(pushPromise).rejects.toThrow("Cancelled by user");
      expect(mockSftp.createWriteStream).toHaveBeenCalledWith(
        "/tmp/restore.tar.gz",
        { mode: 0o600 },
      );
      expect(mockWriteStream.destroy).toHaveBeenCalled();
      expect(mockSftp.end).toHaveBeenCalled();
    });
  });
});
