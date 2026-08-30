import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperatorSession } from "@/server/operator-auth";
import {
  RECEIVER_CAPABILITIES,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_READ_JOB_LEASED,
  RECEIVER_READ_JOB_SUCCEEDED,
  type ReceiverConnection,
  type ReceiverReadJob,
} from "@/domain/receiver-connector";

const mocks = vi.hoisted(() => ({
  config: vi.fn(() => ({ databasePath: "/tmp/redrive-receiver-routes.sqlite" })),
  database: {},
  applicationConnection: vi.fn(),
  receiverForApplication: vi.fn(),
  enrollmentService: {
    issue: vi.fn(),
    reissue: vi.fn(),
    enroll: vi.fn(),
  },
  createEnrollmentService: vi.fn(),
  authentication: vi.fn(),
  createAuthService: vi.fn(),
  jobs: {
    leaseNext: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  },
  createJobsService: vi.fn(),
}));

vi.mock("@/server/config", async () => {
  const actual = await vi.importActual<typeof import("@/server/config")>("@/server/config");
  return { ...actual, getServerConfig: mocks.config };
});
vi.mock("@/server/database", () => ({
  getConfiguredDatabase: vi.fn(() => mocks.database),
}));
vi.mock("@/server/github-connection-service", () => ({
  getApplicationConnection: mocks.applicationConnection,
}));
vi.mock("@/server/receiver-connection-service", async () => {
  const actual = await vi.importActual<typeof import("@/server/receiver-connection-service")>("@/server/receiver-connection-service");
  return {
    ...actual,
    getReceiverConnectionForApplication: mocks.receiverForApplication,
    createReceiverEnrollmentService: mocks.createEnrollmentService,
    createReceiverConnectorAuthService: mocks.createAuthService,
  };
});
vi.mock("@/server/receiver-read-job-service", async () => {
  const actual = await vi.importActual<typeof import("@/server/receiver-read-job-service")>("@/server/receiver-read-job-service");
  return {
    ...actual,
    createReceiverReadJobTransportService: mocks.createJobsService,
  };
});

import { GET as getReceiverStatus } from "@/app/api/integrations/github/connections/[connectionId]/receiver/route";
import { POST as postReceiverEnrollment } from "@/app/api/integrations/github/connections/[connectionId]/receiver-enrollment/route";
import { POST as postReceiverEnroll } from "@/app/api/receiver/enroll/route";
import { POST as postLease } from "@/app/api/receiver/jobs/lease/route";
import { POST as postComplete } from "@/app/api/receiver/jobs/[jobId]/complete/route";
import {
  ReceiverConnectionError,
  ReceiverConnectorAuthenticationError,
} from "@/server/receiver-connection-service";
import {
  ReceiverReadJobError,
} from "@/server/receiver-read-job-service";
import { ReceiverConnectorValidationError } from "@/domain/receiver-connector";

const operatorToken = "operator-token-that-is-at-least-32-characters";
const connectorPrincipal = {
  receiverConnectionId: "receiver-connection-1",
  connectorId: "connector-1",
  receiverConnection: {} as ReceiverConnection,
};

function receiver(state: ReceiverConnection["state"] = RECEIVER_CONNECTION_READY): ReceiverConnection {
  return {
    id: "receiver-connection-1",
    applicationConnectionId: "application-connection-1",
    state,
    enrollmentExpiresAt: null,
    enrollmentConsumedAt: "2026-01-01T00:00:01.000Z",
    connectorId: "connector-1",
    protocolVersion: "1",
    capabilities: [...RECEIVER_CAPABILITIES],
    enrolledAt: "2026-01-01T00:00:01.000Z",
    lastSeenAt: "2026-01-01T00:00:02.000Z",
    lastHealthStatus: "HEALTHY",
    lastHealthAt: "2026-01-01T00:00:02.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
}

function leasedJob(): ReceiverReadJob {
  return {
    id: "job-1",
    receiverConnectionId: "receiver-connection-1",
    capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
    input: { deliveryGuid: "delivery-guid-1" },
    state: RECEIVER_READ_JOB_LEASED,
    leaseGeneration: 1,
    leasedConnectorId: "connector-1",
    leaseExpiresAt: "2026-01-01T00:00:15.000Z",
    deadlineAt: "2026-01-01T00:01:00.000Z",
    result: null,
    errorCode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
  };
}

function completedJob(): ReceiverReadJob {
  return {
    ...leasedJob(),
    state: RECEIVER_READ_JOB_SUCCEEDED,
    leasedConnectorId: null,
    leaseExpiresAt: null,
    result: {
      schemaVersion: 1,
      deliveryGuid: "delivery-guid-1",
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt: "2026-01-01T00:00:03.000Z",
    },
    completedAt: "2026-01-01T00:00:03.000Z",
  };
}

function operatorRequest(url: string, body?: unknown): Request {
  const session = createOperatorSession({
    REDRIVE_OPERATOR_TOKEN: operatorToken,
  } as unknown as NodeJS.ProcessEnv);
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `redrive_operator_session=${session}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function connectorRequest(
  url: string,
  body?: unknown,
  options: { connectorId?: string; secret?: string; signal?: AbortSignal } = {},
): Request {
  return new Request(url, {
    method: "POST",
    signal: options.signal,
    headers: {
      ...(options.connectorId === undefined ? {} : { "x-redrive-connector-id": options.connectorId }),
      ...(options.secret === undefined ? {} : { authorization: `Bearer ${options.secret}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("central receiver HTTP surfaces", () => {
  const originalOperatorToken = process.env.REDRIVE_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.REDRIVE_OPERATOR_TOKEN = operatorToken;
    vi.clearAllMocks();
    mocks.createEnrollmentService.mockReturnValue(mocks.enrollmentService);
    mocks.createAuthService.mockReturnValue({ authenticate: mocks.authentication });
    mocks.createJobsService.mockReturnValue(mocks.jobs);
    mocks.applicationConnection.mockReturnValue({
      id: "application-connection-1",
      state: "READY",
    });
    mocks.receiverForApplication.mockReturnValue(receiver());
    mocks.enrollmentService.issue.mockReturnValue({
      receiverConnection: receiver(RECEIVER_CONNECTION_VERIFYING),
      enrollmentToken: "enrollment-token-1",
      enrollmentExpiresAt: "2026-01-01T00:15:00.000Z",
    });
    mocks.enrollmentService.reissue.mockReturnValue({
      receiverConnection: receiver(),
      enrollmentToken: "enrollment-token-2",
      enrollmentExpiresAt: "2026-01-01T00:15:00.000Z",
    });
    mocks.enrollmentService.enroll.mockReturnValue({
      receiverConnection: receiver(RECEIVER_CONNECTION_VERIFYING),
      disposition: "ENROLLED",
      healthJobId: "health-job-1",
    });
    mocks.authentication.mockReturnValue(connectorPrincipal);
    mocks.jobs.leaseNext.mockReturnValue(leasedJob());
    mocks.jobs.complete.mockReturnValue(completedJob());
    mocks.jobs.fail.mockReturnValue({ ...completedJob(), state: "FAILED", result: null, errorCode: "CONNECTOR_ERROR" });
  });

  afterEach(() => {
    if (originalOperatorToken === undefined) delete process.env.REDRIVE_OPERATOR_TOKEN;
    else process.env.REDRIVE_OPERATOR_TOKEN = originalOperatorToken;
  });

  it("requires operator auth before receiver status or enrollment work", async () => {
    const status = await getReceiverStatus(
      new Request("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver"),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    expect(status.status).toBe(401);
    expect(mocks.config).not.toHaveBeenCalled();

    const enrollment = await postReceiverEnrollment(
      new Request("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver-enrollment", {
        method: "POST",
        body: "not-json",
      }),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    expect(enrollment.status).toBe(401);
    expect(mocks.enrollmentService.issue).not.toHaveBeenCalled();
  });

  it("returns only safe receiver status fields and derived readiness", async () => {
    const response = await getReceiverStatus(
      operatorRequest("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver"),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      receiverConnection: { state: RECEIVER_CONNECTION_READY },
      githubReady: true,
      receiverReady: true,
      recoveryReady: true,
    });
    expect(JSON.stringify(body)).not.toContain("token");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("hash");
  });

  it("implements ISSUE, duplicate conflict, and REISSUE without changing the 1a service", async () => {
    const issueResponse = await postReceiverEnrollment(
      operatorRequest("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver-enrollment", { action: "ISSUE" }),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    expect(issueResponse.status).toBe(201);
    expect(await issueResponse.json()).toMatchObject({ enrollmentToken: "enrollment-token-1" });
    expect(mocks.enrollmentService.issue).toHaveBeenCalledWith("application-connection-1");

    mocks.enrollmentService.issue.mockImplementation(() => {
      throw new ReceiverConnectionError("CONFLICT", "A receiver enrollment token is already pending.");
    });
    const duplicate = await postReceiverEnrollment(
      operatorRequest("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver-enrollment", { action: "ISSUE" }),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    expect(duplicate.status).toBe(409);

    const reissue = await postReceiverEnrollment(
      operatorRequest("http://redrive.test/api/integrations/github/connections/application-connection-1/receiver-enrollment", { action: "REISSUE" }),
      { params: Promise.resolve({ connectionId: "application-connection-1" }) },
    );
    expect(reissue.status).toBe(200);
    expect(mocks.enrollmentService.reissue).toHaveBeenCalledWith("application-connection-1");
  });

  it("enforces connector enrollment schema and hides enrollment secrets", async () => {
    const valid = await postReceiverEnroll(
      connectorRequest("http://redrive.test/api/receiver/enroll", {
        protocolVersion: "1",
        enrollmentToken: "enrollment-token-1",
        connectorId: "connector-1",
        connectorSecret: "connector-secret-1",
        capabilities: [...RECEIVER_CAPABILITIES],
      }),
    );
    expect(valid.status).toBe(200);
    const validBody = await valid.json();
    expect(validBody).toMatchObject({ disposition: "ENROLLED", healthJobId: "health-job-1" });
    expect(JSON.stringify(validBody)).not.toContain("enrollment-token-1");
    expect(JSON.stringify(validBody)).not.toContain("connector-secret-1");

    const extra = await postReceiverEnroll(
      connectorRequest("http://redrive.test/api/receiver/enroll", {
        protocolVersion: "1",
        enrollmentToken: "enrollment-token-1",
        connectorId: "connector-1",
        connectorSecret: "connector-secret-1",
        capabilities: [...RECEIVER_CAPABILITIES],
        receiverId: "do-not-accept",
      }),
    );
    expect(extra.status).toBe(400);
    expect(mocks.enrollmentService.enroll).toHaveBeenCalledTimes(1);
  });

  it("authenticates connector jobs independently before queue access", async () => {
    mocks.authentication.mockImplementation(() => {
      throw new ReceiverConnectorAuthenticationError();
    });
    const response = await postLease(
      connectorRequest("http://redrive.test/api/receiver/jobs/lease", undefined, {
        connectorId: "connector-1",
        secret: "operator-cookie-or-github-token",
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.createJobsService).not.toHaveBeenCalled();
    expect(mocks.jobs.leaseNext).not.toHaveBeenCalled();
  });

  it("does not treat an operator cookie or GitHub MCP bearer as connector auth", async () => {
    mocks.authentication.mockImplementation(() => {
      throw new ReceiverConnectorAuthenticationError();
    });
    const operatorSession = createOperatorSession({
      REDRIVE_OPERATOR_TOKEN: operatorToken,
    } as unknown as NodeJS.ProcessEnv);
    const operatorCookie = await postLease(
      new Request("http://redrive.test/api/receiver/jobs/lease", {
        method: "POST",
        headers: { cookie: `redrive_operator_session=${operatorSession}` },
      }),
    );
    expect(operatorCookie.status).toBe(401);

    const githubBearer = await postLease(
      connectorRequest("http://redrive.test/api/receiver/jobs/lease", undefined, {
        connectorId: "connector-1",
        secret: "github-mcp-token",
      }),
    );
    expect(githubBearer.status).toBe(401);
    expect(mocks.createJobsService).not.toHaveBeenCalled();
  });

  it("returns a bounded leased job without connector selectors", async () => {
    const response = await postLease(
      connectorRequest("http://redrive.test/api/receiver/jobs/lease", undefined, {
        connectorId: "connector-1",
        secret: "connector-secret-1",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({
      jobId: "job-1",
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      leaseGeneration: 1,
    });
    expect(body.job.receiverConnectionId).toBeUndefined();
    expect(body.job.leasedConnectorId).toBeUndefined();
  });

  it("returns no work immediately for an already-aborted connector request", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.jobs.leaseNext.mockReturnValue(null);
    const response = await postLease(
      connectorRequest("http://redrive.test/api/receiver/jobs/lease", undefined, {
        connectorId: "connector-1",
        secret: "connector-secret-1",
        signal: controller.signal,
      }),
    );
    expect(await response.json()).toEqual({ job: null });
    expect(mocks.jobs.leaseNext).not.toHaveBeenCalled();
  });

  it("delegates typed completion and maps stale, terminal, deadline, and malformed results", async () => {
    const success = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {
          schemaVersion: 1,
          deliveryGuid: "delivery-guid-1",
          mutationCount: 1,
          businessState: "EXACTLY_ONE",
          observedAt: "2026-01-01T00:00:03.000Z",
        },
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(success.status).toBe(200);
    expect(mocks.jobs.complete).toHaveBeenCalledWith(
      "job-1",
      connectorPrincipal,
      1,
      expect.objectContaining({ businessState: "EXACTLY_ONE" }),
    );

    mocks.jobs.complete.mockImplementation(() => {
      throw new ReceiverReadJobError("STALE_LEASE", "The receiver read job lease generation is stale.");
    });
    const stale = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {},
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("STALE_LEASE");

    mocks.jobs.complete.mockImplementation(() => {
      throw new ReceiverReadJobError("JOB_ALREADY_COMPLETED", "The receiver read job is already terminal.");
    });
    const duplicate = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {},
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(duplicate.status).toBe(409);

    mocks.jobs.complete.mockImplementation(() => {
      throw new ReceiverReadJobError("DEADLINE_EXPIRED", "The receiver read job deadline has expired.");
    });
    const deadline = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {},
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(deadline.status).toBe(422);
    expect((await deadline.json()).code).toBe("DEADLINE_EXPIRED");

    mocks.jobs.complete.mockImplementation(() => {
      throw new ReceiverConnectorValidationError("health:v1 result is invalid.");
    });
    const malformed = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {},
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(malformed.status).toBe(400);
  });

  it("rejects completion schema extras and does not access a job before connector auth", async () => {
    const strict = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/job-1/complete", {
        leaseGeneration: 1,
        outcome: "FAILED",
        errorCode: "CONNECTOR_ERROR",
        result: "extra",
      }, { connectorId: "connector-1", secret: "connector-secret-1" }),
      { params: Promise.resolve({ jobId: "job-1" }) },
    );
    expect(strict.status).toBe(400);

    mocks.authentication.mockImplementation(() => {
      throw new ReceiverConnectorAuthenticationError();
    });
    const unauthenticated = await postComplete(
      connectorRequest("http://redrive.test/api/receiver/jobs/does-not-exist/complete", {
        leaseGeneration: 1,
        outcome: "SUCCEEDED",
        result: {},
      }),
      { params: Promise.resolve({ jobId: "does-not-exist" }) },
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.createJobsService).not.toHaveBeenCalled();
  });
});
