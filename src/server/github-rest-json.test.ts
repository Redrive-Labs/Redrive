import { describe, expect, it, vi } from "vitest";
import {
  MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS,
  GithubRestJsonError,
  parseGithubRestJson,
} from "@/server/github-rest-json";
import { GithubApi } from "@/server/github-rest";

describe("lossless GitHub REST JSON decoding", () => {
  it("preserves unsafe integer IDs as exact strings without touching quoted values", () => {
    const appId = "900719925474099312345678901234567890";
    const parsed = parseGithubRestJson(
      `{"id":${appId},"owner":{"id":9007199254740993},"quoted":${JSON.stringify(appId)}}`,
    ) as { id: string; owner: { id: string }; quoted: string };

    expect(parsed).toEqual({ id: appId, owner: { id: "9007199254740993" }, quoted: appId });
  });

  it("rejects malformed, unfaithful, and overlong numeric literals", () => {
    expect(() => parseGithubRestJson('{"id":01}')).toThrow(GithubRestJsonError);
    expect(() => parseGithubRestJson('{"value":9007199254740993.1}')).toThrow(
      "cannot be represented faithfully",
    );
    expect(() => parseGithubRestJson('{"value":1e4000}')).toThrow(
      "cannot be represented faithfully",
    );
    expect(() =>
      parseGithubRestJson(
        `{"id":${"9".repeat(MAX_GITHUB_REST_NUMERIC_LITERAL_CHARS + 1)}}`,
      ),
    ).toThrow("numeric literal that is too long");
  });

  it("does not round a large ID through Number before the API boundary", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response('{"id":900719925474099312345678901234567890}', {
        status: 201,
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const api = new GithubApi({ fetchImplementation });
    const response = await api.convertManifest("one-time-code");

    expect(response).toEqual({ id: "900719925474099312345678901234567890" });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/one-time-code/conversions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "Redrive-GitHub-App-Connection",
        }),
      }),
    );
  });

  it("sends repository IDs as exact JSON integer tokens without converting them to Numbers", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response('{"token":"temporary-token","expires_at":"2026-01-01T00:10:00Z"}', {
        status: 201,
        headers: { "content-type": "application/vnd.github+json" },
      }),
    );
    const api = new GithubApi({ fetchImplementation });
    const id = "900719925474099312345678901234567890";
    await api.createInstallationToken("42", "app-jwt", [id]);
    const body = (fetchImplementation.mock.calls[0]?.[1] as RequestInit).body as string;
    expect(body).toContain(`"repository_ids":[${id}]`);
    expect(body).not.toContain("900719925474099400000000000000000000");
  });

  it("paginates repository hook discovery with bounded requests", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index }));
    const fetchImplementation = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const values = page === 1 ? firstPage : [{ id: 100 }];
      return new Response(JSON.stringify(values), {
        status: 200,
        headers: { "content-type": "application/vnd.github+json" },
      });
    });
    const api = new GithubApi({ fetchImplementation });

    await expect(api.listRepositoryHooks("octocat/receiver", "installation-token"))
      .resolves.toHaveLength(101);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(String(fetchImplementation.mock.calls[0]?.[0])).toContain("page=1");
    expect(String(fetchImplementation.mock.calls[1]?.[0])).toContain("page=2");
    expect((fetchImplementation.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer installation-token",
    });
  });

});
