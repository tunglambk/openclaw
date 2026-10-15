import { beforeEach, describe, expect, it, vi } from "vitest";

const containerState = vi.hoisted(() => ({ inContainer: false }));

// Container identity is process-stable and read from the host, so the suite
// drives it explicitly instead of depending on where the tests run.
vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: () => containerState.inContainer,
  resetContainerEnvironmentCacheForTest: () => {},
}));

vi.mock("../infra/device-bootstrap.js", () => ({
  issueDevicePairSetupBootstrapToken: vi.fn(async () => ({
    token: "bootstrap-123",
    expiresAtMs: 123,
    setupId: "setup-123",
  })),
}));

const { resolvePairingGatewayUrl, resolvePairingSetupFromConfig } = await import("./setup-code.js");

// Pins the user-facing message the resolver returns when a container cannot
// offer a reachable endpoint.
const CONTAINER_NETWORK_ERROR =
  "Gateway runs in a container, so its own interface addresses are only reachable inside the container network. Set gateway.publicOrigin to the address devices use, configure plugins.entries.device-pair.config.publicUrl, or enable tailscale serve.";

type ResolveOptions = Parameters<typeof resolvePairingGatewayUrl>[1];

function containerInterfaces(): ReturnType<ResolveOptions["networkInterfaces"]> {
  return {
    eth0: [
      {
        address: "172.18.0.2",
        family: "IPv4",
        internal: false,
        netmask: "255.255.0.0",
        mac: "02:42:ac:12:00:02",
        cidr: "172.18.0.2/16",
      },
    ],
  };
}

beforeEach(() => {
  containerState.inContainer = false;
});

describe("pairing gateway URL inside a container", () => {
  it("does not advertise the container interface address for a LAN bind", async () => {
    containerState.inContainer = true;
    await expect(
      resolvePairingGatewayUrl(
        { gateway: { bind: "lan", port: 19001 } },
        { env: {}, networkInterfaces: containerInterfaces },
      ),
    ).resolves.toEqual({ error: CONTAINER_NETWORK_ERROR });
  });

  it("uses a configured public origin instead of the container interface address", async () => {
    containerState.inContainer = true;
    await expect(
      resolvePairingGatewayUrl(
        { gateway: { bind: "lan", port: 19001, publicOrigin: "https://gateway.example.test" } },
        { env: {}, networkInterfaces: containerInterfaces },
      ),
    ).resolves.toEqual({ url: "wss://gateway.example.test", source: "gateway.publicOrigin" });
  });

  it("keeps advertising the discovered LAN address outside containers", async () => {
    await expect(
      resolvePairingGatewayUrl(
        { gateway: { bind: "lan", port: 19001 } },
        { env: {}, networkInterfaces: containerInterfaces },
      ),
    ).resolves.toEqual({ url: "ws://172.18.0.2:19001", source: "gateway.bind=lan" });
  });

  it("keeps an explicit custom bind host authoritative in a container", async () => {
    containerState.inContainer = true;
    await expect(
      resolvePairingGatewayUrl(
        { gateway: { bind: "custom", customBindHost: "192.168.1.50", port: 19001 } },
        { env: {}, networkInterfaces: containerInterfaces },
      ),
    ).resolves.toEqual({ url: "ws://192.168.1.50:19001", source: "gateway.bind=custom" });
  });

  it("fails the setup payload instead of emitting an unreachable container URL", async () => {
    containerState.inContainer = true;
    await expect(
      resolvePairingSetupFromConfig(
        { gateway: { bind: "lan", port: 19001, auth: { mode: "token", token: "tok_123" } } },
        { env: {}, networkInterfaces: containerInterfaces },
      ),
    ).resolves.toEqual({ ok: false, error: CONTAINER_NETWORK_ERROR });
  });
});
