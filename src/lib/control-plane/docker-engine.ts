import http from "node:http";

const socketPath = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath,
        path: `/v1.44${path}`,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(
              new Error(
                `Docker ${method} ${path} failed (${response.statusCode}): ${data}`,
              ),
            );
            return;
          }
          resolve((data ? JSON.parse(data) : {}) as T);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rawRequest(method: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: `/v1.44${path}`, method },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(
              new Error(
                `Docker ${method} ${path} failed (${response.statusCode}): ${data}`,
              ),
            );
            return;
          }
          resolve(data);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface DockerContainerState {
  Id: string;
  State: { Running: boolean; ExitCode: number; Error?: string };
}

interface DockerContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
}

/** All live/retained one-shot phase containers, used during dispatcher startup. */
export function listPhaseJobContainers(): Promise<DockerContainerSummary[]> {
  return request<DockerContainerSummary[]>(
    "GET",
    "/containers/json?all=1",
  ).then((containers) =>
    containers.filter(
      (container) => container.Labels?.["aida.role"] === "phase-job",
    ),
  );
}

export function dockerHostCpuCount(): Promise<number> {
  return request<{ NCPU?: number }>("GET", "/info").then(
    (info) => info.NCPU || 1,
  );
}

interface DockerMount {
  Type?: "bind" | "volume" | "tmpfs";
  Name?: string;
  Source: string;
  Destination: string;
  Mode?: string;
  RW?: boolean;
}

export async function createJobContainer(input: {
  jobId: string;
  phase: string;
  cpuNano: number;
  memoryBytes: number;
  network: string;
  binds: string[];
  image: string;
  environment: string[];
}): Promise<string> {
  const created = await request<{ Id: string }>("POST", "/containers/create", {
    Image: input.image,
    Cmd: [
      "node",
      "--import",
      "tsx",
      "scripts/orchestrator/job-runner.ts",
      input.jobId,
    ],
    Tty: true,
    Env: input.environment,
    Labels: {
      "aida.role": "phase-job",
      "aida.job-id": input.jobId,
      "aida.phase": input.phase,
    },
    HostConfig: {
      AutoRemove: true,
      NetworkMode: input.network,
      Binds: input.binds,
      NanoCpus: input.cpuNano,
      Memory: input.memoryBytes,
      MemoryReservation: Math.floor(input.memoryBytes * 0.75),
      PidsLimit: 256,
    },
  });
  await request("POST", `/containers/${created.Id}/start`);
  return created.Id;
}

/** Copy required data/secret mounts without leaking the Docker socket. */
export async function safeDispatcherBinds(
  containerId: string,
): Promise<string[]> {
  const inspected = await request<{ Mounts?: DockerMount[] }>(
    "GET",
    `/containers/${containerId}/json`,
  );
  return (inspected.Mounts || [])
    .filter(
      (mount) =>
        mount.Destination !== "/var/run/docker.sock" &&
        [
          "/data",
          "/run/aida-secrets",
          "/workspace/logs",
          "/workspace/batches",
        ].includes(mount.Destination),
    )
    .map(
      (mount) =>
        `${mount.Type === "volume" && mount.Name ? mount.Name : mount.Source}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`,
    );
}

export function inspectContainer(id: string): Promise<DockerContainerState> {
  return request<DockerContainerState>("GET", `/containers/${id}/json`);
}

export function containerLogs(id: string): Promise<string> {
  return rawRequest("GET", `/containers/${id}/logs?stdout=1&stderr=1&tail=all`);
}

export function removeContainer(id: string): Promise<unknown> {
  return request("DELETE", `/containers/${id}?force=1`);
}
