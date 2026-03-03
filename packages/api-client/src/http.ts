import type { IChatRequest, IChatResponse, ITaskSummary, IApiError } from "@oi/shared-types";

export class OiHttpClient {
  private baseUrl: string;
  private getToken: () => Promise<string>;

  constructor(baseUrl: string, getToken: () => Promise<string>) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.getToken = getToken;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error: IApiError = await response.json().catch(() => ({
        status: "error" as const,
        detail: response.statusText,
      }));
      throw new Error(error.detail);
    }

    return response.json();
  }

  async sendMessage(payload: IChatRequest): Promise<IChatResponse> {
    return this.request<IChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getHealth(): Promise<{ status: string }> {
    return this.request("/health");
  }

  async listTasks(): Promise<ITaskSummary[]> {
    return this.request("/tasks");
  }

  async getTask(taskId: string): Promise<ITaskSummary> {
    return this.request(`/tasks/${taskId}`);
  }

  async submitTaskAction(taskId: string, action: string, deviceId: string): Promise<void> {
    await this.request(`/tasks/${taskId}/action`, {
      method: "POST",
      body: JSON.stringify({ action, device_id: deviceId }),
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request(`/tasks/${taskId}/cancel`, { method: "PUT" });
  }

  async registerDevice(
    deviceType: string,
    deviceName: string,
    fcmToken?: string,
  ): Promise<{ device_id: string }> {
    return this.request("/devices/register", {
      method: "POST",
      body: JSON.stringify({
        device_type: deviceType,
        device_name: deviceName,
        fcm_token: fcmToken,
      }),
    });
  }

  async inviteMeshMember(email: string, groupId: string): Promise<void> {
    await this.request("/mesh/invite", {
      method: "POST",
      body: JSON.stringify({ email, group_id: groupId }),
    });
  }
}
