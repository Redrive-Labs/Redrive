import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("operator logout route", () => {
  it("expires only the operator session cookie and redirects to login", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/logout", { method: "POST" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/login");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("redrive_operator_session=;");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});
